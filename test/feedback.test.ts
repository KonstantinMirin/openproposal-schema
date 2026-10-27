import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildLock, type LockBuild } from "../src/compare.ts";
import { loadConstructors } from "../src/constructors.ts";
import { loadFindings } from "../src/examples.ts";
import { allDecisions, placeCounts, buildFeedback, checkFeedback, checkLineLinks, compareSections, DETAILS_LINK, foldedCodeSpans, messageInTerms, proseParts, groupDecisions, INTERNAL, internalCitations, internalTypeName, internalTypeNames, renderComment, renderDetails, renderFeedback, restsOn, RULE_OF_KIND, type FeedbackInput } from "../src/feedback.ts";
import { loadKernel } from "../src/kernel.ts";
import { FINDING_KINDS } from "../src/lint.ts";
import { loadLock } from "../src/lock.ts";
import { loadDecisions, loadMappings } from "../src/mapping.ts";
import { loadDifferences } from "../src/render.ts";
import { loadVectors } from "../src/rules.ts";
import { ROOT } from "./helpers.ts";

const INPUT = {
  root: ROOT,
  mappings: loadMappings(ROOT, join(ROOT, "mapping")),
  decisions: loadDecisions(ROOT, join(ROOT, "decisions")),
  kernel: loadKernel(ROOT),
  constructors: loadConstructors(ROOT),
  vectors: loadVectors(ROOT),
};

async function build(file: string): Promise<LockBuild> {
  const r = await buildLock(loadLock(join(ROOT, "spec-input", file)), INPUT);
  assert.deepEqual(r.problems, []);
  return r.build!;
}

async function input(): Promise<FeedbackInput> {
  const builds = [await build("spec-lock.yaml"), await build("with-open-prs.lock.yaml")];
  return { ...INPUT, builds, recordedFindings: loadFindings(ROOT), recordedDifferences: loadDifferences(ROOT) };
}

test("sections sort as the specification numbers them", () => {
  assert.deepEqual(["5.10", "5.6.1", "5.6", "2", "5.4/creative-inspection-and-previews", "5.4"].sort(compareSections), ["2", "5.4", "5.4/creative-inspection-and-previews", "5.6", "5.6.1", "5.10"]);
});

test("the elements a decision rests on read by section", () => {
  assert.equal(
    restsOn(["field:4.1:valid_from,valid_until", "rule:3.2:ee009430", "marker:3:immutable", "marker:3:derived", "field:5.5:frequency_cap#description/object:1", "field:5.5:frequency_cap", "code:5.5:1"]),
    "§ 3: the markers `immutable`, `derived`; § 3.2: 1 statement; § 4.1: `valid_from`, `valid_until`; § 5.5: `frequency_cap`, 1 code block",
  );
});

test("every lint kind has a row", () => {
  for (const k of FINDING_KINDS) assert.ok(RULE_OF_KIND[k] !== undefined, k);
});

test("a decision's group is the first stage that cites it", () => {
  const groups = groupDecisions(INPUT);
  assert.equal(groups.get("D-001"), "formats", "a primitive cites the timestamp forms");
  assert.equal(groups.get("D-004"), "formats", "a primitive cites the daypart forms before the mapping does");
  assert.equal(groups.get("D-007"), "options", "a constructor's rule cites the option key");
  assert.equal(groups.get("D-008"), "options", "a constructor cites the bare value");
  assert.equal(groups.get("D-038"), "formats", "a value part, which no constructor's shell holds, cites the time zone");
  assert.equal(groups.get("D-016"), "types");
  assert.equal(groups.get("D-031"), "statements", "only obligation entries cite it");
  assert.equal(groups.get("D-034"), "readings", "only vectors cite it");
});

