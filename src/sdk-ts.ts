/**
 * The TypeScript SDK: one file per module under `src/`, each declaration a
 * TypeScript type and a Zod 4 schema of the same name, so `LineItem` is both
 * the interface and `LineItem.parse(json)`. A constructor is a generic
 * interface or type and a function that builds its schema from its
 * arguments' schemas, so a property of `Selectable<FormatId, FormatId>` is typed
 * `Selectable<FormatId, FormatId>` and checked by `Selectable(FormatId, FormatId)`, and the copy
 * `FormatsSelection` is an alias of both. `runtime.ts` holds the checks Zod
 * doesn't state the way JSON Schema does: the formats, a length in code
 * points, a map's keys, an object's member counts, and its conditions, which
 * may require members or narrow a member's type.
 */
import { FORMAT_PATTERNS } from "./sdk-formats.ts";
import { lockPhrase, type Expr, type SdkFile, type SdkModel, type SdkTemplate, type SdkType, type Shape } from "./sdk.ts";

/** The Zod release the generated code is written against, as the package pins it. */
export const ZOD_VERSION = "4.6.7";

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (name: string) => (IDENT.test(name) ? name : JSON.stringify(name));
const fileOf = (module: string) => `${module}.ts`;
const doc = (text: string, indent = "") => {
  const lines = text.replaceAll("*/", "*\\/").split("\n");
  return lines.length === 1 ? `${indent}/** ${lines[0]} */\n` : `${indent}/**\n${lines.map((l) => `${indent} * ${l}`.trimEnd()).join("\n")}\n${indent} */\n`;
};
const num = (n: number) => JSON.stringify(n);
const param = (name: string) => name.toLowerCase();

/** An expression as a TypeScript type. */
function typeOf(e: Expr): string {
  switch (e.k) {
    case "ref":
    case "param":
      return e.name;
    case "boolean":
      return "boolean";
    case "list":
      return `Array<${typeOf(e.item)}>`;
    case "map":
      return `Partial<Record<${typeOf(e.key)}, ${typeOf(e.value)}>>`;
    case "apply":
      return `${e.template}<${e.args.map(typeOf).join(", ")}>`;
  }
}

/** An expression as the Zod schema that checks it. */
function schemaOf(e: Expr): string {
  switch (e.k) {
    case "ref":
      return e.name;
    case "param":
      return param(e.name);
    case "boolean":
      return "z.boolean()";
    case "list":
      return `z.array(${schemaOf(e.item)})`;
    case "map":
      return `rt.map(${schemaOf(e.key)}, ${schemaOf(e.value)})`;
    case "apply":
      return e.copy ?? `${e.template}(${e.args.map(schemaOf).join(", ")})`;
  }
}

const literal = (v: string | number) => JSON.stringify(v);

