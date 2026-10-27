/** The gates on the release manifests: they build against the last frozen release, deterministically, their digests recompute in two languages, and no change is breaking within the major. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkOldCorpus, type CorpusDoc } from "../src/corpus.ts";
import type { EmittedFile } from "../src/emit.ts";
import { MAJOR } from "../src/emit.ts";
import type { ModelDoc } from "../src/model.ts";
import { buildRelease, checkDigests, checkFrozen, loadFrozen, oracleDigests, RELEASES_DIR, renderRelease, unreviewedDecisions, type Frozen, type OracleCheck, type ReleaseDoc, type ReleaseInput } from "../src/release.ts";
import type { RulesDoc } from "../src/rules.ts";
import { committedCurrent, flipped, sameRuns, type CommittedInput, type RunsInput } from "./common.ts";
import { defineGate, ROOT } from "./harness.ts";
import { fixtureFile } from "./outputs.ts";
import { withType } from "./model.ts";

export const frozenReleases = defineGate<{ root: string; locks: string[] }>({
  id: "frozen-releases",
  title: "frozen releases: each manifest is valid, sits at its lock and version, and its schema tree's, model's, and rules' digests recompute",
  code: ["src/release.ts#loadFrozen", "src/release.ts#checkFrozen"],
  check: (i) => {
    const problems: string[] = [];
    const dir = join(i.root, RELEASES_DIR);
    if (existsSync(dir)) for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && !i.locks.includes(e.name)) problems.push(`${RELEASES_DIR}/${e.name}/ names no lock`);
    const frozen: [string, Frozen[]][] = [];
    for (const lock of i.locks) {
      try {
        const list = loadFrozen(i.root, lock);
        frozen.push([lock, list]);
        for (const f of list) problems.push(...checkFrozen(i.root, lock, f));
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    const count = frozen.reduce((n, [, l]) => n + l.length, 0);
    return { problems, note: count === 0 ? "none frozen yet" : frozen.map(([l, f]) => `${l}: ${f.map((x) => x.release.release).join(", ") || "none"}`).join("; ") };
  },
  fixtures: [{ name: "a release directory for no lock", mutate: (i) => ({ ...i, root: join(ROOT, "gates/data/frozen-releases") }), expect: "releases/no-such-lock/ names no lock" }],
});

/** The frozen releases by lock, with the decisions, and the current lock's model and rules, for a fixture to freeze. */
export const frozenReviewed = defineGate<{ frozen: [string, Frozen[]][]; decisions: { id: string; status: string }[]; current: { model: ModelDoc; rules: RulesDoc } }>({
  id: "frozen-reviewed",
  title: "frozen releases rest on reviewed decisions only: every decision a frozen model or its rules cite is accepted, filed, or superseded",
  code: ["src/release.ts#unreviewedDecisions"],
  check: (i) => {
    const problems = i.frozen.flatMap(([l, list]) => list.flatMap((f) => unreviewedDecisions(f.model, f.rules, i.decisions).map((p) => `${RELEASES_DIR}/${l}/${f.release.release} ${p}`)));
    const count = i.frozen.reduce((n, [, l]) => n + l.length, 0);
    return { problems, note: count === 0 ? "none frozen yet" : `${count} frozen release${count === 1 ? "" : "s"}` };
  },
  fixtures: [
    {
      name: "a release frozen on proposed decisions",
      mutate: (i) => ({ ...i, frozen: [["main", [{ release: { release: "1.0.0" } as ReleaseDoc, model: i.current.model, rules: i.current.rules, corpus: {} as CorpusDoc, files: {} }]]], decisions: i.decisions.map((d) => ({ ...d, status: "proposed" })) }),
      expect: "which is still proposed",
    },
  ],
});

/** The release built against a frozen release made from the current one, with one property more than the model now has. */
const frozenWithExtra = (i: ReleaseInput): Frozen => {
  const current = buildRelease({ ...i, previous: null }).doc;
  const model = withType(i.model, "Commitment", (t) => {
    const o = t as Extract<typeof t, { kind: "object" }>;
    return { ...o, properties: { ...o.properties, legacy_note: { type: { kind: "named", name: "Text" }, presence: "optional", sources: [] } } };
  });
  return { release: current, model, rules: i.rules, corpus: { format: 1, input: model.input, oracle: { jsonschema: "" }, constraints: [], implied: [], rules: [] } as CorpusDoc, files: {} };
};

export const releaseBuilds = defineGate<ReleaseInput>({
  id: "release-builds",
  title: "release manifest builds from the model against the last frozen release",
  code: ["src/release.ts#buildRelease"],
  check: (i) => {
    const r = buildRelease(i);
    const counts = (["breaking", "additive", "annotation"] as const).map((k) => `${r.doc.changes.filter((c) => c.class === k).length} ${k}`).join(", ");
    return { problems: r.problems.filter((p) => !p.startsWith("breaking change")), note: `release ${r.doc.release}, ${Object.keys(r.doc.files).length} files; ${i.previous === null ? "the first release" : `against ${i.previous.release.release}: ${counts}`}` };
  },
  fixtures: [
    {
      name: "a previous release of a model format the differ doesn't read",
      mutate: (i) => {
        const f = frozenWithExtra(i);
        return { ...i, previous: { ...f, model: { ...f.model, format: 2 as 1 } } };
      },
      expect: "keeps a model of format 2",
    },
  ],
});

