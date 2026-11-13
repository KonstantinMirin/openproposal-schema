/**
 * Rule programs: a rule's check written as data, so one definition runs in
 * the gates and is generated into every SDK, where each runtime evaluates it
 * the same way. This file is self-contained, since the TypeScript SDK holds
 * it as it is, and the Python and Go runtimes implement the same semantics.
 *
 * A program reads the value of the rule's owner, `["$"]`, and gives its
 * violations, each at a JSON pointer below the value with a message. A rule
 * whose check reads more than its owner's value names the type that holds
 * it, `on`, as `LineItem` for a rule on its `delivery_counting` that reads
 * its `pricing`: the program reads the holder's value as `["up"]`, and runs
 * on each of the owner's values at the places `at` lists in it. A program's
 * `undecided`, where it holds, says the rule can't decide: the holder shows
 * too little of what the rule reads. An expression is a JSON literal, which
 * is itself, or an operation, an array whose first item names it:
 *
 * - values: `["$"]` the owner's value; `["up"]` the holder's, the owner's
 *   where the program names no holder; `["given", key]` whether the holder
 *   shows the member, as a whole value does every member, and a holder a
 *   vector gives in part only those it gives; `["def", name]` a shared definition,
 *   read on the same value; `["var", name]` a name a list operation binds;
 *   `["get", x, key]` a member, `["at", x, i]` an item, absent as `null`;
 *   `["list", ...]` a list; `["table", key, {k: v}]` a literal map's value
 *   at a key, or `null`.
 * - tests: `has`, `ismap`, `islist`, `isnum`, `isstr`, `eq`, `ne` (by JSON
 *   value), `lt`, `le`, `gt`, `ge` (numbers only, else false), `and`, `or`,
 *   `not`, `if`, `coalesce` (the first that isn't null).
 * - numbers, exact: `add`, `sub`, `mul`, `div`, `floor`; a number from JSON
 *   is the decimal it writes, so `0.1 + 0.2` is `0.3`, and any operation on
 *   `null` gives `null`.
 * - lists and maps: `len`, `contains` (an item of a list, or text in
 *   text), `concat`, `values`, `keys` (a map's, sorted), `filter`, `map`,
 *   `sum`, `find`, each of the last four as `[op, list, name, expression]`.
 * - time: `["instant", s]` the seconds since the epoch an `Instant` names,
 *   or `null`; `["moment", s]` those an RFC 3339 date-time names, with its
 *   offset and its fraction of a second, or `null`; `["local_day", seconds,
 *   zone]` the day number, since 1970-01-01, of the civil date in a zone of
 *   the pinned time zone table, or `null` for a zone it doesn't hold or an
 *   instant outside it; `["duration", s]` an ISO 8601 duration as its
 *   calendar part, in months, and its exact part, in seconds, a list of two,
 *   or `null`.
 * - text: `["str", ...]`, each part's text, a number in its shortest
 *   decimal form; `["matches", s, pattern]`, whether the whole text matches
 *   a pattern, which uses only what JavaScript, Python, and Go regular
 *   expressions read alike; `["split", s, separator]`; `["num", s]`, a
 *   decimal's text as the number, or `null`; `["pointer", ...]`, a JSON
 *   pointer of its parts, each a member or an index; `["json", x]`, a
 *   value's JSON text, with a map's keys sorted and a number in its shortest
 *   decimal form.
 * - lists another body keeps: `["listed", list, code]`, whether the pinned
 *   list holds the code, as kernel/lists.yaml pins it; the programs carry the
 *   codes of each list they read.
 *
 * A violation applies when its `when` is `true`; any other value, `null`
 * included, means it doesn't. A violation with `each` applies once per item
 * of a list, or member of a map, by key order, binding the names `as` gives
 * to the index or key and to the item; its `path` is then an expression,
 * as any violation's may be.
 */

export type Expr = null | boolean | number | string | Expr[] | { [k: string]: Expr };

