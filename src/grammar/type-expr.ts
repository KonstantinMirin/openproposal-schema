/**
 * The IR's type expression: what a row's type cell says, as each
 * specification's plugin parses it (`TextFrontEnd.readTypeCell`), such as
 * `Array[Object]` or `Timestamp/Offset` in OpenProposal. A text that defines
 * its own types, as OpenProposal does with the stack's § 2.2 Shared types,
 * also writes a type by its name (`Instant`), a generic type applied to
 * arguments (`Selectable[FormatId]`, `Map[Domain, Object]`), and a generic
 * type's parameter (`T`).
 */
export type TypeExpr =
  | { kind: "scalar"; name: string }
  | { kind: "array"; items: TypeExpr }
  | { kind: "union"; members: TypeExpr[] }
  | { kind: "named"; name: string }
  | { kind: "apply"; name: string; arguments: TypeExpr[] }
  | { kind: "param"; name: string };

/** True when the expression is, or contains, the named scalar. */
export function typeMentions(t: TypeExpr, name: string): boolean {
  switch (t.kind) {
    case "scalar":
      return t.name === name;
    case "array":
      return typeMentions(t.items, name);
    case "union":
      return t.members.some((m) => typeMentions(m, name));
    case "apply":
      return t.arguments.some((m) => typeMentions(m, name));
    case "named":
    case "param":
      return false;
  }
}