/** The interface body and the Zod object of a shape. */
function objectParts(shape: Shape, indent: string): { body: string; schema: string } {
  const members = shape.properties.map((p) => `${p.description ? doc(p.description, `${indent}  `) : ""}${indent}  ${key(p.name)}${p.required ? "" : "?"}: ${typeOf(p.expr)};\n`).join("");
  const rest = shape.open ? `${indent}  /** A member the object doesn't name, which it keeps. */\n${indent}  [member: string]: unknown;\n` : "";
  const fields = shape.properties.map((p) => `${indent}  ${key(p.name)}: ${schemaOf(p.expr)}${p.required ? "" : ".optional()"},\n`).join("");
  const checks: string[] = [];
  if (shape.minProperties !== undefined || shape.maxProperties !== undefined) checks.push(`rt.memberCount(${shape.minProperties ?? "undefined"}, ${shape.maxProperties ?? "undefined"})`);
  for (const d of shape.dependent) checks.push(`rt.dependent(${literal(d.member)}, ${d.maxProperties})`);
  for (const d of shape.requires) checks.push(`rt.requires(${literal(d.member)}, ${JSON.stringify(d.names)})`);
  for (const d of shape.within) checks.push(`rt.requiresWithin(${literal(d.member)}, ${JSON.stringify(d.inner)}, ${JSON.stringify(d.names)})`);
  for (const b of shape.bounds) checks.push(`rt.bounds(${literal(b.member)}, ${b.minItems}, ${b.unique})`);
  for (const r of shape.rejects) checks.push(`rt.rejects(${literal(r.sibling)}, ${JSON.stringify(r.value)})`);
  for (const c of shape.conditions) {
    const types = c.types.length > 0 ? `, { ${c.types.map((x) => `${key(x.name)}: ${schemaOf(x.expr)}`).join(", ")} }` : "";
    checks.push(`rt.condition(${literal(c.sibling)}, ${JSON.stringify(c.value)}, ${JSON.stringify(c.require)}${types})`);
  }
  const base = `z.${shape.open ? "looseObject" : "strictObject"}(${fields ? `{\n${fields}${indent}}` : "{}"})`;
  return { body: `{\n${members}${rest}${indent}}`, schema: checks.length > 0 ? `${base}.check(${checks.join(", ")})` : base };
}

function scalarSchema(t: Extract<SdkType, { kind: "scalar" }>): { type: string; schema: string } {
  const s = t.scalar;
  if (s.enum) {
    const type = s.enum.map(literal).join(" | ");
    return { type, schema: s.json === "string" ? `z.enum([${s.enum.map(literal).join(", ")}])` : `z.literal([${s.enum.map(literal).join(", ")}])` };
  }
  switch (s.json) {
    case "boolean":
      return { type: "boolean", schema: "z.boolean()" };
    case "number":
    case "integer": {
      let z = "z.number()";
      if (s.minimum !== undefined) z += `.gte(${num(s.minimum)})`;
      if (s.exclusiveMinimum !== undefined) z += `.gt(${num(s.exclusiveMinimum)})`;
      if (s.maximum !== undefined) z += `.lte(${num(s.maximum)})`;
      if (s.exclusiveMaximum !== undefined) z += `.lt(${num(s.exclusiveMaximum)})`;
      if (s.json === "integer") z += `.refine(Number.isInteger, "isn't an integer")`;
      return { type: "number", schema: z };
    }
    case "string": {
      let z = "z.string()";
      if (s.pattern !== undefined) z += `.regex(new RegExp(${JSON.stringify(s.pattern)}, "u"))`;
      if (s.format !== undefined) z += `.refine(rt.format(${literal(s.format)}), "isn't a valid ${s.format}")`;
      if (s.minLength !== undefined) z += `.refine((s) => rt.codePoints(s) >= ${s.minLength}, "is shorter than ${s.minLength} characters")`;
      if (s.maxLength !== undefined) z += `.refine((s) => rt.codePoints(s) <= ${s.maxLength}, "is longer than ${s.maxLength} characters")`;
      return { type: "string", schema: z };
    }
  }
}

