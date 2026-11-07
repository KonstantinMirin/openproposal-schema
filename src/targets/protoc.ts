/**
 * protoc's verdict on a target's proto files: the compiler that
 * grpcio-tools bundles, pinned in tools/proto/requirements.txt and installed
 * into the venv by `npm run setup:proto`, so every machine and CI compile
 * with the same protoc.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The venv's Python, which runs protoc as `python -m grpc_tools.protoc`. */
export const protocPython = (root: string): string => join(root, ".venv", "bin", "python");

/**
 * Compiles every file of a tree, by path under its root, as one protoc run
 * with the root as its only import path, and gives protoc's errors. Writes
 * the files to a fresh temporary folder, so what compiles is what's given.
 */
export function compileProto(files: ReadonlyMap<string, Buffer | string>, root: string): { problems: string[]; version: string } {
  const python = protocPython(root);
  if (!existsSync(python)) return { problems: ["no venv at .venv; run: npm run setup:oracle && npm run setup:proto"], version: "" };
  const version = spawnSync(python, ["-I", "-m", "grpc_tools.protoc", "--version"], { encoding: "utf8" });
  if (version.status !== 0) return { problems: [`protoc doesn't run: ${`${version.error?.message ?? ""}${version.stderr ?? ""}`.trim()}; run: npm run setup:proto`], version: "" };
  if (files.size === 0) return { problems: ["no proto file to compile"], version: version.stdout.trim() };
  const dir = mkdtempSync(join(tmpdir(), "protoc-"));
  try {
    for (const [p, b] of files) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), b);
    }
    const r = spawnSync(python, ["-I", "-m", "grpc_tools.protoc", `--proto_path=${dir}`, `--descriptor_set_out=${join(dir, "descriptors.pb")}`, ...[...files.keys()].sort()], { cwd: dir, encoding: "utf8" });
    const output = `${r.error?.message ?? ""}${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    return { problems: r.status === 0 ? [] : [`protoc fails: ${output.split("\n").slice(0, 10).join("; ")}`], version: version.stdout.trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
