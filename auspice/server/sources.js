/* eslint-disable no-use-before-define */
const AWS = require("aws-sdk");
const fetch = require("node-fetch");
const queryString = require("query-string");
const {NoDatasetPathError, InvalidSourceImplementation} = require("./exceptions");
const utils = require("./utils");

const S3 = new AWS.S3();

/* These Source, Dataset, and Narrative classes contain information to map an
 * array of dataset/narrative path parts onto a URL.  Source selection and
 * dataset path aliasing (/flu → /flu/seasonal/h3n2/ha/3y) is handled in
 * getDatasetHelpers.parsePrefix().
 *
 * The class definitions would be a bit shorter/prettier if we were using Babel
 * to allow class properties on Node.
 */

class Source {
  static get _name() {
    throw InvalidSourceImplementation("_name() must be implemented by subclasses");
  }
  get name() {
    return this.constructor._name;
  }
  get baseUrl() {
    throw InvalidSourceImplementation("baseUrl() must be implemented by subclasses");
  }
  dataset(pathParts) {
    return new Dataset(this, pathParts);
  }
  narrative(pathParts) {
    return new Narrative(this, pathParts);
  }
  availableDatasets() {
    return [];
  }
  availableNarratives() {
    return [];
  }

  /* Static access control for this entire source, regardless of any
   * instance-specific parameters.
   */
  static visibleToUser(user) { // eslint-disable-line no-unused-vars
    return true;
  }

  /* Instance-specific access control delegates to the static method by
   * default.
   */
  visibleToUser(user) {
    return this.constructor.visibleToUser(user);
  }
}

class Dataset {
  constructor(source, pathParts) {
    this.source = source;
    this.pathParts = pathParts;

    // Require baseParts, otherwise we have no actual dataset path.  This
    // inspects baseParts because some of the pathParts (above) may not apply,
    // which each Dataset subclass determines for itself.
    if (!this.baseParts.length) {
      throw new NoDatasetPathError();
    }
  }
  get baseParts() {
    return this.pathParts.slice();
  }
  baseNameFor(type) {
    const baseName = this.baseParts.join("_");
    return type === "main"
      ? `${baseName}.json`
      : `${baseName}_${type}.json`;
  }
  urlFor(type) {
    const url = new URL(this.baseNameFor(type), this.source.baseUrl);
    return url.toString();
  }
  get isRequestValidWithoutDataset() {
    return false;
  }
}

class Narrative {
  constructor(source, pathParts) {
    this.source = source;
    this.pathParts = pathParts;
  }
  get baseParts() {
    return this.pathParts.slice();
  }
  get baseName() {
    const baseName = this.baseParts.join("_");
    return `${baseName}.md`;
  }
  url() {
    const url = new URL(this.baseName, this.source.baseUrl);
    return url.toString();
  }
}

class CoreSource extends Source {
  static get _name() { return "core"; }
  get baseUrl() { return "http://data.nextstrain.org/"; }
  get repo() { return "nextstrain/narratives"; }
  get branch() { return "master"; }

  narrative(pathParts) {
    return new CoreNarrative(this, pathParts);
  }

  // The computation of these globals should move here.
  availableDatasets() {
    return global.availableDatasets[this.name] || [];
  }

  async availableNarratives() {
    const qs = queryString.stringify({ref: this.branch});
    const response = await fetch(`https://api.github.com/repos/${this.repo}/contents?${qs}`);

    if (!response.ok) {
      utils.warn(`Error fetching available narratives from GitHub for source ${this.name}`);
      return [];
    }

    const files = await response.json();
    return files
      .filter((file) => file.type === "file")
      .filter((file) => file.name !== "README.md")
      .filter((file) => file.name.endsWith(".md"))
      .map((file) => file.name
        .replace(/[.]md$/, "")
        .split("_")
        .join("/"));
  }
}

class CoreStagingSource extends CoreSource {
  static get _name() { return "staging"; }
  get baseUrl() { return "http://staging.nextstrain.org/"; }
  get repo() { return "nextstrain/narratives"; }
  get branch() { return "staging"; }
}

class CoreNarrative extends Narrative {
  url() {
    const repoBaseUrl = `https://raw.githubusercontent.com/${this.source.repo}/${this.source.branch}/`;
    const url = new URL(this.baseName, repoBaseUrl);
    return url.toString();
  }
}

