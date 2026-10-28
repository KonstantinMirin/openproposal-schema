/**
 * The IR's type expression: what a row's type cell says, as each
 * specification's plugin parses it (`TextFrontEnd.readTypeCell`), such as
 * `Array[Object]` or `Timestamp/Offset` in OpenProposal.
 */
export type TypeExpr =
  | { kind: "scalar"; name: string }
  | { kind: "array"; items: TypeExpr }
  | { kind: "union"; members: TypeExpr[] };

/** True when the expression is, or contains, the named scalar. */
export function typeMentions(t: TypeExpr, name: string): boolean {
  switch (t.kind) {
    case "scalar":
      return t.name === name;
    case "array":
      return typeMentions(t.items, name);
    case "union":
      return t.members.some((m) => typeMentions(m, name));
  }
}
