/** The gates on the mapping and the decision records: they load, they are current on each lock's IR, the bijection holds, and the files are what `npm run map` writes. */
import { join } from "node:path";
import type { Constructors } from "../src/constructors.ts";
import { checkCoverage } from "../src/coverage.ts";
import type { SpecIR } from "../src/ir-types.ts";
import type { Kernel } from "../src/kernel.ts";
import { writeMappings, type LockIr } from "../src/map-writer.ts";
import type { Lists } from "../src/lists.ts";
import { checkSources } from "../src/mapping-sources.ts";
import { checkMapping, loadDecisions, loadMappings, type DecisionRecord, type MappingFile } from "../src/mapping.ts";
import { defineGate, ROOT } from "./harness.ts";

export const mappingLoad = defineGate<{ mappingDir: string; decisionsDir: string }>({
  id: "mapping-load",
  title: "mapping and decisions: schema-valid",
  code: ["src/mapping.ts#loadMappings", "src/mapping.ts#loadDecisions"],
  check: (i) => {
    const m = loadMappings(i.mappingDir);
    const d = loadDecisions(i.decisionsDir);
    return { problems: [], note: `${m.length} mapping files, ${m.reduce((n, f) => n + f.entries.length, 0)} entries, ${d.length} decision records` };
  },
  fixtures: [
    { name: "a decision record with no options", mutate: (i) => ({ ...i, decisionsDir: join(ROOT, "gates/data/mapping-load/decisions") }), expect: "not a valid decision record" },
    { name: "a mapping file named for another module", mutate: (i) => ({ ...i, mappingDir: join(ROOT, "gates/data/mapping-load/mapping") }), expect: 'it must equal the file name "kernel"' },
  ],
});

/** One lock's IR with the mapping and the decisions. */
export interface MappingInput {
  ir: SpecIR;
  lock: string;
  mappings: MappingFile[];
  decisions: DecisionRecord[];
  /** The code lists other standards keep, which a vocabulary may take its terms from. */
  lists?: Lists;
}

const firstCover = (ds: DecisionRecord[], change: (c: DecisionRecord["covers"][number]) => DecisionRecord["covers"][number]) => ds.map((d, n) => (n === 0 ? { ...d, covers: d.covers.map((c, k) => (k === 0 ? change(c) : c)) } : d));

export const mappingCurrent = defineGate<MappingInput>({
  id: "mapping-current",
  title: "mapping and decisions current",
  code: ["src/mapping.ts#checkMapping"],
  check: (i) => ({ problems: checkMapping(i.ir, i.lock, i.mappings, i.decisions) }),
  fixtures: [
    { name: "a decision's stale digest", mutate: (i) => ({ ...i, decisions: firstCover(i.decisions, (c) => ({ ...c, digest: "0".repeat(64) })) }), expect: "stale" },
    { name: "a decision's altered quote", mutate: (i) => ({ ...i, decisions: firstCover(i.decisions, (c) => ({ ...c, quote: `${c.quote} (altered)` })) }), expect: "differs from the IR" },
    {
      name: "an entry that cites a decision that doesn't exist",
      mutate: (i) => ({ ...i, mappings: i.mappings.map((m, n) => (n === 0 ? { ...m, entries: m.entries.map((e, k) => (k === 0 ? { ...e, source: { decision: "D-999" } } : e)) } : m)) as MappingFile[] }),
      expect: 'cites decision "D-999", which doesn\'t exist',
    },
  ],
});

/** One lock's IR with the mapping, the kernel, and the constructors, as the coverage checks read them. */
export interface CoverageInput {
  ir: SpecIR;
  lock: string;
  mappings: MappingFile[];
  kernel: Kernel;
  constructors: Constructors;
}

const dropEntry = (i: CoverageInput, ir: string): CoverageInput => ({ ...i, mappings: i.mappings.map((m) => ({ ...m, entries: m.entries.filter((e) => e.ir !== ir) })) });

