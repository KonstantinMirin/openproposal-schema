import { DEPLOY } from "../site/config.ts";

/**
 * Usage: site:deploy
 *
 * Prints the command that copies the built site, `site/`, to the server.
 * It runs nothing: review the command, then run it yourself after
 * `npm run site`.
 */
console.log(`rsync -avz --delete --checksum site/ ${DEPLOY.host}:${DEPLOY.path}/`);
