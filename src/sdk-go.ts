/**
 * The Go SDK: the package `openproposal`, one file per model module, with
 * the standard library only. Each named type is a Go type of the same name
 * with a `ValidateValue` method, which checks a JSON value, parsed with its
 * numbers kept exact, the way the type's schema does; `Decode[T]` checks a
 * JSON text and then decodes it into a `T`. A constructor is a generic type,
 * so a property of `Selectable<FormatId, FormatId>` is a `Selectable[FormatId, FormatId]` and
 * the copy `FormatsSelection` is an alias of it; `List[T]` and `Map[K, V]` are the
 * generic slice and map that hold the lists and maps the schema fills in
 * place. An optional member is a pointer, or a list or map that `omitzero`
 * leaves out when absent, so a decoded value encodes back to what it was
 * decoded from. An open object keeps the members it doesn't name in `Extra`.
 * A union is a struct with one pointer per branch, of which decoding sets
 * the first branch the value is valid in.
 */
import { FORMAT_PATTERNS } from "./sdk-formats.ts";
import { lockPhrase, PROVENANCE_DOCS, type Expr, type Provenance, type SdkFile, type SdkModel, type SdkTemplate, type SdkType, type Shape } from "./sdk.ts";

/** The Go version the generated module declares; `omitzero` needs Go 1.24. */
export const GO_VERSION = "1.25";
/** The module path of the default lock's SDK; another lock's is under it at its directory, as the repository holds it. */
export const GO_MODULE_BASE = "github.com/KonstantinMirin/openproposal-schema";

/** Names the runtime declares, which no model type may take. */
const RUNTIME_NAMES = new Set(["Decode", "Error", "Errors", "Extension", "ExtensionRegistry", "ExtensionValidator", "Extensions", "Key", "List", "Map", "ParseJSON", "Type", "TypeOf", "Types", "Validate", "Value"]);

const str = (s: string) => JSON.stringify(s);
const comment = (text: string, indent = "") => `${text.split("\n").map((l) => `${indent}// ${l}`.trimEnd()).join("\n")}\n`;
const moduleFile = (module: string) => `${module.replaceAll("-", "_")}_types.go`;
const pascal = (s: string) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter((x) => x !== "")
    .map((x) => x[0]!.toUpperCase() + x.slice(1))
    .join("");

/**
 * The initialisms a term's words may be, which Go writes in one case, as
 * its own names write `ID` and `URL`: the ones the terms use, and the common
 * ones Go's style lists. `oauth2` is written `OAuth2`.
 */
const INITIALISMS = new Set(["API", "CPC", "CPM", "CTV", "DAI", "DOOH", "DSP", "HTTP", "HTTPS", "IAB", "ID", "IO", "IOS", "IP", "JSON", "JWT", "OIDC", "SSAI", "SSP", "TV", "UI", "URI", "URL", "UUID", "XML"]);
const SPECIAL_WORDS = new Map([["oauth2", "OAuth2"]]);

/**
 * A term as the suffix of its constant's Go name: each word of the term,
 * split at a character that can't be in a name, is capitalized, an
 * initialism is in upper case, and a term in upper snake case is read as
 * words, so `viewable_rate` gives `ViewableRate`, `PREFERRED_DEAL` gives
 * `PreferredDeal`, and `ctv` and `DIRECT_IO` give `CTV` and `DirectIO`.
 */
export const goTermName = (term: string): string =>
  term
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== "")
    .map((w) => {
      const lower = w.toLowerCase();
      if (SPECIAL_WORDS.has(lower)) return SPECIAL_WORDS.get(lower)!;
      if (INITIALISMS.has(w.toUpperCase())) return w.toUpperCase();
      return lower[0]!.toUpperCase() + lower.slice(1);
    })
    .join("");

/** An expression as a Go type. */
function goType(e: Expr): string {
  switch (e.k) {
    case "ref":
    case "param":
      return e.name;
    case "boolean":
      return "bool";
    case "list":
      return `List[${goType(e.item)}]`;
    case "map":
      return `Map[${goType(e.key)}, ${goType(e.value)}]`;
    case "apply":
      return `${e.template}[${e.args.map(goType).join(", ")}]`;
  }
}

/** The statement that checks the JSON value `x` at `at` against an expression. */
const check = (e: Expr, x: string, at: string) => (e.k === "boolean" ? `validateBool(${x}, ${at}, errs)` : `validateAs[${goType(e)}](${x}, ${at}, errs)`);

/** A Go literal of a JSON scalar, as `jsonEqual` compares it with a parsed value. */
const jsonLiteral = (v: string | number | boolean) => (typeof v === "string" ? str(v) : typeof v === "number" ? `json.Number(${str(String(v))})` : String(v));

interface Ctx {
  problems: string[];
  where: string;
}

function fieldName(name: string, ctx: Ctx): string {
  const n = pascal(name);
  if (!/^[A-Z][A-Za-z0-9]*$/.test(n)) ctx.problems.push(`go: ${ctx.where}: the member "${name}" gives no Go field name`);
  return n;
}

