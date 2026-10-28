/** The gates on the repository itself: it typechecks, its tools are at their pins, the workflow runs every gate, the tests pass, and nothing generated is left untracked. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkToolchain, checkWorkflow, type Pkg } from "../src/toolchain.ts";
import { runTool } from "./common.ts";
import { defineGate, ROOT } from "./harness.ts";

export const typecheck = defineGate<{ args: string[] }>({
  id: "typecheck",
  title: "typecheck",
  code: ["gates/common.ts#runTool"],
  files: ["tsconfig.json"],
  check: (i) => {
    const r = runTool(join(ROOT, "node_modules", ".bin", "tsc"), i.args);
    return { problems: r.ok ? [] : [r.output] };
  },
  fixtures: [
    {
      name: "a null string and an unchecked list item, which only the repository's compiler options reject",
      // The real invocation, on a configuration that extends the repository's and adds the bad file.
      mutate: (i) => ({ args: [...i.args, "-p", "gates/data/typecheck/tsconfig.json"] }),
      expect: /(?=[\s\S]*Type 'null' is not assignable to type 'string')(?=[\s\S]*Type 'string \| undefined' is not assignable to type 'string')/,
    },
  ],
});

export const toolchain = defineGate<{ root: string; pkg: Pkg }>({
  id: "toolchain",
  title: "toolchain: Node, the npm packages, the venv's Python and distributions, and Go are at the versions the repository pins",
  code: ["src/toolchain.ts#checkToolchain"],
  check: (i) => checkToolchain(i.root, i.pkg),
  fixtures: [
    { name: "a range, not an exact pin", mutate: (i) => ({ ...i, pkg: { ...i.pkg, dependencies: { ...i.pkg.dependencies, ajv: "^8.20.0" } } }), expect: 'pins ajv as "^8.20.0", not an exact version' },
    { name: "a pin the installed package isn't at", mutate: (i) => ({ ...i, pkg: { ...i.pkg, dependencies: { ...i.pkg.dependencies, ajv: "8.19.0" } } }), expect: "ajv is 8.20.0, and package.json pins 8.19.0" },
    { name: "a Node range this Node doesn't satisfy", mutate: (i) => ({ ...i, pkg: { ...i.pkg, engines: { node: ">=99" } } }), expect: 'and engines.node is ">=99"' },
  ],
});

export const workflow = defineGate<{ workflow: string; pkg: Pkg; goMods: Record<string, string> }>({
  id: "workflow",
  title: "workflow: runs on main and every pull request, installs with npm ci, runs every setup script, then this script, unconditionally, at the pinned Node, Python, and Go",
  code: ["src/toolchain.ts#checkWorkflow"],
  check: (i) => ({ problems: checkWorkflow(i.workflow, i.pkg, i.goMods) }),
  fixtures: [
    { name: "the gate step may fail", mutate: (i) => ({ ...i, workflow: i.workflow.replace("      - run: npm run ci", "      - run: npm run ci\n        continue-on-error: true") }), expect: "carries continue-on-error" },
    { name: "a setup script not run", mutate: (i) => ({ ...i, workflow: i.workflow.replace("      - run: npm run setup:plaingen\n", "") }), expect: "doesn't run: npm run setup:plaingen" },
    { name: "only on pushes", mutate: (i) => ({ ...i, workflow: i.workflow.replace("  pull_request:\n", "") }), expect: "doesn't run on every pull request" },
    { name: "no base for the gate decisions", mutate: (i) => ({ ...i, workflow: i.workflow.replace(/^ {6}GATE_BASE: .*\n/m, "") }), expect: "the job doesn't set GATE_BASE" },
    { name: "the base not fetched", mutate: (i) => ({ ...i, workflow: i.workflow.replace(/^ {6}- run: git fetch .*\n/m, "") }), expect: "doesn't fetch the base before the gate script" },
  ],
});

/**
 * The fewest tests the suite holds. A test glob that matches nothing, or a
 * deleted test file, runs fewer, and fails the gate even though every test
 * that runs passes. Raise it when tests are added; lowering it is a gate
 * change a gate decision must accept.
 */
export const MIN_TESTS = 465;