class CommunitySource extends Source {
  constructor(owner, repoName) {
    super();

    // The GitHub owner and repo names are required.
    if (!owner) throw new Error(`Cannot construct a ${this.constructor.name} without an owner`);
    if (!repoName) throw new Error(`Cannot construct a ${this.constructor.name} without an repoName`);

    this.owner = owner;
    this.repoName = repoName;
  }

  static get _name() { return "community"; }
  get repo() { return `${this.owner}/${this.repoName}`; }
  get branch() { return "master"; }
  get baseUrl() { return `https://raw.githubusercontent.com/${this.repo}/${this.branch}/`; }

  dataset(pathParts) {
    return new CommunityDataset(this, pathParts);
  }
  narrative(pathParts) {
    return new CommunityNarrative(this, pathParts);
  }

  async availableDatasets() {
    const qs = queryString.stringify({ref: this.branch});
    const response = await fetch(`https://api.github.com/repos/${this.repo}/contents/auspice?${qs}`);

    if (!response.ok) {
      utils.warn(`Error fetching available datasets from GitHub for source ${this.name}`);
      return [];
    }

    const files = await response.json();
    const jsonFiles = files
      .filter((file) => file.type === "file")
      .filter((file) => file.name.endsWith(".json"))
      .filter((file) => file.name.startsWith(this.repoName))
      .map((file) => file.name);

    const sidecarSuffixes = ["meta", "tree", "root-sequence", "seq", "tip-frequencies"];
    const notSidecar = (filename) =>
      !sidecarSuffixes.some((suffix) => filename.endsWith(`_${suffix}.json`));

    // All JSON files which aren't a sidecar file with a known suffix.
    const v2 = jsonFiles
      .filter(notSidecar)
      .map((filename) => filename.replace(/[.]json$/, ""));

    // All *_meta.json files which have a corresponding *_tree.json.
    const v1 = jsonFiles
      .filter((filename) => filename.endsWith("_meta.json"))
      .filter((filename) => jsonFiles.includes(filename.replace(/_meta[.]json$/, "_tree.json")))
      .map((filename) => filename.replace(/_meta[.]json$/, ""));

    return Array.from(new Set([...v2, ...v1]))
      .map((filename) => filename
        .replace(this.repoName, "")
        .replace(/^_/, "")
        .split("_")
        .join("/"));
  }

  async availableNarratives() {
    const qs = queryString.stringify({ref: this.branch});
    const response = await fetch(`https://api.github.com/repos/${this.repo}/contents/narratives?${qs}`);

    if (!response.ok) {
      utils.warn(`Error fetching available narratives from GitHub for source ${this.name}`);
      return [];
    }

    const files = await response.json();
    return files
      .filter((file) => file.type === "file")
      .filter((file) => file.name !== "README.md")
      .filter((file) => file.name.endsWith(".md"))
      .filter((file) => file.name.startsWith(this.repoName))
      .map((file) => file.name
        .replace(this.repoName, "")
        .replace(/^_/, "")
        .replace(/[.]md$/, "")
        .split("_")
        .join("/"));
  }
  async getInfo() {
    /* could attempt to fetch a certain file from the repository if we want to implement
    this functionality in the future */
    return {
      title: `${this.owner}'s Nextstrain community builds for ${this.repoName}`,
      byline: "Nextstrain community builds source datasets from GitHub repositories, in this case" +
        ` https://github.com/${this.owner}/${this.repoName}. You can see the available datasets listed below :)`,
      showDatasets: true,
      showNarratives: true,
      /* avatar could be fetched here & sent in base64 or similar, or a link sent. The former (or similar) has the advantage
      of private S3 buckets working, else the client will have to make (a) an authenticated request (too much work)
      or (b) a subsequent request to nextstrain.org/charon (why not do it at once?) */
      avatar: `https://github.com/${this.owner}.png?size=200`
    };
  }
}

class CommunityDataset extends Dataset {
  get baseParts() {
    // We require datasets are in the auspice/ directory and include the repo
    // name in the file basename.
    return [`auspice/${this.source.repoName}`, ...this.pathParts];
  }
  get isRequestValidWithoutDataset() {
    if (!this.pathParts.length) {
      return true;
    }
    return false;
  }
}

