/**
 * The names a target gives an integer-coded vocabulary's codes, by the rule
 * the type rules record (docs/design/type-rules.md § 6, "Code names"): the
 * UPPER_SNAKE of each code's `title`. Every target that names codes, the
 * proto target now and the SDK emitters later, reads them here, so a code
 * has one name in every language.
 */

/** The longest code name; a longer one is cut at its last underscore before this length. */
export const CODE_NAME_MAX = 48;

/** A text in UPPER_SNAKE: its ASCII letters and digits, every other run of characters an underscore, trimmed of underscores. */
export const upperSnake = (text: string): string =>
  text
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();

/** A PascalCase type name in UPPER_SNAKE, a word at each capital: `ApiFramework` gives `API_FRAMEWORK`, `HTTPServer` `HTTP_SERVER`. */
export const typeUpperSnake = (name: string): string =>
  upperSnake(name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2"));

/** A code as a name's suffix: `3`, or `MINUS_1` for -1. */
export const codeSuffix = (code: number): string => (code < 0 ? `MINUS_${-code}` : String(code));

/**
 * One code's name before collisions: the UPPER_SNAKE of its title, with the
 * prefix `CODE_` where that starts with a digit, cut at its last underscore
 * before `CODE_NAME_MAX` where it runs longer. A title with no ASCII letter
 * or digit gives `CODE_<code>`.
 */
export function codeName(title: string, code: number): string {
  let name = upperSnake(title);
  if (name === "") return `CODE_${codeSuffix(code)}`;
  if (/^[0-9]/.test(name)) name = `CODE_${name}`;
  if (name.length > CODE_NAME_MAX) {
    const cut = name.slice(0, CODE_NAME_MAX + 1).lastIndexOf("_");
    name = cut > 0 ? name.slice(0, cut) : name.slice(0, CODE_NAME_MAX);
  }
  return name;
}

/**
 * The names of a vocabulary's codes, in their order: each code's name, and
 * where two or more codes' names collide, or a name is one of `taken`, each
 * of those codes' names with its code as a suffix, as
 * `GENERIC_MID_ROLL_MINUS_1`. Throws where a suffixed name still collides.
 */
export function codeNames(codes: readonly { code: number; title: string }[], taken: ReadonlySet<string> = new Set()): string[] {
  const first = codes.map((c) => codeName(c.title, c.code));
  const count = new Map<string, number>();
  for (const n of first) count.set(n, (count.get(n) ?? 0) + 1);
  const names = first.map((n, i) => (count.get(n)! > 1 || taken.has(n) ? `${n}_${codeSuffix(codes[i]!.code)}` : n));
  const seen = new Map<string, number>();
  names.forEach((n, i) => {
    const other = seen.get(n);
    if (other !== undefined || taken.has(n)) throw new Error(`the codes ${other !== undefined ? `${codes[other]!.code} and ` : ""}${codes[i]!.code} are both named ${n}, even with their codes as a suffix`);
    seen.set(n, i);
  });
  return names;
}
