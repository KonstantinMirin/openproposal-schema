import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { emitProto, type ProtoSettings } from "../targets/proto.ts";
import { readSchemaTree } from "../targets/schema-tree.ts";

/**
 * Usage: proto [--spec <spec>] [--out <dir>]
 *        proto --schemas <dir> --package <package> --out <dir>
 *
 * The protocol buffer target (src/targets/proto.ts): writes each
 * integer-coded vocabulary of a published schema tree as a proto3 enum. With
 * `--spec`, the default, it reads the spec's `schemas/` and the package its
 * profile names under `names.proto`, and replaces the spec's `proto/`, or
 * writes under `--out`. With `--schemas` it reads that tree alone, as the
 * public export publishes it, and the package `--package` gives, and reads
 * no other file. The output folder is replaced whole, so it must hold only
 * proto files, or not exist, and not hold the schema tree. Exits 1, writing
 * nothing, on a problem.
 */
/** The files under a folder that aren't `.proto` files, by path from it; none for a missing folder. */
function strayFiles(dir: string, rel = ""): string[] {
  const abs = join(dir, rel);
  if (!existsSync(abs)) return [];
  if (!statSync(abs).isDirectory()) return rel.endsWith(".proto") ? [] : [rel];
  return readdirSync(abs)
    .sort()
    .flatMap((f) => strayFiles(dir, rel === "" ? f : join(rel, f)));
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { spec: { type: "string" }, schemas: { type: "string" }, package: { type: "string" }, out: { type: "string" } } });
  let root: string;
  let settings: ProtoSettings;
  let out: string;
  if (values.schemas !== undefined) {
    if (values.spec !== undefined) throw new Error("--schemas reads a tree alone; drop --spec");
    if (values.package === undefined || values.out === undefined) throw new Error("--schemas needs --package and --out");
    root = resolve(values.schemas);
    settings = { package: values.package };
    out = resolve(values.out);
  } else {
    if (values.package !== undefined) throw new Error("--package goes with --schemas; a spec's package is its profile's names.proto");
    // Only a spec's run reads its profile, for the package and the folders.
    const { specRoot } = await import("../repo.ts");
    const { loadProfile } = await import("../profile.ts");
    const spec = specRoot(values.spec);
    const profile = loadProfile(spec);
    if (!profile.names.proto) throw new Error(`${relative(process.cwd(), profile.file)}: names no proto package (names.proto), so the spec has no proto files`);
    root = join(spec, "schemas");
    settings = profile.names.proto;
    const { PROTO_DIR } = await import("../targets/layout.ts");
    out = values.out !== undefined ? resolve(values.out) : join(spec, PROTO_DIR);
  }
  // The output folder is replaced whole, so it may hold only proto files and folders, and not the schema tree.
  if (root === out || root.startsWith(`${out}${sep}`)) throw new Error(`--out ${relative(process.cwd(), out) || "."} holds the schema tree; write the proto files elsewhere`);
  const stray = strayFiles(out);
  if (stray.length > 0) throw new Error(`--out ${relative(process.cwd(), out) || "."} holds ${stray.slice(0, 3).join(", ")}, which isn't a proto file; it is replaced whole, so give a folder of proto files or a new one`);
  const emitted = emitProto(readSchemaTree(root), settings);
  for (const p of emitted.problems) console.error(`error: ${p}`);
  if (emitted.problems.length > 0) return 1;
  rmSync(out, { recursive: true, force: true });
  for (const f of emitted.files) {
    mkdirSync(dirname(join(out, f.path)), { recursive: true });
    writeFileSync(join(out, f.path), f.text);
  }
  const values_ = emitted.enums.reduce((n, e) => n + e.values.length, 0);
  console.log(`${emitted.files.length} files, ${emitted.enums.length} enums, ${values_} values; ${relative(process.cwd(), out) || "."}/`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: Error) => {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  },
);