/** Every operation a program may name, with how many arguments it takes, as [least, most]; `Infinity` for any number. */
export const OPERATIONS: Record<string, [number, number]> = {
  $: [0, 0], up: [0, 0], given: [1, 1], def: [1, 1], var: [1, 1], get: [2, 2], at: [2, 2], list: [0, Infinity], table: [2, 2],
  has: [2, 2], ismap: [1, 1], islist: [1, 1], isnum: [1, 1], isstr: [1, 1], eq: [2, 2], ne: [2, 2], lt: [2, 2], le: [2, 2], gt: [2, 2], ge: [2, 2],
  and: [1, Infinity], or: [1, Infinity], not: [1, 1], if: [3, 3], coalesce: [1, Infinity],
  add: [2, Infinity], sub: [2, 2], mul: [2, Infinity], div: [2, 2], floor: [1, 1],
  len: [1, 1], contains: [2, 2], concat: [1, Infinity], values: [1, 1], keys: [1, 1], filter: [3, 3], map: [3, 3], sum: [3, 3], find: [3, 3],
  instant: [1, 1], moment: [1, 1], local_day: [2, 2], duration: [1, 1], str: [1, Infinity],
  matches: [2, 2], split: [2, 2], num: [1, 1], pointer: [1, Infinity], json: [1, 1], listed: [2, 2],
};

/**
 * The problems with a set of programs, read without running them: an
 * operation no evaluator knows, or with the wrong number of arguments, a
 * definition no program defines, and a list operation's name that isn't
 * bound where it is read.
 */
export function programProblems(p: Programs): string[] {
  const out: string[] = [];
  const walk = (e: Expr, where: string, bound: Set<string>) => {
    if (!Array.isArray(e)) return;
    const [op, ...args] = e;
    const arity = typeof op === "string" ? OPERATIONS[op] : undefined;
    if (arity === undefined) {
      out.push(`${where}: ${JSON.stringify(op)} is no operation`);
      return;
    }
    if (args.length < arity[0] || args.length > arity[1]) out.push(`${where}: ${op} takes ${arity[0] === arity[1] ? arity[0] : `${arity[0]} or more`} arguments, not ${args.length}`);
    if (op === "def" && !(String(args[0]) in p.defs)) out.push(`${where}: no definition ${JSON.stringify(args[0])}`);
    if (op === "var" && !bound.has(String(args[0]))) out.push(`${where}: the name ${JSON.stringify(args[0])} isn't bound here`);
    if (op === "get" || op === "has") {
      walk(args[0]!, where, bound);
      return;
    }
    if (op === "table") {
      walk(args[0]!, where, bound);
      return;
    }
    if (op === "filter" || op === "map" || op === "sum" || op === "find") {
      walk(args[0]!, where, bound);
      walk(args[2]!, where, new Set([...bound, String(args[1])]));
      return;
    }
    if (op === "listed" && (typeof args[0] !== "string" || !(args[0] in (p.lists ?? {})))) out.push(`${where}: the programs carry no codes of the list ${JSON.stringify(args[0])}`);
    if (op === "listed") {
      walk(args[1]!, where, bound);
      return;
    }
    if (op === "def" || op === "var" || op === "given") return;
    for (const a of args) walk(a, where, bound);
  };
  for (const [k, e] of Object.entries(p.defs)) walk(e, `defs.${k}`, new Set());
  for (const [id, r] of Object.entries(p.rules)) {
    if (r.undecided !== undefined) walk(r.undecided, `${id} undecided`, new Set());
    r.violations.forEach((v, i) => {
      const names = new Set(v.as ?? []);
      if (v.each !== undefined) walk(v.each, `${id} violation ${i + 1} each`, new Set());
      if ((v.each === undefined) !== (v.as === undefined)) out.push(`${id} violation ${i + 1}: \`each\` and \`as\` go together`);
      walk(v.when, `${id} violation ${i + 1} when`, names);
      walk(v.message, `${id} violation ${i + 1} message`, names);
      walk(v.path, `${id} violation ${i + 1} path`, names);
    });
  }
  return out;
}

