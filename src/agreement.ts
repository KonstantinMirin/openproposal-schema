/**
 * The registry agreement (plan § 5.2): every spec on this site agrees with
 * the registries of code lists the site holds, as AdCOM's, wherever it cites
 * one. For each lock of a spec that isn't a registry itself:
 *
 * 1. every list its IR or text cites, as "List: Device Types" or a link to
 *    the list's anchor, is a list with codes that a registry the spec's
 *    profile imports titles at the lock the spec pins; a citation of a
 *    registry the spec doesn't import fails;
 * 2. every vocabulary of a registry's list is a `$ref` to the registry's
 *    vocabulary, no emitted schema holds the codes of a registry's list in
 *    an enum or in const branches, and the kernel's lists copy none;
 * 3. every vocabulary of such a list holds the registry's codes, with its
 *    labels, and every code the text restates beside a label of a list it
 *    cites, as "MRAID 3.0 (6)" or a device table's "Connected TV (3)", is
 *    the code the registry gives that label;
 * 4. the spec pins each registry once, at a lock the registry has, and no
 *    two specs pin one registry at different locks;
 * 5. every link into a registry's text is at the commit the pinned lock
 *    names, and names a section the registry has, by its anchor or by the
 *    slug GitHub gives its heading as written.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import GithubSlugger from "github-slugger";
import { allLocks } from "./builds.ts";
import type { EmittedFile } from "./emit.ts";
import { snapshotOf } from "./fetch.ts";
import { importedLists, type ImportAllowance } from "./imports.ts";
import type { SpecIR } from "./ir-types.ts";
import { loadLists, type ExternalList } from "./lists.ts";
import { repoRoot, type SpecLock } from "./lock.ts";
import type { ModelDoc } from "./model.ts";
import { loadDecisions, stands } from "./mapping.ts";
import { loadProfile } from "./profile.ts";
import { REPO_ROOT, specRoot } from "./repo.ts";

/** One registry spec as the agreement reads it, at the lock a spec pins, or, for a registry the spec doesn't import, at its first. */
export interface AgreementRegistry {
  spec: string;
  lock: string;
  /** Whether the spec's profile imports it. */
  imported: boolean;
  commit: string;
  locks: string[];
  lists: ExternalList[];
  /** Each section: its ID, its title, and the slug GitHub gives its heading as the text writes it. */
  sections: { id: string; title: string; slug: string }[];
  upstream: string;
  path: string;
}

/** What the agreement reads of one lock of a spec. */
export interface AgreementInput {
  spec: string;
  lock: string;
  ir: SpecIR;
  model: ModelDoc;
  files: EmittedFile[];
  /** The lock's specification text, line by line. */
  text: string[];
  /** The kernel's own lists, `kernel/lists.yaml`, which copy no registry's list. */
  kernelLists: ExternalList[];
  registries: AgreementRegistry[];
  /** Every spec on this site that imports a registry, with the lock it pins. */
  pins: { spec: string; registry: string; lock: string }[];
  /** The citations of each imported registry that the spec's profile reads as a decision record says (`ImportAllowance`). */
  allowances?: (ImportAllowance & { registry: string })[];
  /** The spec's decision records: whether each stands, and the IR elements it covers, each with the locks it is on, or none for every lock. */
  decisions?: { id: string; stands: boolean; covers: { ir: string; locks?: string[] }[] }[];
}