export const mappingBijection = defineGate<CoverageInput>({
  id: "mapping-bijection",
  title: "mapping bijection: every IR element mapped exactly once, in its section's module",
  code: ["src/coverage.ts#checkCoverage"],
  check: (i) => {
    const elements = i.mappings.reduce((n, m) => n + m.entries.filter((e) => e.locks === undefined || e.locks.includes(i.lock)).length, 0);
    return { problems: checkCoverage(i.ir, i.lock, i.mappings, i.kernel, i.constructors).coverage, note: `${elements} entries` };
  },
  fixtures: [
    { name: "an element with no entry", mutate: (i) => dropEntry(i, "field:5.6:min_spend"), expect: "field:5.6:min_spend" },
    {
      name: "an element mapped in another section's module",
      mutate: (i) => {
        const entry = i.mappings.flatMap((m) => m.entries).find((e) => e.ir === "field:5.6:min_spend")!;
        return { ...dropEntry(i, "field:5.6:min_spend"), mappings: dropEntry(i, "field:5.6:min_spend").mappings.map((m) => (m.module === "proposal" ? { ...m, entries: [...m.entries, entry] } : m)) };
      },
      expect: "field:5.6:min_spend",
    },
  ],
});

/** A type entry of the mapping, by its element. */
const retype = (i: CoverageInput, ir: string, change: (as: Record<string, unknown>) => Record<string, unknown>): CoverageInput => ({
  ...i,
  mappings: i.mappings.map((m) => ({ ...m, entries: m.entries.map((e) => (e.ir === ir ? ({ ...e, as: change(e.as as unknown as Record<string, unknown>) } as unknown as typeof e) : e)) })),
});

export const mappingLocation = defineGate<CoverageInput>({
  id: "mapping-location",
  title: "mapping location: rows at their path's object with their stated presence, members as the IR lists them",
  code: ["src/coverage.ts#checkCoverage"],
  check: (i) => ({ problems: checkCoverage(i.ir, i.lock, i.mappings, i.kernel, i.constructors).location }),
  fixtures: [
    { name: "a REQUIRED key row mapped as optional", mutate: (i) => retype(i, "key:5.6.1:commitment.amount", (as) => ({ ...as, presence: "optional" })), expect: "commitment.amount" },
    { name: "a row at another object", mutate: (i) => retype(i, "field:5.6:pricing[].floor", (as) => ({ ...as, object: "Commitment" })), expect: "pricing[].floor" },
  ],
});

export const mappingRules = defineGate<CoverageInput>({
  id: "mapping-rules",
  title: "mapping rules reproduce, and every type the mapping names is defined once",
  code: ["src/coverage.ts#checkCoverage"],
  check: (i) => {
    const r = checkCoverage(i.ir, i.lock, i.mappings, i.kernel, i.constructors);
    return { problems: [...r.rules, ...r.types] };
  },
  fixtures: [
    {
      name: "a rule-derived entry changed by hand",
      mutate: (i) => ({ ...i, mappings: i.mappings.map((m) => ({ ...m, entries: m.entries.map((e) => (e.ir.startsWith("sentence:") && "rule" in e.source ? { ...e, as: { role: "rendered" } } : e)) })) as MappingFile[] }),
      expect: "prose-sentence",
    },
    // Two lists of the same codes restate each other only with the same labels, as the Deals API's `pubcount` and `dinventory` don't.
    {
      name: "a labeled list read as restating another of the same codes",
      spec: "dealsapi",
      mutate: (i) => ({ ...i, mappings: i.mappings.map((m) => ({ ...m, entries: m.entries.map((e) => (e.ir === "field:object-deal:dinventory#description/values:1" ? { ...e, source: { rule: "restated-value-list" }, as: { role: "same", name: "PublisherCount" } } : e)) })) as MappingFile[] }),
      expect: 'entry "field:object-deal:dinventory#description/values:1": cites rule "restated-value-list", but no mapping rule applies',
    },
    // A labeled list of the codes 0 and 1 restates the integer flag only with its titles, or on a row the binding cites for it.
    {
      name: "a labeled 0 and 1 list that is no flag read as restating the integer flag",
      spec: "dealsapi",
      mutate: (i) => {
        const id = "field:object-deal:dinventory#description/values:1";
        return {
          ...i,
          ir: { ...i.ir, value_lists: i.ir.value_lists.map((v) => (v.id === id ? { ...v, items: [{ value: "0", annotation: "undisclosed" }, { value: "1", annotation: "single publisher" }] } : v)) },
          mappings: i.mappings.map((m) => ({ ...m, entries: m.entries.map((e) => (e.ir === id ? { ...e, source: { rule: "restated-value-list" }, as: { role: "schema", in: "IntegerFlag" } } : e)) })) as MappingFile[],
        };
      },
      expect: 'entry "field:object-deal:dinventory#description/values:1": cites rule "restated-value-list", but no mapping rule applies',
    },
    // A table whose columns are headed by member names, as the Example Scenarios, is no concept table.
    {
      name: "a scenario row read as a concept row",
      spec: "dealsapi",
      mutate: (i) => ({ ...i, mappings: i.mappings.map((m) => ({ ...m, entries: m.entries.map((e) => (e.ir === "concept:example-scenarios:1" ? { ...e, source: { rule: "concept-row" }, as: { role: "informative" } } : e)) })) as MappingFile[] }),
      expect: 'entry "concept:example-scenarios:1": cites rule "concept-row", but no mapping rule applies',
    },
    {
      name: "a type the mapping names that nobody defines",
      mutate: (i) => retype(i, "field:5.6:min_spend", (as) => ({ ...as, type: { kind: "named", name: "NoSuchType" } })),
      expect: "NoSuchType",
    },
  ],
});

