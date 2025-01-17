#!/usr/bin/env node
/* eslint-disable no-await-in-loop */
import { ArgumentParser } from 'argparse';
import IAM from '@aws-sdk/client-iam';
import S3 from '@aws-sdk/client-s3';
import fs from 'fs';
import os from 'os';
import { basename, dirname, relative as relativePath, parse as parsePath } from 'path';
import process from 'process';
import { fileURLToPath } from 'url';
import { Group } from '../src/groups.js';
import { reportUnhandledRejectionsAtExit, run, setupConsole } from '../src/utils/scripts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID;

const REPO = relativePath(".", `${__dirname}/..`) || ".";


function parseArgs() {
  const argparser = new ArgumentParser({
    usage: `%(prog)s [--dry-run | --wet-run] <name>`,
    description: `
      Migrate a Nextstrain Group from an old single-tenant bucket to the new
      multi-tenant bucket.  The group must already be defined in
      data/groups.json.
    `,
  });

  argparser.addArgument("groupName", {metavar: "<name>", help: "Name of the Nextstrain Group"});
  argparser.addArgument("--dry-run", {
    help: "Go through the motions locally but don't actually make any changes on AWS or to local files.  This is the default.",
    dest: "dryRun",
    action: "storeTrue",
    defaultValue: true,
  });
  argparser.addArgument("--wet-run", {
    help: "Actually make changes on AWS.",
    dest: "dryRun",
    action: "storeFalse",
  });

  return argparser.parseArgs();
}


function main({groupName, dryRun = true}) {
  if (!AWS_ACCOUNT_ID) throw new Error("AWS_ACCOUNT_ID env var required");

  // Canonicalizes name for us and ensures a data entry exists.
  const group = new Group(groupName);

  setupConsole({dryRun});

  console.log(`Migrating Nextstrain Group ${group.name}`);

  migrate({group, dryRun})
    .then(finalSteps => {
      console.group("\nMigration ready for the final (manual) steps!");
      finalSteps.forEach(step => console.log(`- [ ] ${step}`));
      console.groupEnd();
    })
    .catch(error => {
      console.error("\n\n%s\n", error);
      console.error("Migration FAILED.  See above for details.  It's typically safe to re-run this program after fixing the issue.");
      process.exitCode = 1;
    });
}


async function migrate({group, dryRun = true}) {
  const oldBucket = group.bucket;

  if (!oldBucket) throw new Error(`Group ${group.name} doesn't have a single-tenant bucket defined.`);

  // Each automatic step can return remaining steps to be performed manually.
  const remainingSteps = [
    await deleteIAMResources({dryRun, group}),
    await updateBucketPolicies({dryRun, oldBucket}),
    await syncData({dryRun, group}),
    await updateGroupsDataFile({dryRun, group}),
    `Review local changes, commit, and push.`,
    `Monitor for successful deploy to the [canary](https://dashboard.heroku.com/apps/nextstrain-canary/activity)`,
    `[Deploy canary to production](https://dashboard.heroku.com/pipelines/38f67fc7-d93c-40c6-a182-501da2f89d9d)`,
    await updateServerPolicies({dryRun, oldBucket}),
    `Delete bucket [${group.bucket}](https://s3.console.aws.amazon.com/s3/buckets/${group.bucket}) after short retention period (~1 month?)`,
  ];

  return remainingSteps.filter(s => s != null).flat();
}


async function syncData({dryRun = true, group}) {
  console.group(`\nSyncing S3 data`);

  // Datasets
  await s3Sync({
    dryRun,
    group,
    prefix: "datasets/",
    filters: [
      "--exclude=*",
      "--include=*.json",
      "--exclude=*/*",
    ]
  });

  // Narratives
  await s3Sync({
    dryRun,
    group,
    prefix: "narratives/",
    filters: [
      "--exclude=*",
      "--include=*.md",
      "--exclude=*/*",
      "--exclude=group-overview.md",
    ]
  });

  // Control/customization files
  await s3Sync({
    dryRun,
    group,
    prefix: "",
    filters: [
      "--exclude=*",
      "--include=group-overview.md",
      "--include=group-logo.png",
    ]
  });

  // Discover files to consider for manual review
  const unsynced = (await s3ListObjects({group})).filter(
    key => !(key.endsWith(".json") && !key.includes("/"))
        && !(key.endsWith(".md") && !key.includes("/"))
        && key !== "group-overview.md"
        && key !== "group-logo.png"
  );

  console.groupEnd();

  return unsynced.map(key => `Investigate unsynced object s3://${group.bucket}/${key}`);
}