/** Every string of an IR, with where it is. */
function* texts(o: unknown, at = ""): Generator<[string, string]> {
  if (typeof o === "string") yield [at, o];
  else if (Array.isArray(o)) for (const [i, v] of o.entries()) yield* texts(v, `${at}/${i}`);
  else if (o !== null && typeof o === "object") for (const [k, v] of Object.entries(o)) if (k !== "markdown" && k !== "digest") yield* texts(v, `${at}/${k}`);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (s: string) => s.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/** The slug GitHub gives a heading line as the text writes it: its words, its runs of spaces, and the space before an anchor tag kept. */
export function headingSlug(line: string): string {
  return new GithubSlugger().slug(line.replace(/^\s*#{1,6}\s/, "").replace(/<[^>]*>/g, ""));
}

/** The problems of a lock's agreement with the registries on this site; empty when it agrees. */
export function checkAgreement(i: AgreementInput): string[] {
  const problems: string[] = [];
  const where = `${i.spec}/${i.lock}`;
  // The IR elements a place holds: the element an IR path runs through, or every element of a text line.
  const elementsAt = (at: string): string[] => {
    const line = /^line (\d+)$/.exec(at);
    if (line) {
      const n = Number(line[1]);
      return Object.values(i.ir).flatMap((v) => (Array.isArray(v) ? v.flatMap((e) => (e !== null && typeof e === "object" && (e as { loc?: { line?: number } }).loc?.line === n && typeof (e as { id?: unknown }).id === "string" ? [(e as { id: string }).id] : [])) : []));
    }
    let node: unknown = i.ir;
    let id: string | null = null;
    for (const k of at.split("/").filter((x) => x !== "")) {
      if (node === null || typeof node !== "object") break;
      node = (node as Record<string, unknown>)[k];
      if (node !== null && typeof node === "object" && typeof (node as { id?: unknown }).id === "string") id = (node as { id: string }).id;
    }
    return id === null ? [] : [id];
  };
  // An allowance excuses a citation only where its decision stands and covers an element at the citation's place.
  const used = new Set<ImportAllowance>();
  // A variant's build is labeled by its lock, as "main (as-written)".
  const lock = i.lock.split(" ")[0]!;
  const onLock = (a: ImportAllowance) => a.locks === undefined || a.locks.includes(lock);
  const allowed = (a: ImportAllowance, at: string): boolean => {
    const d = (i.decisions ?? []).find((x) => x.id === a.decision);
    return onLock(a) && d !== undefined && d.stands && elementsAt(at).some((e) => d.covers.some((c) => c.ir === e && (c.locks === undefined || c.locks.includes(lock))));
  };
  for (const a of i.allowances ?? []) {
    const d = (i.decisions ?? []).find((x) => x.id === a.decision);
    if (!d) problems.push(`${i.spec}: an allowance for ${a.registry} cites ${a.decision}, which has no decision record`);
    else if (!d.stands) problems.push(`${i.spec}: an allowance for ${a.registry} cites ${a.decision}, which no longer stands`);
  }
  const imported = i.registries.filter((r) => r.imported);
  // 4. One pin per registry, at a lock it has, the same across specs.
  for (const r of imported) {
    const mine = i.pins.filter((p) => p.spec === i.spec && p.registry === r.spec);
    if (mine.length !== 1) problems.push(`${i.spec}: pins ${r.spec} ${mine.length} times (${mine.map((p) => p.lock).join(", ")}); a spec pins each registry once`);
    if (!r.locks.includes(r.lock)) problems.push(`${i.spec}: pins ${r.spec} at "${r.lock}", which ${r.spec} has no lock named`);
    for (const o of i.pins.filter((p) => p.registry === r.spec && p.spec !== i.spec && p.lock !== r.lock)) problems.push(`${i.spec} pins ${r.spec} at "${r.lock}", and ${o.spec} at "${o.lock}"; every spec pins one lock of a registry`);
  }
  const lists = i.registries.flatMap((r) => r.lists.map((l) => ({ r, l })));
  const titled = i.registries.flatMap((r) => r.sections.flatMap((s) => (/^List:\s*/i.test(s.title) ? [{ r, title: s.title.replace(/\s+/g, " ").trim() }] : [])));
  const byLength = [...titled].sort((a, b) => b.title.length - a.title.length);
  const cited = new Map<string, { r: AgreementRegistry; l: ExternalList }>();
  const cite = (at: string, rest: string) => {
    const flat = rest.replace(/\s+/g, " ");
    let hit = byLength.find((t) => new RegExp(`^${escapeRe(t.title)}(?![A-Za-z0-9/-])`, "i").test(flat));
    // A citation the registry titles otherwise, as "List: Device Type" or a link's "List: [Device Type]", is the list a decision reads it as.
    if (!hit) {
      const unbracketed = flat.replace(/\[([^\]]*)\](\([^)]*\))?/g, "$1");
      const a = (i.allowances ?? []).find((x): x is ImportAllowance & { cites: string; means: string; registry: string } => "cites" in x && new RegExp(`^${escapeRe(x.cites)}(?![A-Za-z0-9/-])`, "i").test(unbracketed) && allowed(x, at));
      if (a) {
        used.add(a);
        hit = titled.find((t) => t.r.spec === a.registry && t.title.toLowerCase() === a.means.toLowerCase());
        if (!hit) return problems.push(`${where}: ${at} cites "${a.cites}", which ${a.decision} reads as ${a.means}, and ${a.registry} titles no such list`);
      }
    }
    if (!hit) return problems.push(`${where}: ${at} cites "${/^List:\s*.+?(?=\s+(?:in|and|or|that|for|respectively|each|which|from|of)\b|[.;,()]|$)/i.exec(flat)?.[0]?.trim() ?? flat.slice(0, 40)}", which no registry on this site titles`);
    if (!hit.r.imported) return problems.push(`${where}: ${at} cites ${hit.title} of ${hit.r.spec}, a registry its profile doesn't import`);
    const list = lists.find((x) => x.r === hit.r && x.l.name.toLowerCase() === hit.title.toLowerCase());
    if (!list) return problems.push(`${where}: ${at} cites ${hit.title}, which ${hit.r.spec} at ${hit.r.lock} titles with no codes`);
    cited.set(list.l.name, list);
  };
  // 1. Each citation, in the IR and in the text, names a list with codes of a registry the spec imports.
  for (const [at, s] of texts(i.ir)) for (const m of s.matchAll(/\bList:\s*(?=\S)/gi)) cite(at, s.slice(m.index));
  i.text.forEach((line, n) => {
    const joined = `${line} ${i.text[n + 1] ?? ""}`;
    for (const m of joined.matchAll(/\bList:\s*(?=\S)/gi)) if (m.index < line.length) cite(`line ${n + 1}`, joined.slice(m.index));
  });
  // 5. Each link into a registry's text is at the pinned commit and names a section of it.
  for (const r of i.registries) {
    const anchors = new Set(r.sections.flatMap((s) => [s.id, s.slug]));
    const page = new RegExp(`${escapeRe(r.upstream)}/blob/([^/#)\\s]+)/${escapeRe(r.path.split("/").map(encodeURIComponent).join("/"))}#([^)\\s"'>]+)`, "gi");
    i.text.forEach((line, n) => {
      for (const m of line.matchAll(page)) {
        let anchor: string;
        try {
          anchor = decodeURIComponent(m[2]!);
        } catch {
          anchor = m[2]!;
        }
        if (!r.imported) problems.push(`${where}: line ${n + 1} links ${r.spec}'s text, a registry its profile doesn't import`);
        else if (!(r.commit.startsWith(m[1]!) && m[1]!.length >= 7)) {
          const a = (i.allowances ?? []).find((x) => "links_at" in x && x.registry === r.spec && x.links_at === m[1] && allowed(x, `line ${n + 1}`));
          if (a) used.add(a);
          else problems.push(`${where}: line ${n + 1} links ${r.spec}'s text at ${m[1]}, not at ${r.commit.slice(0, 7)}, the commit of the lock "${r.lock}" the spec pins`);
        }
        if (!anchors.has(anchor)) problems.push(`${where}: line ${n + 1} links ${r.spec}'s text at #${m[2]}, which names no section of it`);
        const s = r.sections.find((x) => x.id === anchor || x.slug === anchor);
        const list = s && lists.find((x) => x.r === r && x.l.name.toLowerCase() === s.title.replace(/\s+/g, " ").trim().toLowerCase());
        if (list && r.imported) cited.set(list.l.name, list);
      }
    });
  }
  // 3. Each code the text restates beside a label of a list it cites is the code the registry gives that label. A label is read only where it is
  // exactly a code's label, as written before the code; a phrase that isn't one is a restatement only among others that are, as a "such as" list.
  // A label is a code's whole label, or its name before a dash or a colon, as "Continuous Playback - Media playback is set to …" names "Continuous Playback".
  const short = (label: string) => /^(.+?)(?:\s+-\s+|:\s)/.exec(label)?.[1];
  const labels = [...cited.values()]
    .flatMap(({ l }) => l.codes.flatMap((c) => [norm(c.label ?? ""), ...(short(c.label ?? "") ? [norm(short(c.label ?? "")!)] : [])].map((label) => ({ l, code: c.code, label }))))
    .filter((x) => x.label !== "")
    .sort((a, b) => b.label.length - a.label.length);
  const restated = (at: string, s: string) => {
    const items = [...s.matchAll(/\((\d+)\)/g)].map((m) => {
      const before = norm(s.slice(0, m.index));
      const n = Number(m[1]);
      const hits = labels.filter((x) => before === x.label || before.endsWith(` ${x.label}`) || before.endsWith(`(${x.label}`));
      return { n, before, hits };
    });
    const named = items.filter((x) => x.hits.length > 0);
    for (const x of named) {
      if (x.hits.some((h) => Number(h.code) === x.n)) continue;
      const h = x.hits[0]!;
      const held = h.l.codes.some((c) => Number(c.code) === x.n);
      problems.push(`${where}: ${at} restates ${h.l.name}'s "${h.label}" as code ${x.n}, where the registry gives it ${h.code}${held ? "" : `, and holds no code ${x.n}`}`);
    }
    // A phrase among named codes that names none, as a changed label would, is a restatement the registry doesn't make.
    if (named.length > 0) {
      for (const x of items.filter((y) => y.hits.length === 0)) {
        const phrase = /([a-z0-9][a-z0-9 ./&-]{0,60})$/.exec(x.before.split(/,|\band\b|\bor\b|:|such as/).at(-1) ?? "")?.[1]?.trim() ?? "";
        const list = named[0]!.hits[0]!.l;
        const code = list.codes.find((c) => Number(c.code) === x.n);
        if (phrase !== "" && /\d|[a-z]{3}/.test(phrase)) problems.push(`${where}: ${at} restates ${list.name}'s code ${x.n} as "${phrase}", where the registry labels it "${code?.label ?? "no code"}"`);
      }
    }
  };
  for (const [at, s] of texts(i.ir)) restated(at, s);
  i.text.forEach((line, n) => line.split(/(?<!\\)\|/).forEach((cell) => restated(`line ${n + 1}`, cell)));
  // 3. A vocabulary of a registry's list holds the registry's codes, with its labels, from the registry.
  for (const t of i.model.types) {
    if (t.kind !== "vocabulary" || !t.list) continue;
    const r = lists.find((x) => x.l.name === t.list!.name && x.l.standard === t.list!.standard);
    if (!r) continue;
    if (!t.list.registry) problems.push(`${where}: ${t.name} takes the codes of ${t.list.standard} ${t.list.name} from a copy, not from the registry`);
    const want = r.l.codes.map((c) => `${c.code} ${c.label ?? ""}`);
    const have = t.terms.map((x) => `${x.value} ${x.annotation ?? ""}`);
    for (const x of have.filter((h) => !want.includes(h))) problems.push(`${where}: ${t.name} holds "${x}", which ${t.list.name} at ${r.r.lock} doesn't`);
    for (const x of want.filter((w) => !have.includes(w))) problems.push(`${where}: ${t.name} lacks "${x}", which ${t.list.name} at ${r.r.lock} holds`);
    if (t.open !== (r.l.vendor !== undefined || r.l.extension !== undefined)) problems.push(`${where}: ${t.name} is ${t.open ? "open" : "closed"}, where ${t.list.name} at ${r.r.lock} is ${t.open ? "closed" : "open"}`);
  }
  // 2. No emitted schema holds a registry list's codes, in an enum or in const branches; a registry's vocabulary is a `$ref`; the kernel copies no list.
  // The vocabularies of the spec's own labeled lists, by their definitions' names, whose codes alone say nothing.
  const ownLabeled = new Set(i.model.types.flatMap((t) => (t.kind === "vocabulary" && t.labeled === true && t.list === undefined ? [t.name] : [])));
  const walk = (node: unknown, file: string, ptr: string) => {
    if (Array.isArray(node)) node.forEach((n, k) => walk(n, file, `${ptr}/${k}`));
    else if (node !== null && typeof node === "object") {
      const o = node as Record<string, unknown>;
      const own = ownLabeled.has(/^\/\$defs\/([^/]+)$/.exec(ptr)?.[1] ?? "");
      const branches = Array.isArray(o.oneOf) ? (o.oneOf as Record<string, unknown>[]).filter((b) => b !== null && typeof b === "object" && "const" in b) : [];
      const codes = new Set<unknown>(Array.isArray(o.enum) ? o.enum : branches.map((b) => b.const));
      const titles = new Set(branches.map((b) => norm(String(b.title ?? ""))));
      const text = norm(`${String(o.title ?? "")} ${String(o.description ?? "")}`);
      const copies = codes.size === 0 ? [] : lists.filter(({ l }) => {
        if (l.codes.length < 2 || !l.codes.every((c) => codes.has(c.code))) return false;
        // The codes alone are evidence where a list has four or more and the node holds exactly them; else its labels or its name must be there
        // too. A vocabulary of the spec's own list, each code with the label the text gives it, is another list of the same codes, as the Deals
        // API's `0` = deal is active is no AdCOM Volume Normalization Mode, unless its labels or its name are the registry's.
        const exact = !own && codes.size === l.codes.length && l.codes.length >= 4;
        const named = text.includes(norm(l.name));
        const labeled = l.codes.filter((c) => titles.has(norm(c.label ?? ""))).length * 2 >= l.codes.length;
        return exact || named || labeled;
      });
      if (copies.length > 0) problems.push(`${where}: ${file} at ${ptr || "/"} copies the codes of ${copies.map((x) => `${x.l.standard} ${x.l.name}`).join(" or ")}; reference the registry's vocabulary instead`);
      for (const [k, v] of Object.entries(o)) walk(v, file, `${ptr}/${k}`);
    }
  };
  for (const f of i.files) walk(f.schema, f.path, "");
  const defsOf = new Map(i.files.flatMap((f) => Object.entries((f.schema.$defs ?? {}) as Record<string, Record<string, unknown>>)));
  for (const t of i.model.types) {
    if (t.kind !== "vocabulary" || !t.list?.registry) continue;
    const ref = `${t.list.registry.schema}#/$defs/${t.list.registry.def}`;
    if (defsOf.get(t.name)?.$ref !== ref) problems.push(`${where}: ${t.name}'s schema isn't a $ref to ${ref}`);
  }
  for (const k of i.kernelLists) {
    for (const { r, l } of lists) {
      const sameText = r.upstream !== "" && k.url.startsWith(`${r.upstream}/blob/`) && k.url.includes(`/${r.path.split("/").map(encodeURIComponent).join("/")}`);
      const sameCodes = k.codes.length === l.codes.length && k.codes.every((c) => l.codes.some((x) => x.code === c.code && norm(x.label ?? "") === norm(c.label ?? "")));
      if (sameText || (sameCodes && l.codes.length >= 2)) {
        problems.push(`kernel/lists.yaml: the list "${k.name}" copies ${r.spec}'s ${sameText ? "text" : `${l.name}`}; import the registry instead`);
        break;
      }
    }
  }
  for (const a of i.allowances ?? []) {
    if (onLock(a) && !used.has(a)) problems.push(`${where}: the allowance of ${a.decision} for ${a.registry}, ${"cites" in a ? `"${a.cites}" as ${a.means}` : `links at ${a.links_at}`}, excuses no citation on this lock; remove it`);
  }
  return [...new Set(problems)];
}

/** Every registry on this site, as a spec that imports some of them reads it, and every pin. */
export function agreementContext(specDir: string): Pick<AgreementInput, "registries" | "pins" | "kernelLists" | "allowances" | "decisions"> {
  const specs = readdirSync(join(REPO_ROOT, "specs"), { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(REPO_ROOT, "specs", d.name, "spec.yaml"))).map((d) => d.name);
  const imports = loadProfile(specDir).imports ?? [];
  const registries: AgreementRegistry[] = specs
    .filter((s) => loadProfile(specRoot(s)).site?.registry === true)
    .map((spec) => {
      const root = specRoot(spec);
      const locks = allLocks(root);
      const pinned = imports.find((x) => x.spec === spec);
      const lock = locks.find((l) => l.name === (pinned?.lock ?? locks[0]?.name));
      const ir = lock ? (JSON.parse(readFileSync(join(root, lock.ir_dir, "spec-ir.json"), "utf8")) as SpecIR) : null;
      const text = lock ? lockText(lock) : [];
      return {
        spec,
        lock: pinned?.lock ?? lock?.name ?? "",
        imported: pinned !== undefined,
        commit: lock?.commit ?? "",
        locks: locks.map((l) => l.name),
        lists: lock ? importedLists({ spec, lock: lock.name }) : [],
        sections: (ir?.sections ?? []).map((s) => ({ id: s.id, title: s.title, slug: s.line > 0 && text[s.line - 1] !== undefined ? headingSlug(text[s.line - 1]!) : s.anchor })),
        upstream: lock?.upstream ?? "",
        path: lock?.path ?? "",
      };
    });
  // An import of a spec that isn't a registry, or of none on this site, is a registry with no lists, so its pin is checked.
  for (const x of imports) if (!registries.some((r) => r.spec === x.spec)) registries.push({ spec: x.spec, lock: x.lock, imported: true, commit: "", locks: [], lists: [], sections: [], upstream: "", path: "" });
  const pins = specs.flatMap((s) => (loadProfile(specRoot(s)).imports ?? []).map((x) => ({ spec: s, registry: x.spec, lock: x.lock })));
  const allowances = imports.flatMap((x) => (x.allowances ?? []).map((a) => ({ ...a, registry: x.spec })));
  const decisionsDir = join(specDir, "decisions");
  const decisions = existsSync(decisionsDir) ? loadDecisions(decisionsDir).map((d) => ({ id: d.id, stands: stands(d), covers: d.covers.map((c) => ({ ir: c.ir, ...(c.locks ? { locks: c.locks } : {}) })) })) : [];
  return { registries, pins, kernelLists: loadLists(REPO_ROOT).lists, allowances, decisions };
}

/** A lock's specification text, line by line, from its snapshot, or none. */
export function lockText(lock: SpecLock): string[] {
  const dir = snapshotOf(lock);
  return dir === null ? [] : readFileSync(join(repoRoot(lock), dir, lock.path), "utf8").split("\n");
}