function declaration(t: SdkType): string {
  const head = doc(t.doc);
  switch (t.kind) {
    case "scalar": {
      const { type, schema } = scalarSchema(t);
      return `${head}export type ${t.name} = ${type};\nexport const ${t.name}: z.ZodType<${t.name}> = ${schema};\n`;
    }
    case "enum": {
      // An open vocabulary whose core terms the specification doesn't list accepts namespaced terms only.
      if (t.open && t.values.length === 0) return `${head}export type ${t.name} = NamespacedTerm;\nexport const ${t.name}: z.ZodType<${t.name}> = NamespacedTerm;\n`;
      const values = t.values.map(literal);
      const core = t.json === "string" ? `z.enum([${values.join(", ")}])` : `z.literal([${values.join(", ")}])`;
      const type = [...values, ...(t.open ? [t.extension] : [])].join(" | ");
      const schema = t.open ? `z.union([${core}, ${t.extension}])` : core;
      const labels = t.values.flatMap((v, i) => (t.labels[i] ? [`- \`${v}\`: ${t.labels[i]}`] : []));
      const docText = labels.length > 0 ? doc([t.doc, "", ...labels].join("\n")) : head;
      return `${docText}export type ${t.name} = ${type};\nexport const ${t.name}: z.ZodType<${t.name}> = ${schema};\n`;
    }
    case "object": {
      const { body, schema } = objectParts(t.shape, "");
      return `${head}export interface ${t.name} ${body}\nexport const ${t.name}: z.ZodType<${t.name}> = ${schema};\n`;
    }
    case "union":
      return `${head}export type ${t.name} = ${t.branches.map(typeOf).join(" | ")};\nexport const ${t.name}: z.ZodType<${t.name}> = z.union([${t.branches.map(schemaOf).join(", ")}]);\n`;
    case "alias":
      return `${head}export type ${t.name} = ${typeOf(t.expr)};\nexport const ${t.name}: z.ZodType<${t.name}> = ${schemaOf(t.expr)};\n`;
  }
}

function templateDeclaration(t: SdkTemplate): string {
  const tparams = t.params.map((p) => (p.accepts === "string" ? `${p.name} extends string` : p.name)).join(", ");
  const targs = t.params.map((p) => p.name).join(", ");
  const args = t.params.map((p) => `${param(p.name)}: z.ZodType<${p.name}>`).join(", ");
  const paramDocs = t.params.map((p) => ` * @param ${param(p.name)} ${p.description}\n`).join("");
  const head = `/**\n * ${t.doc.replaceAll("*/", "*\\/")}\n */\n`;
  const fnHead = `/**\n * The schema of \`${t.name}\` applied to its arguments' schemas.\n *\n${paramDocs} */\n`;
  if (t.body.kind === "union") {
    return `${head}export type ${t.name}<${tparams}> = ${t.body.branches.map(typeOf).join(" | ")};\n${fnHead}export function ${t.name}<${tparams}>(${args}): z.ZodType<${t.name}<${targs}>> {\n  return z.union([${t.body.branches.map(schemaOf).join(", ")}]);\n}\n`;
  }
  const { body, schema } = objectParts(t.body.shape, "");
  const indented = schema.split("\n").join("\n  ");
  return `${head}export interface ${t.name}<${tparams}> ${body}\n${fnHead}export function ${t.name}<${tparams}>(${args}): z.ZodType<${t.name}<${targs}>> {\n  return ${indented};\n}\n`;
}