test("the report places every record and finding, and renders from its JSON form", async () => {
  const inp = await input();
  const { doc, problems } = buildFeedback(inp);
  assert.deepEqual(problems, []);
  assert.deepEqual(checkFeedback(doc, inp.builds), []);
  const decisions = doc.groups.flatMap((g) => g.decisions);
  assert.equal(decisions.find((d) => d.id === "D-022")?.locks.join(), "with-open-prs", "the geo decision applies only with the PRs");
  assert.equal(decisions.find((d) => d.id === "D-023")?.feedback, undefined, "a decision that asks nothing stays listed");
  // With the open PRs, the text states the daypart window and the line item's clock, so only main cites the two decisions.
  assert.equal(decisions.find((d) => d.id === "D-004")?.locks.join(), "main", "the window's form is a decision only on main");
  assert.equal(decisions.find((d) => d.id === "D-038")?.locks.join(), "main", "the line item's time zone is a decision only on main");
  // The seven rules of #121 hold its 33 findings on main.
  const main = doc.findings.filter((r) => /^\d$/.test(r.rule)).reduce((n, r) => n + r.findings.filter((f) => f.messages.some((m) => m.lock === "main")).length, 0);
  assert.equal(main, 33);
  assert.ok(doc.unions.some((u) => u.name === "MaterialsDue"), "an untagged union is feedback (type rules § 8)");
  // A condition names the key the specification writes, not the generated type that holds it.
  assert.ok(doc.conditions.some((c) => c.locks.join() === "with-open-prs" && c.text.startsWith("`placement.plcmt`: ")));
  assert.ok(!doc.conditions.some((c) => c.text.startsWith("Placement.")));
  // A report that lost a finding fails the check.
  const lossy = structuredClone(doc);
  lossy.findings[0]!.findings.pop();
  assert.ok(checkFeedback(lossy, inp.builds).some((p) => p.includes("isn't listed")));
  // The renderings are functions of the document.
  assert.equal(renderFeedback(doc), renderFeedback(buildFeedback(inp).doc));
  const comment = renderComment(doc);
  assert.ok(comment.includes(DETAILS_LINK), "the comment links the details gist");
  assert.match(comment, /^<!-- Generated by `npm run feedback`/);
  assert.doesNotMatch(comment.replace(/^<!--.*-->\n/, ""), /npm run|type rules|\bD-\d+\b/, "the comment is in the working group's terms");
  assert.match(comment, /Inputs: `main` at `44dfaaf`, and `main` with the 14 open PRs merged, including our #119, #120, and #123, at `[0-9a-f]{7}`\./, "the inputs name the PRs, ours among them");
  // Decisions are numbered 1 to N in reading order, and the text names them by number, never by ID.
  assert.deepEqual(decisions.map((d) => d.number), decisions.map((_, i) => i + 1));
  const details = renderDetails(doc);
  const n = decisions.find((d) => d.id === "D-016")!.number;
  assert.match(details, new RegExp(`\n#### ${n}\\. What does an object field hold`));
  assert.doesNotMatch(details.replace(/^<!--.*-->\n/, ""), /\bD-\d+\b/, "the details name no decision by its ID");
});

test("a decision ID or a repository document in the text for the working group is a problem", async () => {
  const inp = await input();
  const { doc } = buildFeedback(inp);
  assert.deepEqual(internalCitations(doc), []);
  const cited = structuredClone(doc);
  cited.findings.find((r) => r.findings.length > 0)!.findings[0]!.messages[0]!.message = "As D-7 reads it.";
  assert.ok(checkFeedback(cited, inp.builds).some((p) => p.startsWith("details.md line ") && p.includes('cites "D-7"')), "a short decision ID is caught too");
  const command = structuredClone(doc);
  command.groups[0]!.decisions[0]!.reading = "Run npm run map first.";
  assert.ok(internalCitations(command).some((p) => p.includes('cites "npm run"')));
});

test("a model type name the specification never writes is internal in the text for the working group, and one the specification writes isn't", async () => {
  const inp = await input();
  const names = internalTypeNames(inp.builds);
  for (const n of ["ExternalId", "DaypartWindow", "FormatId", "GeoBounds", "Selectable", "Count"]) assert.ok(names.has(n), n);
  // The specification writes these: `Timestamp` in its Type cells, AdCOM's `Placement` in a code span.
  for (const n of ["Timestamp", "Placement"]) assert.ok(!names.has(n), n);
  assert.equal(internalTypeName("Each entry names an option, as an `ExternalId`.", names), "ExternalId");
  assert.equal(internalTypeName("A daypart option is a DaypartWindow.", names), "DaypartWindow");
  assert.equal(internalTypeName("A selectable field takes `Selectable<FormatId>`.", names), "Selectable");
  assert.equal(internalTypeName("A point in time, a `Timestamp`, as AdCOM's `Placement` writes it.", names), null);
  assert.equal(internalTypeName("Count the options; the text is plain.", names), null, "a one-word name in prose is an English word");
  const { doc } = buildFeedback(inp);
  const named = structuredClone(doc);
  named.groups[0]!.decisions[0]!.reading = "Each is a `DaypartWindow`.";
  assert.ok(internalCitations(named, names).some((p) => p.includes('names the type "DaypartWindow"')));
});

test("a repository path, a record or task ID, or the pipeline's own terms read as internal, and the specification's own terms don't", () => {
  for (const text of ["See kernel/domains.yaml.", "As mapping/commercial.yaml writes it.", "In src/fidelity.ts.", "Accepted by G-002.", "Tracked as ops-c4g.23.", "Each use supplies it in the mapping.", "Each member takes the kernel type its meaning names.", "The constructor takes the bare value's type as an optional parameter `B`.", "So the model leaves it an open object.", "Lists, which the model writes with `[]`.", "An untagged union of its selectable copy and its settable copy.", "Each copy of a constructor is an alias.", "The proposal's summary profile.", "The summary is a profile.", "The generated model leaves it open.", "Our model leaves it open.", "As the pipeline's model writes it.", "The models agree.", "The model's type names.", "Its selectable copy.", "A copy of the template.", "The Selectable copy.", "Summary profiles of each document.", "The summary is a profile of the line item."]) {
    assert.ok(INTERNAL.test(text), text);
  }
  for (const text of ["See `examples/line-item-audio.yaml`.", "A selectable field accepts its bare value.", "Each member takes the schema type its meaning names.", "The seller maps each option to a key.", "A kernel of truth.", "D-day", "Where § 5.2.2 copies an AdCOM `0` | `1` integer.", "Whether inspection belongs to the object model.", "An untagged union of its selectable form and its settable form.", "To view a copy of this license, visit the link.", "The seller keeps a copy of the proposal.", "Where the list copies AdCOM's codes.", "A range copies its bounds.", "Runnable copies of every example.", "Copy the field.", "Copywriting.", "The buyer's audience profile.", "Sign it with a Web Bot Auth profile.", "Profiled audiences.", "The modeling of the object model and the data model."]) {
    assert.ok(!INTERNAL.test(text), text);
  }
});

test("a point the text leaves open doesn't ask for what a change we propose proposes: D-047 proposes production's id, so D-019 doesn't ask for it", () => {
  const byId = new Map(INPUT.decisions.map((d) => [d.id, d]));
  const d047 = byId.get("D-047")!;
  assert.equal(d047.kind, "departure");
  assert.ok(d047.covers.some((c) => c.ir === "field:5.4:production"));
  assert.match(d047.feedback ?? "", /production/);
  assert.doesNotMatch((byId.get("D-019")!.feedback ?? "").replace(/\s+/g, " "), /production/);
});

test("feedback that cites this repository's documents is a problem", async () => {
  const inp = await input();
  const decisions = inp.decisions.map((d) => (d.id === "D-017" ? { ...d, feedback: "Tag the two forms, as type rules § 8 asks." } : d));
  const { problems } = buildFeedback({ ...inp, decisions });
  assert.ok(problems.some((p) => p.startsWith("D-017's feedback cites \"type rules\"")), problems.join("; "));
});

test("a decision no lock cites has no place in the report", async () => {
  const inp = await input();
  const orphan = { ...inp.decisions.find((d) => d.id === "D-017")!, id: "D-999" };
  const { problems } = buildFeedback({ ...inp, decisions: [...inp.decisions, orphan] });
  assert.ok(problems.some((p) => p.startsWith("D-999: no lock's model or rules cite it")), problems.join("; "));
});

test("the report keeps the points the text leaves open apart from the changes we propose, and splits the example failures the same way", async () => {
  const inp = await input();
  const { doc } = buildFeedback(inp);
  const kind = new Map(inp.decisions.map((d) => [d.id, d.kind]));
  assert.ok(doc.groups.every((g) => g.decisions.every((d) => kind.get(d.id) === "gap")));
  assert.deepEqual(doc.departures.map((d) => d.id).sort(), inp.decisions.filter((d) => d.kind === "departure").map((d) => d.id).sort());
  for (const id of ["D-037", "D-039", "D-040", "D-041"]) assert.ok(doc.departures.some((d) => d.id === id), `${id} is a change we propose`);
  // The flights' calendar dates follow the text; the placeholder hash disagrees with it.
  assert.deepEqual(doc.examples.find((x) => x.paths.includes("/commitment/flight_start"))?.causes, ["departure"]);
  assert.deepEqual(doc.examples.find((x) => x.paths.includes("/exclusions/list_ref/sha256"))?.causes, ["gap"]);
  // An option with a readable ID and an unlisted term has two causes, and each decision lists it.
  const both = doc.examples.find((x) => x.paths.includes("/audiences/available/1"))!;
  assert.deepEqual(both.decisions, ["D-037", "D-041"]);
  const details = renderDetails(doc);
  for (const id of both.decisions) {
    const n = allDecisions(doc).find((d) => d.id === id)!.number;
    const section = details.slice(details.indexOf(`#### ${n}. `), details.indexOf("\n####", details.indexOf(`#### ${n}. `) + 1));
    assert.ok(section.includes("`/audiences/available/1`"), `decision ${n} lists the failure`);
  }
  assert.ok(details.includes("## Changes we propose") && details.includes("## The examples follow the text, but not a change we propose"));
  // The comment counts distinct places, so a value the schema rejects that also breaks a rule is one place, and a place
  // with a failure of each kind of cause is counted once, as doing both, and the three counts add up to the places.
  const places = placeCounts(doc, "main");
  assert.equal(places.gap + places.departure + places.both, places.places);
  const failures = doc.examples.filter((e) => e.locks.includes("main") && e.severity === "error").reduce((n, e) => n + e.paths.length, 0);
  assert.ok(places.places < failures, "the display example's measurement source is invalid and breaks a rule at one place");
  assert.ok(places.both >= 1, "the display example's catalog audience follows the text in its form and leaves its name open");
  assert.match(renderComment(doc), new RegExp(`so ${places.gap} \\+ ${places.departure} \\+ ${places.both} = ${places.places}`));
  const mixed = structuredClone(doc);
  const x = mixed.examples.find((e) => e.paths.includes("/audiences/available/1") && e.locks.includes("main"))!;
  x.causes = ["gap", "departure"];
  const after = placeCounts(mixed, "main");
  assert.deepEqual([after.departure, after.both, after.places], [places.departure - 1, places.both + 1, places.places]);
  // A SHOULD rule's failure is a warning, counted apart from the errors.
  const warned = structuredClone(doc);
  warned.examples.find((e) => e.locks.includes("main") && e.paths.includes("/audiences/available/1"))!.severity = "warning";
  assert.deepEqual([placeCounts(warned, "main").places, placeCounts(warned, "main").warnings], [places.places - 1, 1]);
  assert.match(renderComment(warned), /They break a SHOULD rule, a warning rather than an error, in 1 place on `main`/);
  // A report that files a change we propose with the open points fails the check.
  const misfiled = structuredClone(doc);
  misfiled.groups[0]!.decisions.push(misfiled.departures.shift()!);
  assert.ok(checkFeedback(misfiled, inp.builds).some((p) => /is a departure, listed with the decisions the text leaves open/.test(p)));
});

test("each union is one row across the locks, and a summary's union shows its projected form and its § 2.1 rows", async () => {
  const { doc } = buildFeedback(await input());
  const names = doc.unions.map((u) => u.name);
  assert.equal(new Set(names).size, names.length, "one item per union");
  const line = doc.unions.find((u) => u.name === "PropertiesOptionOrCatalogRef")!;
  assert.deepEqual(line.forms.map((f) => f.locks), [["main"], ["with-open-prs"]], "the open PRs add `apps` to a property");
  const summary = doc.unions.find((u) => u.name === "LineItemSummaryPropertiesOptionOrCatalogRef")!;
  assert.deepEqual(summary.forms, [{ locks: ["main", "with-open-prs"], forms: ["a reference that stands in for an inline value", "an object of `{ name }`"] }]);
  assert.ok(summary.sources.some((x) => x.startsWith("block:2.1:")), "the summary's union rests on § 2.1's list");
  const rows = renderDetails(doc).split("\n").filter((l) => l.includes("§ 5.2: `properties`"));
  assert.equal(new Set(rows).size, rows.length, "no repeated row");
});

test("an example's places are listed once under each decision, and the findings at one place in one table give one reason", async () => {
  const inp = await input();
  const { doc } = buildFeedback(inp);
  const details = renderDetails(doc);
  // Each example once, and each place in it once, though the display example's measurement source option is invalid and breaks a rule there.
  for (const line of details.split("\n").filter((l) => l.startsWith("- **Examples that"))) {
    const examples = line.split("; ").map((x) => /`([^`]+\.(?:yaml|json))`|§ [\d.]+ code block/.exec(x)?.[0]);
    assert.equal(new Set(examples).size, examples.length, line);
    for (const part of line.split("; ")) {
      const paths = [...part.matchAll(/`(\/[^`]*)`/g)].map((m) => m[1]);
      assert.equal(new Set(paths).size, paths.length, part);
    }
  }
  assert.ok(details.includes("`examples/line-item-ctv-bonus.yaml`, only with the open PRs, at `/line_item_id`"), "an example only one lock has says so");
  const row = details.split("\n").find((l) => l.startsWith("| `examples/line-item-display.yaml` | `/measurement_source/included/0` |"))!;
  assert.equal(row.split("The example follows the text").length - 1, 1, "the row gives its reason once");
  const split = structuredClone(doc);
  split.examples.find((x) => x.paths.includes("/reporting/included/0") && x.kind === "rule")!.reason += " Another reason.";
  assert.ok(checkFeedback(split, inp.builds).some((p) => p.includes("give different reasons in one table")));
});

