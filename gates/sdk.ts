/** The gates on each lock's SDK types: they generate, deterministically, compile, and reach the reference verdict on every case; and the plain generator's classes do too, or each divergence is a numbered exemption. */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { ModelDoc } from "../src/model.ts";
import { checkExemptions, checkExemptionsFile, EXEMPTIONS_FILE, generatePlain, plainDivergences, type ExemptionsFile } from "../src/plain-parity.ts";
import { emitSdk } from "../src/sdk-emit.ts";
import { compareRun, type SdkCase, type SdkRun } from "../src/sdk-parity.ts";
import { committedTreeCurrent, flipFirst, onlyGenerated, runTool, sameTreeRuns, type CommittedTreeInput, type TrackedInput, type TreeRunsInput } from "./common.ts";
import { defineGate, ROOT } from "./harness.ts";
import { withType } from "./model.ts";

export const plainExemptionsFile = defineGate<{ exemptions: ExemptionsFile; pinned: string; locks: string[] }>({
  id: "plain-exemptions-file",
  title: "plain generator: exemptions file schema-valid and consistent",
  code: ["src/plain-parity.ts#checkExemptionsFile"],
  exemptions: [EXEMPTIONS_FILE],
  check: (i) => ({ problems: checkExemptionsFile(i.exemptions, i.pinned, i.locks), note: `${i.exemptions.exemptions.length} exemptions, checked against datamodel-code-generator ${i.pinned}` }),
  fixtures: [
    { name: "written for another generator version", mutate: (i) => ({ ...i, exemptions: { ...i.exemptions, generator: "datamodel-code-generator 0.1.0" } }), expect: "written for datamodel-code-generator 0.1.0" },
    { name: "an ID used twice", mutate: (i) => ({ ...i, exemptions: { ...i.exemptions, exemptions: [...i.exemptions.exemptions, { ...i.exemptions.exemptions[0]!, cases: [] }] } }), expect: "is used twice" },
  ],
});

export const sdkGenerate = defineGate<{ model: ModelDoc; dir: string }>({
  id: "sdk-generate",
  title: "SDK types generate from the model",
  check: (i) => {
    const e = emitSdk(i.model, i.dir);
    return { problems: e.problems, note: `${e.files.length} files: ${e.sdk.emitted.length} named types and ${e.sdk.templates.size} generic templates in each of TypeScript, Python, and Go` };
  },
  fixtures: [
    {
      name: "a property whose type the model doesn't define",
      mutate: (i) => ({
        ...i,
        model: withType(i.model, "Commitment", (t) => {
          const o = t as Extract<typeof t, { kind: "object" }>;
          return { ...o, properties: { ...o.properties, amount: { ...o.properties.amount!, type: { kind: "named", name: "NoSuchType" } } } };
        }),
      }),
      expect: "NoSuchType",
    },
  ],
});

export const sdkNames = defineGate<{ schemaNames: string[]; emitted: string[]; templates: string[] }>({
  id: "sdk-names",
  title: "SDK names: each named type the schema emits is one declaration of the same name in each SDK, and no template takes a type's name",
  check: (i) => {
    const same = JSON.stringify([...i.schemaNames].sort()) === JSON.stringify([...i.emitted].sort());
    const taken = i.templates.filter((n) => i.schemaNames.includes(n));
    return {
      problems:
        same && taken.length === 0
          ? []
          : [`the schema emits ${i.schemaNames.filter((n) => !i.emitted.includes(n)).join(", ") || "nothing"} the SDKs lack, the SDKs declare ${i.emitted.filter((n) => !i.schemaNames.includes(n)).join(", ") || "nothing"} the schema lacks${taken.length > 0 ? `, and the templates ${taken.join(", ")} take type names` : ""}`],
      note: `${i.schemaNames.length} names`,
    };
  },
  fixtures: [
    { name: "an SDK type the schema lacks", mutate: (i) => ({ ...i, emitted: [...i.emitted, "Extra"] }), expect: "the SDKs declare Extra the schema lacks" },
    { name: "a template named like a type", mutate: (i) => ({ ...i, templates: [...i.templates, i.schemaNames[0]!] }), expect: "take type names" },
  ],
});