class CommunityNarrative extends Narrative {
  get baseParts() {
    // We require narratives are in the narratives/ directory and include the
    // repo name in the file basename.
    return [`narratives/${this.source.repoName}`, ...this.pathParts];
  }
}

class S3Source extends Source {
  get bucket() {
    throw InvalidSourceImplementation("bucket() must be implemented by subclasses");
  }
  get baseUrl() {
    return `https://${this.bucket}.s3.amazonaws.com`;
  }
  async _listObjects() {
    // XXX TODO: This will only return the first 1000 objects.  That's fine for
    // now (for comparison, nextstrain-data only has ~500), but we really
    // should iterate over the whole bucket contents using the S3 client's
    // pagination support.
    //   -trs, 30 Aug 2019
    const list = await S3.listObjectsV2({Bucket: this.bucket}).promise();
    return list.Contents;
  }
  async availableDatasets() {
    // Walking logic borrowed from auspice's cli/server/getAvailable.js
    const objects = await this._listObjects();
    return objects
      .map((object) => object.Key)
      .filter((file) => file.endsWith("_tree.json"))
      .map((file) => file
        .replace(/_tree[.]json$/, "")
        .split("_")
        .join("/"));
  }
  async availableNarratives() {
    // Walking logic borrowed from auspice's cli/server/getAvailable.js
    const objects = await this._listObjects();
    return objects
      .map((object) => object.Key)
      .filter((file) => file.endsWith(".md"))
      .map((file) => file
        .replace(/[.]md$/, "")
        .split("_")
        .join("/"));
  }
  /**
   * Get information about a (particular) source.
   * The data could be a JSON, or a markdown with YAML frontmatter. Or something else.
   * This is very similar to our previous discussions around moving the auspice footer
   * content to the dataset JSON - it would be nice to allow links etc to be written in
   * the title/byline. One advantage of this being outside of the auspice codebase is that
   * we can iterate on it after pushing live to nextstrain.org
   */
  async getInfo() {
    try {
      /* attempt to fetch customisable information from S3 bucket */
      throw new Error();
    } catch (err) {
      /* Appropriate fallback if no customised data is available */
      return {
        title: `Nextstrain group page for ${this.bucket}`,
        byline: `The following are the available datasets & narratives for this nextstrain group:`,
        showDatasets: true,
        showNarratives: true
      };
    }
  }
}

class PrivateS3Source extends S3Source {
  dataset(pathParts) {
    return new PrivateS3Dataset(this, pathParts);
  }
  narrative(pathParts) {
    return new PrivateS3Narrative(this, pathParts);
  }
  static visibleToUser(user) { // eslint-disable-line no-unused-vars
    throw InvalidSourceImplementation("visibleToUser() must be implemented explicitly by subclasses (not inherited from PrivateS3Source)");
  }
}

class PrivateS3Dataset extends Dataset {
  urlFor(type) {
    return S3.getSignedUrl("getObject", {
      Bucket: this.source.bucket,
      Key: this.baseNameFor(type)
    });
  }
}

class PrivateS3Narrative extends Narrative {
  url() {
    return S3.getSignedUrl("getObject", {
      Bucket: this.source.bucket,
      Key: this.baseName
    });
  }
}

class PublicGroupSource extends S3Source {
  get bucket() { return `nextstrain-${this.name}`; }
}

class PrivateGroupSource extends PrivateS3Source {
  get bucket() { return `nextstrain-${this.name}`; }

  static visibleToUser(user) {
    return !!user && !!user.groups && user.groups.includes(this._name);
  }
}

class InrbDrcSource extends PrivateGroupSource {
  static get _name() { return "inrb-drc"; }

  // INRB's bucket is named differently due to early adoption
  get bucket() { return "nextstrain-inrb"; }
}

class SeattleFluSource extends PublicGroupSource {
  static get _name() { return "seattleflu"; }
}

const sources = [
  CoreSource,
  CoreStagingSource,
  CommunitySource,
  InrbDrcSource,
  SeattleFluSource,
];

const sourceMap = new Map(sources.map(s => [s._name, s]));
utils.verbose("Sources are:", sourceMap);

module.exports = sourceMap;