test("a lint finding's places split by lock, and each MUST statement that names no field says how it is checked, not which authoring rule removes it", async () => {
  const inp = await input();
  const { doc } = buildFeedback(inp);
  const details = renderDetails(doc);
  // `viewable_rate` is named in § 5.2.2 only with the open PRs.
  assert.ok(details.includes("| `viewable_rate` resolves to no table row, key, or table-declared value. | § 5.7, § 8; with the open PRs, also § 5.2.2 |"));
  // A MUST statement is a rule with test vectors, the schemas, or an obligation on a party, as the model places it.
  const statements = doc.findings.find((r) => r.rule === "statements")!;
  assert.match(statements.title, /need conformance test vectors or bind a party/);
  assert.deepEqual([...new Set(statements.findings.flatMap((f) => f.messages.map((m) => m.checked)))].sort(), ["consumer", "implementation", "rule", "schema", "seller"]);
  assert.ok(details.includes('| A MUST statement in § 2.1 names no field or key: "A full fetch MUST return it." | § 2.1 | An obligation on the seller |'));
  assert.ok(details.includes("| Conformance test vectors, of a rule on one payload |"));
  const comment = renderComment(doc);
  assert.match(comment, /\| MUST statements that need conformance test vectors or bind a party \| 13 \| 26 \|/);
  // #118 at 395ca83: § 6.3 only points to § 5.4, and § 5.4's landing-page statement binds an implementation.
  assert.ok(!details.includes("| § 6.3 | An obligation on an implementation |"), "§ 6.3 states no inspection requirement of its own");
  assert.ok(details.includes('names no field or key: "The inspector MUST NOT request a destination or redirect that sends a production notification;'));
  assert.ok(details.includes("- **Rests on:** § 5.4: 7 statements\n- **Only on:** With the open PRs"), "the inspection decision rests on § 5.4 alone");
  assert.match(comment, /No authoring rule removes a MUST statement that names no field or key/);
});

