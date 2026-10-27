/**
 * The validity gate on the emitted schemas: every file is a JSON Schema
 * 2020-12 schema whose references resolve, under two validators.
 *
 * - Ajv 2020, strict, with `ajv-formats`: each file validates against the
 *   2020-12 meta-schema, and, with every file added under its `$id`, each one
 *   compiles, which resolves every `$ref` and applies strict mode (no unknown
 *   keyword, no ignored keyword, no type ambiguity). Strict mode's
 *   `strictRequired` is off: it reads the `required` of a `then` against the
 *   `then` alone, so it rejects "`currency` REQUIRED when `basis = spend`" in
 *   its idiomatic form, `then: { required: ["currency"] }`. `checkEmitted`
 *   checks instead that every required name is a property of its object.
 * - The reference oracle, python-jsonschema with `referencing` as
 *   tools/oracle/requirements.txt pins them (`tools/oracle/schema_check.py`).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { installFormats } from "./formats.ts";
import type { EmittedFile } from "./emit.ts";
import { ORACLE_REQUIREMENTS, pinnedOracle } from "./engines.ts";
import { spawnWithInput } from "./spawn.ts";

/** Ajv 2020's verdict on the files. Returns the problems; empty means every file is valid and compiles. */
export function ajvProblems(files: EmittedFile[]): string[] {
  const problems: string[] = [];
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  installFormats(ajv);
  for (const f of files) {
    if (!ajv.validateSchema(f.schema)) {
      for (const e of ajv.errors ?? []) problems.push(`${f.path}: not a valid 2020-12 schema: ${e.instancePath || "/"} ${e.message ?? ""}`);
    }
  }
  if (problems.length > 0) return problems;
  try {
    for (const f of files) ajv.addSchema(f.schema);
  } catch (e) {
    return [`Ajv doesn't load the files: ${(e as Error).message}`];
  }
  for (const f of files) {
    try {
      ajv.getSchema(String(f.schema.$id));
    } catch (e) {
      problems.push(`${f.path}: Ajv doesn't compile it: ${(e as Error).message}`);
    }
  }
  return problems;
}

/** What `tools/oracle/schema_check.py` reports. */
export interface OracleSchemaRun {
  jsonschema: string;
  referencing: string;
  problems: string[];
}

/** Runs the files through the oracle. Tests replace it; the gate uses `spawnOracle`. */
export type SchemaOracle = (files: EmittedFile[]) => OracleSchemaRun;

export function spawnOracle(root: string): SchemaOracle {
  const python = join(root, ".venv", "bin", "python");
  return (files) => {
    if (!existsSync(python)) throw new Error("no oracle venv at .venv; run: npm run setup:oracle");
    const input = JSON.stringify({ schemas: files.map((f) => ({ path: f.path, schema: f.schema })) });
    const r = spawnWithInput(python, ["-I", join(root, "tools", "oracle", "schema_check.py")], input, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw new Error(`${python}: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`tools/oracle/schema_check.py failed: ${(r.stderr || r.stdout).trim()}`);
    return JSON.parse(r.stdout) as OracleSchemaRun;
  };
}

/** The oracle's verdict on the files, and the versions it ran. */
export function oracleProblems(root: string, files: EmittedFile[], oracle: SchemaOracle = spawnOracle(root)): { problems: string[]; note: string } {
  let run: OracleSchemaRun;
  try {
    run = oracle(files);
  } catch (e) {
    return { problems: [(e as Error).message], note: "" };
  }
  const problems = [...run.problems];
  const pinned = pinnedOracle(root);
  if (run.jsonschema !== pinned) problems.push(`the oracle is jsonschema ${run.jsonschema}, but ${ORACLE_REQUIREMENTS} pins ${pinned}; run: npm run setup:oracle`);
  const referencing = /^referencing==(\S+)/m.exec(readFileSync(join(root, ORACLE_REQUIREMENTS), "utf8"))?.[1];
  if (run.referencing !== referencing) problems.push(`the oracle runs referencing ${run.referencing}, but ${ORACLE_REQUIREMENTS} pins ${referencing ?? "none"}; run: npm run setup:oracle`);
  return { problems, note: `python-jsonschema ${run.jsonschema}, referencing ${run.referencing}` };
}
