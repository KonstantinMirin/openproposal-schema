import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHECKS, checkProblems, codesOf, instantOf } from "../src/rule-checks.ts";
import { loadLists } from "../src/lists.ts";
import type { RulesDoc } from "../src/rules.ts";
import { ROOT } from "./helpers.ts";

/** How a range's bounds compare, for the types the constructor rules' vectors fill `T` with. */
const ORDERS = new Map([["Count", "number"], ["Timestamp", "instant"]] as const);
const CODES = codesOf(loadLists(ROOT));

const RULES: [string, RulesDoc][] = [
  ["main", JSON.parse(readFileSync(join(ROOT, "rules", "rules.json"), "utf8")) as RulesDoc],
  ["with-open-prs", JSON.parse(readFileSync(join(ROOT, "rules", "with-open-prs", "rules.json"), "utf8")) as RulesDoc],
];

test("every rule one payload decides has a check that gives each of its vectors its verdict, and reads the pinned list its rule rests on", () => {
  for (const [lock, doc] of RULES) {
    const r = checkProblems(doc, ORDERS, CODES);
    assert.deepEqual(r.problems, [], lock);
    // Each rule is checked or says why not, and the reasons are the two a payload can't settle.
    assert.equal(r.checked.length + r.unchecked.length, doc.rules.length, lock);
    for (const u of r.unchecked) assert.ok(["two versions", "what a receiver does"].includes(u.why), `${lock}: ${u.id}: ${u.why}`);
    for (const id of r.checked) assert.ok(id in CHECKS);
  }
  const prs = checkProblems(RULES[1]![1], ORDERS, CODES);
  assert.deepEqual(prs.checked, [
    "constructor:Range:ordered",
    "constructor:Selectable:options-named",
    "constructor:Selectable:priced-beyond-included",
    "kernel:CurrencyCode:assigned",
    "kernel:DaypartWindow:ordered",
    "kernel:TimeZone:listed",
    "rule:2.2:06ccee9f",
    "rule:5.2.1:cc42a1f8",
    "rule:5.2.2:f9a1a6d5",
    "rule:5.2:f3d3f9e8",
    "rule:5.5:16494a1a",
    "rule:5.5:2eab2842",
  ]);
});

test("a check names options by value or by id, never a catalog reference, and compares bounds as numbers or instants", () => {
  const named = CHECKS["constructor:Selectable:options-named"]!;
  const ctx = { context: {}, part: false };
  assert.deepEqual(named({ available: [{ catalog_ref: "examplepub/audiences/smb@3" }], included: ["examplepub/audiences/smb@3"] }, ctx)!.map((v) => v.path), ["/included/0"]);
  assert.deepEqual(named({ available: [{ id: "a" }, "b"], included: ["a", "b"], pricing: { c: { delta_cpm: 1 } } }, ctx)!.map((v) => v.path), ["/pricing/c"]);
  const ordered = CHECKS["constructor:Range:ordered"]!;
  const instants = { ...ctx, order: "instant" as const };
  assert.deepEqual(ordered({ min: "2026-10-07T01:00:00Z", max: "2026-10-06T23:00:00-04:00" }, instants), [], "an instant compares as one, whatever its offset");
  assert.equal(ordered({ min: "2026-10-06T23:00:00-04:00", max: "2026-10-07T02:00:00Z" }, instants)!.length, 1);
  // An environment or a channel the tables don't define is an extension, which the check leaves alone.
  const env = CHECKS["rule:5.2.1:cc42a1f8"]!;
  assert.deepEqual(env({ channel: "examplepub.example:linear_tv", environments: { available: ["web_desktop"] } }, ctx), []);
  assert.deepEqual(env({ channel: "audio", environments: { available: ["ctv", "dooh", "examplepub.example:car"] } }, ctx)!.map((v) => v.path), ["/environments/available/1"]);
});

test("a range compares its bounds by its parameter's type, and never parses text that isn't a timestamp", () => {
  const ordered = CHECKS["constructor:Range:ordered"]!;
  const numbers = { context: {}, part: false, order: "number" as const };
  const instants = { context: {}, part: false, order: "instant" as const };
  assert.equal(ordered({ min: 10, max: 9 }, numbers)!.length, 1);
  assert.deepEqual(ordered({ min: 3, max: 3 }, numbers), []);
  // Numerals, a year, and a calendar date aren't the bounds' type: the schema rejects them, and the check compares nothing.
  assert.deepEqual(ordered({ min: "10", max: "9" }, numbers), []);
  assert.deepEqual(ordered({ min: "5", max: "1" }, instants), [], "Date.parse reads \"5\" as a year; the check doesn't");
  assert.deepEqual(ordered({ min: "2026-10-07", max: "2026-10-06T23:00:00Z" }, instants), [], "a calendar date isn't a timestamp");
  assert.deepEqual(ordered({ min: 5, max: "2026-01-01T00:00:00Z" }, instants), []);
  assert.equal(ordered({ min: "2026-10-06T00:00:00.5Z", max: "2026-10-06T00:00:00.25Z" }, instants)!.length, 1, "fractions of a second count");
  // Without the parameter's type, two bounds can't be compared; one bound needs no comparison.
  assert.equal(ordered({ min: 5, max: 1 }, { context: {}, part: false }), null);
  assert.deepEqual(ordered({ min: 5 }, { context: {}, part: false }), []);
  assert.equal(instantOf("2026-10-06T00:00:00+02:00"), Date.UTC(2026, 9, 5, 22));
  assert.equal(instantOf("2026-10-06"), null);
});