export interface RuleProgram {
  /** The type whose values the rule reads, its owner in rules.json. */
  owner: string;
  /** The type that holds the owner's values and whose value the rule reads too, as `["up"]`; the owner where absent. */
  on?: string;
  /** The places of the owner's values in a value of `on`, each the members from it, `*` for any item of a list or value of a map, as the model gives them (src/rule-places.ts); written into the SDKs' programs, and absent where `on` is the owner. */
  at?: string[][];
  /** Where it holds, the rule can't decide: the gates' check is undecided, and an SDK reports no violation. */
  undecided?: Expr;
  violations: Violation[];
}

/** One way a value breaks a rule: where `when` holds, at `path`, with `message`; with `each`, once per item of a list or member of a map, binding the names `as` gives to the index or key and the item. */
export interface Violation {
  each?: Expr;
  as?: [string, string];
  when: Expr;
  path: Expr;
  message: Expr;
}

/** The holder of an owner's value: its value, and whether it is whole, as an SDK's is, or the members a vector gives. */
export interface Holder {
  value: unknown;
  whole: boolean;
}

interface Env {
  root: Value;
  up: Value;
  whole: boolean;
  memo: Map<string, Value>;
}

const escapeToken = (t: string) => t.replace(/~/g, "~0").replace(/\//g, "~1");

export interface Programs {
  defs: Record<string, Expr>;
  rules: Record<string, RuleProgram>;
  /** The codes of each pinned list a program reads with `listed`, by the list's name in kernel/lists.yaml. */
  lists?: Record<string, (string | number)[]>;
}

/** The UTC offsets of a time zone database release: each zone's offsets and changes, encoded, and each name's zone. */
export interface ZoneTable {
  release: string;
  from: number;
  until: number;
  /** `<offsets, base 36, comma-separated>|<delta>.<index> …`: the seconds since the previous change, from `from`, and the offset's index, base 36. */
  zones: Record<string, string>;
  names: Record<string, string>;
}

/** An exact rational number, `n / d` with `d > 0` and no common factor. */
interface Rat {
  r: true;
  n: bigint;
  d: bigint;
}

type Value = null | boolean | string | Rat | Value[] | { [k: string]: Value };

const isRat = (x: unknown): x is Rat => x !== null && typeof x === "object" && (x as { r?: unknown }).r === true;
const isObj = (x: unknown): x is { [k: string]: Value } => x !== null && typeof x === "object" && !Array.isArray(x) && !isRat(x);
const abs = (a: bigint) => (a < 0n ? -a : a);
const gcd = (a: bigint, b: bigint): bigint => {
  a = abs(a);
  b = abs(b);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
};
const rat = (n: bigint, d: bigint = 1n): Rat => {
  if (d < 0n) [n, d] = [-n, -d];
  const g = gcd(n, d) || 1n;
  return { r: true, n: n / g, d: d / g };
};

/** A decimal's text, such as `1500.00` or `1e3`, as an exact rational; null for text that isn't one. */
export function decimal(text: string): Rat | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!m) return null;
  const frac = m[3] ?? "";
  let n = BigInt(`${m[2]}${frac}`);
  let d = 10n ** BigInt(frac.length);
  const e = Number(m[4] ?? 0);
  if (e > 0) n *= 10n ** BigInt(e);
  else if (e < 0) d *= 10n ** BigInt(-e);
  return rat(m[1] === "-" ? -n : n, d);
}

/** A JSON value as a program reads it: each number exact. */
function fromJson(v: unknown): Value {
  if (typeof v === "number") return decimal(String(v)) ?? null;
  if (Array.isArray(v)) return v.map(fromJson);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromJson(x)]));
  if (typeof v === "string" || typeof v === "boolean") return v;
  return null;
}