test("a code span that a YAML line break folds holds a space no one wrote, so the source writes each span on one line", () => {
  const folded = "a:\n  reason: >-\n    names `examplepub/audiences/smb-decision-\n    makers@3` by it\n  question: plain, `on one line`\n";
  assert.deepEqual(foldedCodeSpans("x.yaml", folded), ['x.yaml line 3: a code span in "reason" runs onto the next line, so YAML folds the break into a space inside it; write the span on one line']);
  // A plain multi-line scalar folds too; a literal block keeps its breaks; a field the report doesn't show isn't checked.
  assert.equal(foldedCodeSpans("x.yaml", "feedback: name `a,\n  b` here\n").length, 1);
  assert.deepEqual(foldedCodeSpans("x.yaml", "reason: |\n  `a\n  b`\nrationale: >-\n  `a\n  b`\nsummary: >-\n  `a` and\n  `b`\n"), []);
  // Spans are backtick runs, as CommonMark reads them: a double-backtick span across a break folds, one that holds a backtick on one line doesn't.
  assert.deepEqual(foldedCodeSpans("x.yaml", "reason: >-\n  a ``x\n  y`` z\n"), ['x.yaml line 2: a code span in "reason" runs onto the next line, so YAML folds the break into a space inside it; write the span on one line']);
  assert.deepEqual(foldedCodeSpans("x.yaml", "reason: >-\n  a span `` ` `` then\n  more text\n"), []);
  assert.deepEqual(foldedCodeSpans("x.yaml", "reason: >-\n  the ``a `b` c`` span and `d`\n  more\n"), []);
  // A run that no run of as many backticks closes is literal, and a backslash escapes a backtick outside a span.
  assert.deepEqual(foldedCodeSpans("x.yaml", "reason: >-\n  a ``x` y\n  z\n"), ['x.yaml line 2: a run of 2 backticks in "reason" opens no code span, since no run of as many closes it, so it shows as literal backticks; close the span on its line, or remove the run', 'x.yaml line 2: a run of 1 backtick in "reason" opens no code span, since no run of as many closes it, so it shows as literal backticks; close the span on its line, or remove the run']);
  assert.deepEqual(foldedCodeSpans("x.yaml", "reason: >-\n  a \\` and `b`\n  c\n"), []);
  // The working group's text, as the committed records write it, has none.
  for (const d of INPUT.decisions) assert.deepEqual(foldedCodeSpans(d.id, readFileSync(d.file, "utf8")), []);
  assert.deepEqual(foldedCodeSpans("findings", readFileSync(loadFindings(ROOT).file, "utf8")), []);
  assert.doesNotMatch(readFileSync(join(ROOT, "feedback", "details.md"), "utf8"), /smb-decision- makers|cfo-finance- leaders/);
});