test("a daypart window compares times of day, and a time the schema rejects compares as nothing", () => {
  const window = CHECKS["kernel:DaypartWindow:ordered"]!;
  const ctx = { context: {}, part: false };
  assert.deepEqual(window({ start: "9:00", end: "10:00" }, ctx), [], "an unpadded hour is the schema's to reject");
  assert.equal(window({ start: "10:00", end: "10:00" }, ctx)!.length, 1);
  assert.deepEqual(window({ start: "22:00", end: "24:00" }, ctx), []);
  assert.equal(window({ start: "22:00", end: "02:00" }, ctx)!.length, 1);
});

test("a rule a code block can't decide is undecided: it shows a member the rule reads and leaves out the one the verdict turns on", () => {
  const part = { context: {}, part: true };
  const whole = { context: {}, part: false };
  const plcmt = CHECKS["rule:5.2:f3d3f9e8"]!;
  assert.equal(plcmt({ channel: "video" }, part), null, "a block that leaves out the placement");
  assert.equal(plcmt({ placement: { skip: true } }, part), null, "a block that leaves out the channel");
  assert.deepEqual(plcmt({ geo: { allowed: ["SGP"] } }, part), [], "a block that shows neither says nothing the rule reads");
  assert.equal(plcmt({ channel: "video" }, whole)!.length, 1);
  // "REQUIRED for video ads (`channel` `video`, or video on `channel` `ctv`)": no field says a ctv line item's ads are video.
  assert.equal(plcmt({ channel: "ctv", formats: { available: ["ctv/instream-15s"], included: [] } }, whole), null);
  assert.deepEqual(plcmt({ channel: "ctv", placement: { plcmt: 1 } }, whole), []);
  assert.deepEqual(plcmt({ channel: "display" }, whole), []);
  const env = CHECKS["rule:5.2.1:cc42a1f8"]!;
  assert.equal(env({ environments: { available: ["dooh"] } }, part), null);
  assert.deepEqual(env({ environments: { available: ["dooh"] } }, whole), []);
  const agreed = CHECKS["rule:2.2:06ccee9f"]!;
  assert.equal(agreed({ audiences: { available: [{ catalog_ref: "a/b@1" }] } }, part), null);
  assert.deepEqual(agreed({ geo: { allowed: ["SGP"] } }, part), []);
  const pinned = CHECKS["rule:5.5:16494a1a"]!;
  assert.equal(pinned({ exclusions: { list_ref: { url: "https://x.example/l", sha256: "a" } } }, part), null, "the pin is there, the status isn't");
  assert.equal(pinned({ exclusions: { list_ref: { url: "https://x.example/l" } } }, part)!.length, 1, "a missing pin needs no status");
  const measured = CHECKS["rule:5.2.2:f9a1a6d5"]!;
  const seller = { context: { "Proposal.seller_id": "examplepub" }, part: true };
  const base = { committed_metrics: [{ metric: "viewable_rate", value: 0.7 }], environments: { available: ["app_mobile"] }, measurement_source: { available: [{ id: "u", vendor: "IAS" }] } };
  assert.equal(measured(base, seller), null, "the block leaves out the placement, whose api[] may hold OMID 1.0");
  assert.equal(measured({ ...base, placement: { api: [6] } }, seller)!.length, 1);
  assert.deepEqual(measured({ ...base, placement: { api: [6] }, committed_metrics: [] }, seller), [], "a false condition decides it");
  assert.equal(measured({ ...base, placement: { api: [6] }, measurement_source: { available: [{ catalog_ref: "ias@1" }] } }, { ...seller, part: false }), null, "a vendor a reference stands for");
});

test("a currency code and a zone name are ones the pinned lists hold, and without the lists the checks can't decide", () => {
  const currency = CHECKS["kernel:CurrencyCode:assigned"]!;
  const zone = CHECKS["kernel:TimeZone:listed"]!;
  const ctx = { context: {}, part: false, codes: CODES };
  assert.deepEqual(currency("SGD", ctx), []);
  assert.equal(currency("QQQ", ctx)!.length, 1);
  assert.deepEqual(currency("usd", ctx), [], "a value the pattern rejects is the schema's to reject");
  assert.deepEqual(zone("America/Argentina/Buenos_Aires", ctx), []);
  assert.deepEqual(zone("US/Eastern", ctx), [], "a link the database keeps is a name it lists");
  assert.deepEqual(zone("viewer_local", ctx), []);
  assert.equal(zone("Mars/Olympus_Mons", ctx)!.length, 1);
  assert.equal(currency("USD", { context: {}, part: false }), null);
  const lists = loadLists(ROOT);
  for (const name of ["ISO 4217", "IANA time zone database"]) {
    const l = lists.lists.find((x) => x.name === name)!;
    assert.ok(l.version && /^[0-9a-f]{64}$/.test(l.sha256 ?? ""), `${name} names its version and its file's digest`);
  }
});
