/**
 * Where a rule program's owner sits in its holder (src/rule-program.ts): a
 * rule whose check reads more than its owner's value, as § 5.6.4's
 * `impression_multiplier`, REQUIRED when the line item counts impressions,
 * runs on the type that holds the owner, `on`, and reads that value whole.
 * The model says where the holder's values hold the owner's: each place is
 * the members from the holder to the owner, `*` for any item of a list or
 * value of a map. The SDK emitters write the places into the programs, and
 * the gates read them the same way.
 */
import type { TypeRef } from "./mapping.ts";
import type { ModelDoc } from "./model.ts";
import type { Programs, RuleProgram } from "./rule-program.ts";

/** A place of the owner's values in a holder's value: the members from the holder, `*` for any item of a list or value of a map. */
export type Place = string[];

type Types = Map<string, ModelDoc["types"][number]>;

const subst = (r: TypeRef, args: Record<string, TypeRef>): TypeRef => (r.kind === "parameter" ? (args[r.name] ?? r) : r.kind === "apply" ? { ...r, arguments: Object.fromEntries(Object.entries(r.arguments).map(([k, x]) => [k, subst(x, args)])) } : r);

/** The member types one level below a type reference: each with the member, or `*`, that reaches it. */
function children(types: Types, ref: TypeRef): [string, TypeRef][] {
  if (ref.kind === "apply") {
    const c = types.get(ref.constructor);
    if (c?.kind !== "constructor") return [];
    const shell = c.shell as { properties?: Record<string, { $model?: TypeRef }>; items?: { $model?: TypeRef }; additionalProperties?: { $model?: TypeRef } | boolean };
    const out: [string, TypeRef][] = [];
    for (const [k, p] of Object.entries(shell.properties ?? {})) if (p.$model) out.push([k, subst(p.$model, ref.arguments)]);
    if (shell.items?.$model) out.push(["*", subst(shell.items.$model, ref.arguments)]);
    if (typeof shell.additionalProperties === "object" && shell.additionalProperties.$model) out.push(["*", subst(shell.additionalProperties.$model, ref.arguments)]);
    return out;
  }
  if (ref.kind !== "named") return [];
  const t = types.get(ref.name);
  if (!t) return [];
  if (t.kind === "copy") return children(types, t.of);
  if (t.kind === "union") return t.any_of.flatMap((x) => children(types, x));
  if (t.kind === "object" || t.kind === "document") {
    return Object.entries(t.properties).flatMap(([k, p]) => [[k, p.type] as [string, TypeRef], ...(p.cases ?? []).map((c) => [k, c.type] as [string, TypeRef])]);
  }
  return [];
}

/**
 * The places of a type's values in a holder's value, sorted, by the model: a
 * walk of the holder's members that stops at each value of the owner, at a
 * value of the holder below it, which holds its own, and at a type the walk
 * is already inside.
 */
export function placesOf(model: ModelDoc, holder: string, owner: string): Place[] {
  const types: Types = new Map(model.types.map((t) => [t.name, t]));
  const out = new Map<string, Place>();
  const walk = (ref: TypeRef, path: Place, inside: Set<string>) => {
    if (ref.kind === "named") {
      if (ref.name === owner && path.length > 0) {
        out.set(JSON.stringify(path), path);
        return;
      }
      if ((ref.name === holder && path.length > 0) || inside.has(ref.name)) return;
    }
    const key = ref.kind === "named" ? ref.name : ref.kind === "apply" ? JSON.stringify(ref) : "";
    const next = new Set(inside).add(key);
    for (const [k, c] of children(types, ref)) walk(c, [...path, k], next);
  };
  walk({ kind: "named", name: holder }, [], new Set());
  return [...out.values()].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
}

const escapeToken = (t: string) => t.replace(/~/g, "~0").replace(/\//g, "~1");

/** The values a place reaches in a value, each with its JSON pointer from the value. */
export function valuesAt(value: unknown, place: Place): [string, unknown][] {
  let here: [string, unknown][] = [["", value]];
  for (const seg of place) {
    const next: [string, unknown][] = [];
    for (const [p, v] of here) {
      if (seg === "*") {
        if (Array.isArray(v)) v.forEach((x, i) => next.push([`${p}/${i}`, x]));
        else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) next.push([`${p}/${escapeToken(k)}`, x]);
      } else if (v !== null && typeof v === "object" && !Array.isArray(v) && seg in v) next.push([`${p}/${escapeToken(seg)}`, (v as Record<string, unknown>)[seg]]);
    }
    here = next;
  }
  return here;
}

