import { loadSiteConfig } from "../site/config.ts";

/**
 * Usage: site:deploy
 *
 * Prints the command that copies the built site, `site/`, to the server
 * specs/site.yaml names. It runs nothing: review the command, then run it
 * yourself after `npm run site`. The site links the public repository's
 * folders in place of downloads, and those paths exist there only after the
 * private tree is exported to it, so deploy only after an export.
 */
const site = loadSiteConfig();
console.log(`# Deploy only after the export to ${site.repo || "the public repository"} that publishes the paths the site links.`);
console.log(`rsync -avz --delete --checksum site/ ${site.deploy.host}:${site.deploy.path}/`);
