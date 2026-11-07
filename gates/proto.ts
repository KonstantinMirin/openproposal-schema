/**
 * The gates of the protocol buffer target (src/targets/proto.ts), for a spec
 * whose profile names a proto package: the files it writes from the spec's
 * published schemas compile with protoc, the emitter reads only those
 * schemas and names no spec, two runs and a run on the schema tree alone
 * write the same bytes, and the committed files are current.
 */
import { compileProto } from "../src/targets/protoc.ts";
import { importsOutsideTargets, namesASpec } from "../src/targets/checks.ts";
import { committedTreeCurrent, flipFirst, onlyGenerated, sameTreeRuns, treeDiff, type CommittedTreeInput, type TrackedInput, type TreeRunsInput } from "./common.ts";
import { defineGate, ROOT } from "./harness.ts";

const ADCOM = "adcom";
const FILE = "com/postindustria/ads/adcom/v1/lists.proto";

/** The files with one file's text changed. */
const withText = (files: Map<string, Buffer>, path: string, f: (t: string) => string) => new Map([...files].map(([p, b]) => [p, p === path ? Buffer.from(f(b.toString("utf8"))) : b]));

export const protoBuilds = defineGate<{ files: Map<string, Buffer>; problems: string[]; enums: number; values: number }>({
  id: "proto-builds",
  title: "proto target: every integer-coded vocabulary of the published schemas reads into an enum, with no name two enums or values of the package share, and protoc compiles every file",
  code: ["src/targets/proto.ts#emitProto", "src/targets/protoc.ts#compileProto", "src/targets/schema-tree.ts#readSchemaTree"],
  files: ["tools/proto/requirements.txt", "docs/design/target-rules.md"],
  check: (i) => {
    const compiled = compileProto(i.files, ROOT);
    return { problems: [...i.problems, ...compiled.problems], note: `${i.files.size} file${i.files.size === 1 ? "" : "s"}, ${i.enums} enums, ${i.values} values; ${compiled.version}` };
  },
  fixtures: [
    { name: "a value name two enums share", spec: ADCOM, mutate: (i) => ({ ...i, files: withText(i.files, FILE, (t) => t.replace("API_FRAMEWORK_VPAID_1_0 = 1;", "AGENT_TYPE_IN_APP_IMPRESSIONS = 1;")) }), expect: /protoc fails: .*"AGENT_TYPE_IN_APP_IMPRESSIONS" is already defined/ },
    { name: "an enum whose first value isn't zero", spec: ADCOM, mutate: (i) => ({ ...i, files: withText(i.files, FILE, (t) => t.replace("  AGENT_TYPE_UNSPECIFIED = 0;\n", "")) }), expect: /protoc fails: .*first enum value must be zero/i },
    { name: "a number outside int32", spec: ADCOM, mutate: (i) => ({ ...i, files: withText(i.files, FILE, (t) => t.replace("API_FRAMEWORK_SIMID_1_1 = 9;", "API_FRAMEWORK_SIMID_1_1 = 2147483648;")) }), expect: /protoc fails: .*(out of range|Integer out of range)/i },
    { name: "a problem the emitter found", spec: ADCOM, mutate: (i) => ({ ...i, problems: ["https://example.test/s.json#/$defs/A: lists the code 1 twice"] }), expect: "lists the code 1 twice" },
    { name: "no file to compile", spec: ADCOM, mutate: (i) => ({ ...i, files: new Map() }), expect: "no proto file to compile" },
  ],
});

