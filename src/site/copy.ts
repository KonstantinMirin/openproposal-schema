/**
 * Each spec's own copy on the site: the pages whose text is about that one
 * specification, by the name of the plugin that reads it. The site's other
 * pages are the same for every spec, and its code names no specification, so
 * a spec's own words live with its plugin, under src/specs/<plugin>/.
 */
import { adcomSite } from "../specs/adcom/site.ts";
import { openproposalSite } from "../specs/openproposal/site.ts";
import type { SiteInputs } from "./data.ts";

export interface SiteCopy {
  /** The spec's landing page, `index.html` under its path: what the site is for this spec, framed honestly. */
  landing(inputs: SiteInputs): string;
  /** The spec's How it's built page, `how-it-is-built.html`. */
  method(inputs: SiteInputs): string;
  /** One or two sentences for the spec's card on the site's root page. */
  summary(inputs: SiteInputs): string;
  /** The type map's legend: what each layer holds, and the key for a type that another input adds. */
  mapLegend?(inputs: SiteInputs): { explain: string; added: string };
}

/** Each spec's site copy, by its plugin's name. */
export const SITE_COPY: Readonly<Record<string, SiteCopy>> = { adcom: adcomSite, openproposal: openproposalSite };

/** A spec's site copy. Throws when its plugin has none, since every spec on the site needs its own landing and How it's built pages. */
export function siteCopyOf(inputs: Pick<SiteInputs, "plugin" | "brand">): SiteCopy {
  const c = SITE_COPY[inputs.plugin];
  if (!c) throw new Error(`${inputs.brand.spec}: the plugin "${inputs.plugin}" has no site copy (src/site/copy.ts), so the site can't write its landing and How it's built pages`);
  return c;
}
