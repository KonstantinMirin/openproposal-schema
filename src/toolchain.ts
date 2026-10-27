/**
 * The toolchain pin gate (gate 1): each tool runs at the
 * version this repository pins, so a newer tool can't change an output with
 * no change to its input. And the workflow, the CI's own lock, runs every
 * setup step and the one gate script with those versions, unconditionally.
 *
 * - Node satisfies `engines.node` in `package.json`, and every package in
 *   `node_modules/` that `package.json` names is at its exact pin.
 * - The venv's Python is the version `setup:oracle` creates it with, and
 *   every distribution `tools/<tool>/requirements.txt` pins, where its
 *   marker applies, is installed at its pin.
 * - Go is exactly the `toolchain` directive of the tracked `go.mod` files
 *   that carry one, and CI's setup-go reads it from one of them. The `go`
 *   directives agree, and Go is at least each, as Go's own rule requires.
 *   `GOTOOLCHAIN=local` keeps Go from fetching another toolchain.
 *
 * Node and Python are pinned to their minor version, Node 22
 * and Python 3.12, so a patch release can differ between machines. Every tool
 * that writes an output runs inside them as an exact package pin, and the
 * drift gates catch a changed output. Go is pinned exactly because the Go
 * distribution is itself a tool here: its `regexp` package is a validator
 * behind the regex parity gate, and `gofmt` and `go vet` check the Go SDK.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { spawnWithInput } from "./spawn.ts";

/** One `name==version` line of a hash-locked requirements file, with its environment marker. */
export interface Pin {
  name: string;
  version: string;
  marker: string | null;
}

