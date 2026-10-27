/**
 * The formats the schema uses, as each SDK runtime checks them: one
 * regular expression per format, written once here and copied into the
 * TypeScript, Python, and Go runtimes, plus the range checks a regular
 * expression can't state, which each runtime codes the same way.
 *
 * JSON Schema 2020-12 asserts a format by its RFC grammar (validation § 7.3),
 * so these follow the grammars, not a library: `date` and `date-time` are
 * RFC 3339 § 5.6 `full-date` and `date-time`, `duration` is RFC 3339
 * Appendix A, `uri` is RFC 3986 § 3 `URI`, and `uuid` is the RFC 9562
 * string form, hexadecimal in either case. Every expression is anchored
 * at both ends and uses only what ECMA-262, RE2, and Python `re` read the
 * same way: no `\d`, no lookaround, no backreference. Each runtime matches
 * the whole string, so a trailing newline fails, as type rules § 2 requires.
 *
 * The range checks:
 * - a date's month is 01 to 12, and its day is at least 01 and at most the
 *   month's length, February having 29 days in a leap year;
 * - a date-time's date is a date; its hour is at most 23, its minute at most
 *   59, and its second at most 59, or 60 for a leap second, which RFC 3339
 *   § 5.7 allows only at 23:59 UTC; an offset's hour is at most 23 and its
 *   minute at most 59.
 */

const unreserved = "A-Za-z0-9\\-._~";
const subDelims = "!$&'()*+,;=";
const pct = "%[0-9A-Fa-f]{2}";
const pchar = `(?:[${unreserved}${subDelims}:@]|${pct})`;
const decOctet = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])";
const ipv4 = `${decOctet}(?:\\.${decOctet}){3}`;
const h16 = "[0-9A-Fa-f]{1,4}";
const ls32 = `(?:${h16}:${h16}|${ipv4})`;
const ipv6 = [
  `(?:${h16}:){6}${ls32}`,
  `::(?:${h16}:){5}${ls32}`,
  `(?:${h16})?::(?:${h16}:){4}${ls32}`,
  `(?:(?:${h16}:){0,1}${h16})?::(?:${h16}:){3}${ls32}`,
  `(?:(?:${h16}:){0,2}${h16})?::(?:${h16}:){2}${ls32}`,
  `(?:(?:${h16}:){0,3}${h16})?::${h16}:${ls32}`,
  `(?:(?:${h16}:){0,4}${h16})?::${ls32}`,
  `(?:(?:${h16}:){0,5}${h16})?::${h16}`,
  `(?:(?:${h16}:){0,6}${h16})?::`,
]
  .map((x) => `(?:${x})`)
  .join("|");
const ipvFuture = `[vV][0-9A-Fa-f]+\\.[${unreserved}${subDelims}:]+`;
const host = `(?:\\[(?:${ipv6}|${ipvFuture})\\]|${ipv4}|(?:[${unreserved}${subDelims}]|${pct})*)`;
const authority = `(?:(?:[${unreserved}${subDelims}:]|${pct})*@)?${host}(?::[0-9]*)?`;
const hier = `(?://${authority}(?:/${pchar}*)*|/(?:${pchar}+(?:/${pchar}*)*)?|${pchar}+(?:/${pchar}*)*|)`;
const query = `(?:${pchar}|[/?])*`;

const durTime = "T(?:[0-9]+H(?:[0-9]+M(?:[0-9]+S)?)?|[0-9]+M(?:[0-9]+S)?|[0-9]+S)";
const durDate = "(?:[0-9]+D|[0-9]+M(?:[0-9]+D)?|[0-9]+Y(?:[0-9]+M(?:[0-9]+D)?)?)";

/** Each format's expression. `date` captures year, month, and day; `date-time` also hour, minute, second, and the offset's sign, hour, and minute. */
export const FORMAT_PATTERNS = {
  date: "^([0-9]{4})-([0-9]{2})-([0-9]{2})$",
  "date-time": "^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\\.[0-9]+)?(?:[Zz]|([+-])([0-9]{2}):([0-9]{2}))$",
  duration: `^P(?:${durDate}(?:${durTime})?|${durTime}|[0-9]+W)$`,
  uri: `^[A-Za-z][A-Za-z0-9+\\-.]*:${hier}(?:\\?${query})?(?:#${query})?$`,
  uuid: "^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$",
} as const;
