import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConstructors } from "../src/constructors.ts";
import { emitSchemas } from "../src/emit.ts";
import type { SpecIR } from "../src/ir-types.ts";
import { loadKernel } from "../src/kernel.ts";
import { loadDecisions, loadMappings } from "../src/mapping.ts";
import { resolveModel, type ModelDoc } from "../src/model.ts";
import { checkRuleVectors, emitRules, isChange, loadVectors, renderRules, rulesDirOf, type RulesInput, type VectorFile, VECTORS_DIR } from "../src/rules.ts";
import { OP_SCHEMA, ROOT, SPEC } from "./helpers.ts";

const KERNEL = loadKernel(ROOT, SPEC);
const CONSTRUCTORS = loadConstructors(ROOT, SPEC);
const MAPPINGS = loadMappings(join(SPEC, "mapping"));
const DECISIONS = loadDecisions(join(SPEC, "decisions"));
const VECTORS = loadVectors(join(SPEC, VECTORS_DIR));
const irOf = (dir: string) => JSON.parse(readFileSync(join(SPEC, dir, "spec-ir.json"), "utf8")) as SpecIR;

function lockInput(lock: string, irDir: string, schemaDir: string): RulesInput & { files: ReturnType<typeof emitSchemas>["files"] } {
  const ir = irOf(irDir);
  const model: ModelDoc = resolveModel({ ir, lock, mappings: MAPPINGS, decisions: DECISIONS, kernel: KERNEL, constructors: CONSTRUCTORS }).model;
  const emitted = emitSchemas(model, schemaDir, OP_SCHEMA);
  return { model, ir, lock, vectors: VECTORS, decisions: DECISIONS, schemaDir, conditionsLeft: emitted.conditions.left, schemaBase: OP_SCHEMA.base, files: emitted.files };
}
const MAIN = lockInput("main", "ir", "schemas");
const PRS = lockInput("with-open-prs", join("ir", "with-open-prs"), "schemas/with-open-prs");

/** The vectors with one file's entries changed. */
const withVectors = (edit: (files: VectorFile[]) => void): VectorFile[] => {
  const copy = structuredClone(VECTORS);
  edit(copy);
  return copy;
};
const entry = (files: VectorFile[], rule: string) => files.flatMap((f) => f.rules).find((r) => r.rule === rule)!;

test("each lock's rules emit with no problem, each with valid and invalid vectors that the schema of its type accepts", () => {
  for (const input of [MAIN, PRS]) {
    const r = emitRules(input);
    assert.deepEqual(r.problems, [], `${input.lock}: ${r.problems.join("\n")}`);
    assert.deepEqual(checkRuleVectors(r.doc, input.model, input.files, input.schemaDir), [], input.lock);
    for (const rule of r.doc.rules) {
      assert.ok(rule.vectors.valid.length > 0 && rule.vectors.invalid.length > 0, `${rule.id} has vectors`);
      assert.ok(rule.statement.length > 0 && rule.owner.length > 0, `${rule.id} has a statement and an owner`);
    }
    assert.deepEqual(r.doc.rules.map((x) => x.id), [...r.doc.rules.map((x) => x.id)].sort(), "rules are sorted by ID");
  }
});

test("the committed rules are what the emitter writes", () => {
  for (const [input, dir] of [[MAIN, rulesDirOf("ir")], [PRS, rulesDirOf(join("ir", "with-open-prs"))]] as const) {
    assert.equal(readFileSync(join(SPEC, dir, "rules.json"), "utf8"), renderRules(emitRules(input).doc), dir);
  }
});

test("a marker is one rule, owned by Marker, that holds the statements in its row and applies to every property carrying it", () => {
  const { doc } = emitRules(MAIN);
  const sellerSet = doc.rules.find((r) => r.id === "marker:3:seller-set")!;
  assert.equal(sellerSet.owner, "Marker");
  assert.deepEqual(sellerSet.sources, ["marker:3:seller-set", "rule:3:e768cdf1"]);
  assert.ok(sellerSet.applies_to.includes("LineItem.min_spend") && sellerSet.applies_to.includes("PricingEntry.gross_rate"));
  assert.ok(!doc.rules.some((r) => r.id === "rule:3:e768cdf1"), "the row's statement isn't a rule of its own");
  assert.ok(sellerSet.vectors.valid.every(isChange) && sellerSet.vectors.invalid.every(isChange));
  for (const m of ["immutable", "seller-set", "selectable", "settable", "supplied", "requestable", "derived"]) assert.ok(doc.rules.some((r) => r.id === `marker:3:${m}`), m);
});

