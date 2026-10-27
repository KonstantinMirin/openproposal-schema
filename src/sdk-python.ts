/**
 * The Python SDK: the package `openproposal`, one module per model module,
 * on Pydantic 2. An object is a model class, closed or open as the schema
 * states; a scalar, a vocabulary, or a union is a named `TypeAliasType`; and
 * a constructor is a generic model class or a generic `TypeAliasType`, so a
 * property of `Selectable<FormatId, FormatId>` is typed `Selectable[FormatId, FormatId]` and the
 * copy `FormatsSelection` is `Selectable[FormatId, FormatId]`. `_runtime.py` holds the
 * checks Pydantic doesn't state the way JSON Schema does: the formats, an
 * integer written as `1.0`, a `true` where an integer term is due, a member
 * given as `null`, an object's member counts, and its conditions, which may
 * require members or narrow a member's type.
 */
import { FORMAT_PATTERNS } from "./sdk-formats.ts";
import { lockPhrase, type Expr, type SdkFile, type SdkModel, type SdkTemplate, type SdkType, type Shape } from "./sdk.ts";

/** The Pydantic release the generated code is written against, as `tools/sdk/requirements.txt` pins it. */
export const PYDANTIC_VERSION = "2.13.4";

/** Python's keywords and soft keywords, and the names a Pydantic model's own attributes take. */
const RESERVED = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for",
  "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
  "copy", "dict", "json", "schema", "schema_json", "construct", "validate", "parse_obj", "parse_raw", "parse_file", "from_orm", "update_forward_refs", "fields",
]);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const moduleFile = (module: string) => module.replaceAll("-", "_");
const str = (s: string) => JSON.stringify(s);
const docstring = (text: string, indent: string) => {
  const body = text.replaceAll("\\", "\\\\").replaceAll('"""', '\\"\\"\\"').replace(/"$/, '\\"');
  return `${indent}"""${body
    .split("\n")
    .map((l, i) => (i === 0 || l === "" ? l : `${indent}${l}`))
    .join("\n")}"""\n`;
};
const tuple = (xs: string[]) => (xs.length === 1 ? `(${xs[0]},)` : `(${xs.join(", ")})`);
const literal = (v: string | number | boolean) => (typeof v === "boolean" ? (v ? "True" : "False") : JSON.stringify(v));

/** An expression as a Python type. */
function typeOf(e: Expr): string {
  switch (e.k) {
    case "ref":
    case "param":
      return e.name;
    case "boolean":
      return "rt.Boolean";
    case "list":
      return `list[${typeOf(e.item)}]`;
    case "map":
      return `dict[${typeOf(e.key)}, ${typeOf(e.value)}]`;
    case "apply":
      return `${e.template}[${e.args.map(typeOf).join(", ")}]`;
  }
}

/** The `__shape__` of a model class, or "" when its schema states nothing a class doesn't. */
function shapeLine(shape: Shape, indent: string): string {
  const args: string[] = [];
  if (shape.minProperties !== undefined) args.push(`min_properties=${shape.minProperties}`);
  if (shape.maxProperties !== undefined) args.push(`max_properties=${shape.maxProperties}`);
  if (shape.dependent.length > 0) args.push(`dependent=${tuple(shape.dependent.map((d) => `(${str(d.member)}, ${d.maxProperties})`))}`);
  if (shape.requires.length > 0) args.push(`requires=${tuple(shape.requires.map((d) => `(${str(d.member)}, ${tuple(d.names.map(str))})`))}`);
  if (shape.within.length > 0) args.push(`within=${tuple(shape.within.map((d) => `(${str(d.member)}, ${tuple(d.inner.map(str))}, ${tuple(d.names.map(str))})`))}`);
  if (shape.bounds.length > 0) args.push(`bounds=${tuple(shape.bounds.map((b) => `(${str(b.member)}, ${b.minItems}, ${b.unique ? "True" : "False"})`))}`);
  if (shape.rejects.length > 0) args.push(`rejects=${tuple(shape.rejects.map((r) => `(${str(r.sibling)}, ${literal(r.value)})`))}`);
  if (shape.conditions.length > 0) {
    const one = (c: Shape["conditions"][number]) => `(${str(c.sibling)}, ${literal(c.value)}, ${tuple(c.require.map(str))}, ${tuple(c.types.map((x) => `(${str(x.name)}, ${typeOf(x.expr)})`))})`;
    args.push(`conditions=${tuple(shape.conditions.map(one))}`);
  }
  return args.length > 0 ? `${indent}__shape__: ClassVar[rt.Shape] = rt.Shape(${args.join(", ")})\n\n` : "";
}

function classBody(shape: Shape, problems: string[], where: string): string {
  const fields = shape.properties
    .map((p) => {
      if (!IDENT.test(p.name) || RESERVED.has(p.name) || p.name.startsWith("model_") || p.name.startsWith("_")) {
        problems.push(`python: ${where}: the member "${p.name}" can't be a Pydantic field name`);
      }
      const t = typeOf(p.expr);
      return `    ${p.name}: ${p.required ? t : `Optional[${t}] = None`}\n${p.description ? docstring(p.description, "    ") : ""}`;
    })
    .join("");
  return `${shapeLine(shape, "    ")}${fields}`;
}

function scalarType(t: Extract<SdkType, { kind: "scalar" }>): string {
  const s = t.scalar;
  if (s.enum) {
    const lit = `Literal[${s.enum.map(literal).join(", ")}]`;
    return s.json === "integer" ? `Annotated[${lit}, BeforeValidator(rt.integer_term)]` : lit;
  }
  switch (s.json) {
    case "boolean":
      return "Annotated[bool, Strict()]";
    case "number":
    case "integer": {
      const bounds: string[] = [];
      if (s.minimum !== undefined) bounds.push(`ge=${s.minimum}`);
      if (s.exclusiveMinimum !== undefined) bounds.push(`gt=${s.exclusiveMinimum}`);
      if (s.maximum !== undefined) bounds.push(`le=${s.maximum}`);
      if (s.exclusiveMaximum !== undefined) bounds.push(`lt=${s.exclusiveMaximum}`);
      const field = bounds.length > 0 ? `, Field(${bounds.join(", ")})` : "";
      return s.json === "integer" ? `Annotated[int, BeforeValidator(rt.integral), Strict()${field}]` : `Annotated[float, Strict()${field}]`;
    }
    case "string": {
      const c: string[] = [];
      if (s.pattern !== undefined) c.push(`pattern=${str(s.pattern)}`);
      if (s.minLength !== undefined) c.push(`min_length=${s.minLength}`);
      if (s.maxLength !== undefined) c.push(`max_length=${s.maxLength}`);
      return `Annotated[str, Strict()${c.length > 0 ? `, Field(${c.join(", ")})` : ""}${s.format ? `, AfterValidator(rt.format(${str(s.format)}))` : ""}]`;
    }
  }
}

function declaration(t: SdkType, problems: string[]): string {
  const alias = (body: string) => `${t.name} = TypeAliasType(${str(t.name)}, ${body})\n${docstring(t.doc, "")}`;
  switch (t.kind) {
    case "scalar":
      return alias(scalarType(t));
    case "enum": {
      // An open vocabulary whose core terms the specification doesn't list accepts namespaced terms only.
      if (t.open && t.values.length === 0) return `${t.name} = TypeAliasType(${str(t.name)}, NamespacedTerm)\n${docstring(t.doc, "")}`;
      const lit = `Literal[${t.values.map(literal).join(", ")}]`;
      const core = t.json === "integer" ? `Annotated[${lit}, BeforeValidator(rt.integer_term)]` : lit;
      const labels = t.values.flatMap((v, i) => (t.labels[i] ? [`- \`${v}\`: ${t.labels[i]}`] : []));
      const body = t.open ? `Union[${core}, ${t.extension}]` : core;
      return `${t.name} = TypeAliasType(${str(t.name)}, ${body})\n${docstring(labels.length > 0 ? [t.doc, "", ...labels].join("\n") : t.doc, "")}`;
    }
    case "object":
      return `class ${t.name}(rt.${t.shape.open ? "Open" : "Closed"}):\n${docstring(t.doc, "    ")}${t.shape.properties.length > 0 || shapeLine(t.shape, "") ? "\n" : ""}${classBody(t.shape, problems, t.name)}`;
    case "union":
      return alias(`Union[${t.branches.map(typeOf).join(", ")}]`);
    case "alias":
      return `${t.name} = ${typeOf(t.expr)}\n${docstring(t.doc, "")}`;
  }
}

function templateDeclaration(t: SdkTemplate, problems: string[]): string {
  const params = t.params.map((p) => p.name);
  const paramDoc = t.params.map((p) => `- \`${p.name}\`: ${p.description}`);
  const text = [t.doc, "", ...paramDoc].join("\n");
  if (t.body.kind === "union") {
    return `${t.name} = TypeAliasType(${str(t.name)}, Union[${t.body.branches.map(typeOf).join(", ")}], type_params=${tuple(params)})\n${docstring(text, "")}`;
  }
  return `class ${t.name}(rt.${t.body.shape.open ? "Open" : "Closed"}, Generic[${params.join(", ")}]):\n${docstring(text, "    ")}\n${classBody(t.body.shape, problems, t.name)}`;
}

const header = (lock: string, what: string) => `"""${what}

Generated by \`npm run sdk\` from the OpenProposal model of ${lock}. Do not edit.
"""

`;

const RUNTIME = (lock: string) => `${header(lock, "The checks the generated types share, where Pydantic doesn't state a check the way JSON Schema 2020-12 does.")}import re
from collections.abc import Callable
from typing import Annotated, Any, ClassVar

from pydantic import BaseModel, ConfigDict, Strict, TypeAdapter, ValidationError, model_validator

_FORMATS = {
${Object.entries(FORMAT_PATTERNS)
  .map(([k, v]) => `    ${str(k)}: re.compile(${str(v)}),`)
  .join("\n")}
}

Boolean = Annotated[bool, Strict()]
"""The JSON boolean."""


def _leap(year: int) -> bool:
    return (year % 4 == 0 and year % 100 != 0) or year % 400 == 0


def _valid_date(year: int, month: int, day: int) -> bool:
    if not 1 <= month <= 12:
        return False
    days = [31, 29 if _leap(year) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    return 1 <= day <= days


def is_format(name: str, value: str) -> bool:
    """Whether a string is valid in a format, by its RFC grammar and ranges."""
    m = _FORMATS[name].fullmatch(value)
    if m is None:
        return False
    if name == "date":
        return _valid_date(int(m[1]), int(m[2]), int(m[3]))
    if name != "date-time":
        return True
    if not _valid_date(int(m[1]), int(m[2]), int(m[3])):
        return False
    hour, minute, second = int(m[4]), int(m[5]), int(m[6])
    sign = -1 if m[7] == "-" else 1
    oh, om = int(m[8] or 0), int(m[9] or 0)
    if hour > 23 or minute > 59 or oh > 23 or om > 59:
        return False
    if second <= 59:
        return True
    if second != 60:
        return False
    # A leap second falls at 23:59 UTC (RFC 3339 section 5.7).
    return (hour * 60 + minute - sign * (oh * 60 + om)) % 1440 == 23 * 60 + 59


def format(name: str) -> Callable[[str], str]:
    """A validator that a string is valid in a format."""

    def check(value: str) -> str:
        if not is_format(name, value):
            raise ValueError(f"isn't a valid {name}")
        return value

    return check


def integral(value: Any) -> Any:
    """An integer written with a fraction or an exponent, such as 1.0, is the integer: JSON Schema compares numbers by value."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def integer_term(value: Any) -> Any:
    """A term of an integer vocabulary: true and false aren't numbers in JSON, though Python counts them as ints."""
    if isinstance(value, bool):
        raise ValueError("is a boolean, not an integer term")
    return integral(value)


def _json_equal(a: Any, b: Any) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    return a == b


class Shape:
    """What an object's schema states beside its members' types: its member counts, what a member allows or requires beside it, and its conditions."""

    def __init__(
        self,
        min_properties: int | None = None,
        max_properties: int | None = None,
        dependent: tuple[tuple[str, int], ...] = (),
        conditions: tuple[tuple[str, Any, tuple[str, ...], tuple[tuple[str, Any], ...]], ...] = (),
        requires: tuple[tuple[str, tuple[str, ...]], ...] = (),
        within: tuple[tuple[str, tuple[str, ...], tuple[str, ...]], ...] = (),
        bounds: tuple[tuple[str, int, bool], ...] = (),
        rejects: tuple[tuple[str, Any], ...] = (),
    ) -> None:
        self.min_properties = min_properties
        self.max_properties = max_properties
        self.dependent = dependent
        self.conditions = tuple((sibling, value, require, tuple((m, TypeAdapter(t)) for m, t in types)) for sibling, value, require, types in conditions)
        self.requires = requires
        self.within = within
        self.bounds = bounds
        self.rejects = rejects

    def check(self, data: dict[str, Any]) -> None:
        n = len(data)
        if self.min_properties is not None and n < self.min_properties:
            raise ValueError(f"holds {n} members, fewer than {self.min_properties}")
        if self.max_properties is not None and n > self.max_properties:
            raise ValueError(f"holds {n} members, more than {self.max_properties}")
        for member, most in self.dependent:
            if member in data and n > most:
                raise ValueError(f'holds "{member}" and {n - 1} other members; with "{member}" it holds at most {most}')
        for member, names in self.requires:
            if member in data:
                for r in names:
                    if r not in data:
                        raise ValueError(f'lacks "{r}", which is required with "{member}"')
        for member, inner, names in self.within:
            m = data.get(member)
            if isinstance(m, dict) and all(i in m for i in inner):
                for r in names:
                    if r not in data:
                        raise ValueError(f'lacks "{r}", which is required with "{member}" holding {", ".join(inner)}')
        for member, least, unique in self.bounds:
            m = data.get(member)
            if isinstance(m, list):
                if len(m) < least:
                    raise ValueError(f'"{member}" holds {len(m)} items, fewer than {least}')
                if unique and any(_json_equal(m[i], m[j]) for i in range(len(m)) for j in range(i)):
                    raise ValueError(f'"{member}" holds an item twice')
        for sibling, value in self.rejects:
            if sibling in data and _json_equal(data[sibling], value):
                raise ValueError(f'"{sibling}" is {value!r}, which it cannot be')
        for sibling, value, require, types in self.conditions:
            if sibling in data and _json_equal(data[sibling], value):
                for r in require:
                    if r not in data:
                        raise ValueError(f'lacks "{r}", which is required when "{sibling}" is {value!r}')
                for m, adapter in types:
                    if m in data:
                        try:
                            adapter.validate_python(data[m], strict=True)
                        except ValidationError as e:
                            raise ValueError(f'"{m}" is invalid while "{sibling}" is {value!r}: {e.errors()[0]["msg"]}') from None


class Model(BaseModel):
    """The base of every generated model: strict, and with no member given as null, since no OpenProposal type admits null."""

    model_config = ConfigDict(strict=True, extra="forbid", use_attribute_docstrings=True)
    __shape__: ClassVar[Shape] = Shape()

    @model_validator(mode="before")
    @classmethod
    def _check_shape(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for name in cls.model_fields:
                if name in data and data[name] is None:
                    raise ValueError(f'the member "{name}" is null')
            cls.__shape__.check(data)
        return data


class Closed(Model):
    """An object that rejects the members it doesn't name."""

    model_config = ConfigDict(extra="forbid")


class Open(Model):
    """An object that keeps the members it doesn't name."""

    model_config = ConfigDict(extra="allow")
`;

const REGISTRY = (lock: string) => `${header(
  lock,
  "The extension registry seam.\n\nAn extension's validator is registered under the extension's URI and the digest of its definition, so a receiver can find the validator for extension data it meets. An extension package registers through the entry-point group `openproposal.extensions`, whose entry is a callable that takes the registry. The model declares no extension point yet, so no generated type calls it.",
)}import re
from collections.abc import Callable
from importlib.metadata import entry_points
from typing import Any

from ._runtime import is_format

ExtensionValidator = Callable[[Any], list[str]]
"""Checks an extension's data, and returns what is wrong with it, or nothing."""

ENTRY_POINT_GROUP = "openproposal.extensions"

_DIGEST = re.compile(r"[0-9a-f]{64}")


class ExtensionRegistry:
    """Extension validators, by the extension's URI and the digest of its definition."""

    def __init__(self) -> None:
        self._entries: dict[tuple[str, str], ExtensionValidator] = {}

    @staticmethod
    def _key(uri: str, digest: str) -> tuple[str, str]:
        if not isinstance(uri, str) or not is_format("uri", uri):
            raise ValueError(f"{uri!r} isn't an absolute URI")
        if not isinstance(digest, str) or _DIGEST.fullmatch(digest) is None:
            raise ValueError(f"{digest!r} isn't a SHA-256 digest in lowercase hexadecimal")
        return (uri, digest)

    def register(self, uri: str, digest: str, validate: ExtensionValidator) -> None:
        """Registers the validator of one extension version. Registering the same URI and digest twice is an error."""
        key = self._key(uri, digest)
        if key in self._entries:
            raise ValueError(f"an extension is already registered as {uri} with the digest {digest}")
        self._entries[key] = validate

    def lookup(self, uri: str, digest: str) -> ExtensionValidator | None:
        """The validator registered for the URI and digest, if any."""
        return self._entries.get(self._key(uri, digest))

    def __len__(self) -> int:
        return len(self._entries)

    def load_entry_points(self, group: str = ENTRY_POINT_GROUP) -> None:
        """Lets every installed extension package in the group register its validators."""
        for ep in sorted(entry_points(group=group), key=lambda e: e.name):
            ep.load()(self)
`;

/** The Python SDK of one lock's SDK model, as files under the lock's `python/` directory. */
export function emitPython(sdk: SdkModel): { files: SdkFile[]; problems: string[] } {
  const problems: string[] = [];
  const lock = lockPhrase(sdk.input);
  const moduleOf = new Map<string, string>([...[...sdk.types.values()].map((t): [string, string] => [t.name, t.module]), ...[...sdk.templates.values()].map((t): [string, string] => [t.name, t.module])]);
  const typeVars = [...new Set([...sdk.templates.values()].flatMap((t) => t.params.map((p) => p.name)))].sort();
  for (const v of typeVars) if (moduleOf.has(v)) problems.push(`python: the type variable "${v}" has the name of a type`);
  const files: SdkFile[] = [];
  for (const module of sdk.modules) {
    const names = sdk.order.filter((n) => moduleOf.get(n) === module);
    const imports = new Map<string, Set<string>>();
    const parts: string[] = [];
    for (const n of names) {
      const t = sdk.types.get(n);
      const tpl = sdk.templates.get(n);
      for (const d of t?.deps ?? tpl!.deps) {
        const m = moduleOf.get(d);
        if (m !== undefined && m !== module) imports.set(m, (imports.get(m) ?? new Set()).add(d));
      }
      parts.push(t ? declaration(t, problems) : templateDeclaration(tpl!, problems));
    }
    const hasTemplates = names.some((n) => sdk.templates.has(n));
    const typing = ["Annotated", "ClassVar", "Literal", "Optional", "Union", ...(hasTemplates ? ["Generic", "TypeVar"] : [])].sort();
    const importLines = [...imports.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([m, set]) => `from .${moduleFile(m)} import ${[...set].sort().join(", ")}\n`)
      .join("");
    const vars = hasTemplates ? `${typeVars.map((v) => `${v} = TypeVar(${str(v)})`).join("\n")}\n\n` : "";
    const text = `${header(lock, `The OpenProposal \`${module}\` module's types.`)}# ruff: noqa: F401, E501
from typing import ${typing.join(", ")}

from pydantic import AfterValidator, BeforeValidator, Field, Strict
from typing_extensions import TypeAliasType

from . import _runtime as rt
${importLines}
${vars}${parts.join("\n\n")}`;
    files.push({ path: `openproposal/${moduleFile(module)}.py`, text });
  }
  const all = [...new Set([...sdk.emitted, ...sdk.templates.keys()])].sort();
  const imports = sdk.modules
    .map((m) => {
      const ns = all.filter((n) => moduleOf.get(n) === m);
      return ns.length > 0 ? `from .${moduleFile(m)} import ${ns.join(", ")}\n` : "";
    })
    .join("");
  files.push({
    path: "openproposal/__init__.py",
    text: `${header(
      lock,
      `The OpenProposal types of ${lock}.\n\nEach named type the schema emits is a Pydantic model or a named type alias of the same name, and each constructor is a generic model or a generic type alias. \`validate\` checks a JSON value against a type by its name.`,
    )}# ruff: noqa: E501
from functools import cache
from typing import Any

from pydantic import TypeAdapter

from ._runtime import is_format
${imports}from .registry import ExtensionRegistry

TYPES: dict[str, Any] = {
${sdk.emitted.map((n) => `    ${str(n)}: ${n},`).join("\n")}
}
"""Every named type the JSON Schema emits, by name."""

TEMPLATES: dict[str, Any] = {
${[...sdk.templates.keys()].sort().map((n) => `    ${str(n)}: ${n},`).join("\n")}
}
"""Every constructor's generic type, by name."""


@cache
def adapter(type_name: str) -> TypeAdapter[Any]:
    """The Pydantic adapter of a named type."""
    return TypeAdapter(TYPES[type_name])


def validate_json(type_name: str, data: str | bytes) -> Any:
    """Checks one JSON text against a named type, and returns its value."""
    return adapter(type_name).validate_json(data)


__all__ = [
${["ExtensionRegistry", "TEMPLATES", "TYPES", "adapter", "is_format", "validate_json", ...all].sort().map((n) => `    ${str(n)},`).join("\n")}
]
`,
  });
  files.push({ path: "openproposal/_runtime.py", text: RUNTIME(lock) });
  files.push({ path: "openproposal/registry.py", text: REGISTRY(lock) });
  files.push({ path: "openproposal/py.typed", text: "" });
  files.push({ path: "requirements.in", text: `# The OpenProposal Python types need Pydantic; tools/sdk/requirements.txt hash-locks it for the gates.\npydantic==${PYDANTIC_VERSION}\n` });
  return { files, problems };
}