test("a structure proposed from a row's prose says only what the row says, and asks what the row leaves open", () => {
  const d016 = INPUT.decisions.find((d) => d.id === "D-016")!;
  const feedback = (d016.feedback ?? "").replace(/\s+/g, " ");
  const quote = d016.covers.find((c) => c.ir === "field:5.6:creative_policy")!.quote;
  assert.match(quote, /Content and category restrictions on creative$/);
  // The row names no taxonomy, so the proposal assigns none, and asks which list a category comes from.
  assert.doesNotMatch(feedback, /each category an IAB Content Taxonomy ID/);
  assert.match(feedback, /Say whether a category restriction names a category of the IAB Tech Lab Content Taxonomy, of its Ad Product Taxonomy, or of another list\./);
});

test("a record writes a list as paragraphs that start with a dash, and the details show each as an item under its label", async () => {
  assert.deepEqual(proseParts("Say:\n- whose status\n- which party"), { lead: "Say:", items: ["whose status", "which party"] });
  assert.deepEqual(proseParts("- one\n- two\nmore of two"), { lead: "", items: ["one", "two more of two"] });
  assert.deepEqual(proseParts("One  sentence,\nno list."), { lead: "One sentence, no list.", items: [] });
  const { doc } = buildFeedback(await input());
  const details = renderDetails(doc);
  assert.ok(details.includes("- **What to change:** Give each selectable and settable field its option type:\n  - The `formats` row namespaces a format ID by channel"));
  assert.ok(details.includes("- **What to change:**\n  - Name the key of each manifest entry"), "a list with no lead starts under its label");
  assert.ok(details.includes("- **Examples that follow the text:**\n  - § 5.6.3 code block, only with the open PRs, at"), "a change we propose lists each example as an item");
  // A finding's reason keeps the code span a careless edit once dropped from it.
  assert.ok(!details.includes("a catalog entry's included"));
  // A list item with no blank line before it would fold into the line above, which the check catches.
  assert.equal(foldedCodeSpans("x.yaml", "feedback: >-\n  Say:\n  - one\n").length, 1);
  assert.deepEqual(foldedCodeSpans("x.yaml", "feedback: >-\n  Say:\n\n  - one\n"), []);
});

