/**
 * Writes the mapping files (`npm run map`). It keeps every entry and
 * declaration that cites a decision record as it is, derives every other
 * entry and declaration with the mapping rules on each lock, scopes each one
 * to the locks it holds on, and writes each file in one canonical layout, in
 * specification order. With `--check`, CI compares the result with the
 * committed files.
 */
import { stringify } from "yaml";
import { canonicalJson } from "./canonical.ts";
import type { Constructors } from "./constructors.ts";
import { ruleContext } from "./coverage.ts";
import { elementDigest, indexElements } from "./elements.ts";
import type { SpecIR } from "./ir-types.ts";
import type { Kernel } from "./kernel.ts";
import { inScope, type Declaration, type MappingEntry, type MappingFile } from "./mapping.ts";
import { DECLARATION_RULES, firstRule } from "./mapping-rules.ts";

export interface LockIr {
  name: string;
  ir: SpecIR;
}

/** One file's text per mapping file, keyed by its path. */
export function writeMappings(locks: LockIr[], mappings: MappingFile[], kernel: Kernel, constructors: Constructors): Map<string, string> {
  const decided: MappingFile[] = mappings.map((m) => ({
    ...m,
    entries: m.entries.filter((e) => !("rule" in e.source)),
    types: (m.types ?? []).filter((d) => !("rule" in d.source)),
  }));
  const allLocks = locks.map((l) => l.name).sort();
  const order = elementOrder(locks);

  // Per lock, derive the rule entries until no rule adds one.
  const derived = new Map<string, { lock: string; digest: string; entry: MappingEntry }[]>();
  const declared = new Map<string, { lock: string; decl: Declaration; section: string }[]>();
  const sectionOf = new Map<string, string>();
  for (const { name: lock, ir } of locks) {
    const elements = indexElements(ir);
    for (const [id, e] of elements) sectionOf.set(id, e.element.loc.section);
    const working: MappingFile[] = decided.map((m) => ({ ...m, entries: [...m.entries] }));
    const scratch: MappingFile = { format: 1, module: "\u0000rules", sections: [], entries: [], file: "(rules)" };
    working.push(scratch);
    for (let pass = 0; pass < 8; pass++) {
      const ctx = ruleContext(ir, lock, working, kernel, constructors);
      let added = 0;
      for (const [id, e] of elements) {
        if (ctx.entries.has(id)) continue;
        const r = firstRule(e, ctx);
        if (!r) continue;
        scratch.entries.push({ ir: id, digest: elementDigest(e), locks: [lock], source: { rule: r.rule }, as: r.as });
        added++;
      }
      if (added === 0) break;
    }
    // Rederive with the full context, so an early entry sees every later one.
    const ctx = ruleContext(ir, lock, working, kernel, constructors);
    for (const entry of scratch.entries) {
      const r = firstRule(elements.get(entry.ir)!, ctx);
      if (!r) continue;
      const list = derived.get(entry.ir) ?? [];
      list.push({ lock, digest: entry.digest, entry: { ir: entry.ir, digest: entry.digest, source: { rule: r.rule }, as: r.as } });
      derived.set(entry.ir, list);
    }
    const decidedNames = new Set(decided.flatMap((m) => (m.types ?? []).filter((d) => inScope(d.locks, lock)).map((d) => d.name)));
    for (const rule of DECLARATION_RULES) {
      for (const d of rule.derive(ctx)) {
        if (decidedNames.has(d.name)) continue;
        const list = declared.get(d.name) ?? [];
        list.push({ lock, decl: d, section: d.ir ? (elements.get(d.ir)?.element.loc.section ?? "") : "" });
        declared.set(d.name, list);
      }
    }
  }

  const ids = new Map(locks.map((l) => [l.name, new Set(indexElements(l.ir).keys())]));
  const locksOf = (id: string) => allLocks.filter((l) => ids.get(l)!.has(id));

  // Group each element's derived entries by digest and target; scope each group to its locks.
  const ruleEntries = new Map<string, MappingEntry[]>();
  for (const [id, list] of derived) {
    const groups = new Map<string, { entry: MappingEntry; locks: string[] }>();
    for (const x of list) {
      const key = canonicalJson({ digest: x.digest, source: x.entry.source, as: x.entry.as });
      const g = groups.get(key) ?? { entry: x.entry, locks: [] };
      g.locks.push(x.lock);
      groups.set(key, g);
    }
    const everywhere = allLocks;
    ruleEntries.set(
      id,
      [...groups.values()].map((g) => {
        const all = g.locks.length === everywhere.length && locksOf(id).length === everywhere.length;
        return all ? g.entry : { ir: g.entry.ir, digest: g.entry.digest, locks: [...g.locks].sort(), source: g.entry.source, as: g.entry.as };
      }),
    );
  }
  const ruleDecls: { decl: Declaration; section: string }[] = [];
  for (const list of declared.values()) {
    const groups = new Map<string, { decl: Declaration; locks: string[]; section: string }>();
    for (const x of list) {
      const key = canonicalJson(x.decl);
      const g = groups.get(key) ?? { decl: x.decl, locks: [], section: x.section };
      g.locks.push(x.lock);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      const decl = g.locks.length === allLocks.length ? g.decl : { ...g.decl, locks: [...g.locks].sort() };
      ruleDecls.push({ decl, section: g.section });
    }
  }

  // Place each rule entry and declaration in the module that owns its section.
  const moduleOf = new Map<string, MappingFile>();
  for (const m of decided) for (const s of m.sections) if (!moduleOf.has(s)) moduleOf.set(s, m);
  const out = new Map<string, string>();
  for (const m of decided) {
    const entries = [...m.entries];
    for (const [id, list] of ruleEntries) if (moduleOf.get(sectionOf.get(id) ?? "") === m) entries.push(...list);
    const types = [...(m.types ?? [])];
    for (const { decl, section } of ruleDecls) if (moduleOf.get(section) === m) types.push(decl);
    const rank = (id: string | undefined) => (id === undefined ? -1 : (order.get(id) ?? Number.MAX_SAFE_INTEGER));
    const lockKey = (l: string[] | undefined) => (l === undefined ? "" : l.join(","));
    entries.sort((a, b) => rank(a.ir) - rank(b.ir) || lockKey(a.locks).localeCompare(lockKey(b.locks)) || a.ir.localeCompare(b.ir));
    types.sort((a, b) => rank(a.ir) - rank(b.ir) || a.name.localeCompare(b.name) || lockKey(a.locks).localeCompare(lockKey(b.locks)));
    out.set(m.file, render({ ...m, entries, types }));
  }
  return out;
}

