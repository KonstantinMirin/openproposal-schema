/**
 * Stage 5c's entry point: one build's model to its TypeScript, Python, and
 * Go SDKs, as files under the build's SDK directory (`sdkDirOf`, such as
 * `sdk/` or `sdk/proposed/with-open-prs/`): `ts/`, `python/`, and `go/`.
 * Every file is a function of the model; the emitters read nothing else.
 */
import { emitSchemas } from "./emit.ts";
import type { ModelDoc } from "./model.ts";
import { treeDigest } from "./release.ts";
import { allConstants, buildSdkModel, provenanceOf, type SdkFile, type SdkModel } from "./sdk.ts";
import { emitGo } from "./sdk-go.ts";
import { emitPython } from "./sdk-python.ts";
import { emitTypeScript } from "./sdk-ts.ts";

/** The language directories a lock's SDK directory holds. */
export const SDK_ROOTS = ["ts", "python", "go"] as const;

export interface EmittedSdk {
  sdk: SdkModel;
  /** Sorted by path, which is relative to the lock's SDK directory. */
  files: SdkFile[];
  problems: string[];
}

/**
 * Emits one build's SDKs. `sdkDir` is the build's SDK directory, such as
 * `sdk`, which the Go module path names, and `schemaDir` its schema
 * directory, such as `schemas/as-written`, whose tree's digest each SDK
 * states as the schema release its types match.
 */
export function emitSdk(model: ModelDoc, sdkDir: string, schemaDir: string): EmittedSdk {
  const { sdk, problems } = buildSdkModel(model);
  if (problems.length > 0) return { sdk, files: [], problems };
  const schemas = emitSchemas(model, schemaDir);
  if (schemas.problems.length > 0) return { sdk, files: [], problems: schemas.problems.map((p) => `schemas: ${p}`) };
  const prov = provenanceOf(sdk, treeDigest(schemas.files));
  const named = allConstants(sdk);
  if (named.problems.length > 0) return { sdk, files: [], problems: named.problems.map((p) => `constants: ${p}`) };
  const files: SdkFile[] = [];
  const langs: [string, { files: SdkFile[]; problems: string[] }][] = [
    ["ts", emitTypeScript(sdk, prov)],
    ["python", emitPython(sdk, prov)],
    ["go", emitGo(sdk, sdkDir, prov)],
  ];
  for (const [dir, out] of langs) {
    problems.push(...out.problems);
    for (const f of out.files) files.push({ path: `${dir}/${f.path}`, text: f.text });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { sdk, files, problems };
}