export const breaking = defineGate<ReleaseInput>({
  id: "release-breaking",
  title: `breaking: no removed field, narrowed type or schema entry, new required member, changed marker, or narrowed or new rule against the last frozen release within major ${MAJOR}`,
  code: ["src/release.ts#buildRelease"],
  check: (i) => {
    const r = buildRelease(i);
    const problems = r.problems.filter((p) => p.startsWith("breaking change"));
    return { problems, note: i.previous === null ? "no release frozen yet, so nothing to compare" : `against ${i.previous.release.release}` };
  },
  fixtures: [{ name: "a property removed since the last release", mutate: (i) => ({ ...i, previous: frozenWithExtra(i) }), expect: "legacy_note" }],
});

/** The last frozen release's corpus, or with none frozen yet the committed corpus, as `of` says. */
export const breakingCorpus = defineGate<{ old: CorpusDoc; files: EmittedFile[]; rules: RulesDoc; of: string }>({
  id: "release-breaking-corpus",
  title: (i) => `breaking: every valid case of ${i.of} still validates under the new schemas and rules`,
  code: ["src/corpus.ts#checkOldCorpus"],
  check: (i) => ({ problems: checkOldCorpus(i.old, i.files, i.rules), note: `${i.old.constraints.length} baselines, ${i.old.rules.reduce((n, x) => n + x.valid.length, 0)} valid rule vectors` }),
  fixtures: [
    { name: "an old valid case the new schemas reject", mutate: (i) => ({ ...i, old: { ...i.old, constraints: i.old.constraints.map((c, n) => (n === 0 ? { ...c, baseline: c.mutant } : c)) } }), expect: "is invalid under the new schemas" },
  ],
});

export const releaseDeterministic = defineGate<RunsInput>({
  id: "release-deterministic",
  title: (i) => `deterministic ${i.label}`,
  code: ["gates/common.ts#sameRuns"],
  check: sameRuns,
  fixtures: [{ name: "the runs differ", mutate: (i) => ({ ...i, runs: [i.runs[0]!, flipped(i.runs[1]!)] }), expect: "run 2 differs" }],
});

export const releaseCommitted = defineGate<CommittedInput>({
  id: "release-committed",
  title: (i) => `committed ${i.file} current`,
  code: ["gates/common.ts#committedCurrent"],
  check: committedCurrent,
  fixtures: [{ name: "a stale committed manifest", mutate: (i) => ({ ...i, committed: flipped(i.committed!) }), expect: "isn't what the pipeline writes" }],
});

export const releaseDigests = defineGate<{ doc: ReleaseDoc; files: Map<string, Buffer>; model: ModelDoc; rules: RulesDoc }>({
  id: "release-digests",
  title: "release digests recompute byte for byte from the committed files (JCS SHA-256)",
  code: ["src/release.ts#checkDigests"],
  check: (i) => ({ problems: checkDigests(i.doc, i.files, i.model, i.rules), note: `${Object.keys(i.doc.files).length} files, the tree, the model, and the rules` }),
  fixtures: [
    { name: "a tree digest the files don't give", mutate: (i) => ({ ...i, doc: { ...i.doc, digest: "0".repeat(64) } }), expect: "the tree digest is" },
    { name: "a model digest the model doesn't give", mutate: (i) => ({ ...i, doc: { ...i.doc, model: "0".repeat(64) } }), expect: "the model digest is" },
  ],
});

/** The reference oracle's recomputation of each listed manifest's digests from the files on disk. */
export const releaseOracle = defineGate<{ checks: OracleCheck[] }>({
  id: "release-oracle",
  title: "the reference oracle's rfc8785 recomputes the release digests",
  code: ["src/release.ts#oracleDigests"],
  check: (i) => oracleDigests(ROOT, i.checks),
  fixtures: [
    {
      name: "a manifest whose tree digest the files don't give",
      mutate: (i) => {
        const c = i.checks[0]!;
        const doc = manifestAt(c.release);
        return { checks: [{ ...c, release: fixtureFile("release-oracle/release.json", renderRelease({ ...doc, digest: "0".repeat(64) })) }] };
      },
      expect: "0".repeat(64),
    },
  ],
});

export const frozenOracle = defineGate<{ checks: OracleCheck[] }>({
  id: "frozen-oracle",
  title: "frozen releases: the reference oracle's rfc8785 recomputes each frozen tree's, model's, and rules' digests",
  code: ["src/release.ts#oracleDigests"],
  check: (i) => oracleDigests(ROOT, i.checks),
  fixtures: [
    {
      name: "a frozen manifest whose model digest the model doesn't give",
      mutate: (i) => {
        const c = i.checks[0]!;
        const doc = manifestAt(c.release);
        return { checks: [{ ...c, release: fixtureFile("frozen-oracle/release.json", renderRelease({ ...doc, model: "0".repeat(64) })) }] };
      },
      expect: "0".repeat(64),
    },
  ],
});

/** A manifest the oracle reads, by its path from the root. */
const manifestAt = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8")) as ReleaseDoc;

/** A frozen release is `releases/<lock>/<MAJOR.MINOR.PATCH>/` with its manifest, its model, its rules, and its schema tree. */
const FROZEN_FILE = /^releases\/[^/]+\/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\/((release|model|rules|corpus)\.json|schemas\/(kernel|modules|documents)\/[a-z0-9/.-]+\.json)$/;

export const releasesTracked = defineGate<{ tracked: string[]; schema: string }>({
  id: "releases-tracked",
  title: `every tracked file under ${RELEASES_DIR}/ is the format schema or a frozen release`,
  check: (i) => {
    const stray = i.tracked.filter((p) => p !== "" && p !== i.schema && !FROZEN_FILE.test(p));
    return { problems: stray.length === 0 ? [] : [stray.slice(0, 20).join("; ")] };
  },
  fixtures: [{ name: "a file outside any frozen release", mutate: (i) => ({ ...i, tracked: [...i.tracked, "releases/main/notes.md"] }), expect: "releases/main/notes.md" }],
});
