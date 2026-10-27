/**
 * The per-field example values (`field-examples/field-examples.yaml`): for a
 * member the specification's examples give no value, a value a reader's
 * example payload shows in place of its primitive's showcase value or its
 * vocabulary's representative term, such as `Net 30 from the end of the
 * calendar month` for a line item's payment terms. They're for readers'
 * examples only (src/type-examples.ts), not conformance vectors.
 *
 * Each entry names the member by the IR element its property rests on and
 * the member's name, so an entry goes stale with the text: the type-examples
 * gate fails on an entry whose element or member is gone. A value is the
 * member's whole value, a list or an object too; a second value is for the
 * second option of a selection. An entry may carry a note, which the type
 * examples list beside the value, such as that its structure is a proposal of
 * the feedback, not the specification's.
 */
import { join } from "node:path";
import { schemaIdOf } from "./emit.ts";
import { inScope, readYaml } from "./mapping.ts";
import type { ModelDoc } from "./model.ts";
import { compileSchema } from "./pipeline.ts";

export interface FieldExample {
  /** The IR element the member's property rests on, one of its `sources` in the model. */
  ir: string;
  /** The member's name in its type. */
  member: string;
  /** One value, or two, the second for a second option. */
  values: unknown[];
  /** The locks the entry is for; every lock when absent. */
  locks?: string[];
  /** What a reader should know about the value, which the type examples list beside it. */
  note?: string;
}

export interface FieldExamplesFile {
  format: 1;
  fields: FieldExample[];
  file: string;
}

export const FIELD_EXAMPLES_FILE = join("field-examples", "field-examples.yaml");
const FIELD_EXAMPLES_SCHEMA = join("field-examples", "field-examples.schema.json");

/** Loads and validates the per-field example values. */
export function loadFieldExamples(root: string, file = join(root, FIELD_EXAMPLES_FILE)): FieldExamplesFile {
  const doc = readYaml(file);
  const errors = compileSchema(join(root, FIELD_EXAMPLES_SCHEMA))(doc);
  if (errors.length > 0) throw new Error(`${file}: not a valid field examples file: ${errors.join("; ")}`);
  return { ...(doc as Omit<FieldExamplesFile, "file">), file };
}

/** An entry's key, as a problem names it. */
export const fieldKey = (e: Pick<FieldExample, "ir" | "member">) => `${e.ir} ${e.member}`;

/** One place an entry's value goes: the schema location of the member's property, in the type that holds it. */
export interface FieldLocation {
  /** `<file $id>#<JSON pointer>` of the property. */
  at: string;
  /** The type that holds the member. */
  type: string;
  /** The `$id` of that type's schema, with its fragment. */
  schema: string;
  /** The property's type, when it's a named type. */
  named?: string;
}

const escape = (token: string) => token.replaceAll("~", "~0").replaceAll("/", "~1");

/** The entries in scope on the lock, each with the locations of every property named `member` whose sources hold `ir`, in the model's type order. */
export function fieldLocations(model: ModelDoc, schemaDir: string, fields: FieldExample[]): { entry: FieldExample; locations: FieldLocation[] }[] {
  return fields
    .filter((e) => inScope(e.locks, model.input.lock))
    .map((entry) => ({
      entry,
      locations: model.types.flatMap((t) => {
        if (!("properties" in t)) return [];
        const p = t.properties[entry.member];
        const id = schemaIdOf(t, schemaDir);
        if (!p || !p.sources.includes(entry.ir) || id === null) return [];
        const loc = id.includes("#") ? id : `${id}#`;
        return [{ at: `${loc}/properties/${escape(entry.member)}`, type: t.name, schema: id, ...(p.type.kind === "named" ? { named: p.type.name } : {}) }];
      }),
    }));
}