/** A struct's fields, its `ValidateValue` body, and, for an open object, its JSON methods. */
function objectParts(shape: Shape, ctx: Ctx): { fields: string; validate: string } {
  const names = new Map<string, string>();
  const fields = shape.properties
    .map((p) => {
      const f = fieldName(p.name, ctx);
      if (names.has(f) || (shape.open && f === "Extra")) ctx.problems.push(`go: ${ctx.where}: the members "${names.get(f) ?? "Extra"}" and "${p.name}" both give the Go field ${f}`);
      names.set(f, p.name);
      const t = goType(p.expr);
      const inline = p.expr.k === "list" || p.expr.k === "map";
      const decl = p.required ? `${f} ${t} \`json:${str(p.name)}\`` : inline ? `${f} ${t} \`json:${str(`${p.name},omitzero`)}\`` : `${f} *${t} \`json:${str(`${p.name},omitempty`)}\``;
      return `${comment(p.description ? `${f}: ${p.description}` : `${f} is the \`${p.name}\` member.`, "\t")}\t${decl}\n`;
    })
    .join("");
  const extra = shape.open ? `${comment("Extra holds the members the object doesn't name, which it keeps.", "\t")}\tExtra map[string]json.RawMessage \`json:"-"\`\n` : "";
  const all = shape.properties.map((p) => str(p.name)).join(", ");
  const required = shape.properties.filter((p) => p.required).map((p) => str(p.name));
  const lines: string[] = [];
  if (required.length > 0) lines.push(`\tcheckRequired(m, at, errs, ${required.join(", ")})`);
  if (!shape.open) lines.push(`\tcheckClosed(m, at, errs${all ? `, ${all}` : ""})`);
  if (shape.minProperties !== undefined || shape.maxProperties !== undefined) lines.push(`\tcheckMemberCount(m, at, errs, ${shape.minProperties ?? -1}, ${shape.maxProperties ?? -1})`);
  for (const d of shape.dependent) lines.push(`\tcheckDependent(m, at, errs, ${str(d.member)}, ${d.maxProperties})`);
  for (const d of shape.requires) lines.push(`\tcheckRequiredWith(m, at, errs, ${str(d.member)}, ${d.names.map(str).join(", ")})`);
  for (const d of shape.within) lines.push(`\tcheckRequiredWithin(m, at, errs, ${str(d.member)}, []string{${d.inner.map(str).join(", ")}}, ${d.names.map(str).join(", ")})`);
  for (const b of shape.bounds) lines.push(`\tcheckBounds(m, at, errs, ${str(b.member)}, ${b.minItems}, ${b.unique})`);
  for (const r of shape.rejects) lines.push(`\tif x, ok := m[${str(r.sibling)}]; ok && jsonEqual(x, ${jsonLiteral(r.value)}) {`, `\t\terrs.add(member(at, ${str(r.sibling)}), "is %s, which it cannot be", ${str(JSON.stringify(r.value))})`, "\t}");
  for (const p of shape.properties) lines.push(`\tif x, ok := m[${str(p.name)}]; ok {`, `\t\t${check(p.expr, "x", `member(at, ${str(p.name)})`)}`, "\t}");
  for (const c of shape.conditions) {
    lines.push(`\tif x, ok := m[${str(c.sibling)}]; ok && jsonEqual(x, ${jsonLiteral(c.value)}) {`);
    if (c.require.length > 0) lines.push(`\t\tcheckRequiredWhen(m, at, errs, ${str(c.sibling)}, ${c.require.map(str).join(", ")})`);
    for (const t of c.types) lines.push(`\t\tif x, ok := m[${str(t.name)}]; ok {`, `\t\t\t${check(t.expr, "x", `member(at, ${str(t.name)})`)}`, "\t\t}");
    lines.push("\t}");
  }
  const head = lines.length > 0 ? ["\tm, ok := objectValue(v, at, errs)", "\tif !ok {", "\t\treturn", "\t}"] : ["\tobjectValue(v, at, errs)"];
  return { fields: fields + extra, validate: [...head, ...lines].join("\n") };
}

/** UnmarshalJSON and MarshalJSON for an open object, which keep the members it doesn't name. */
function openMethods(name: string, shape: Shape): string {
  const names = shape.properties.map((p) => str(p.name)).join(", ");
  return `
// UnmarshalJSON decodes the members ${name} names into its fields, matching each name exactly, and keeps the others in Extra.
func (o *${name}) UnmarshalJSON(data []byte) error {
	type plain ${name}
	known, extra, err := splitMembers(data${names ? `, ${names}` : ""})
	if err != nil {
		return err
	}
	var p plain
	if err := json.Unmarshal(known, &p); err != nil {
		return err
	}
	p.Extra = extra
	*o = ${name}(p)
	return nil
}

// MarshalJSON encodes the members in Extra beside the ones ${name} names.
func (o ${name}) MarshalJSON() ([]byte, error) {
	type plain ${name}
	return marshalOpen(plain(o), o.Extra)
}
`;
}