test("a rule without vectors fails", () => {
  const vectors = withVectors((fs) => {
    for (const f of fs) f.rules = f.rules.filter((r) => r.rule !== "rule:4.1:8e9aacb8");
  });
  const r = emitRules({ ...MAIN, vectors });
  assert.match(r.problems.join("\n"), /rule "rule:4\.1:8e9aacb8" \(owner Proposal\) has 0 valid and 0 invalid vectors on lock "main"; every rule needs at least one of each \(type rules § 9\)/);
});

test("vectors for no rule, a stale digest, the wrong module, and a decision that doesn't cover the rule fail", () => {
  const vectors = withVectors((fs) => {
    const proposal = fs.find((f) => f.module === "proposal")!;
    proposal.rules.push({ ...structuredClone(proposal.rules[0]!), rule: "rule:4.1:00000000" });
    entry(fs, "rule:5.4:2eaa294f").digest = "0".repeat(64);
    entry(fs, "rule:5.7:4994173c").decision = "D-001";
    const hold = fs.find((f) => f.module === "commercial")!;
    fs.find((f) => f.module === "creative")!.rules.push(hold.rules.shift()!);
  });
  const text = emitRules({ ...MAIN, vectors }).problems.join("\n");
  assert.match(text, /rule "rule:4\.1:00000000": names no rule on lock "main"/);
  assert.match(text, /rule "rule:5\.4:2eaa294f": stale digest on lock "main"/);
  assert.match(text, /rule "rule:5\.7:4994173c": cites "D-001", which doesn't cover "rule:5\.7:4994173c" on lock "main"/);
  assert.match(text, /rule "block:5\.6\.2:1\/values:1": the rule sits in § 5\.6\.2, which module "commercial" owns, so its vectors go in vectors\/commercial\.yaml/);
});

test("a marker rule's vector that isn't a pair, a vector both valid and invalid, and an unknown context key fail", () => {
  const vectors = withVectors((fs) => {
    const immutable = entry(fs, "marker:3:immutable");
    immutable.valid.push({ value: { line_item_id: "li-1" } });
    const hold = entry(fs, "block:5.6.2:1/values:1");
    hold.invalid.push(structuredClone(hold.valid[0]!));
    entry(fs, "rule:5.4:2eaa294f").valid[0]!.context = { "Proposal.no_such_field": 1 };
  });
  const text = emitRules({ ...MAIN, vectors }).problems.join("\n");
  assert.match(text, /rule "marker:3:immutable": a marker rule is about two versions and the party that changed one into the other/);
  assert.match(text, /rule "block:5\.6\.2:1\/values:1": .* is both valid and invalid/);
  assert.match(text, /rule "rule:5\.4:2eaa294f": the context key "Proposal\.no_such_field" names no property/);
});

test("a vector type the schema doesn't emit fails, and so does a vector the schema of its type rejects", () => {
  const unemitted = withVectors((fs) => {
    entry(fs, "marker:3:derived").type = "Marker";
  });
  assert.match(emitRules({ ...MAIN, vectors: unemitted }).problems.join("\n"), /rule "marker:3:derived": its vectors are instances of "Marker", which the schema doesn't emit/);

  const rejected = withVectors((fs) => {
    const v = entry(fs, "marker:3:seller-set").invalid[0]!;
    if (isChange(v)) v.after = { status: "draft", min_spend: -1 };
    entry(fs, "rule:2.2:06ccee9f").valid.push({ value: { status: "agreed", channel: 3 } });
  });
  const r = emitRules({ ...MAIN, vectors: rejected });
  assert.deepEqual(r.problems, []);
  const text = checkRuleVectors(r.doc, MAIN.model, MAIN.files, MAIN.schemaDir).join("\n");
  assert.match(text, /rule "marker:3:seller-set": invalid vector 1: the LineItem schema rejects its after \(\/min_spend must be >= 0/);
  assert.match(text, /rule "rule:2\.2:06ccee9f": valid vector 3: the LineItem schema rejects its value/);
});

test("a context value must be an instance of its property's type", () => {
  const vectors = withVectors((fs) => {
    entry(fs, "rule:5.2.2:f9a1a6d5").valid[0]!.context = { "Proposal.seller_id": 42 };
  });
  const r = emitRules({ ...PRS, vectors });
  assert.deepEqual(r.problems, []);
  assert.match(checkRuleVectors(r.doc, PRS.model, PRS.files, PRS.schemaDir).join("\n"), /rule "rule:5\.2\.2:f9a1a6d5": valid vector 1: context "Proposal\.seller_id": \/ must be string/);
});

test("a condition the schema leaves to the rules must be named by a rule, whose vectors entry lists the condition's row as a source", () => {
  const { doc } = emitRules(PRS);
  assert.deepEqual(PRS.conditionsLeft.map((c) => c.split(":")[0]), ["Placement.plcmt"]);
  assert.ok(doc.rules.find((r) => r.id === "rule:5.2:f3d3f9e8")!.sources.includes("key:5.2.2:placement.plcmt"));
  const r = emitRules({ ...PRS, conditionsLeft: [...PRS.conditionsLeft, "Placement.skipafter: the condition is unstated"] });
  assert.match(r.problems.join("\n"), /the schema leaves the condition of Placement\.skipafter to the rules, but no rule names its row \(key:5\.2\.2:placement\.skipafter\)/);
  // A rule whose statement mentions `plcmt` doesn't name the condition unless its entry lists the row.
  const unnamed = withVectors((fs) => {
    delete entry(fs, "rule:5.2:f3d3f9e8").sources;
  });
  assert.match(emitRules({ ...PRS, vectors: unnamed }).problems.join("\n"), /the schema leaves the condition of Placement\.plcmt to the rules, but no rule names its row/);
});

test("a vectors entry's sources join the rule's sources, and each must be an element its decision covers", () => {
  const hold = emitRules(MAIN).doc.rules.find((r) => r.id === "block:5.6.2:1/values:1")!;
  assert.deepEqual(hold.sources, ["block:5.6.2:1/values:1", "sentence:5.6.2:516faad1", "sentence:5.6.2:774f52b4"]);
  const vectors = withVectors((fs) => {
    entry(fs, "block:5.6.2:1/values:1").sources = ["sentence:5.6.2:774f52b4", "rule:2.2:06ccee9f", "sentence:9:00000000"];
    const history = entry(fs, "rule:4.1:8e9aacb8");
    history.sources = ["marker:3:immutable"];
    delete history.decision;
  });
  const text = emitRules({ ...MAIN, vectors }).problems.join("\n");
  assert.match(text, /rule "block:5\.6\.2:1\/values:1": its source "rule:2\.2:06ccee9f" isn't covered by "D-034"/);
  assert.match(text, /rule "block:5\.6\.2:1\/values:1": its source "sentence:9:00000000" is no IR element/);
  assert.match(text, /rule "rule:4\.1:8e9aacb8": its source "marker:3:immutable" needs a decision that covers it/);
});

test("a statement in a field row's description names that row as a source and applies to the owner's property", () => {
  const rules = emitRules(PRS).doc.rules;
  const history = rules.find((r) => r.id === "rule:4.1:8e9aacb8")!;
  assert.deepEqual(history.applies_to, ["Proposal.negotiation_history"]);
  assert.ok(history.sources.includes("field:4.1:negotiation_history[]"));
  assert.deepEqual(rules.find((r) => r.id === "rule:5.4:2eaa294f")!.applies_to, ["LineItem.materials_due"]);
  assert.deepEqual(rules.find((r) => r.id === "rule:5.7:4994173c")!.applies_to, ["LineItem.committed_metrics"]);
  assert.deepEqual(rules.find((r) => r.id === "rule:5.5:2eab2842")!.applies_to, ["LineItem"], "a statement in a prose block applies to its owner");
});

test("an invalid vector of a SHOULD-level rule is a warning, and of any other rule an error", () => {
  const rules = emitRules(PRS).doc.rules;
  const omid = rules.find((r) => r.id === "rule:5.2.2:f9a1a6d5")!;
  assert.equal(omid.level, "SHOULD NOT");
  assert.equal(omid.severity, "warning");
  for (const r of rules) if (r.id !== omid.id) assert.equal(r.severity, "error", r.id);
});

test("a Marker rule statement outside a marker row fails", () => {
  const model = structuredClone(MAIN.model);
  model.rules.find((r) => r.ir === "rule:4.1:8e9aacb8")!.owner = "Marker";
  assert.match(emitRules({ ...MAIN, model }).problems.join("\n"), /rule "rule:4\.1:8e9aacb8": the mapping gives it to "Marker", but it doesn't sit in a § 3 marker row/);
});