/** A rational in its shortest decimal form, where it has one, else as `n/d`. */
export function ratText(x: Rat): string {
  let d = x.d;
  let twos = 0;
  let fives = 0;
  while (d % 2n === 0n) (d /= 2n), twos++;
  while (d % 5n === 0n) (d /= 5n), fives++;
  if (d !== 1n) return `${x.n}/${x.d}`;
  const k = Math.max(twos, fives);
  const scaled = (abs(x.n) * 10n ** BigInt(k)) / x.d;
  const digits = scaled.toString().padStart(k + 1, "0");
  const text = k === 0 ? digits : `${digits.slice(0, -k)}.${digits.slice(-k)}`;
  return x.n < 0n ? `-${text}` : text;
}

const same = (a: Value, b: Value): boolean => {
  if (isRat(a) || isRat(b)) return isRat(a) && isRat(b) && a.n === b.n && a.d === b.d;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]!));
  if (isObj(a)) return isObj(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => k in b && same(a[k]!, b[k]!));
  return a === b;
};
const cmp = (a: Value, b: Value): number | null => (isRat(a) && isRat(b) ? Number(Math.sign(Number(a.n * b.d - b.n * a.d))) : null);

/** The civil date of a day number since 1970-01-01, and back. */
const daysFromCivil = (y: number, m: number, d: number): number => {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
};

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const MOMENT = /^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?(?:([Zz])|([+-])([0-9]{2}):([0-9]{2}))$/;
const DURATION = /^P(?:([0-9]+)Y)?(?:([0-9]+)M)?(?:([0-9]+)W)?(?:([0-9]+)D)?(?:T(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+)S)?)?$/;

/** A zone's changes, decoded from the table once. */
const decoded = new Map<string, { at: number[]; offset: number[] }>();
function changesOf(table: ZoneTable, zone: string): { at: number[]; offset: number[] } | null {
  const key = table.names[zone];
  if (key === undefined) return null;
  let z = decoded.get(`${table.release} ${key}`);
  if (!z) {
    const [offsets, changes] = table.zones[key]!.split("|") as [string, string];
    const values = offsets.split(",").map((o) => parseInt(o, 36));
    let t = table.from;
    const at: number[] = [];
    const offset: number[] = [];
    for (const c of changes.split(" ")) {
      const [delta, index] = c.split(".") as [string, string];
      t += parseInt(delta, 36);
      at.push(t);
      offset.push(values[parseInt(index, 36)]!);
    }
    z = { at, offset };
    decoded.set(`${table.release} ${key}`, z);
  }
  return z;
}

/** The day number of the civil date in a zone at an instant, or null for a zone the table doesn't hold or an instant outside it. */
export function localDay(table: ZoneTable, seconds: number, zone: string): number | null {
  if (seconds < table.from || seconds >= table.until) return null;
  const z = changesOf(table, zone);
  if (z === null) return null;
  let lo = 0;
  let hi = z.at.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (z.at[mid]! <= seconds) lo = mid;
    else hi = mid - 1;
  }
  return Math.floor((seconds + z.offset[lo]!) / 86400);
}