/** A union's struct, its ValidateValue, and its JSON methods. `recv` is the receiver type, with its type parameters. */
function unionParts(name: string, recv: string, branches: Expr[], ctx: Ctx, typeParams = ""): string {
  const fields = branches.map((b) => {
    if (b.k === "param") return "Value";
    if (b.k === "ref") return b.name;
    if (b.k === "apply") return b.copy ?? b.template;
    ctx.problems.push(`go: ${ctx.where}: a union branch ${goType(b)} is no named type, copy, or parameter`);
    return "Invalid";
  });
  if (new Set(fields).size !== fields.length) ctx.problems.push(`go: ${ctx.where}: two branches give one field name (${fields.join(", ")})`);
  const decl = branches.map((b, i) => `${comment(`${fields[i]} holds the value when it is a ${goType(b)}.`, "\t")}\t${fields[i]} *${goType(b)}\n`).join("");
  const validators = branches.map((b) => (b.k === "boolean" ? "validateBool" : `validateAs[${goType(b)}]`)).join(", ");
  const decode = branches
    .map((b, i) => `\tcase validates[${goType(b)}](v):\n\t\tu.${fields[i]} = new(${goType(b)})\n\t\treturn json.Unmarshal(data, u.${fields[i]})\n`)
    .join("");
  const encode = branches.map((_, i) => `\tcase u.${fields[i]} != nil:\n\t\treturn json.Marshal(u.${fields[i]})\n`).join("");
  return `type ${name}${typeParams} struct {
${decl}}

// ValidateValue implements Value: the value is valid in at least one branch.
func (${recv}) ValidateValue(v any, at string, errs *Errors) {
	validateAnyOf(v, at, errs, ${validators})
}

// UnmarshalJSON sets the first branch the value is valid in.
func (u *${recv}) UnmarshalJSON(data []byte) error {
	v, err := ParseJSON(data)
	if err != nil {
		return err
	}
	*u = ${recv}{}
	switch {
${decode}	}
	return fmt.Errorf("openproposal: the value is in no branch of ${name}")
}

// MarshalJSON encodes the branch the union holds.
func (u ${recv}) MarshalJSON() ([]byte, error) {
	switch {
${encode}	}
	return nil, fmt.Errorf("openproposal: the ${name} holds no branch")
}
`;
}

const integerUnmarshal = (name: string) => `
// UnmarshalJSON decodes an integer written in any JSON spelling, such as 1.0 or 1e3.
func (n *${name}) UnmarshalJSON(data []byte) error {
	i, err := decodeInteger(data)
	if err != nil {
		return err
	}
	*n = ${name}(i)
	return nil
}
`;