test("the inputs name the day the PRs were open, each PR's head in merge order, and what the merge changed beside them", async () => {
  const { doc } = buildFeedback(await input());
  const details = renderDetails(doc);
  const pr = (n: number) => `[#${n}](https://github.com/IABTechLab/OpenProposal/pull/${n})`;
  assert.ok(details.includes(`The open PRs are the 14 open on 2026-10-26: ${pr(17)}, ${pr(18)}, ${pr(70)} to ${pr(76)}, ${pr(117)} to ${pr(120)}, and ${pr(123)}. Ours are #119, #120, and #123.`));
  // Each edit INTEGRATION-r4.md records outside a conflict hunk, merges 12, 13, and 14, in merge order.
  assert.ok(details.includes("We resolved the merge conflicts by hand, and moved #17's App identity block back above the § 5.2.1 that #119 adds, set the header of #120's rewarded-video example to § 6.7, and added `time_zone: viewer_local` to the examples of #70 and #120, as #123's description asks."));
  assert.ok(details.includes(`| 5 | ${pr(117)} | \`e51ee17\` |`), "#117 at its live head");
  assert.ok(details.includes(`| 11 | ${pr(118)} | \`395ca83\` |`), "#118 at its live head");
  assert.ok(details.includes(`| 14 | ${pr(123)} | \`9783ec8\` |`), "#123 merges last");
  assert.ok(details.includes("| `main` | [`44dfaaf`](https://github.com/IABTechLab/OpenProposal/tree/44dfaaf618736219426c311ec997b6d37e94b950) |"));
});