/** A word for the shell, quoted. */
const shellWord = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export const npmTest = defineGate<{ script: string; extra: string[] }>({
  id: "npm-test",
  title: "npm test",
  code: ["gates/common.ts#runTool"],
  files: ["package.json", "test/"],
  check: (i) => {
    // `npm test` runs package.json's test script in a shell, with the packages' binaries first on the PATH; so does the gate.
    const r = runTool("sh", ["-c", [i.script, ...i.extra.map(shellWord)].join(" ")], ROOT, { PATH: `${join(ROOT, "node_modules", ".bin")}:${process.env.PATH ?? ""}` });
    const summary = r.output.split("\n").filter((l) => /^ℹ (tests|pass|fail|skipped)/.test(l)).join(", ");
    const ran = Number(/^ℹ tests (\d+)$/m.exec(r.output)?.[1] ?? 0);
    const problems = r.ok ? [] : [r.output];
    if (ran < MIN_TESTS) problems.push(`ran ${ran} tests, fewer than the ${MIN_TESTS} the suite holds: a test glob that matches nothing, or a deleted test file, runs fewer`);
    return { problems, note: summary };
  },
  fixtures: [
    { name: "a failing test, run by the real test script", mutate: (i) => ({ ...i, extra: [...i.extra, "gates/data/npm-test/failing.ts"] }), expect: "ℹ fail 1" },
    { name: "a test glob that matches nothing", mutate: (i) => ({ ...i, script: i.script.replace('"test/**/*.test.ts"', '"test/**/*.no-such.test.ts"') }), expect: "ran 0 tests, fewer than" },
    { name: "a test file deleted", mutate: (i) => ({ ...i, script: i.script.replace('"test/**/*.test.ts"', '"test/gates.test.ts"') }), expect: /ran \d+ tests, fewer than/ },
  ],
});

/**
 * The directories whose files are reviewed input or generated output, so none
 * may be untracked: every spec's folder, the root's tooling and format
 * schemas, and the single-spec layout's other folders (`layoutTracked`).
 */
export const TRACKED_DIRS = ["specs", "spec-input", "ir", "mapping", "decisions", "kernel", "schemas", "vectors", "rules", "corpus", "type-examples", "field-examples", "sdk", "plain-generator", "roundtrip", "examples", "releases", "comparison", "feedback", "drift", "gates", "variants", "src", "scripts", "test", "tools"];

export const untracked = defineGate<{ untracked: string[] }>({
  id: "untracked",
  title: `no untracked files under ${TRACKED_DIRS.map((d) => `${d}/`).join(", ")}`,
  check: (i) => ({ problems: i.untracked.length === 0 ? [] : [`${i.untracked.slice(0, 20).join(", ")}; add them, or remove them`] }),
  fixtures: [{ name: "a file left out of git", mutate: () => ({ untracked: ["mapping/stray.yaml"] }), expect: "mapping/stray.yaml" }],
});

/** The repository's package.json. */
export const packageJson = (): Pkg => JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Pkg;

/** The single-spec layout's folders at the root that hold nothing now: each spec's inputs and outputs are in its folder. */
export const MOVED_DIRS = ["spec-input", "schemas", "rules", "corpus", "type-examples", "comparison", "feedback"];
/** The root's folders that hold only their format schemas, `<dir>/<name>.schema.json`, which every spec's files validate against. */
export const FORMAT_DIRS = ["ir", "mapping", "decisions", "vectors", "examples", "variants", "field-examples", "roundtrip", "plain-generator", "releases", "drift"];

/** The tracked files the root's moved and format folders hold that the layout doesn't allow there. */
export function strayAtRoot(tracked: readonly string[]): string[] {
  return tracked.filter((p) => {
    const [top, ...rest] = p.split("/");
    if (MOVED_DIRS.includes(top!)) return true;
    return FORMAT_DIRS.includes(top!) && !(rest.length === 1 && rest[0]!.endsWith(".schema.json"));
  });
}

export const layoutTracked = defineGate<{ tracked: string[] }>({
  id: "layout-tracked",
  title: `layout: the root's ${MOVED_DIRS.map((d) => `${d}/`).join(", ")} track nothing, since each spec's files are in its folder, and ${FORMAT_DIRS.map((d) => `${d}/`).join(", ")} track only their format schemas`,
  code: ["gates/setup.ts#strayAtRoot"],
  check: (i) => {
    const stray = strayAtRoot(i.tracked);
    return { problems: stray.length === 0 ? [] : [`${stray.slice(0, 20).join(", ")}: the root holds only the tooling, the kernel, and the format schemas; move a spec's file into its folder under specs/`], note: `${i.tracked.length} format schemas` };
  },
  fixtures: [
    { name: "a schema committed where the single-spec layout kept it", mutate: (i) => ({ tracked: [...i.tracked, "schemas/documents/1/proposal.json"] }), expect: "schemas/documents/1/proposal.json: the root holds only" },
    { name: "a mapping file beside the mapping format", mutate: (i) => ({ tracked: [...i.tracked, "mapping/commercial.yaml"] }), expect: "mapping/commercial.yaml: the root holds only" },
  ],
});