function scalarDecl(t: Extract<SdkType, { kind: "scalar" }>, ctx: Ctx, consts: Set<string>): string {
  const s = t.scalar;
  const base = s.json === "string" ? "string" : s.json === "integer" ? "int64" : s.json === "number" ? "float64" : "bool";
  const lines: string[] = [];
  let pre = "";
  if (s.json === "string") {
    lines.push("\ts, ok := stringValue(v, at, errs)", "\tif !ok {", "\t\treturn", "\t}");
    if (s.pattern !== undefined) {
      const re = s.pattern.includes("`") ? str(s.pattern) : `\`${s.pattern}\``;
      pre = `var pattern${t.name} = regexp.MustCompile(${re})\n\n`;
      lines.push(`\tcheckPattern(s, pattern${t.name}, at, errs)`);
    }
    if (s.format !== undefined) lines.push(`\tcheckFormat(s, ${str(s.format)}, at, errs)`);
    if (s.minLength !== undefined) lines.push(`\tcheckLength(s, ${s.minLength}, -1, at, errs)`);
    if (s.maxLength !== undefined) lines.push(`\tcheckLength(s, -1, ${s.maxLength}, at, errs)`);
    if (s.enum) lines.push(`\tcheckEnum(v, at, errs, terms${t.name}...)`);
  } else if (s.json === "boolean") {
    lines.push("\tvalidateBool(v, at, errs)");
  } else {
    lines.push(`\tr, ok := ${s.json === "integer" ? "integerValue" : "numberValue"}(v, at, errs)`, "\tif !ok {", "\t\treturn", "\t}");
    const bound = (fn: string, n: number | undefined, exclusive: boolean) => (n === undefined ? [] : [`\t${fn}(r, ${str(String(n))}, ${exclusive}, at, errs)`]);
    lines.push(...bound("checkMinimum", s.minimum, false), ...bound("checkMinimum", s.exclusiveMinimum, true), ...bound("checkMaximum", s.maximum, false), ...bound("checkMaximum", s.exclusiveMaximum, true));
    if (s.enum) lines.push(`\tcheckEnum(v, at, errs, terms${t.name}...)`);
  }
  let terms = "";
  if (s.enum) terms = enumConsts(t.name, s.enum, ctx, consts);
  // A value with nothing to check beyond its JSON type keeps no variable.
  if (s.json !== "boolean" && !lines.slice(4).some((l) => /\((s|r), /.test(l))) lines.splice(0, 4, `\t${s.json === "string" ? "stringValue" : s.json === "integer" ? "integerValue" : "numberValue"}(v, at, errs)`);
  return `${comment(`${t.name}: ${t.doc}`)}type ${t.name} ${base}
${terms}
${pre}// ValidateValue implements Value.
func (${t.name}) ValidateValue(v any, at string, errs *Errors) {
${lines.join("\n")}
}
${s.json === "integer" ? integerUnmarshal(t.name) : ""}`;
}

function enumConsts(name: string, values: (string | number)[], ctx: Ctx, consts: Set<string>): string {
  const out = values.map((v) => {
    const c = `${name}${typeof v === "number" ? String(v).replace("-", "Minus") : goTermName(v)}`;
    if (!/^[A-Z][A-Za-z0-9]*$/.test(c) || consts.has(c)) ctx.problems.push(`go: ${ctx.where}: the term ${JSON.stringify(v)} gives the constant ${c}, which isn't a unique Go name`);
    consts.add(c);
    return `\n${comment(`${c} is the term ${JSON.stringify(v)}.`)}const ${c} ${name} = ${typeof v === "number" ? String(v) : str(v)}\n`;
  });
  return `${out.join("")}\nvar terms${name} = []any{${values.map((v) => jsonLiteral(v)).join(", ")}}\n`;
}

function declaration(t: SdkType, ctx: Ctx, consts: Set<string>): string {
  switch (t.kind) {
    case "scalar":
      return scalarDecl(t, ctx, consts);
    case "enum": {
      const base = t.json === "string" ? "string" : "int64";
      const labels = t.values.flatMap((v, i) => (t.labels[i] ? [`- ${JSON.stringify(v)}: ${t.labels[i]}`] : []));
      const docText = labels.length > 0 ? [`${t.name}: ${t.doc}`, "", ...labels].join("\n") : `${t.name}: ${t.doc}`;
      const body =
        t.open && t.values.length === 0
          ? `\tvalidateAs[NamespacedTerm](v, at, errs)`
          : t.open
        ? `\tvalidateAnyOf(v, at, errs, func(v any, at string, errs *Errors) { checkEnum(v, at, errs, terms${t.name}...) }, validateAs[${t.extension}])`
        : `\tcheckEnum(v, at, errs, terms${t.name}...)`;
      return `${comment(docText)}type ${t.name} ${base}
${enumConsts(t.name, t.values, ctx, consts)}
// ValidateValue implements Value.
func (${t.name}) ValidateValue(v any, at string, errs *Errors) {
${body}
}
${t.json === "integer" ? integerUnmarshal(t.name) : ""}`;
    }
    case "object": {
      const { fields, validate } = objectParts(t.shape, ctx);
      return `${comment(`${t.name}: ${t.doc}`)}type ${t.name} struct {
${fields}}

// ValidateValue implements Value.
func (${t.name}) ValidateValue(v any, at string, errs *Errors) {
${validate}
}
${t.shape.open ? openMethods(t.name, t.shape) : ""}`;
    }
    case "union":
      return `${comment(`${t.name}: ${t.doc}`)}${unionParts(t.name, t.name, t.branches, ctx)}`;
    case "alias":
      return `${comment(`${t.name}: ${t.doc}`)}type ${t.name} = ${goType(t.expr)}\n`;
  }
}

function templateDeclaration(t: SdkTemplate, ctx: Ctx): string {
  const tparams = `[${t.params.map((p) => `${p.name} ${p.accepts === "string" ? "Key" : "Value"}`).join(", ")}]`;
  const recv = `${t.name}[${t.params.map((p) => p.name).join(", ")}]`;
  const docText = [`${t.name}: ${t.doc}`, "", ...t.params.map((p) => `${p.name}: ${p.description}`)].join("\n");
  if (t.body.kind === "union") return `${comment(docText)}${unionParts(t.name, recv, t.body.branches, ctx, tparams)}`;
  if (t.body.shape.open) ctx.problems.push(`go: ${ctx.where}: an open template; a generic method can't declare the plain type an open object decodes through`);
  const { fields, validate } = objectParts(t.body.shape, ctx);
  return `${comment(docText)}type ${t.name}${tparams} struct {
${fields}}

// ValidateValue implements Value.
func (${recv}) ValidateValue(v any, at string, errs *Errors) {
${validate}
}
`;
}

const header = (lock: string) => `// Code generated by \`npm run sdk\` from the OpenProposal model of ${lock}. DO NOT EDIT.\n\n`;

/** The imports a file's code uses, as a Go import block. */
function importBlock(code: string): string {
  const uses: [string, RegExp][] = [
    ["encoding/json", /\bjson\./],
    ["fmt", /\bfmt\./],
    ["regexp", /\bregexp\./],
  ];
  const pkgs = uses.filter(([, re]) => re.test(code)).map(([p]) => p);
  if (pkgs.length === 0) return "";
  if (pkgs.length === 1) return `import ${str(pkgs[0]!)}\n\n`;
  return `import (\n${pkgs.map((p) => `\t${str(p)}\n`).join("")})\n\n`;
}

const RUNTIME = (lock: string) => `${header(lock)}package openproposal

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Error is one place where a value breaks its type.
type Error struct {
	// At is the JSON pointer of the place in the value.
	At string
	// Message says what is wrong there.
	Message string
}

// Errors lists every place where a value breaks its type.
type Errors []Error

// Error implements error.
func (e Errors) Error() string {
	parts := make([]string, len(e))
	for i, x := range e {
		at := x.At
		if at == "" {
			at = "the value"
		}
		parts[i] = at + ": " + x.Message
	}
	return "openproposal: " + strings.Join(parts, "; ")
}

func (e *Errors) add(at, format string, args ...any) {
	*e = append(*e, Error{At: at, Message: fmt.Sprintf(format, args...)})
}

// Value is a type that checks JSON values.
type Value interface {
	// ValidateValue adds to errs every place where v, a JSON value as
	// ParseJSON returns it, breaks the type. at is v's JSON pointer.
	ValidateValue(v any, at string, errs *Errors)
}

// Key is a type whose values are strings, so it can key a map.
type Key interface {
	~string
	Value
}

// ParseJSON parses one JSON value, keeping each number as a json.Number so
// no digit is lost.
func ParseJSON(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("openproposal: more data after the JSON value")
	}
	return v, nil
}

// Validate checks one JSON text against T.
func Validate[T Value](data []byte) error {
	v, err := ParseJSON(data)
	if err != nil {
		return err
	}
	var errs Errors
	validateAs[T](v, "", &errs)
	if len(errs) > 0 {
		return errs
	}
	return nil
}

// Decode checks one JSON text against T, then decodes it into a T.
func Decode[T Value](data []byte) (T, error) {
	var out T
	if err := Validate[T](data); err != nil {
		return out, err
	}
	err := json.Unmarshal(data, &out)
	return out, err
}

// List is a JSON array whose items are values of T.
type List[T Value] []T

// ValidateValue implements Value.
func (List[T]) ValidateValue(v any, at string, errs *Errors) {
	a, ok := v.([]any)
	if !ok {
		errs.add(at, "is %s, not an array", kindOf(v))
		return
	}
	for i, x := range a {
		validateAs[T](x, at+"/"+strconv.Itoa(i), errs)
	}
}

// Map is a JSON object whose keys are values of K and whose members are
// values of V.
type Map[K Key, V Value] map[K]V

// ValidateValue implements Value.
func (Map[K, V]) ValidateValue(v any, at string, errs *Errors) {
	m, ok := objectValue(v, at, errs)
	if !ok {
		return
	}
	for _, k := range sortedKeys(m) {
		validateAs[K](k, member(at, k), errs)
		validateAs[V](m[k], member(at, k), errs)
	}
}

func validateAs[T Value](v any, at string, errs *Errors) {
	var t T
	t.ValidateValue(v, at, errs)
}

func validates[T Value](v any) bool {
	var errs Errors
	validateAs[T](v, "", &errs)
	return len(errs) == 0
}

func validateAnyOf(v any, at string, errs *Errors, branches ...func(any, string, *Errors)) {
	for _, b := range branches {
		var e Errors
		b(v, at, &e)
		if len(e) == 0 {
			return
		}
	}
	errs.add(at, "is valid in none of the %d branches", len(branches))
}

func member(at, name string) string {
	return at + "/" + strings.ReplaceAll(strings.ReplaceAll(name, "~", "~0"), "/", "~1")
}

func kindOf(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case bool:
		return "a boolean"
	case json.Number:
		return "a number"
	case string:
		return "a string"
	case []any:
		return "an array"
	case map[string]any:
		return "an object"
	}
	return fmt.Sprintf("%T", v)
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func objectValue(v any, at string, errs *Errors) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	if !ok {
		errs.add(at, "is %s, not an object", kindOf(v))
	}
	return m, ok
}

func stringValue(v any, at string, errs *Errors) (string, bool) {
	s, ok := v.(string)
	if !ok {
		errs.add(at, "is %s, not a string", kindOf(v))
	}
	return s, ok
}

func validateBool(v any, at string, errs *Errors) {
	if _, ok := v.(bool); !ok {
		errs.add(at, "is %s, not a boolean", kindOf(v))
	}
}

func ratOf(s string) (*big.Rat, bool) {
	if strings.ContainsAny(s, "/") {
		return nil, false
	}
	return new(big.Rat).SetString(s)
}

func numberValue(v any, at string, errs *Errors) (*big.Rat, bool) {
	n, ok := v.(json.Number)
	if !ok {
		errs.add(at, "is %s, not a number", kindOf(v))
		return nil, false
	}
	r, ok := ratOf(string(n))
	if !ok {
		errs.add(at, "is %s, which isn't a number", n)
	}
	return r, ok
}

func integerValue(v any, at string, errs *Errors) (*big.Rat, bool) {
	r, ok := numberValue(v, at, errs)
	if ok && !r.IsInt() {
		errs.add(at, "is %s, not an integer", v)
		return nil, false
	}
	return r, ok
}

func checkMinimum(r *big.Rat, bound string, exclusive bool, at string, errs *Errors) {
	b, _ := ratOf(bound)
	if c := r.Cmp(b); c < 0 || (exclusive && c == 0) {
		errs.add(at, "is %s, below its minimum %s", r.RatString(), bound)
	}
}

func checkMaximum(r *big.Rat, bound string, exclusive bool, at string, errs *Errors) {
	b, _ := ratOf(bound)
	if c := r.Cmp(b); c > 0 || (exclusive && c == 0) {
		errs.add(at, "is %s, above its maximum %s", r.RatString(), bound)
	}
}

func checkPattern(s string, re *regexp.Regexp, at string, errs *Errors) {
	if !re.MatchString(s) {
		errs.add(at, "%q doesn't match %s", s, re)
	}
}

func checkLength(s string, min, max int, at string, errs *Errors) {
	n := utf8.RuneCountInString(s)
	if min >= 0 && n < min {
		errs.add(at, "is %d characters, fewer than %d", n, min)
	}
	if max >= 0 && n > max {
		errs.add(at, "is %d characters, more than %d", n, max)
	}
}

func checkEnum(v any, at string, errs *Errors, terms ...any) {
	for _, t := range terms {
		if jsonEqual(v, t) {
			return
		}
	}
	errs.add(at, "is no term of its vocabulary")
}

func checkRequired(m map[string]any, at string, errs *Errors, names ...string) {
	for _, n := range names {
		if _, ok := m[n]; !ok {
			errs.add(at, "lacks the required member %q", n)
		}
	}
}

func checkRequiredWhen(m map[string]any, at string, errs *Errors, sibling string, names ...string) {
	for _, n := range names {
		if _, ok := m[n]; !ok {
			errs.add(at, "lacks %q, which is required when %q is %v", n, sibling, m[sibling])
		}
	}
}

func checkRequiredWith(m map[string]any, at string, errs *Errors, member string, names ...string) {
	if _, ok := m[member]; !ok {
		return
	}
	for _, n := range names {
		if _, ok := m[n]; !ok {
			errs.add(at, "lacks %q, which is required with %q", n, member)
		}
	}
}

func checkRequiredWithin(m map[string]any, at string, errs *Errors, name string, inner []string, names ...string) {
	o, ok := m[name].(map[string]any)
	if !ok {
		return
	}
	for _, i := range inner {
		if _, ok := o[i]; !ok {
			return
		}
	}
	for _, n := range names {
		if _, ok := m[n]; !ok {
			errs.add(at, "lacks %q, which is required with %q holding %s", n, name, strings.Join(inner, ", "))
		}
	}
}

func checkClosed(m map[string]any, at string, errs *Errors, names ...string) {
	for _, k := range sortedKeys(m) {
		known := false
		for _, n := range names {
			if k == n {
				known = true
				break
			}
		}
		if !known {
			errs.add(member(at, k), "is a member the object doesn't name")
		}
	}
}

func checkMemberCount(m map[string]any, at string, errs *Errors, min, max int) {
	if min >= 0 && len(m) < min {
		errs.add(at, "holds %d members, fewer than %d", len(m), min)
	}
	if max >= 0 && len(m) > max {
		errs.add(at, "holds %d members, more than %d", len(m), max)
	}
}

func checkDependent(m map[string]any, at string, errs *Errors, name string, max int) {
	if _, ok := m[name]; ok && len(m) > max {
		errs.add(at, "holds %q and %d other members; with %q it holds at most %d", name, len(m)-1, name, max)
	}
}

// checkBounds checks that the list member name, where present, holds at least least items, each once where unique.
func checkBounds(m map[string]any, at string, errs *Errors, name string, least int, unique bool) {
	x, ok := m[name].([]any)
	if !ok {
		return
	}
	if len(x) < least {
		errs.add(member(at, name), "holds %d items, fewer than %d", len(x), least)
	}
	if unique {
		for i := range x {
			for j := 0; j < i; j++ {
				if jsonEqual(x[i], x[j]) {
					errs.add(member(at, name), "holds an item twice")
					return
				}
			}
		}
	}
}

func jsonEqual(a, b any) bool {
	switch x := a.(type) {
	case nil:
		return b == nil
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case string:
		y, ok := b.(string)
		return ok && x == y
	case json.Number:
		y, ok := b.(json.Number)
		if !ok {
			return false
		}
		rx, okx := ratOf(string(x))
		ry, oky := ratOf(string(y))
		return okx && oky && rx.Cmp(ry) == 0
	}
	return false
}

func decodeInteger(data []byte) (int64, error) {
	r, ok := ratOf(string(bytes.TrimSpace(data)))
	if !ok || !r.IsInt() || !r.Num().IsInt64() {
		return 0, fmt.Errorf("openproposal: %s isn't an integer that fits 64 bits", data)
	}
	return r.Num().Int64(), nil
}

// splitMembers splits a JSON object into the members it names, matched
// exactly, and the others.
func splitMembers(data []byte, names ...string) ([]byte, map[string]json.RawMessage, error) {
	var all map[string]json.RawMessage
	if err := json.Unmarshal(data, &all); err != nil {
		return nil, nil, err
	}
	known := map[string]json.RawMessage{}
	for _, n := range names {
		if x, ok := all[n]; ok {
			known[n] = x
			delete(all, n)
		}
	}
	b, err := json.Marshal(known)
	if len(all) == 0 {
		all = nil
	}
	return b, all, err
}

func marshalOpen(v any, extra map[string]json.RawMessage) ([]byte, error) {
	b, err := json.Marshal(v)
	if err != nil || len(extra) == 0 {
		return b, err
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	for k, x := range extra {
		if _, ok := m[k]; !ok {
			m[k] = x
		}
	}
	return json.Marshal(m)
}

${Object.entries(FORMAT_PATTERNS)
  .map(([k, v]) => `var format${pascal(k)} = regexp.MustCompile(\`${v}\`)\n`)
  .join("\n")}
