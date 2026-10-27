/**
 * Stage 5c's entry point: one lock's model to its TypeScript, Python, and Go
 * SDKs, as files under the lock's SDK directory (`sdk/`, or
 * `sdk/with-open-prs/`): `ts/`, `python/`, and `go/`. Every file is a
 * function of the model; the emitters read nothing else.
 */
import type { ModelDoc } from "./model.ts";
import { buildSdkModel, type SdkFile, type SdkModel } from "./sdk.ts";
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

/** Emits one lock's SDKs. `sdkDir` is the lock's SDK directory, such as `sdk`, which the Go module path names. */
export function emitSdk(model: ModelDoc, sdkDir: string): EmittedSdk {
  const { sdk, problems } = buildSdkModel(model);
  if (problems.length > 0) return { sdk, files: [], problems };
  const files: SdkFile[] = [];
  const langs: [string, { files: SdkFile[]; problems: string[] }][] = [
    ["ts", emitTypeScript(sdk)],
    ["python", emitPython(sdk)],
    ["go", emitGo(sdk, sdkDir)],
  ];
  for (const [dir, out] of langs) {
    problems.push(...out.problems);
    for (const f of out.files) files.push({ path: `${dir}/${f.path}`, text: f.text });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { sdk, files, problems };
}
