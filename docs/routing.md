# URL Routing

Routing of URL paths for nextstrain.org is a bit complicated at the moment.
There are four primary sources of valid paths:

  1. Server-side routes in the Express app (`src/app.js`), which often respond
     with dynamic content.

  2. Auspice client-side routes, which are activated when
     `auspice-client/dist/index.html` is served.  Auspice changes the URL path
     when the dataset or narrative changes.

  3. Gatsby client-side routes, which are activated when any Gatsby HTML page
     is served from `static-site/public/`.  Gatsby changes the URL path when
     links between its pages are clicked and on page load to canonicalize the
     URL for a given page.

  4. Server-side static HTML tree generated by Gatsby (`static-site/public/`),
     primarily for assets and other behind-the-scenes resources Gatsby pages
     need.

Notably, these URL routers are all separate and largely do not know of each
other.  This means there can be some unexpected behaviour if routes clash,
particularly between the server-side and client-side routes.

## Server-side routes

The server-side routes try to adhere to some basic organizational principles:

  * Routes (e.g. `/charon/getDataset`) go in `src/app.js`.  The longer we can
    keep all (server-side) routes in one place, the better.

  * Endpoints ("route handlers", e.g. `charon.getDataset(req, res, next)`) live
    in `src/endpoints/`, grouped into arbitrary directories/files/modules as
    seems best for development.

  * The names in route paths and the endpoint source file paths do not
    necessarily need to match, although they may (as in the case of Charon).
    Routes are user-facing, endpoint source file paths are developer-facing.

  * There does not need to be a 1:1 correspondence between a single route and a
    single endpoint source file, although there may be (as in the case of
    Charon). For example, a single file `src/endpoints/groups.js` may define
    several endpoints used for several routes under `/groups/…`.