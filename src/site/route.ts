/**
 * The type map's router, `assets/route.js`, loaded in Node so the site's
 * check and its tests read addresses exactly as the browser does.
 */
import { runInNewContext } from "node:vm";

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
  };
}