test("each lint finding on main links its lines at the locked commit, and the link check fails a link that doesn't open there", async () => {
  const inp = await input();
  const { doc } = buildFeedback(inp);
  const spec = readFileSync(join(ROOT, "spec-input/snapshots/main/spec/openproposal-3.0.md"), "utf8");
  const details = renderDetails(doc);
  const ok = checkLineLinks(doc, details, spec);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.unplaced, 2, "the two presence counts are about whole tables, with no line");
  assert.equal(ok.linked, doc.findings.reduce((n, r) => n + r.findings.filter((f) => f.messages.some((m) => m.lock === "main")).length, 0) - 2);
  assert.ok(details.includes("| `deal_id` resolves to no table row, key, or table-declared value. | § 1.1 | [§ 1.1, line 49](https://github.com/IABTechLab/OpenProposal/blob/44dfaaf618736219426c311ec997b6d37e94b950/spec/openproposal-3.0.md?plain=1#L49) | yes | yes |"));
  // A row with at most four links, though the Where column names every section.
  assert.equal((details.split("\n").find((l) => l.startsWith("| `catalog_ref` resolves"))!.match(/\]\(https/g) ?? []).length, 4);
  // A row that lost its links, a link to a blank line, and a link to the wrong commit each fail.
  const unlinked = details.replace(/\[§ 1\.1, line 49\]\([^)]*\)/, "");
  assert.ok(checkLineLinks(doc, unlinked, spec).problems.some((p) => p.includes("unresolved_identifier:deal_id: its row links none of its lines")));
  const blank = spec.split("\n");
  blank[48] = "";
  assert.ok(checkLineLinks(doc, details, blank.join("\n")).problems.some((p) => p.includes("line 49 of the specification is blank")));
  const moved = details.replace("blob/44dfaaf618736219426c311ec997b6d37e94b950/spec/openproposal-3.0.md?plain=1#L49", "blob/main/spec/openproposal-3.0.md?plain=1#L49");
  assert.ok(checkLineLinks(doc, moved, spec).problems.some((p) => p.includes("not the permalink")));
});

test("a lint message names an unnumbered heading by its section and title, and a value set by the names its codes have", async () => {
  const inp = await input();
  const prs = inp.builds[1]!;
  const statement = prs.lint.find((f) => f.id === "must_without_field:rule:5.4/creative-inspection-and-previews:7adf48a7")!;
  assert.match(messageInTerms(statement, prs.ir), /^A MUST NOT statement in § 5\.4, under "Creative inspection and previews", names no field or key: /);
  const flags = prs.lint.find((f) => f.id === "value_set_duplicate:0 | 1")!;
  assert.equal(messageInTerms(flags, prs.ir), "The value set `0` (no) | `1` (yes) is declared 3 times.");
  const platforms = prs.lint.find((f) => f.id.startsWith("value_set_duplicate:android"))!;
  assert.equal(messageInTerms(platforms, prs.ir), platforms.message, "a value set whose codes have no names is written as the lint writes it");
  // The suggestion's decisions must be listed, or the report has no number for them.
  const without = { ...inp, decisions: inp.decisions.map((d) => (d.id === "D-036" ? { ...d, status: "superseded" as const } : d)) };
  assert.ok(buildFeedback(without).problems.some((p) => p.includes("the suggestion to the working group cites D-036")));
});