func formatPattern(format string) *regexp.Regexp {
	switch format {
${Object.keys(FORMAT_PATTERNS)
  .map((k) => `\tcase ${str(k)}:\n\t\treturn format${pascal(k)}\n`)
  .join("")}	}
	return nil
}

func leap(y int) bool {
	return (y%4 == 0 && y%100 != 0) || y%400 == 0
}

func validDate(y, m, d int) bool {
	days := [12]int{31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31}
	if m < 1 || m > 12 {
		return false
	}
	n := days[m-1]
	if m == 2 && leap(y) {
		n = 29
	}
	return d >= 1 && d <= n
}

// IsFormat reports whether a string is valid in a format, by its RFC grammar
// and ranges.
func IsFormat(format, s string) bool {
	re := formatPattern(format)
	if re == nil {
		return false
	}
	m := re.FindStringSubmatch(s)
	if m == nil {
		return false
	}
	atoi := func(x string) int {
		n, _ := strconv.Atoi(x)
		return n
	}
	switch format {
	case "date":
		return validDate(atoi(m[1]), atoi(m[2]), atoi(m[3]))
	case "date-time":
	default:
		return true
	}
	if !validDate(atoi(m[1]), atoi(m[2]), atoi(m[3])) {
		return false
	}
	hour, minute, second := atoi(m[4]), atoi(m[5]), atoi(m[6])
	sign := 1
	if m[7] == "-" {
		sign = -1
	}
	oh, om := atoi(m[8]), atoi(m[9])
	if hour > 23 || minute > 59 || oh > 23 || om > 59 {
		return false
	}
	if second <= 59 {
		return true
	}
	if second != 60 {
		return false
	}
	// A leap second falls at 23:59 UTC (RFC 3339 § 5.7).
	utc := ((hour*60+minute-sign*(oh*60+om))%1440 + 1440) % 1440
	return utc == 23*60+59
}

