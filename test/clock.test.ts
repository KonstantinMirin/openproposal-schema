/**
 * The line item's clock across the stages: the daypart window's one
 * `TimeOfDay` primitive, the time zone the open PRs add, and the decisions
 * that apply only on the lock whose text leaves the window and the clock
 * open.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConstructors } from "../src/constructors.ts";
import { constraintsOf } from "../src/corpus.ts";
import type { SpecIR } from "../src/ir-types.ts";
import { loadKernel } from "../src/kernel.ts";
import { loadDecisions, loadMappings } from "../src/mapping.ts";
import { restatesPart } from "../src/mapping-rules.ts";
import { resolveModel } from "../src/model.ts";
import { renderTables } from "../src/render.ts";
import { ROOT } from "./helpers.ts";

const KERNEL = loadKernel(ROOT);
const CONSTRUCTORS = loadConstructors(ROOT);
const MAPPINGS = loadMappings(ROOT, join(ROOT, "mapping"));
const DECISIONS = loadDecisions(ROOT, join(ROOT, "decisions"));
const irOf = (dir: string) => JSON.parse(readFileSync(join(ROOT, dir, "spec-ir.json"), "utf8")) as SpecIR;
const MAIN_IR = irOf("ir");
const PRS_IR = irOf(join("ir", "with-open-prs"));
const resolve = (lock: string, ir: SpecIR) => resolveModel({ ir, lock, mappings: MAPPINGS, decisions: DECISIONS, kernel: KERNEL, constructors: CONSTRUCTORS });
const MAIN = resolve("main", MAIN_IR).model;
const PRS = resolve("with-open-prs", PRS_IR).model;
const typeOf = (m: typeof MAIN, name: string) => m.types.find((t) => t.name === name)!;
const WINDOW = CONSTRUCTORS.parts.find((p) => p.name === "DaypartWindow")!.shell;

test("an inline object restates a part only with exactly its members, `[]` where the part holds a list", () => {
  const member = (key: string, array = false) => ({ key, array, value: null });
  assert.equal(restatesPart({ combinator: "all", members: [member("days", true), member("start"), member("end")] }, WINDOW), true);
  assert.equal(restatesPart({ combinator: "all", members: [member("days"), member("start"), member("end")] }, WINDOW), false, "days is a list");
  assert.equal(restatesPart({ combinator: "all", members: [member("days", true), member("start")] }, WINDOW), false, "a member missing");
  assert.equal(restatesPart({ combinator: "all", members: [member("days", true), member("start"), member("end"), member("time_zone")] }, WINDOW), false, "a member the part lacks");
  const valued = { key: "start", array: false, value: { kind: "values" as const, items: ["06:00"], value_list: null } };
  assert.equal(restatesPart({ combinator: "all", members: [member("days", true), valued, member("end")] }, WINDOW), false, "a member with values of its own");
});

test("both daypart rows' window objects restate DaypartWindow with the open PRs, by rule", () => {
  const entries = MAPPINGS.flatMap((m) => m.entries).filter((e) => e.ir === "field:5.5:daypart#description/object:1" || e.ir === "block:5.5:12/object:1");
  assert.equal(entries.length, 2);
  for (const e of entries) {
    assert.deepEqual(e.source, { rule: "restated-part" });
    assert.deepEqual(e.as, { role: "same", name: "DaypartWindow" });
  }
  assert.deepEqual(resolve("with-open-prs", PRS_IR).problems, []);
});

test("the window decisions apply only on main, and a lock-scoped source applies only on its lock", () => {
  for (const name of ["TimeOfDay", "DayName"]) {
    assert.deepEqual(typeOf(MAIN, name).decisions, ["D-004"], `${name} on main`);
    assert.deepEqual(typeOf(PRS, name).decisions, [], `${name} with the open PRs`);
  }
  assert.deepEqual(typeOf(MAIN, "DaypartWindow").decisions, ["D-004", "D-038", "D-045"], "the window's shape and its start rest on D-004, its clock on D-038, its days on D-045");
  assert.deepEqual(typeOf(PRS, "DaypartWindow").decisions, ["D-045"], "with the open PRs, only the days' bound rests on a decision");
  assert.deepEqual(typeOf(MAIN, "TimeOfDay").sources, ["field:5.5:daypart"], "the sentence only the open PRs hold isn't a source on main");
  assert.deepEqual(typeOf(PRS, "TimeOfDay").sources, ["field:5.5:daypart", "sentence:5.5:348ea676"]);
  const ordered = (m: typeof MAIN) => m.kernel_rules.find((r) => r.id === "kernel:DaypartWindow:ordered")!;
  assert.deepEqual([ordered(MAIN).decisions, ordered(MAIN).sources], [["D-004"], []]);
  assert.deepEqual([ordered(PRS).decisions, ordered(PRS).sources], [[], ["sentence:5.5:348ea676"]]);
  for (const d of [...MAIN.decisions, ...PRS.decisions]) assert.ok(d !== "D-019" || MAIN.decisions.includes(d));
  assert.ok(!PRS.decisions.includes("D-004"), "the mapping cites the window decision only on main");
});

test("time_zone is a TimeZone, required with either of the members its row names, and only with the open PRs", () => {
  const li = typeOf(PRS, "LineItem");
  assert.ok(li.kind === "document");
  assert.deepEqual(li.properties.time_zone, { ...li.properties.time_zone, type: { kind: "named", name: "TimeZone" }, presence: "conditional", condition: "REQUIRED with `daypart` or `frequency_cap.period`" });
  const main = typeOf(MAIN, "LineItem");
  assert.ok(main.kind === "document" && !("time_zone" in main.properties));
  assert.equal(MAIN.types.some((t) => t.name === "TimeZone"), false);
});

test("the corpus reads a part's then: false as a constraint, and a dependency's then too", () => {
  const window = constraintsOf({ type: "object", properties: { start: { $ref: "#/$defs/TimeOfDay" } }, if: { type: "object", properties: { start: { const: "24:00" } }, required: ["start"] }, then: false });
  assert.deepEqual(window.found.map((f) => `${f.at}/${f.keyword}`), ["/type", "/then"], "the if is a condition, so nothing under it is walked");
  assert.deepEqual(window.unknown, []);
  const li = constraintsOf({ type: "object", properties: { frequency_cap: { $ref: "#/x" }, time_zone: { $ref: "#/y" } }, dependentSchemas: { frequency_cap: { if: { properties: { frequency_cap: { type: "object", required: ["period"] } } }, then: { required: ["time_zone"] } } } });
  assert.deepEqual(li.found.filter((f) => f.keyword === "required").map((f) => `${f.at}/${f.keyword}/${f.name}`), ["/dependentSchemas/frequency_cap/then/required/time_zone"]);
});

test("the round trip renders the daypart row's window from the part", () => {
  const { tables, problems } = renderTables(PRS, PRS_IR);
  assert.deepEqual(problems, []);
  const row = tables.find((t) => t.id === "table:5.5:1")!.rows.find((r) => r.row === "field:5.5:daypart")!;
  assert.match(row.cells.at(-1)!, /^`allowed\[\]` of `\{ days\[\], start, end \}`:/);
});

test("the daypart row's day list is what DayName's schema expresses, by rule, and the round trip renders it from DayName", () => {
  const e = MAPPINGS.flatMap((m) => m.entries).find((x) => x.ir === "field:5.5:daypart#description/values:1")!;
  assert.deepEqual([e.source, e.as], [{ rule: "restated-value-list" }, { role: "schema", in: "DayName" }]);
  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => `\`${d}\``).join(" | ");
  const text = (m: typeof PRS) => JSON.stringify(renderTables(m, PRS_IR).tables);
  assert.ok(text(PRS).includes(`\`days[]\` from ${days}, HH:MM civil time`), "the rendered daypart row lists DayName's values");
  // A DayName without Sunday renders without it, so the round trip would fail.
  const short = structuredClone(PRS);
  const dayName = short.types.find((t) => t.name === "DayName")! as unknown as { schema: { enum: string[] } };
  dayName.schema.enum = dayName.schema.enum.filter((d) => d !== "sunday");
  assert.ok(!text(short).includes(`\`days[]\` from ${days}`));
});
