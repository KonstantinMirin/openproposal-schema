/**
 * The public site's settings (`npm run site`, src/site/build.ts): the site
 * itself, from `specs/site.yaml` (its host, publisher, repository, deploy
 * target, and the specs it lists), the names each spec's pages carry, from
 * the spec's profile (`names`, `site`, and `feedback`, src/profile.ts), and
 * the policy every page declares.
 */
import { join } from "node:path";
import { readYaml } from "../mapping.ts";
import { compileSchema } from "../pipeline.ts";
import type { LockNames, SiteProfile, SpecProfile } from "../profile.ts";
import { REPO_ROOT } from "../repo.ts";

/** The site as a whole: one host for every specification, each under `/<spec>/`. */
export interface SiteConfig {
  format: 1;
  /** The site's root URL, with its trailing slash. */
  url: string;
  /** The site's name in the header, and the root page's title. */
  name: string;
  title: string;
  /** The root page's opening paragraphs. */
  lead: string[];
  publisher: string;
  /** The public repository of this tooling; empty for none. */
  repo: string;
  deploy: { host: string; path: string };
  /** The specs the root lists, in order. */
  specs: string[];
  file: string;
}

export const SITE_CONFIG = join("specs", "site.yaml");
const SITE_SCHEMA = join("specs", "site.schema.json");

/** Loads `specs/site.yaml`. Throws when it is missing or invalid. */
export function loadSiteConfig(root: string = REPO_ROOT, file: string = join(root, SITE_CONFIG)): SiteConfig {
  const doc = readYaml(file);
  const errors = compileSchema(join(REPO_ROOT, SITE_SCHEMA))(doc);
  if (errors.length > 0) throw new Error(`${file}: not a valid site file: ${errors.join("; ")}`);
  return { ...(doc as Omit<SiteConfig, "file">), file };
}

/** What a spec's pages name: the specification, who publishes the site, and where its records and feedback live. */
export interface SiteBrand {
  /** The spec's folder name, which is its path on the site. */
  spec: string;
  /** The specification's name in prose, its edition, and the release the default lock pins. */
  short: string;
  edition: string;
  release: string;
  /** Who publishes the site. */
  publisher: string;
  /**
   * The public repository of this tooling. Each decision page links its
   * record's YAML file there, and the files page links the spec's folders.
   * Empty, the site leaves out every link into the repository.
   */
  repo: string;
  /** The issue the implementation feedback follows up on, its number, its `<owner>/<repo>#<number>` reference, and the supporting page; null for a spec with no feedback yet. */
  feedback: { issue: string; issueNumber: string; issueRef: string; gist: string } | null;
  /** The documents the field rows describe, in the profile's order. */
  documents: string[];
  /** The base of the spec's schema `$id`s, and the site's own root URL. */
  schemaBase: string;
  siteUrl: string;
  /** The type the type map opens at. */
  defaultType: string;
  /** The field the How it's built page follows, with its document, its IR element, and the build its links open. */
  example: SiteProfile["example"];
  /** The example document's owner in prose, as "line item". */
  exampleOwner: string;
  /** How the pages name each lock. */
  locks: Record<string, LockNames>;
  /** Whether the spec is a registry of code lists other specs cite, which gets a page of its lists and their citations. */
  registry: boolean;
}

/** A spec's site brand, from its profile and the site's settings. Throws when the profile gives no site. */
export function brandOf(p: SpecProfile, site: Pick<SiteConfig, "publisher" | "repo" | "url">): SiteBrand {
  if (!p.site) throw new Error(`${p.file}: gives no site, which the site's pages of the spec read`);
  const f = p.feedback;
  const m = f ? /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([0-9]+)$/.exec(f.issue)! : null;
  const example = p.site.example;
  return {
    spec: p.id,
    short: p.names.short,
    edition: p.names.edition,
    release: p.names.release,
    publisher: site.publisher,
    repo: site.repo,
    feedback: f && m ? { issue: f.issue, issueNumber: m[2]!, issueRef: `${m[1]}#${m[2]}`, gist: f.gist } : null,
    documents: (p.documents ?? []).map((d) => d.document),
    schemaBase: p.names.schema_base,
    siteUrl: site.url,
    defaultType: p.site.default_type,
    example,
    exampleOwner: example ? ((p.documents ?? []).find((d) => d.document === example.document)?.owner.replaceAll("_", " ") ?? example.document) : "",
    locks: p.site.locks ?? {},
    registry: p.site.registry === true,
  };
}

/** How the pages name a lock: as the profile says, or by its name. */
export const lockNames = (b: SiteBrand, lock: string): LockNames => b.locks[lock] ?? { label: lock, short: lock, where: `on ${lock}` };

/** The name the pages give the specification, with its edition, as in a page's title. */
export const named = (b: Pick<SiteBrand, "short" | "edition">): string => `${b.short} ${b.edition}`;

/**
 * The Content-Security-Policy every page declares in a `<meta>` element, and
 * the server should send as a header, with `frame-ancestors`, which a
 * `<meta>` element can't carry.
 */
export const CSP_META = "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
export const CSP_HEADER = `${CSP_META}; frame-ancestors 'none'`;