func checkFormat(s, format string, at string, errs *Errors) {
	if !IsFormat(format, s) {
		errs.add(at, "%q isn't a valid %s", s, format)
	}
}
`;

const REGISTRY = (lock: string) => `${header(lock)}package openproposal

import (
	"encoding/json"
	"fmt"
	"sync"
)

// ExtensionValidator checks an extension's data, and returns what is wrong
// with it, or nil.
type ExtensionValidator func(data json.RawMessage) error

// ExtensionRegistry holds extension validators, by the extension's URI and
// the digest of its definition. It is the extension registry seam: the model
// declares no extension point yet, so no generated type calls it.
type ExtensionRegistry struct {
	mu      sync.RWMutex
	entries map[[2]string]ExtensionValidator
}

// Extensions is the process's registry, which an extension package
// registers with from its init function.
var Extensions = &ExtensionRegistry{}

func extensionKey(uri, digest string) ([2]string, error) {
	var errs Errors
	if !IsFormat("uri", uri) {
		errs.add("/uri", "%q isn't an absolute URI", uri)
	}
	if !isDigest(digest) {
		errs.add("/digest", "%q isn't a SHA-256 digest in lowercase hexadecimal", digest)
	}
	if len(errs) > 0 {
		return [2]string{}, errs
	}
	return [2]string{uri, digest}, nil
}