const num = (x: Value): Rat | null => (isRat(x) ? x : null);
/** A value's JSON text: a map's keys sorted, a number in its shortest decimal form. */
const jsonText = (v: Value): string => {
  if (isRat(v)) return ratText(v);
  if (Array.isArray(v)) return `[${v.map(jsonText).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${jsonText(v[k]!)}`).join(",")}}`;
  return JSON.stringify(v);
};
const arith = (args: Value[], f: (a: Rat, b: Rat) => Rat | null): Value => {
  let acc: Rat | null = num(args[0] ?? null);
  for (const x of args.slice(1)) {
    const b = num(x);
    acc = acc === null || b === null ? null : f(acc, b);
  }
  return acc;
};

/** Evaluates programs against owner values, with the pinned time zone table. */
export class RuleEvaluator {
  constructor(
    private readonly programs: Programs,
    private readonly zones: ZoneTable,
  ) {}

  /** The rules the evaluator checks, by ID. */
  get rules(): string[] {
    return Object.keys(this.programs.rules).sort();
  }

  /**
   * The violations of one rule on one value of its owner, each at a JSON
   * pointer below it, with the owner's holder, where the program names one;
   * null where the rule can't decide.
   */
  check(rule: string, value: unknown, holder: Holder | null = null): { path: string; message: string }[] | null {
    const p = this.programs.rules[rule];
    if (!p) throw new Error(`no program for ${rule}`);
    const root = fromJson(value);
    const env: Env = holder === null ? { root, up: root, whole: true, memo: new Map() } : { root, up: fromJson(holder.value), whole: holder.whole, memo: new Map() };
    if (p.undecided !== undefined && this.eval(p.undecided, env, {}) === true) return null;
    const out: { path: string; message: string }[] = [];
    for (const v of p.violations) {
      for (const vars of this.bindings(v, env)) {
        if (this.eval(v.when, env, vars) !== true) continue;
        const m = this.eval(v.message, env, vars);
        const at = this.eval(v.path, env, vars);
        out.push({ path: typeof at === "string" ? at : "", message: typeof m === "string" ? m : "violates the rule" });
      }
    }
    return out;
  }

  /** The names a violation binds, once per item of its `each`; once, binding none, without one. */
  private bindings(v: Violation, env: Env): Record<string, Value>[] {
    if (v.each === undefined || v.as === undefined) return [{}];
    const x = this.eval(v.each, env, {});
    const [k, item] = v.as;
    if (Array.isArray(x)) return x.map((y, i) => ({ [k]: rat(BigInt(i)), [item]: y }));
    if (isObj(x)) return Object.keys(x).sort().map((key) => ({ [k]: key, [item]: x[key]! }));
    return [];
  }

  /**
   * The violations of one rule on a value of the type that runs it, its
   * holder, `on`, or its owner: on each of the owner's values at each place
   * `at` lists, each at a JSON pointer below the holder; none where the rule
   * can't decide, as an SDK reports.
   */
  violations(rule: string, value: unknown): { path: string; message: string }[] {
    const p = this.programs.rules[rule];
    if (!p) throw new Error(`no program for ${rule}`);
    if (p.on === undefined || p.on === p.owner) return this.check(rule, value) ?? [];
    const out: { path: string; message: string }[] = [];
    for (const place of p.at ?? []) {
      let here: [string, unknown][] = [["", value]];
      for (const seg of place) {
        const next: [string, unknown][] = [];
        for (const [at, v] of here) {
          if (seg === "*") {
            if (Array.isArray(v)) v.forEach((x, i) => next.push([`${at}/${i}`, x]));
            else if (v !== null && typeof v === "object") for (const k of Object.keys(v).sort()) next.push([`${at}/${escapeToken(k)}`, (v as Record<string, unknown>)[k]]);
          } else if (v !== null && typeof v === "object" && !Array.isArray(v) && seg in v) next.push([`${at}/${escapeToken(seg)}`, (v as Record<string, unknown>)[seg]]);
        }
        here = next;
      }
      for (const [at, v] of here) for (const x of this.check(rule, v, { value, whole: true }) ?? []) out.push({ path: at + x.path, message: x.message });
    }
    return out;
  }

  private eval(e: Expr, env: Env, vars: Record<string, Value>): Value {
    if (e === null || typeof e === "boolean" || typeof e === "string") return e;
    if (typeof e === "number") return decimal(String(e));
    if (!Array.isArray(e)) return fromJson(e);
    const [op, ...args] = e as [string, ...Expr[]];
    const ev = (x: Expr, more: Record<string, Value> = {}) => this.eval(x, env, { ...vars, ...more });
    switch (op) {
      case "$":
        return env.root;
      case "up":
        return env.up;
      case "given":
        return env.whole || (isObj(env.up) && (args[0] as string) in env.up);
      case "def": {
        const name = args[0] as string;
        if (!env.memo.has(name)) {
          const d = this.programs.defs[name];
          if (d === undefined) throw new Error(`no definition ${name}`);
          env.memo.set(name, this.eval(d, env, {}));
        }
        return env.memo.get(name)!;
      }
      case "var":
        return vars[args[0] as string] ?? null;
      case "get": {
        const x = ev(args[0]!);
        return isObj(x) ? (x[args[1] as string] ?? null) : null;
      }
      case "at": {
        const x = ev(args[0]!);
        const i = num(ev(args[1]!));
        return Array.isArray(x) && i !== null && i.d === 1n && i.n >= 0n && i.n < BigInt(x.length) ? x[Number(i.n)]! : null;
      }
      case "list":
        return args.map((x) => ev(x));
      case "table": {
        const k = ev(args[0]!);
        const t = args[1] as { [k: string]: Expr };
        return typeof k === "string" && k in t ? fromJson(t[k]) : null;
      }
      case "has": {
        const x = ev(args[0]!);
        return isObj(x) && (args[1] as string) in x;
      }
      case "ismap":
        return isObj(ev(args[0]!));
      case "islist":
        return Array.isArray(ev(args[0]!));
      case "isnum":
        return isRat(ev(args[0]!));
      case "isstr":
        return typeof ev(args[0]!) === "string";
      case "eq":
        return same(ev(args[0]!), ev(args[1]!));
      case "ne":
        return !same(ev(args[0]!), ev(args[1]!));
      case "lt":
      case "le":
      case "gt":
      case "ge": {
        const c = cmp(ev(args[0]!), ev(args[1]!));
        if (c === null) return false;
        return op === "lt" ? c < 0 : op === "le" ? c <= 0 : op === "gt" ? c > 0 : c >= 0;
      }
      case "and":
        for (const x of args) if (ev(x) !== true) return false;
        return true;
      case "or":
        for (const x of args) if (ev(x) === true) return true;
        return false;
      case "not":
        return ev(args[0]!) !== true;
      case "if":
        return ev(args[0]!) === true ? ev(args[1]!) : ev(args[2]!);
      case "coalesce":
        for (const x of args) {
          const v = ev(x);
          if (v !== null) return v;
        }
        return null;
      case "add":
        return arith(args.map((x) => ev(x)), (a, b) => rat(a.n * b.d + b.n * a.d, a.d * b.d));
      case "sub":
        return arith(args.map((x) => ev(x)), (a, b) => rat(a.n * b.d - b.n * a.d, a.d * b.d));
      case "mul":
        return arith(args.map((x) => ev(x)), (a, b) => rat(a.n * b.n, a.d * b.d));
      case "div":
        return arith(args.map((x) => ev(x)), (a, b) => (b.n === 0n ? null : rat(a.n * b.d, a.d * b.n)));
      case "floor": {
        const x = num(ev(args[0]!));
        if (x === null) return null;
        const q = x.n / x.d;
        return rat(x.n < 0n && q * x.d !== x.n ? q - 1n : q);
      }
      case "len": {
        const x = ev(args[0]!);
        return Array.isArray(x) ? rat(BigInt(x.length)) : null;
      }
      case "contains": {
        const x = ev(args[0]!);
        const y = ev(args[1]!);
        if (typeof x === "string") return typeof y === "string" && x.includes(y);
        return Array.isArray(x) && x.some((z) => same(z, y));
      }
      case "concat": {
        const parts = args.map((x) => ev(x));
        return parts.every(Array.isArray) ? (parts as Value[][]).flat() : null;
      }
      case "values": {
        const x = ev(args[0]!);
        return isObj(x) ? Object.keys(x).sort().map((k) => x[k]!) : null;
      }
      case "keys": {
        const x = ev(args[0]!);
        return isObj(x) ? Object.keys(x).sort() : null;
      }
      case "filter":
      case "map":
      case "sum":
      case "find": {
        const x = ev(args[0]!);
        if (!Array.isArray(x)) return op === "sum" ? rat(0n) : null;
        const name = args[1] as string;
        if (op === "filter") return x.filter((y) => ev(args[2]!, { [name]: y }) === true);
        if (op === "map") return x.map((y) => ev(args[2]!, { [name]: y }));
        if (op === "find") return x.find((y) => ev(args[2]!, { [name]: y }) === true) ?? null;
        return arith([rat(0n), ...x.map((y) => ev(args[2]!, { [name]: y }))], (a, b) => rat(a.n * b.d + b.n * a.d, a.d * b.d));
      }
      case "instant": {
        const x = ev(args[0]!);
        const m = typeof x === "string" ? INSTANT.exec(x) : null;
        if (!m) return null;
        const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
        return rat(BigInt(daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s));
      }
      case "moment": {
        const x = ev(args[0]!);
        const m = typeof x === "string" ? MOMENT.exec(x) : null;
        if (!m) return null;
        const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
        const offset = m[8] ? 0 : (m[9] === "-" ? -1 : 1) * (Number(m[10]) * 60 + Number(m[11])) * 60;
        const whole = rat(BigInt(daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s - offset));
        const fraction = m[7] ? decimal(`0${m[7]}`)! : rat(0n);
        return rat(whole.n * fraction.d + fraction.n * whole.d, whole.d * fraction.d);
      }
      case "duration": {
        const x = ev(args[0]!);
        const m = typeof x === "string" ? DURATION.exec(x) : null;
        if (!m || x === "P" || (x as string).endsWith("T")) return null;
        const n = (i: number) => BigInt(m[i] ?? 0);
        return [rat(n(1) * 12n + n(2)), rat(((n(3) * 7n + n(4)) * 24n + n(5)) * 3600n + n(6) * 60n + n(7))];
      }
      case "matches": {
        const x = ev(args[0]!);
        const pattern = ev(args[1]!);
        return typeof x === "string" && typeof pattern === "string" && new RegExp(`^(?:${pattern})$`, "u").test(x);
      }
      case "split": {
        const x = ev(args[0]!);
        const sep = ev(args[1]!);
        return typeof x === "string" && typeof sep === "string" && sep !== "" ? x.split(sep) : null;
      }
      case "num": {
        const x = ev(args[0]!);
        return typeof x === "string" ? decimal(x) : null;
      }
      case "pointer":
        return args
          .map((a) => {
            const v = ev(a);
            return `/${(isRat(v) ? ratText(v) : String(v)).replace(/~/g, "~0").replace(/\//g, "~1")}`;
          })
          .join("");
      case "json":
        return jsonText(ev(args[0]!));
      case "listed": {
        const codes = this.programs.lists?.[args[0] as string];
        const x = ev(args[1]!);
        if (codes === undefined) return null;
        return codes.some((c) => (typeof c === "number" ? isRat(x) && same(x, rat(BigInt(c))) : c === x));
      }
      case "local_day": {
        const t = num(ev(args[0]!));
        const z = ev(args[1]!);
        if (t === null || t.d !== 1n || typeof z !== "string") return null;
        const day = localDay(this.zones, Number(t.n), z);
        return day === null ? null : rat(BigInt(day));
      }
      case "str":
        return args
          .map((x) => {
            const v = ev(x);
            return isRat(v) ? ratText(v) : v === null ? "null" : typeof v === "string" ? v : JSON.stringify(v);
          })
          .join("");
      default:
        throw new Error(`no operation ${JSON.stringify(op)}`);
    }
  }
}