/**
 * Every value of a named type in a value of a type, each with its JSON
 * pointer, by the model: the value itself where it is one, and those its
 * members hold. A list or map is walked by its items, a union by each of its
 * types, and a member is walked where the value holds it; the walk doesn't
 * check the value, so a value its type rejects may still be walked.
 */
export function instancesIn(model: ModelDoc, type: string, value: unknown): { type: string; path: string; value: unknown }[] {
  const types: Types = new Map(model.types.map((t) => [t.name, t]));
  const out: { type: string; path: string; value: unknown }[] = [];
  const seen = new Set<string>();
  const walk = (ref: TypeRef, path: string, v: unknown) => {
    if (ref.kind === "named") {
      const t = types.get(ref.name);
      if (t && (t.kind === "object" || t.kind === "document" || t.kind === "copy") && v !== null && typeof v === "object" && !Array.isArray(v)) {
        const k = `${ref.name} ${path}`;
        if (seen.has(k)) return;
        seen.add(k);
        out.push({ type: ref.name, path, value: v });
      }
    }
    const byKey = new Map<string, TypeRef[]>();
    for (const [k, c] of children(types, ref)) byKey.set(k, [...(byKey.get(k) ?? []), c]);
    for (const [k, refs] of byKey) for (const [p, x] of valuesAt(v, [k])) for (const c of refs) walk(c, `${path}${p}`, x);
  };
  walk({ kind: "named", name: type }, "", value);
  return out;
}

/**
 * The programs of a model's rules, each with the type it runs on, its
 * holder or its owner, and the places of the owner's values in a holder, as
 * the SDKs hold them; with the problems: a program whose owner isn't its
 * rule's, and a holder that holds no value of the owner.
 */
export function placedPrograms(model: ModelDoc, programs: Programs): { programs: Programs; runs: Map<string, string[]>; problems: string[] } {
  const rules: Record<string, RuleProgram> = {};
  const runs = new Map<string, string[]>();
  const problems: string[] = [];
  for (const r of [...model.rules].sort((a, b) => (a.ir < b.ir ? -1 : a.ir > b.ir ? 1 : 0))) {
    const program = programs.rules[r.ir];
    if (program === undefined) continue;
    if (program.owner !== r.owner) {
      problems.push(`rule "${r.ir}": its program's owner is "${program.owner}", and the rule's is "${r.owner}"`);
      continue;
    }
    const on = program.on ?? r.owner;
    const at = on === r.owner ? [] : placesOf(model, on, r.owner);
    if (on !== r.owner && at.length === 0) {
      problems.push(`rule "${r.ir}": its program runs on "${on}", which holds no value of its owner "${r.owner}"`);
      continue;
    }
    rules[r.ir] = at.length > 0 ? { ...program, at } : program;
    runs.set(on, [...(runs.get(on) ?? []), r.ir]);
  }
  return { programs: { defs: programs.defs, rules }, runs, problems };
}

/**
 * A vector's value of a rule's owner in a value of its holder, as an SDK
 * reads it: the holder's whole value where the vector's context gives it,
 * or else the holder's least example (`minimal`, which the schema accepts)
 * with each member the context gives, and the owner's value at the place,
 * with each list on the way holding the one value, and each object on the
 * way the least the walk gives it. The context names the holder's members
 * as `<holder>.<member>`, as a check's context does.
 */
export function inHolder(minimal: unknown, on: string, place: Place, value: unknown, context: Record<string, unknown>): unknown {
  const whole = context[on];
  const base: unknown = whole !== null && typeof whole === "object" && !Array.isArray(whole) ? whole : minimal;
  const out = JSON.parse(JSON.stringify(base ?? {})) as Record<string, unknown>;
  if (base === minimal) for (const [k, x] of Object.entries(context)) if (k.startsWith(`${on}.`)) out[k.slice(on.length + 1)] = x;
  let here: unknown = out;
  place.forEach((seg, i) => {
    const last = i === place.length - 1;
    const fresh = (): unknown => (last ? value : place[i + 1] === "*" ? [] : {});
    if (Array.isArray(here)) {
      const item = here.length > 0 && !last ? here[0] : fresh();
      here.splice(0, here.length, item);
      here = item;
    } else if (here !== null && typeof here === "object") {
      const o = here as Record<string, unknown>;
      const key = seg === "*" ? (Object.keys(o).sort()[0] ?? "x") : seg;
      if (last || o[key] === undefined) o[key] = fresh();
      here = o[key];
    }
  });
  return out;
}