export const sdkDeterministic = defineGate<TreeRunsInput>({
  id: "sdk-deterministic",
  title: "deterministic SDK types",
  code: ["gates/common.ts#sameTreeRuns"],
  check: sameTreeRuns,
  fixtures: [{ name: "a run writes one file differently", mutate: (i) => ({ ...i, runs: [flipFirst(i.runs[0]!), i.runs[1]!] }), expect: "run 1: " }],
});

export const sdkCommitted = defineGate<CommittedTreeInput>({
  id: "sdk-committed",
  title: (i) => `committed ${i.dir}/ current`,
  code: ["gates/common.ts#committedTreeCurrent"],
  check: committedTreeCurrent,
  fixtures: [{ name: "a committed SDK file edited by hand", mutate: (i) => ({ ...i, committed: flipFirst(i.committed) }), expect: "differs" }],
});

export const sdkTypecheck = defineGate<{ project: string }>({
  id: "sdk-typecheck",
  title: "the TypeScript SDK typechecks",
  code: ["gates/common.ts#runTool"],
  check: (i) => {
    const r = runTool(join(ROOT, "node_modules", ".bin", "tsc"), ["-p", i.project]);
    return { problems: r.ok ? [] : [r.output.split("\n").slice(0, 20).join("; ")], note: "tsc, strict" };
  },
  fixtures: [{ name: "a type error", mutate: () => ({ project: "gates/data/sdk-typecheck/tsconfig.json" }), expect: "error TS2322" }],
});

export const sdkGo = defineGate<{ dir: string }>({
  id: "sdk-go",
  title: "the Go SDK is gofmt-clean and vets clean",
  check: (i) => {
    const env = { ...process.env, GOWORK: "off", GOTOOLCHAIN: "local", FORCE_COLOR: "0" };
    const gofmt = spawnSync("gofmt", ["-l", "."], { cwd: join(ROOT, i.dir), encoding: "utf8", env });
    const vet = spawnSync("go", ["vet", "./..."], { cwd: join(ROOT, i.dir), encoding: "utf8", env });
    const ok = gofmt.status === 0 && (gofmt.stdout ?? "").trim() === "" && vet.status === 0;
    const problems = ok ? [] : [[gofmt.error?.message, (gofmt.stdout ?? "").trim() && `gofmt would change: ${(gofmt.stdout ?? "").trim()}`, `${vet.error?.message ?? ""}${vet.stdout ?? ""}${vet.stderr ?? ""}`.trim()].filter(Boolean).join("; ")];
    return { problems, note: "gofmt -l, go vet" };
  },
  fixtures: [{ name: "a file gofmt would change", mutate: () => ({ dir: "gates/data/sdk-go" }), expect: "gofmt would change: bad.go" }],
});

export const sdkParity = defineGate<{ language: string; cases: SdkCase[]; run: SdkRun }>({
  id: "sdk-parity",
  title: (i) => `SDK parity: the ${i.language} types reach the reference verdict on every corpus case and kernel vector, and encode each accepted value back unchanged`,
  code: ["src/sdk-parity.ts#compareRun"],
  check: (i) => compareRun(i.language, i.cases, i.run),
  fixtures: [
    { name: "a verdict that isn't the label", mutate: (i) => ({ ...i, run: { ...i.run, verdicts: i.run.verdicts.map((v, n) => (n === 0 ? !v : v)) } }), expect: "but the SDK says" },
    {
      name: "an accepted value encoded back changed",
      mutate: (i) => {
        const at = i.run.verdicts.findIndex((v) => v);
        return { ...i, run: { ...i.run, dumps: i.run.dumps.map((d, n) => (n === at ? { changed: true } : d)) } };
      },
      expect: "encodes",
    },
    { name: "a verdict missing", mutate: (i) => ({ ...i, run: { ...i.run, verdicts: i.run.verdicts.slice(1) } }), expect: "verdicts for" },
  ],
});

