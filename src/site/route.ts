/**
 * The type map's router, `assets/route.js`, loaded in Node so the site's
 * check and its tests read addresses exactly as the browser does.
 */
import { runInNewContext } from "node:vm";
import type { VariantSlug } from "./data.ts";

export interface RouteState {
  type: string;
  lock: string;
  variant: string;
  view: string;
  open: string[];
}

export type Parsed = { route: false } | { route: true; state: RouteState; changes: string[] };

export interface MapRoute {
  LOCKS: string[];
  VARIANTS: string[];
  VIEWS: string[];
  DEFAULT: RouteState;
  PARAMS: Record<string, string>;
  VALUES: Record<"lock" | "variant" | "view", Record<string, string>>;
  parse(hash: string): Parsed;
  hashOf(s: RouteState): string;
  /** Where a reference across hosts opens, by the build's registry targets: the registry's page, null for none, or undefined for a reference within the spec's own schemas. */
  registryHref(registry: Record<string, { href: string }> | undefined, ref: string): string | null | undefined;
  /** Where a reference inside a registry's schema opens: the registry's page of a `#/$defs/<Name>`, or null. */
  registryInnerHref(target: { map: string; lock: string }, ref: string): string | null;
}

/** The router that `source`, the text of `assets/route.js`, defines. Its results are plain JSON values of this realm. */
export function loadRoute(source: string): MapRoute {
  const sandbox = { window: {} as { MapRoute?: MapRoute }, URLSearchParams };
  runInNewContext(source, sandbox);
  const r = sandbox.window.MapRoute;
  if (!r) throw new Error("assets/route.js defines no MapRoute");
  const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  return {
    ...plain({ LOCKS: r.LOCKS, VARIANTS: r.VARIANTS, VIEWS: r.VIEWS, DEFAULT: r.DEFAULT, PARAMS: r.PARAMS, VALUES: r.VALUES }),
    parse: (hash) => plain(r.parse(hash)),
    hashOf: (s) => r.hashOf(s),
    registryHref: (registry, ref) => r.registryHref(registry, ref),
    registryInnerHref: (target, ref) => r.registryInnerHref(target, ref),
  };
}

/** A link into the type map, at a type, on a lock, in a variant, in a view, with the composition's members `open` expanded; `base` leads from the linking page to the spec's folder. */
export const mapLink = (base: string, type: string, lock: string, variant: VariantSlug, view?: "schema" | "example", open?: string[]) =>
  `${base}map.html#!/type/${encodeURIComponent(type)}?lock=${lock}&variant=${variant}&view=${view ?? "schema"}${open && open.length > 0 ? `&open=${open.map(encodeURIComponent).join(",")}` : ""}`;