export const mappingSources = defineGate<MappingInput>({
  id: "mapping-sources",
  title: "mapping sources: members, terms, and required members rest on the text their decisions cover",
  code: ["src/mapping-sources.ts#checkSources"],
  check: (i) => ({ problems: checkSources(i.ir, i.lock, i.mappings, i.decisions, i.lists).sources }),
  fixtures: [
    {
      name: "a member required with no text that requires it",
      mutate: (i) => ({ ...i, mappings: JSON.parse(JSON.stringify(i.mappings).replace(/"quantity":\{("type":\{"kind":"named","name":"Count"\}),"presence":"optional"\}/, '"quantity":{$1,"presence":"required"}')) as MappingFile[] }),
      expect: "quantity",
    },
    {
      name: "a profile path through a member no covered element writes",
      mutate: (i) => ({ ...i, mappings: JSON.parse(JSON.stringify(i.mappings).replaceAll('"properties.available[].name"', '"properties.available[].nickname"')) as MappingFile[] }),
      expect: 'path "properties.available[].nickname": member "nickname" is written by none of the elements it rests on',
    },
    {
      name: "a vocabulary placed in the kernel by a decision that doesn't say why",
      mutate: (i) => ({ ...i, decisions: i.decisions.map((d) => (d.id === "D-013" ? { ...d, rationale: d.rationale.replace(/`Party` is the kernel's, beside `Marker`\./, "`Party` sits beside `Marker`.") } : d)) }),
      expect: 'places "Party" in the kernel, but no decision it cites says why',
    },
  ],
});

export const mappingNames = defineGate<MappingInput>({
  id: "mapping-names",
  title: "mapping names: every object the mapping defines is named after its field or member, or a decision names it",
  code: ["src/mapping-sources.ts#checkSources"],
  check: (i) => ({ problems: checkSources(i.ir, i.lock, i.mappings, i.decisions, i.lists).names }),
  fixtures: [
    {
      name: "an object renamed with no decision",
      mutate: (i) => ({ ...i, mappings: JSON.parse(JSON.stringify(i.mappings).replaceAll('"HoldStatus"', '"HoldInfo"')) as MappingFile[] }),
      expect: "HoldInfo",
    },
    // An object the text names by its own table's heading keeps that name only as the rule that declares it from the text says.
    {
      name: "a heading-named object declared by a decision",
      spec: "dealsapi",
      mutate: (i) => ({ ...i, mappings: i.mappings.map((m) => ({ ...m, types: (m.types ?? []).map((t) => (t.name === "BuyerStatus" ? { ...t, source: { decision: "D-021" } } : t)) })) as MappingFile[] }),
      expect: 'the field or member that holds "BuyerStatus" names it "BuyerstatusEntry"',
    },
  ],
});

export const mapDrift = defineGate<{ locks: LockIr[]; mappings: MappingFile[]; kernel: Kernel; constructors: Constructors; texts: Map<string, string> }>({
  id: "map-drift",
  title: "mapping files are what npm run map writes",
  code: ["src/map-writer.ts#writeMappings"],
  check: (i) => {
    const out = writeMappings(i.locks, i.mappings, i.kernel, i.constructors);
    const changed = [...out].filter(([file, text]) => i.texts.get(file) !== text).map(([file]) => file.slice(ROOT.length + 1));
    return { problems: changed.map((f) => `${f} is not what npm run map writes`) };
  },
  fixtures: [
    {
      name: "a mapping file edited by hand",
      mutate: (i) => {
        const [file, text] = [...i.texts][0]!;
        return { ...i, texts: new Map([...i.texts, [file, `${text}# edited\n`]]) };
      },
      expect: "is not what npm run map writes",
    },
  ],
});
