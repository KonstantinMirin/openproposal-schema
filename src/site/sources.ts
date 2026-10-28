/**
 * What the site shows for an IR element: a readable label, such as "§ 5.10,
 * the `billing` row's description: the inline object", the element's quote,
 * and links to its lines in the specification on GitHub.
 *
 * On a lock whose commit is on GitHub, such as `main`, a link opens the
 * lines at the lock's commit, as the feedback's permalinks do. A lock that
 * merges open PRs has a commit only a local clone holds, so its links follow
 * the line provenance `npm run provenance` writes (src/provenance.ts): each
 * line opens where its PR, or `main`, wrote it, and a line the integration
 * wrote has no link.
 */
import { citeText, type Element } from "../elements.ts";
import { permalink } from "../feedback.ts";
import type { SpecLock } from "../lock.ts";
import type { ProvenanceDoc } from "../provenance.ts";

export interface SourceLink {
  href: string;
  text: string;
}

export interface SourceInfo {
  label: string;
  quote: string;
  /** The first and last line of the element in the lock's specification. */
  lines: [number, number];
  links: SourceLink[];
  /** Why a line has no link, where one doesn't. */
  note?: string;
}

const code = (s: string) => `\`${s}\``;
const ordinal = (n: string) => (n === "1" ? "" : ` ${n}`);

/**
 * The section's name as a reader cites it: `§ 5.10`, the front matter, or an
 * appendix. A section whose ID is the anchor its heading writes, as
 * `list_devicetypes`, is cited by its heading, as "List: Device Types",
 * where `titleOf` knows it.
 */
function sectionLabel(section: string, titleOf?: (section: string) => string | undefined): string {
  if (section === "front") return "The front matter";
  const numbered = /^[0-9A-Z][0-9.]*(\/|$)/.test(section);
  const title = numbered ? undefined : titleOf?.(section);
  return title !== undefined ? title : `§ ${section}`;
}

/** What a fragment of an ID names, such as `#description/object:1` for "'s description: the inline object". */
function fragmentLabel(fragment: string): string {
  const [part, ...rest] = fragment.split("/");
  let out = part === "description" ? "'s description" : part === "meaning" ? "'s meaning" : part ? `'s ${part}` : "";
  const sub = rest.join("/");
  const m = /^(object|values|identifiers):(\d+)(?:\/(.+))?$/.exec(sub);
  if (m) {
    const [, kind, n, member] = m;
    const what = kind === "object" ? `the inline object${ordinal(n!)}` : kind === "values" ? `the value list${ordinal(n!)}` : `the list of identifiers${ordinal(n!)}`;
    out += `: ${what}${member ? `'s ${code(member)} values` : ""}`;
  }
  return out;
}

/** A readable label for an IR element's ID, such as "§ 5.6.1, the `commitment.flight_start` key row". */
export function elementLabel(id: string, titleOf?: (section: string) => string | undefined): string {
  const [kind, section, ...restParts] = id.split(":");
  const rest = restParts.join(":");
  if (kind === "appendix-a") return `Appendix A, row ${section}`;
  if (kind === "appendix-b") return `Appendix B, the ${code(section!)} row`;
  const [head, fragment] = rest.split("#");
  const where = sectionLabel(section!, titleOf);
  switch (kind) {
    case "field":
      return `${where}, the ${head!.split(",").map(code).join(" and ")} row${fragment ? fragmentLabel(fragment) : ""}`;
    case "key":
      return `${where}, the ${code(head!)} key row${fragment ? fragmentLabel(fragment) : ""}`;
    case "def": {
      // A value of a field, as `def:5.4:channel.display`; a code of a list, which names no field, as `def:list_devicetypes:3`.
      const dot = head!.lastIndexOf(".");
      return dot < 0 ? `${where}, the row of ${code(head!)}` : `${where}, the definition of ${code(head!.slice(dot + 1))} for ${code(head!.slice(0, dot))}`;
    }
    case "marker":
      return `${where}, the ${code(head!)} marker row`;
    case "concept":
      return `${where}, concept row ${head}`;
    case "rule":
      return `${where}, a requirement`;
    case "sentence":
      return `${where}, a sentence`;
    case "code":
      return `${where}, code block ${head}`;
    case "block": {
      const [n, ...sub] = head!.split("/");
      const s = sub.join("/");
      return `${where}, paragraph ${n}${s ? fragmentLabel(`/${s}`).replace(/^: /, ": ") : ""}`;
    }
    default:
      return `${where}, ${id}`;
  }
}

/** The element's first and last line in the specification: a code block spans its fences, and every other element one line. */
export function elementLines(e: Element): [number, number] {
  const loc = (e.element as { loc?: { line: number } }).loc;
  const line = loc?.line ?? (e.element as { line?: number }).line ?? 1;
  if (e.kind === "code_block") return [line, line + e.element.text.split("\n").length + 1];
  return [line, line];
}

const range = (a: number, b: number) => (a === b ? `L${a}` : `L${a}-L${b}`);

/** An element's label, quote, lines, and links on a lock. */
export function sourceInfo(lock: SpecLock, provenance: ProvenanceDoc | null, id: string, e: Element, titleOf?: (section: string) => string | undefined): SourceInfo {
  const lines = elementLines(e);
  const base = { label: elementLabel(id, titleOf), quote: citeText(e), lines };
  if (lock.merge_order === null) {
    const href = permalink(lock, lines[0]).replace(/#L\d+$/, `#${range(lines[0], lines[1])}`);
    return { ...base, links: [{ href, text: `${range(lines[0], lines[1])} at ${lock.commit.slice(0, 7)}` }] };
  }
  if (provenance === null) return { ...base, links: [], note: "This input's commit isn't on GitHub, and no line provenance is recorded for it." };
  // Group the element's lines by where they come from, keeping each run of consecutive lines from one commit.
  const links: SourceLink[] = [];
  let unlinked = false;
  let run: { pr: number | null; commit: string; path: string; from: number; to: number } | null = null;
  const flush = () => {
    if (!run) return;
    const href = `${lock.upstream}/blob/${run.commit}/${run.path}?plain=1#${range(run.from, run.to)}`;
    links.push({ href, text: `${range(run.from, run.to)} ${run.pr === null ? `on main at ${run.commit.slice(0, 7)}` : `in #${run.pr}`}` });
    run = null;
  };
  for (let n = lines[0]; n <= lines[1]; n++) {
    const o = provenance.lines[n - 1];
    if (!o) {
      flush();
      unlinked = true;
      continue;
    }
    if (run && run.commit === o.commit && run.path === o.path && o.line === run.to + 1) run.to = o.line;
    else {
      flush();
      run = { pr: o.pr, commit: o.commit, path: o.path, from: o.line, to: o.line };
    }
  }
  flush();
  return { ...base, links, ...(unlinked ? { note: "The integration of the open PRs wrote this text, to resolve a conflict or as its lock records, so no commit on GitHub holds it." } : {}) };
}

/** The PRs whose lines an element's links name, for a link to each PR. */
export const prsOf = (s: SourceInfo): number[] => [...new Set(s.links.flatMap((l) => (/in #(\d+)$/.exec(l.text) ? [Number(/in #(\d+)$/.exec(l.text)![1])] : [])))];