const RUNTIME = (lock: string) => `${banner(lock)}/**
 * The checks the generated schemas share, where Zod doesn't state a check
 * the way JSON Schema 2020-12 does.
 */
import { z } from "zod";

const FORMATS = {
${Object.entries(FORMAT_PATTERNS)
  .map(([k, v]) => `  ${JSON.stringify(k)}: new RegExp(${JSON.stringify(v)}, "u"),`)
  .join("\n")}
} as const;

/** The format names the schemas use. */
export type Format = keyof typeof FORMATS;

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (y: number, m: number) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0;
const validDate = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);

/** Whether a string is valid in a format, by its RFC grammar and ranges. */
export function isFormat(format: Format, s: string): boolean {
  const m = FORMATS[format].exec(s);
  if (!m) return false;
  if (format === "date") return validDate(+m[1]!, +m[2]!, +m[3]!);
  if (format !== "date-time") return true;
  if (!validDate(+m[1]!, +m[2]!, +m[3]!)) return false;
  const [hour, minute, second] = [+m[4]!, +m[5]!, +m[6]!];
  const sign = m[7] === "-" ? -1 : 1;
  const [oh, om] = [+(m[8] ?? 0), +(m[9] ?? 0)];
  if (hour > 23 || minute > 59 || oh > 23 || om > 59) return false;
  if (second <= 59) return true;
  if (second !== 60) return false;
  // A leap second falls at 23:59 UTC (RFC 3339 § 5.7).
  const utc = (((hour * 60 + minute - sign * (oh * 60 + om)) % 1440) + 1440) % 1440;
  return utc === 23 * 60 + 59;
}

/** A refinement that a string is valid in a format. */
export const format = (f: Format) => (s: string) => isFormat(f, s);

/** A string's length in Unicode code points, as JSON Schema counts it. */
export const codePoints = (s: string) => [...s].length;

type Payload = z.core.ParsePayload<object>;
const fail = (payload: Payload, message: string) => payload.issues.push({ code: "custom", message, input: payload.value });

/** A check that an object holds at least \`min\` and at most \`max\` members. */
export const memberCount = (min: number | undefined, max: number | undefined) => (payload: Payload) => {
  const n = Object.keys(payload.value).length;
  if (min !== undefined && n < min) fail(payload, \`holds \${n} members, fewer than \${min}\`);
  if (max !== undefined && n > max) fail(payload, \`holds \${n} members, more than \${max}\`);
};

/** A check that an object that holds \`member\` holds at most \`max\` members. */
export const dependent = (member: string, max: number) => (payload: Payload) => {
  const n = Object.keys(payload.value).length;
  if (member in payload.value && n > max) fail(payload, \`holds "\${member}" and \${n - 1} other members; with "\${member}" it holds at most \${max}\`);
};

/** A check that an object that holds \`member\` holds each of \`names\`, as a money value holds its currency. */
export const requires = (member: string, names: string[]) => (payload: Payload) => {
  const v = payload.value as Record<string, unknown>;
  if (!(member in v)) return;
  for (const n of names) if (!(n in v)) fail(payload, \`lacks "\${n}", which is required with "\${member}"\`);
};

/** A check that an object whose \`member\` is an object holding each of \`inner\` holds each of \`names\`, as a line item whose frequency cap has a period holds its time zone. */
export const requiresWithin = (member: string, inner: string[], names: string[]) => (payload: Payload) => {
  const v = payload.value as Record<string, unknown>;
  const m = v[member];
  if (m === null || typeof m !== "object" || Array.isArray(m) || !inner.every((i) => i in m)) return;
  for (const n of names) if (!(n in v)) fail(payload, \`lacks "\${n}", which is required with "\${member}.\${inner.join(\`", "\${member}.\`)}"\`);
};

/** A JSON value with its object keys sorted, so two equal values have one spelling. */
const canonical = (x: unknown): string =>
  Array.isArray(x) ? \`[\${x.map(canonical).join(",")}]\` : x !== null && typeof x === "object" ? \`{\${Object.keys(x).sort().map((k) => \`\${JSON.stringify(k)}:\${canonical((x as Record<string, unknown>)[k])}\`).join(",")}}\` : JSON.stringify(x);

/** A check that an object's list \`member\` holds at least \`minItems\` items, each once where \`unique\`, as a daypart window's \`days\`. */
export const bounds = (member: string, minItems: number, unique: boolean) => (payload: Payload) => {
  const v = payload.value as Record<string, unknown>;
  const m = v[member];
  if (!Array.isArray(m)) return;
  if (m.length < minItems) fail(payload, \`"\${member}" holds \${m.length} items, fewer than \${minItems}\`);
  if (unique && new Set(m.map(canonical)).size !== m.length) fail(payload, \`"\${member}" holds an item twice\`);
};

/** A check that an object's \`sibling\` isn't \`value\`, a value the member can't take, as a daypart window's \`start\` can't be \`24:00\`. */
export const rejects = (sibling: string, value: string | number | boolean) => (payload: Payload) => {
  const v = payload.value as Record<string, unknown>;
  if (sibling in v && v[sibling] === value) fail(payload, \`"\${sibling}" is \${JSON.stringify(value)}, which it cannot be\`);
};

/** A check that an object whose \`sibling\` equals \`value\` holds each of \`require\`, and that each member \`types\` names is a value of its type. */
export const condition = (sibling: string, value: string | number | boolean, require: string[], types: Record<string, z.ZodType> = {}) => (payload: Payload) => {
  const v = payload.value as Record<string, unknown>;
  if (!(sibling in v) || v[sibling] !== value) return;
  for (const r of require) if (!(r in v)) fail(payload, \`lacks "\${r}", which is required when "\${sibling}" is \${JSON.stringify(value)}\`);
  for (const [m, t] of Object.entries(types)) {
    if (!(m in v)) continue;
    const r = t.safeParse(v[m]);
    if (!r.success) fail(payload, \`"\${m}" \${r.error.issues[0]?.message ?? "is invalid"} while "\${sibling}" is \${JSON.stringify(value)}\`);
  }
};

/** A map: an object whose keys are values of \`key\` and whose members are values of \`value\`. */
export function map<K extends string, V>(key: z.ZodType<K>, value: z.ZodType<V>): z.ZodType<Partial<Record<K, V>>> {
  return z.record(z.string(), value).check((payload) => {
    for (const k of Object.keys(payload.value)) {
      const r = key.safeParse(k);
      if (!r.success) payload.issues.push({ code: "custom", message: \`the key \${JSON.stringify(k)} \${r.error.issues[0]?.message ?? "is invalid"}\`, input: k, path: [k] });
    }
  }) as unknown as z.ZodType<Partial<Record<K, V>>>;
}
`;

