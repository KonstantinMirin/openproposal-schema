import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BUILD_OPTIONS, cliBuilds } from "../builds.ts";
import { emitSchemas, schemaDirOf } from "../emit.ts";
import { lockExamples } from "../examples.ts";
import { loadFieldExamples } from "../field-examples.ts";
import { codesOf } from "../rule-checks.ts";
import { generateTypeExamples, renderTypeExamples, TYPE_EXAMPLES_FILE, typeExamplesDirOf } from "../type-examples.ts";

/**
 * Usage: type-examples [--lock <file>] [--variant <name>] [--out <dir>]
 *
 * Resolves each lock's model and emits its schemas, as `npm run emit` does,
 * loads the specification's examples, as `npm run examples` does, then
 * builds a minimal and a full example payload for every named type the
 * schemas emit, with the values the specification's examples give where
 * they hold and else the per-field example values of
 * `field-examples/field-examples.yaml`, checks each against the schemas and the rules one payload
 * decides, and writes them to `examples.json`. The default lock's file goes
 * to `type-examples/`, another lock's to `type-examples/<its IR directory
 * under ir/>/`, such as `type-examples/with-open-prs/`, and each variant's
 * under `type-examples/<variant>/` (src/variant.ts). `--lock` generates one
 * lock, `--variant` one variant, or `proposed`, and `--out` sets the
 * directory of the one build it names. Exits 1, writing nothing for the
 * lock, if the model doesn't resolve, the schemas don't emit, no source
 * yields the specification's examples, or an example can't be built or
 * fails.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({ options: BUILD_OPTIONS });
  const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
  const fields = loadFieldExamples(root).fields;

  let failed = false;
  for (const b of cliBuilds(root, values)) {
    const { model, lock, kernel } = b;
    const codes = codesOf(kernel.lists ?? { lists: [] });
    if (b.problems.length > 0) {
      for (const p of b.problems) console.error(`error: ${b.label}: model: ${p}`);
      failed = true;
      continue;
    }
    const schemaDir = b.dirOf(schemaDirOf(b.irDir));
    const emitted = emitSchemas(model, schemaDir);
    if (emitted.problems.length > 0) {
      for (const p of emitted.problems) console.error(`error: ${b.label}: schemas: ${p}`);
      failed = true;
      continue;
    }
    let spec;
    try {
      spec = await lockExamples(lock, model);
    } catch (e) {
      console.error(`error: ${b.label}: the specification's examples: ${(e as Error).message.split("\n")[0]}`);
      failed = true;
      continue;
    }
    const r = generateTypeExamples({ model, files: emitted.files, kernel, schemaDir, codes, spec, fields });
    if (r.problems.length > 0) {
      for (const p of r.problems) console.error(`error: ${b.label}: type examples: ${p}`);
      failed = true;
      continue;
    }
    const out = values.out !== undefined ? resolve(values.out) : join(root, b.dirOf(typeExamplesDirOf(b.irDir)));
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, TYPE_EXAMPLES_FILE), renderTypeExamples(r.doc));
    const shown = out.startsWith(`${root}/`) ? out.slice(root.length + 1) : out;
    const entries = Object.values(r.doc.types);
    const reduced = entries.filter((x) => x.notes !== undefined).length;
    const { spec: given, showcase, term, field, other } = r.sources;
    console.log(`${b.label}: ${entries.length} types, a minimal and a full example each (${reduced} full examples hold less than every member, as their notes say) in ${shown}/${TYPE_EXAMPLES_FILE}; the full examples' own values: ${given} from the specification's examples, ${field} per-field values, ${showcase} showcase values, ${term} vocabulary terms, ${other} other`);
  }
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  },
);