// isDigest reports whether a string is a SHA-256 digest: 64 lowercase
// hexadecimal characters.
func isDigest(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// Register registers the validator of one extension version. Registering the
// same URI and digest twice is an error.
func (r *ExtensionRegistry) Register(uri, digest string, v ExtensionValidator) error {
	k, err := extensionKey(uri, digest)
	if err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.entries[k]; ok {
		return fmt.Errorf("openproposal: an extension is already registered as %s with the digest %s", uri, digest)
	}
	if r.entries == nil {
		r.entries = map[[2]string]ExtensionValidator{}
	}
	r.entries[k] = v
	return nil
}

// Lookup returns the validator registered for the URI and digest, if any.
func (r *ExtensionRegistry) Lookup(uri, digest string) (ExtensionValidator, bool) {
	k, err := extensionKey(uri, digest)
	if err != nil {
		return nil, false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	v, ok := r.entries[k]
	return v, ok
}

// Len returns how many extension versions are registered.
func (r *ExtensionRegistry) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.entries)
}
`;

/** The Go module path of a build's SDK, from its SDK directory, such as `sdk` or `sdk/proposed/with-open-prs`. */
export const goModulePath = (sdkDir: string) => `${GO_MODULE_BASE}/${sdkDir}/go`;

/** The provenance constants of `provenance.go`. */
const PROVENANCE_NAMES: [keyof Provenance, string][] = [
  ["commit", "SpecCommit"],
  ["blob", "SpecBlob"],
  ["lock", "Lock"],
  ["variant", "Variant"],
  ["schemaRelease", "SchemaRelease"],
];

/** The Go SDK of one build's SDK model, as files under the build's `go/` directory. */
export function emitGo(sdk: SdkModel, sdkDir: string, prov: Provenance): { files: SdkFile[]; problems: string[] } {
  const problems: string[] = [];
  const lock = lockPhrase(sdk.input);
  for (const [, n] of PROVENANCE_NAMES) if (sdk.types.has(n) || sdk.templates.has(n)) problems.push(`go: the type "${n}" has the name of a provenance constant`);
  const consts = new Set<string>([...sdk.types.keys(), ...sdk.templates.keys(), ...RUNTIME_NAMES, ...PROVENANCE_NAMES.map(([, n]) => n)]);
  for (const n of [...sdk.types.keys(), ...sdk.templates.keys()]) if (RUNTIME_NAMES.has(n)) problems.push(`go: the type "${n}" has the name of a runtime declaration`);
  const moduleOf = new Map<string, string>([...[...sdk.types.values()].map((t): [string, string] => [t.name, t.module]), ...[...sdk.templates.values()].map((t): [string, string] => [t.name, t.module])]);
  const files: SdkFile[] = [];
  for (const module of sdk.modules) {
    const names = sdk.order.filter((n) => moduleOf.get(n) === module);
    const parts = names.map((n) => {
      const ctx = { problems, where: n };
      const t = sdk.types.get(n);
      return t ? declaration(t, ctx, consts) : templateDeclaration(sdk.templates.get(n)!, ctx);
    });
    const code = parts.join("\n");
    files.push({ path: `openproposal/${moduleFile(module)}`, text: `${header(lock)}package openproposal\n\n${importBlock(code)}${code}` });
  }
  const registrations = sdk.emitted.map((n) => `\tTypes[${str(n)}] = TypeOf[${n}]()\n`).join("");
  files.push({
    path: "openproposal/types.go",
    text: `${header(lock)}package openproposal