export const plainGenerates = defineGate<{ schemaDir: string; out: string }>({
  id: "plain-generates",
  title: "plain generator: classes generate from each published schema file alone",
  code: ["src/plain-parity.ts#generatePlain"],
  check: (i) => {
    const g = generatePlain(ROOT, i.schemaDir, i.out);
    return { problems: g.problems, note: `datamodel-code-generator ${g.version}, ${g.modules} modules` };
  },
  fixtures: [{ name: "a schema file the generator can't read", mutate: (i) => ({ ...i, schemaDir: join(ROOT, "gates/data/plain-generates"), out: join(ROOT, "build/ci/fixtures/plain-generates") }), expect: "broken.json: datamodel-codegen failed" }],
});

export const plainParity = defineGate<{ lock: string; cases: SdkCase[]; ran: string[]; run: SdkRun; exemptions: ExemptionsFile }>({
  id: "plain-parity",
  title: "plain generator parity: its classes reach the reference verdict on every case with a concrete type and encode each accepted value back unchanged, or the divergence is a numbered exemption",
  code: ["src/plain-parity.ts#plainDivergences", "src/plain-parity.ts#checkExemptions"],
  exemptions: [EXEMPTIONS_FILE],
  check: (i) => {
    const divergences = plainDivergences(i.cases, i.run);
    const r = checkExemptions(divergences, new Set(i.ran), i.exemptions, i.lock);
    return { problems: r.problems, note: `${i.run.engine}: ${i.cases.length} cases, ${i.cases.length - divergences.length} reach the reference, ${divergences.length} diverge under ${r.used.length > 0 ? r.used.join(", ") : "no exemption"}` };
  },
  fixtures: [
    { name: "an exemption removed", mutate: (i) => ({ ...i, exemptions: { ...i.exemptions, exemptions: i.exemptions.exemptions.slice(1) } }), expect: "no exemption in plain-generator/exemptions.yaml lists it" },
    {
      name: "an exempt case that no longer diverges",
      mutate: (i) => {
        const e = i.exemptions.exemptions[0]!;
        const c = i.cases.findIndex((x) => x.label === e.cases[0]!.label);
        return { ...i, run: { ...i.run, verdicts: i.run.verdicts.map((v, n) => (n === c ? i.cases[c]!.valid : v)), errors: i.run.errors.map((x, n) => (n === c ? null : x)), dumps: i.run.dumps.map((d, n) => (n === c ? i.cases[c]!.value : d)) } };
      },
      expect: "no longer diverges",
    },
  ],
});

export const plainStale = defineGate<{ exemptions: ExemptionsFile; absent: [string, number][]; scope: [string, number][] }>({
  id: "plain-stale",
  title: "plain generator: every exempt case is a parity case on some lock it applies to",
  check: (i) => {
    const scope = new Map(i.scope);
    const never = i.absent.filter(([k, n]) => n === scope.get(k.split(" ")[0]!)).map(([k]) => k);
    return { problems: never.length === 0 ? [] : [`${never.slice(0, 20).join("; ")}; remove it from ${EXEMPTIONS_FILE}`] };
  },
  fixtures: [{ name: "a case no lock runs", mutate: (i) => ({ ...i, absent: [...i.absent, [`${i.scope[0]![0]} corpus NoSuchCase mutant [verdict]`, i.scope[0]![1]]] }), expect: "NoSuchCase" }],
});

export const sdkTracked = defineGate<TrackedInput>({
  id: "sdk-tracked",
  title: "every tracked file under sdk/ is generated by some lock",
  code: ["gates/common.ts#onlyGenerated"],
  check: onlyGenerated,
  fixtures: [{ name: "a hand-written SDK file", mutate: (i) => ({ ...i, tracked: [...i.tracked, "sdk/ts/src/extra.ts"] }), expect: "sdk/ts/src/extra.ts" }],
});