export const protoSchemaOnly = defineGate<{ entries: string[]; reader: string; read: (path: string) => string; sources: Map<string, string>; names: string[]; want: Map<string, Buffer>; alone: Map<string, Buffer>; aloneLog: string; tree: string }>({
  id: "proto-schema-only",
  title: "proto target: the emitter imports only the targets' modules, by name, with the file system in the schema tree's reader alone, so it reads only the published schemas; its code names no spec; and its code and a copy of the published schema tree, alone in a folder outside the repository, write the spec's bytes",
  code: ["src/targets/checks.ts#importsOutsideTargets", "src/targets/checks.ts#namesASpec", "gates/common.ts#treeDiff"],
  check: (i) => {
    const imports = i.entries.map((e) => importsOutsideTargets(e, i.read, i.reader));
    const reached = [...new Set(imports.flatMap((x) => x.reached))].sort();
    const problems = [...imports.flatMap((x) => x.problems), ...namesASpec(i.sources, i.names), ...treeDiff(i.want, i.alone).map((d) => `the run on ${i.tree} alone: ${d}`), ...(i.aloneLog ? [`the run on ${i.tree} alone failed: ${i.aloneLog}`] : [])];
    return { problems, note: `${reached.length} modules reached from ${i.entries.join(", ")}; ${i.alone.size} files from ${i.tree} alone` };
  },
  fixtures: [
    { name: "the emitter imports the model", spec: ADCOM, mutate: (i) => ({ ...i, read: (p) => (p === "src/targets/proto.ts" ? `import { loadModel } from "../model.ts";\n${i.read(p)}` : i.read(p)) }), expect: "src/targets/proto.ts imports src/model.ts, which isn't a target's module" },
    { name: "a module the emitter reaches imports the IR's types dynamically", spec: ADCOM, mutate: (i) => ({ ...i, read: (p) => (p === "src/targets/names.ts" ? `${i.read(p)}\nexport const ir = () => import("../ir-types.ts");\n` : i.read(p)) }), expect: "src/targets/names.ts imports src/ir-types.ts" },
    { name: "a module the emitter reaches loads a module by a computed name", spec: ADCOM, mutate: (i) => ({ ...i, read: (p) => (p === "src/targets/names.ts" ? `${i.read(p)}\nexport const m = () => import(\`../\${"model"}.ts\`);\n` : i.read(p)) }), expect: "src/targets/names.ts loads a module by a computed name" },
    { name: "the emitter reads files itself", spec: ADCOM, mutate: (i) => ({ ...i, read: (p) => (p === "src/targets/proto.ts" ? `import { readdirSync } from "node:fs";\n${i.read(p)}` : i.read(p)) }), expect: "src/targets/proto.ts imports node:fs, which an emitter may not" },
    { name: "the emitter imports a package", spec: ADCOM, mutate: (i) => ({ ...i, read: (p) => (p === "src/targets/proto.ts" ? `import { parse } from "yaml";\n${i.read(p)}` : i.read(p)) }), expect: "src/targets/proto.ts imports yaml, which an emitter may not" },
    { name: "a spec's name written into a target's code", spec: ADCOM, mutate: (i) => ({ ...i, sources: new Map([...i.sources, ["src/targets/proto.ts", `${i.sources.get("src/targets/proto.ts") ?? ""}\nconst pkg = "adcom.v1";\n`]]) }), expect: /src\/targets\/proto\.ts:\d+: names "adcom"/ },
    { name: "a run on the schema tree alone that writes other bytes", spec: ADCOM, mutate: (i) => ({ ...i, alone: flipFirst(i.alone) }), expect: `the run on` },
    { name: "a run on the schema tree alone that fails", spec: ADCOM, mutate: (i) => ({ ...i, alone: new Map(), aloneLog: "error: no release manifest" }), expect: "alone failed: error: no release manifest" },
  ],
});

export const protoDeterministic = defineGate<TreeRunsInput>({
  id: "proto-deterministic",
  title: "deterministic proto files",
  code: ["gates/common.ts#sameTreeRuns"],
  check: sameTreeRuns,
  fixtures: [{ name: "a run writes a file differently", spec: ADCOM, mutate: (i) => ({ ...i, runs: [i.runs[0]!, flipFirst(i.runs[1]!)] }), expect: "run 2: " }],
});

export const protoCommitted = defineGate<CommittedTreeInput>({
  id: "proto-committed",
  title: (i) => `committed ${i.dir}/ files current`,
  code: ["gates/common.ts#committedTreeCurrent"],
  check: committedTreeCurrent,
  fixtures: [
    { name: "a committed value renamed by hand", spec: ADCOM, mutate: (i) => ({ ...i, committed: withText(i.committed, FILE, (t) => t.replace("API_FRAMEWORK_MRAID_3_0 = 6;", "MRAID_3_0 = 6;")) }), expect: `${FILE} differs` },
    { name: "a committed file left out", spec: ADCOM, mutate: (i) => ({ ...i, committed: new Map() }), expect: `${FILE} missing` },
  ],
});

export const protoTracked = defineGate<TrackedInput>({
  id: "proto-tracked",
  title: "every tracked file under proto/ is one the proto target writes",
  code: ["gates/common.ts#onlyGenerated"],
  check: onlyGenerated,
  fixtures: [{ name: "a proto file the target doesn't write", spec: ADCOM, mutate: (i) => ({ ...i, tracked: [...i.tracked, "proto/com/postindustria/ads/adcom/v1/objects.proto"] }), expect: "proto/com/postindustria/ads/adcom/v1/objects.proto" }],
});