/** The pins of a requirements file that `pip-compile --generate-hashes` writes. */
export function parseRequirements(text: string): Pin[] {
  const pins: Pin[] = [];
  for (const line of text.split("\n")) {
    if (line === "" || /^[\s#-]/.test(line)) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?==([^\s;\\]+)\s*(?:;\s*(.*?))?\s*\\?$/.exec(line);
    if (!m) throw new Error(`"${line}" isn't an exact pin`);
    pins.push({ name: m[1]!.toLowerCase().replace(/[-_.]+/g, "-"), version: m[2]!, marker: m[3] ?? null });
  }
  return pins;
}

/** A dotted version's numeric parts, such as [22, 13, 1] for `v22.13.1` or `go1.26.8`. */
export function versionParts(v: string): number[] {
  const m = /(\d+(?:\.\d+)*)/.exec(v);
  if (!m) throw new Error(`"${v}" names no version`);
  return m[1]!.split(".").map(Number);
}

/** Compares two versions part by part; a missing part counts as 0. */
export function compareVersions(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Whether a version satisfies a range of space-separated `>=`, `>`, `<=`, `<`, and `=` comparators, as `engines` writes them. */
export function satisfies(version: string, range: string): boolean {
  return range
    .trim()
    .split(/\s+/)
    .every((c) => {
      const m = /^(>=|<=|>|<|=)?v?(\d+(?:\.\d+)*)$/.exec(c);
      if (!m) throw new Error(`"${c}" in "${range}" isn't a comparator this gate reads`);
      const d = compareVersions(version, m[2]!);
      return { ">=": d >= 0, "<=": d <= 0, ">": d > 0, "<": d < 0, "=": d === 0 }[m[1] ?? "="]!;
    });
}

/** The Python version `setup:oracle` creates the venv with, from its `python3.12 -m venv` call. */
export function venvPython(setupOracle: string): string {
  const m = /\bpython(\d+\.\d+)\s+-m\s+venv\b/.exec(setupOracle);
  if (!m) throw new Error(`setup:oracle doesn't create the venv with a pinned python3.x`);
  return m[1]!;
}

/** The `toolchain` directive of a go.mod, such as `go1.26.8`, or null when it has none. */
export function toolchainDirective(text: string): string | null {
  const m = /^toolchain\s+(go\d+\.\d+\.\d+)\s*$/m.exec(text);
  return m ? m[1]! : null;
}

/** The `go` directive of a go.mod. */
export function goDirective(text: string): string {
  const m = /^go\s+(\d+\.\d+(?:\.\d+)?)\s*$/m.exec(text);
  if (!m) throw new Error("no go directive");
  return m[1]!;
}

export interface Pkg {
  engines?: { node?: string };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * The workflow's problems: it must run on a push to `main` and on every pull
 * request, install with `npm ci --ignore-scripts`, run every `setup:*`
 * script, and run `npm run ci`, last; no step and not the job may carry an
 * `if` or a `continue-on-error`, which would skip a step or ignore its
 * failure; and its Node, Python, and Go versions must be the ones the
 * repository pins. `goMods` maps each tracked go.mod to its text.
 */
/** The base the gate decisions are compared with: the pull request's base, or the push's previous commit. */
export const GATE_BASE = "${{ (github.event.created && github.sha) || github.event.pull_request.base.sha || github.event.before }}";
/** The step that fetches it into the shallow clone. */
export const FETCH_BASE = 'git fetch --no-tags --depth=1 origin "$GATE_BASE"';

export function checkWorkflow(workflow: string, pkg: Pkg, goMods: Record<string, string>): string[] {
  const doc = parse(workflow, { version: "1.2", schema: "core" }) as { on?: unknown; jobs?: Record<string, Record<string, unknown> & { steps?: Record<string, unknown>[] }> };
  const jobs = Object.entries(doc.jobs ?? {});
  if (jobs.length !== 1) return [`the workflow runs ${jobs.length} jobs; it runs one, the gate script`];
  const [jobName, job] = jobs[0]!;
  const steps = job.steps ?? [];
  const runs = steps.flatMap((s) => (typeof s.run === "string" ? [s.run.trim()] : []));
  const using = (action: string) => steps.find((s) => typeof s.uses === "string" && s.uses.split("@")[0] === action) as { with?: Record<string, unknown> } | undefined;
  const problems: string[] = [];
  const on: Record<string, unknown> = doc.on !== null && typeof doc.on === "object" && !Array.isArray(doc.on) ? (doc.on as Record<string, unknown>) : {};
  const push = on.push as { branches?: unknown } | null | undefined;
  if (typeof push !== "object" || push === null || !Array.isArray(push.branches) || !push.branches.includes("main")) problems.push("the workflow doesn't run on a push to main");
  // A pull_request trigger with no filter runs on every pull request.
  const pr = on.pull_request;
  if (!("pull_request" in on) || (pr !== null && (typeof pr !== "object" || Object.keys(pr).length > 0))) problems.push("the workflow doesn't run on every pull request");
  const guarded = (what: string, x: Record<string, unknown>) => {
    if ("if" in x) problems.push(`${what} carries an if, which can skip it`);
    if ("continue-on-error" in x && x["continue-on-error"] !== false) problems.push(`${what} carries continue-on-error, which ignores its failure`);
  };
  guarded(`the job "${jobName}"`, job);
  steps.forEach((s, i) => guarded(`step ${i + 1} (${typeof s.run === "string" ? s.run.trim() : String(s.uses ?? s.name ?? "unnamed")})`, s));
  if (!runs.includes("npm ci --ignore-scripts")) problems.push("the workflow doesn't install with: npm ci --ignore-scripts");
  const setups = Object.keys(pkg.scripts ?? {}).filter((s) => s.startsWith("setup:")).sort();
  for (const s of setups) if (!runs.includes(`npm run ${s}`)) problems.push(`the workflow doesn't run: npm run ${s}`);
  if (runs[runs.length - 1] !== "npm run ci") problems.push("the workflow's last step isn't: npm run ci");
  // The gate script checks that no gate decision the base holds is edited, so the job names the base and fetches it first.
  const env = (job.env ?? {}) as Record<string, unknown>;
  if (env.GATE_BASE !== GATE_BASE) problems.push(`the job doesn't set GATE_BASE to ${GATE_BASE}, so the gate script can't tell an edited gate decision from a new one`);
  const fetch = runs.indexOf(FETCH_BASE);
  if (fetch === -1 || fetch > runs.lastIndexOf("npm run ci")) problems.push(`the workflow doesn't fetch the base before the gate script: ${FETCH_BASE}`);
  const node = String(using("actions/setup-node")?.with?.["node-version"] ?? "");
  if (pkg.engines?.node === undefined) problems.push("package.json pins no engines.node");
  else if (node === "" || !satisfies(node, pkg.engines.node)) problems.push(`the workflow's node-version "${node}" doesn't satisfy engines.node "${pkg.engines.node}"`);
  const python = String(using("actions/setup-python")?.with?.["python-version"] ?? "");
  try {
    const want = venvPython(pkg.scripts?.["setup:oracle"] ?? "");
    if (python !== want) problems.push(`the workflow's python-version "${python}" isn't ${want}, the version setup:oracle creates the venv with`);
  } catch (e) {
    problems.push((e as Error).message);
  }
  const goFile = String(using("actions/setup-go")?.with?.["go-version-file"] ?? "");
  if (!(goFile in goMods)) problems.push(`the workflow's go-version-file "${goFile}" isn't a tracked go.mod`);
  else if (toolchainDirective(goMods[goFile]!) === null) problems.push(`the workflow's go-version-file "${goFile}" has no toolchain directive, so setup-go would take the newest Go its go directive allows`);
  return problems;
}

const run = (cmd: string, args: string[], opts: { cwd?: string; input?: string; env?: Record<string, string> } = {}) => {
  const o = { cwd: opts.cwd, encoding: "utf8" as const, env: { ...process.env, ...opts.env } };
  const r = opts.input === undefined ? spawnSync(cmd, args, o) : spawnWithInput(cmd, args, opts.input, o);
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: `${r.error?.message ?? ""}${r.stderr ?? ""}`.trim() };
};

/** The tracked go.mod files, by path from the root, each with its text. */
export function trackedGoMods(root: string): Record<string, string> {
  const r = run("git", ["ls-files"], { cwd: root });
  if (!r.ok) throw new Error(`git ls-files failed: ${r.err}`);
  const paths = r.out.split("\n").filter((p) => p === "go.mod" || p.endsWith("/go.mod")).sort();
  return Object.fromEntries(paths.map((p) => [p, readFileSync(join(root, p), "utf8")]));
}

/** The toolchain gate on this machine, against the root's package.json or the one given. */
export function checkToolchain(root: string, pkg: Pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Pkg): { problems: string[]; note: string } {
  const problems: string[] = [];

  const node = process.versions.node;
  if (pkg.engines?.node === undefined) problems.push("package.json pins no engines.node");
  else if (!satisfies(node, pkg.engines.node)) problems.push(`Node is ${node}, and engines.node is "${pkg.engines.node}"`);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const [name, pin] of Object.entries(deps).sort()) {
    if (!/^\d+\.\d+\.\d+$/.test(pin)) {
      problems.push(`package.json pins ${name} as "${pin}", not an exact version`);
      continue;
    }
    const file = join(root, "node_modules", name, "package.json");
    const installed = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { version?: string }).version : undefined;
    if (installed !== pin) problems.push(`${name} is ${installed ?? "not installed"}, and package.json pins ${pin}; run: npm ci --ignore-scripts`);
  }

  let pythonNote = "no venv";
  const python = join(root, ".venv", "bin", "python");
  const files = readdirSync(join(root, "tools"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, "tools", e.name, "requirements.txt")))
    .map((e) => `tools/${e.name}/requirements.txt`)
    .sort();
  const pins = files.flatMap((f) => parseRequirements(readFileSync(join(root, f), "utf8")).map((p) => ({ ...p, file: f })));
  const byName = new Map<string, typeof pins>();
  for (const p of pins) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
  for (const [name, list] of byName) {
    const versions = [...new Set(list.map((p) => p.version))];
    if (versions.length > 1) problems.push(`${name} is pinned as ${versions.join(" and ")} across ${list.map((p) => p.file).join(", ")}`);
  }
  if (!existsSync(python)) problems.push("no venv at .venv; run: npm run setup:oracle && npm run setup:sdk && npm run setup:plaingen");
  else {
    const r = run(python, ["-I", join(root, "tools", "toolchain", "installed.py")], { input: JSON.stringify({ pins: pins.map((p) => ({ name: p.name, marker: p.marker })) }) });
    if (!r.ok) problems.push(`tools/toolchain/installed.py failed: ${r.err}`);
    else {
      const got = JSON.parse(r.out) as { python: string; pins: { name: string; applies: boolean; installed: string | null }[] };
      try {
        const want = venvPython(pkg.scripts?.["setup:oracle"] ?? "");
        if (got.python !== want) problems.push(`the venv's Python is ${got.python}, and setup:oracle creates it with ${want}`);
      } catch (e) {
        problems.push((e as Error).message);
      }
      got.pins.forEach((g, i) => {
        const p = pins[i]!;
        if (g.applies && g.installed !== p.version) problems.push(`${p.name} is ${g.installed ?? "not installed"} in .venv, and ${p.file} pins ${p.version}`);
      });
      pythonNote = `Python ${got.python}, ${got.pins.filter((g) => g.applies).length} pins in ${files.length} requirements files`;
    }
  }

  let goNote = "no go";
  const go = run("go", ["env", "GOVERSION"], { env: { GOTOOLCHAIN: "local" } });
  const mods = trackedGoMods(root);
  const directives = new Map<string, string>();
  const toolchains = new Map<string, string>();
  for (const [m, text] of Object.entries(mods)) {
    try {
      directives.set(m, goDirective(text));
    } catch (e) {
      problems.push(`${m}: ${(e as Error).message}`);
    }
    const t = toolchainDirective(text);
    if (t !== null) toolchains.set(m, t);
  }
  const distinct = [...new Set(directives.values())];
  if (distinct.length > 1) problems.push(`the go.mod files disagree on the go directive: ${[...directives].map(([m, v]) => `${m} ${v}`).join(", ")}`);
  const pinned = [...new Set(toolchains.values())];
  if (pinned.length === 0) problems.push("no tracked go.mod pins Go with a toolchain directive");
  if (pinned.length > 1) problems.push(`the go.mod files disagree on the toolchain directive: ${[...toolchains].map(([m, v]) => `${m} ${v}`).join(", ")}`);
  if (!go.ok) problems.push(`go env GOVERSION failed: ${go.err}`);
  else {
    for (const [m, v] of directives) if (compareVersions(go.out, v) < 0) problems.push(`Go is ${go.out}, below the go ${v} that ${m} requires`);
    for (const [m, v] of toolchains) if (go.out !== v) problems.push(`Go is ${go.out}, and ${m} pins toolchain ${v}`);
    goNote = `${go.out} as the toolchain directive of ${[...toolchains.keys()].join(", ")} pins it; go ${distinct.join(", ")} in ${Object.keys(mods).length} go.mod files`;
  }

  return { problems, note: `Node ${node}, ${Object.keys(deps).length} npm pins; ${pythonNote}; ${goNote}` };
}