/** A rank for every element ID on any lock: specification order on the lock with the most sections. */
function elementOrder(locks: LockIr[]): Map<string, number> {
  const byDepth = [...locks].sort((a, b) => b.ir.sections.length - a.ir.sections.length || a.name.localeCompare(b.name));
  const sectionRank = new Map<string, number>();
  for (const l of byDepth) for (const s of l.ir.sections) if (!sectionRank.has(s.id)) sectionRank.set(s.id, sectionRank.size);
  const keyed = new Map<string, [number, number, string]>();
  for (const l of byDepth) {
    for (const [id, e] of indexElements(l.ir)) {
      if (!keyed.has(id)) keyed.set(id, [sectionRank.get(e.element.loc.section) ?? 0, e.element.loc.line, id]);
    }
  }
  const sorted = [...keyed.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]));
  return new Map(sorted.map((k, i) => [k[2], i]));
}

const HEADER = [
  "# Written by `npm run map`. `depends`, and the entries and types that cite a decision record,",
  "# are kept as they are; every other entry and type is derived by a mapping rule (src/mapping-rules.ts).",
];

/** The canonical text of one mapping file. */
function render(m: MappingFile): string {
  const lines = [...HEADER, "format: 1", `module: ${m.module}`, `sections: ${flow(m.sections)}`];
  if (m.depends && m.depends.length > 0) lines.push(`depends: ${flow(m.depends)}`);
  if (m.deferred) lines.push(`deferred: { decision: ${m.deferred.decision} }`);
  if (m.types && m.types.length > 0) {
    lines.push("types:");
    for (const d of m.types) lines.push(...item(d as unknown as Record<string, unknown>, ["name", "kind", "ir", "locks", "source", "open", "terms", "any_of", "includes", "members"]));
  } else lines.push("types: []");
  if (m.entries.length > 0) {
    lines.push("entries:");
    for (const e of m.entries) lines.push(...item(e as unknown as Record<string, unknown>, ["ir", "digest", "locks", "source", "as"]));
  } else lines.push("entries: []");
  return `${lines.join("\n")}\n`;
}

/** A value in YAML flow style, on one line. */
const flow = (v: unknown): string => stringify(v, { collectionStyle: "flow", lineWidth: 0 }).trimEnd();

const WIDTH = 120;

/** One sequence item: a block map whose keys come in `keys` order, each value in flow style when it fits. */
function item(v: Record<string, unknown>, keys: string[]): string[] {
  const lines: string[] = [];
  const ordered = [...keys.filter((k) => k in v), ...Object.keys(v).filter((k) => !keys.includes(k))];
  ordered.forEach((k, i) => {
    const prefix = i === 0 ? "  - " : "    ";
    lines.push(...pair(prefix, k, v[k], 2));
  });
  return lines;
}

/** A key and its value at an indent: flow when it fits, else a block map (or a sequence of flow items). */
function pair(prefix: string, key: string, value: unknown, depth: number): string[] {
  const head = `${prefix}${key}:`;
  const f = flow(value);
  if (value === null || typeof value !== "object" || head.length + 1 + f.length <= WIDTH) return [`${head} ${f}`];
  const pad = "  ".repeat(depth + 1);
  if (Array.isArray(value)) return [head, ...value.map((x) => `${pad}- ${flow(x)}`)];
  const order = key === "as" ? ["role", "object", "name", "layer", "open", "vocabulary", "profile", "document", "type", "presence", "members"] : [];
  const keys = [...order.filter((k) => k in (value as object)), ...Object.keys(value as object).filter((k) => !order.includes(k))];
  return [head, ...keys.flatMap((k) => pair(pad, k, (value as Record<string, unknown>)[k], depth + 1))];
}