// Type is one named type's checks, for code that has only its name.
type Type struct {
	// Validate checks one JSON text against the type.
	Validate func(data []byte) error
	// Decode checks one JSON text against the type, then decodes it.
	Decode func(data []byte) (any, error)
}

// TypeOf returns T's Type.
func TypeOf[T Value]() Type {
	return Type{
		Validate: Validate[T],
		Decode: func(data []byte) (any, error) {
			return Decode[T](data)
		},
	}
}

// Types holds every named type the JSON Schema emits, by name.
var Types = map[string]Type{}

func init() {
${registrations}}
`,
  });
  files.push({
    path: "openproposal/doc.go",
    text: `${header(lock)}// Package openproposal holds the OpenProposal types of ${lock}.
//
// Each named type the JSON Schema emits is a Go type of the same name, with
// a ValidateValue method that checks a JSON value the way the type's schema
// does. Decode checks a JSON text and decodes it. Each constructor is a
// generic type, such as Selectable[T], and each copy the schema names, such
// as FormatsSelection, is an alias of one application.
package openproposal
`,
  });
  files.push({
    path: "openproposal/provenance.go",
    text: `${header(lock)}package openproposal

${PROVENANCE_NAMES.map(([k, n]) => `${comment(`${n} is ${PROVENANCE_DOCS[k][0]!.toLowerCase()}${PROVENANCE_DOCS[k].slice(1)}`)}const ${n} = ${str(prov[k])}\n`).join("\n")}`,
  });
  files.push({ path: "openproposal/runtime.go", text: RUNTIME(lock) });
  files.push({ path: "openproposal/registry.go", text: REGISTRY(lock) });
  files.push({ path: "go.mod", text: `module ${goModulePath(sdkDir)}\n\ngo ${GO_VERSION}\n` });
  return { files, problems };
}