const REGISTRY = (lock: string) => `${banner(lock)}/**
 * The extension registry seam: where an extension's validator is registered
 * under the extension's URI and the digest of its definition, so a receiver
 * can find the validator for extension data it meets. The model declares no
 * extension point yet, so no generated type calls it.
 */
import { isFormat } from "./runtime.js";

/** A SHA-256 digest of an extension's definition, as 64 lowercase hexadecimal characters. */
const DIGEST = /^[0-9a-f]{64}$/u;

/** Checks an extension's data, and returns what is wrong with it, or nothing. */
export type ExtensionValidator = (data: unknown) => readonly string[];

/** What an extension package exports: it registers its validators. */
export interface Extension {
  register(registry: ExtensionRegistry): void;
}

/** Extension validators, by the extension's URI and the digest of its definition. */
export class ExtensionRegistry {
  private readonly entries = new Map<string, ExtensionValidator>();

  private static keyOf(uri: string, digest: string): string {
    if (!isFormat("uri", uri)) throw new Error(\`\${JSON.stringify(uri)} isn't an absolute URI\`);
    if (!DIGEST.test(digest)) throw new Error(\`\${JSON.stringify(digest)} isn't a SHA-256 digest in lowercase hexadecimal\`);
    return \`\${digest} \${uri}\`;
  }

  /** Registers the validator of one extension version. Registering the same URI and digest twice is an error. */
  register(uri: string, digest: string, validate: ExtensionValidator): void {
    const k = ExtensionRegistry.keyOf(uri, digest);
    if (this.entries.has(k)) throw new Error(\`an extension is already registered as \${uri} with the digest \${digest}\`);
    this.entries.set(k, validate);
  }

  /** The validator registered for the URI and digest, if any. */
  lookup(uri: string, digest: string): ExtensionValidator | undefined {
    return this.entries.get(ExtensionRegistry.keyOf(uri, digest));
  }

  /** How many extension versions are registered. */
  get size(): number {
    return this.entries.size;
  }
}
`;

const banner = (lock: string) => `// Generated by \`npm run sdk\` from the OpenProposal model of ${lock}. Do not edit.\n\n`;