async function s3Sync({dryRun = true, group, prefix = "", filters = []}) {
  const argv = [
    "aws", "s3", "sync",
    ...(dryRun
      ? ["--dryrun"]
      : []),
    "--delete",
    `s3://${group.bucket}/`,
    `s3://nextstrain-groups/${group.name}/${prefix}`,
    ...filters,
  ];
  console.group(`\nRunning ${argv.join(" ")}`);
  await run(argv);
  console.groupEnd();
}


async function s3ListObjects({group}) {
  const client = new S3.S3Client();

  return await collate(
    S3.paginateListObjectsV2({client}, {Bucket: group.bucket}),
    page => (page.Contents ?? []).map(object => object.Key),
  );
}


async function updateServerPolicies({dryRun = true, oldBucket}) {
  const policyFiles = [
    "aws/iam/policy/NextstrainDotOrgServerInstance.json",
    "aws/iam/policy/NextstrainDotOrgServerInstanceDev.json",
  ];

  const updatedFiles = await updatePolicyFiles({dryRun, policyFiles, oldBucket});

  return await syncPoliciesTodo({dryRun, policyFiles: updatedFiles});
}


async function updatePolicyFiles({dryRun = true, policyFiles, oldBucket}) {
  const oldBucketArn = `arn:aws:s3:::${oldBucket}`;

  console.group(`\nRemoving ${oldBucketArn} resources from local policy files`);

  const updatedFiles = [];

  for (const policyFile of policyFiles) {
    console.group(`\n${policyFile}`);

    const policy = readJSON(policyFile);
    const newPolicy = {
      ...policy,
      Statement: policy.Statement.map(statement => ({
        ...statement,
        Resource: statement.Resource.filter(resource =>
          resource !== oldBucketArn && !resource.startsWith(`${oldBucketArn}/`)
        ),
      }))
    };

    if (dryRun) {
      const tmpDir = tempdir();
      const tmpFile = `${tmpDir}/${basename(policyFile)}`;

      writeJSON(tmpFile, newPolicy);
      updatedFiles.push(tmpFile);

      await diff(policyFile, tmpFile);
    } else {
      writeJSON(policyFile, newPolicy);
      updatedFiles.push(policyFile);

      await diff(policyFile);
    }

    console.groupEnd();
  }

  console.groupEnd();
  return updatedFiles;
}


async function syncPoliciesTodo({dryRun = true, policyFiles}) {
  const policyNames = policyFiles.map(file => parsePath(file).name);
  const argv = [
    "terraform",
    ...(dryRun
      ? ["plan"]
      : ["apply"]),
  ];
  return `After deploy completes, update the IAM policies (${policyNames.join(", ")}) by running: \`${argv.join(" ")}\``;
}


async function updateBucketPolicies({dryRun = true, oldBucket}) {
  const s3 = new S3.S3Client();

  console.group(`\nUpdating bucket access policies`);

  const deleteBucketPolicy = new S3.DeleteBucketPolicyCommand({
    Bucket: oldBucket,
    ExpectedBucketOwner: AWS_ACCOUNT_ID,
  });

  const putPublicAccessBlock = new S3.PutPublicAccessBlockCommand({
    Bucket: oldBucket,
    ExpectedBucketOwner: AWS_ACCOUNT_ID,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    },
  });

  console.log("Deleting bucket policy");
  if (!dryRun) await s3.send(deleteBucketPolicy);

  console.log("Blocking public access");
  if (!dryRun) await s3.send(putPublicAccessBlock);

  console.groupEnd();
}


