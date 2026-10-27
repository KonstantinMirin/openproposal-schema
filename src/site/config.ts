/**
 * The public site's settings (`npm run site`, src/site/build.ts).
 */

import { SCHEMA_BASE } from "../emit.ts";

/** Where the site is served: the base of every schema's `$id`, so each schema file is served at its `$id`. */
export const SITE_URL = SCHEMA_BASE.replace(/\/$/, "");

/**
 * The public repository of this tooling. Each decision page links its
 * record's YAML file there. Set to "", the site leaves out every link into
 * the repository.
 */
export const PUBLIC_REPO_URL = "https://github.com/KonstantinMirin/openproposal-schema";

/** The issue the implementation feedback follows up on, and the supporting page it links. */
export const ISSUE_URL = "https://github.com/IABTechLab/OpenProposal/issues/121";
export const GIST_URL = "https://gist.github.com/KonstantinMirin/3c4439731aec62dc68f7bd7eb447bbd2";

/** Who publishes the site. */
export const PUBLISHER = "Postindustria";

/** Where the deploy script copies the site to, which it prints and never runs. */
export const DEPLOY = { host: "hetzner2", path: "/srv/www/openproposal" };

/**
 * The Content-Security-Policy every page declares in a `<meta>` element, and
 * the server should send as a header, with `frame-ancestors`, which a
 * `<meta>` element can't carry.
 */
export const CSP_META = "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
export const CSP_HEADER = `${CSP_META}; frame-ancestors 'none'`;