/** The TypeScript SDK of one lock's SDK model, as files under the lock's `ts/` directory. */
export function emitTypeScript(sdk: SdkModel): { files: SdkFile[]; problems: string[] } {
  const problems: string[] = [];
  const lock = lockPhrase(sdk.input);
  const moduleOf = new Map<string, string>([...[...sdk.types.values()].map((t): [string, string] => [t.name, t.module]), ...[...sdk.templates.values()].map((t): [string, string] => [t.name, t.module])]);
  const files: SdkFile[] = [];
  for (const module of sdk.modules) {
    const names = sdk.order.filter((n) => moduleOf.get(n) === module);
    const imports = new Map<string, Set<string>>();
    const parts: string[] = [];
    for (const n of names) {
      const t = sdk.types.get(n);
      const tpl = sdk.templates.get(n);
      const deps = t?.deps ?? tpl!.deps;
      for (const d of deps) {
        const m = moduleOf.get(d);
        if (m === undefined) problems.push(`ts: "${n}" references "${d}", which no module declares`);
        else if (m !== module) imports.set(m, (imports.get(m) ?? new Set()).add(d));
      }
      parts.push(t ? declaration(t) : templateDeclaration(tpl!));
    }
    const importLines = [...imports.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([m, set]) => `import { ${[...set].sort().join(", ")} } from "./${m}.js";\n`)
      .join("");
    const usesRt = parts.some((p) => p.includes("rt."));
    const text = `${banner(lock)}/** The OpenProposal \`${module}\` module's types. */\nimport { z } from "zod";\n${usesRt ? 'import * as rt from "./runtime.js";\n' : ""}${importLines}\n${parts.join("\n")}`;
    files.push({ path: `src/${fileOf(module)}`, text });
  }
  const emitted = sdk.emitted.map((n) => `  ${key(n)}: ${n},\n`).join("");
  const templates = [...sdk.templates.keys()].sort().map((n) => `  ${key(n)}: ${n} as Template,\n`).join("");
  const allNames = [...new Set([...sdk.emitted, ...sdk.templates.keys()])];
  const indexImports = sdk.modules
    .map((m) => {
      const ns = allNames.filter((n) => moduleOf.get(n) === m).sort();
      return ns.length > 0 ? `import { ${ns.join(", ")} } from "./${m}.js";\n` : "";
    })
    .join("");
  files.push({
    path: "src/index.ts",
    text: `${banner(lock)}/**
 * The OpenProposal types of ${lock}: each named type the schema
 * emits, as a TypeScript type and a Zod schema of the same name, and each
 * constructor as a generic type and a function that builds its schema.
 */
import type { z } from "zod";
${indexImports}
${sdk.modules.map((m) => `export * from "./${m}.js";\n`).join("")}export * from "./registry.js";
export { isFormat, type Format } from "./runtime.js";

/** A constructor's schema function, applied to its arguments' schemas. */
export type Template = (...args: z.ZodType[]) => z.ZodType;

/** The schema of every named type the JSON Schema emits, by name. */
export const TYPES: Readonly<Record<string, z.ZodType>> = {
${emitted}};

/** Every constructor's schema function, by name. */
export const TEMPLATES: Readonly<Record<string, Template>> = {
${templates}};
`,
  });
  files.push({ path: "src/runtime.ts", text: RUNTIME(lock) });
  files.push({ path: "src/registry.ts", text: REGISTRY(lock) });
  files.push({
    path: "package.json",
    text: `${JSON.stringify(
      {
        name: "openproposal-types",
        private: true,
        description: `The OpenProposal types of ${lock}, generated from the model. Do not edit.`,
        type: "module",
        exports: { ".": "./src/index.ts" },
        dependencies: { zod: ZOD_VERSION },
      },
      null,
      2,
    )}\n`,
  });
  files.push({
    path: "tsconfig.json",
    text: `${JSON.stringify(
      {
        compilerOptions: { target: "ES2023", lib: ["ES2023"], module: "NodeNext", moduleResolution: "NodeNext", strict: true, noUncheckedIndexedAccess: true, noEmit: true, skipLibCheck: true, types: [] },
        include: ["src"],
      },
      null,
      2,
    )}\n`,
  });
  return { files, problems };
}