async function deleteIAMResources({dryRun = true, group}) {
  console.group("\nDiscovering IAM resources…");

  const iam = new IAM.IAMClient();

  // Names used for IAM groups and IAM users associated with a Nextstrain Group
  const potentialNames = new Set([
    group.bucket,
    `nextstrain-${group.name.toLowerCase()}`,
  ]);

  const iamGroup = await findIAMGroup(iam, potentialNames);

  if (!iamGroup) {
    console.warn(`Unable to find IAM group matching any of: ${Array.from(potentialNames.values()).join(" ")}`);
    return [`Review AWS Console for IAM groups, users, and policies associated with ${group.name}`];
  }

  const todo = [];

  console.log(`Found IAM group ${iamGroup.GroupName}`);

  /* Users
   */
  console.group("Removing members:");

  for (const {UserName: username} of iamGroup.Members) {
    const marked = potentialNames.has(username);
    console.log(`- ${username}${marked ? " [suggested for manual deletion]" : ""}`);
    if (marked) {
      todo.push(`Delete IAM user [${username}](https://console.aws.amazon.com/iam/home#/users/${username})`);
    }

    if (!dryRun) await iam.send(new IAM.RemoveUserFromGroupCommand({GroupName: iamGroup.GroupName, UserName: username}));
  }
  console.groupEnd();

  /* Policies
   */
  const attachedPolicies = await listIAMAttachedGroupPolicies(iam, iamGroup.GroupName);

  console.group("Detaching policies:");

  for (const {name, arn} of attachedPolicies) {
    const marked = name !== "SeeCloudFrontDistributions";
    console.log(`- ${name}${marked ? " [suggested for manual deletion]" : ""}`);
    if (marked) {
      todo.push(`Delete IAM policy [${name}](https://console.aws.amazon.com/iam/home#/policies/${arn})`);
    }

    if (!dryRun) await iam.send(new IAM.DetachGroupPolicyCommand({GroupName: iamGroup.GroupName, PolicyArn: arn}));
  }
  console.groupEnd();

  console.log(`Deleting IAM group ${iamGroup.GroupName}`);
  if (!dryRun) await iam.send(new IAM.DeleteGroupCommand({GroupName: iamGroup.GroupName}));

  console.groupEnd();

  return todo;
}


async function findIAMGroup(client, potentialNames) {
  const groups = await listIAMGroups(client);
  const candidateGroups = groups.filter(g => potentialNames.has(g));

  if (candidateGroups.length < 1) return null;
  if (candidateGroups.length > 1) throw new Error(`found more than one candidate IAM group: ${candidateGroups.join(" ")}`);

  return await getIAMGroup(client, candidateGroups[0]);
}


async function listIAMGroups(client) {
  return await collateGroupNames(IAM.paginateListGroups({client}, {}));
}


async function listIAMAttachedGroupPolicies(client, GroupName) {
  return await collate(
    IAM.paginateListAttachedGroupPolicies({client}, {GroupName}),
    page => page.AttachedPolicies.map(p => ({name: p.PolicyName, arn: p.PolicyArn})),
  );
}


async function collateGroupNames(paginator) {
  return await collate(paginator, page => page.Groups.map(g => g.GroupName));
}


async function collate(paginator, xform = page => page) {
  let collated = [];

  for await (const page of paginator) {
    collated = collated.concat(xform(page));
  }
  return collated;
}


async function getIAMGroup(client, GroupName) {
  let group = {};

  for await (const page of IAM.paginateGetGroup({client}, {GroupName})) {
    group = {
      ...group,
      ...page.Group,
      Members: [
        ...(group.Members || []),
        ...page.Users,
      ],
    };
  }
  return group;
}


async function updateGroupsDataFile({dryRun = true, group}) {
  const dataFile = `${REPO}/data/groups.json`;

  console.group(`\nRemoving group's "bucket" key from ${dataFile}`);

  const newData = readJSON(dataFile).map(g => {
    if (g.name === group.name) delete g.bucket;
    return g;
  });

  if (dryRun) {
    const tmpFile = `${tempdir()}/${basename(dataFile)}`;
    writeJSON(tmpFile, newData);
    await diff(dataFile, tmpFile);
  } else {
    writeJSON(dataFile, newData);
    await diff(dataFile);
  }
  console.groupEnd();
}


/**
 * Run `git diff` with the given arguments.
 *
 * @returns {Promise<boolean>} true if differences were reported; false if not.
 */
/* eslint-disable-next-line consistent-return */
async function diff(...args) {
  try {
    await run(["git", "diff", ...args]);
  } catch (error) {
    switch (error.code) {
      case 0: // files are the same
      case 1: // files are different
        return error.code === 1;

      default:
        throw error;
    }
  }
}


/**
 * Read file at *path* as JSON.
 *
 * @param {string} path
 */
function readJSON(path) {
  return JSON.parse(fs.readFileSync(path));
}

/**
 * Write *data* to file at *path* as JSON.
 *
 * @param {string} path
 * @param {*} data
 */
function writeJSON(path, data) {
  return fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}


/**
 * Create a temporary directory which will be cleaned up upon process exit.
 */
function tempdir() {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/migrate-group-`);
  process.on("exit", () => fs.rmSync(dir, {recursive: true}));
  return dir;
}


reportUnhandledRejectionsAtExit();
main(parseArgs());
