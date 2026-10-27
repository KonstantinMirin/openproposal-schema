import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalJson, sha256 } from "../src/canonical.ts";
import { loadConstructors } from "../src/constructors.ts";
import { emitSchemas } from "../src/emit.ts";
import type { SpecIR } from "../src/ir-types.ts";
import { loadKernel } from "../src/kernel.ts";
import { decisionsOf, loadDecisions, loadMappings } from "../src/mapping.ts";
import { resolveModel, type ModelDoc, type ModelType } from "../src/model.ts";
import { emitRules, loadVectors, type Rule, type RulesDoc } from "../src/rules.ts";
import { generateCorpus, type CorpusDoc } from "../src/corpus.ts";
import {
  buildRelease,
  checkDigests,
  citedDecisions,
  checkFrozen,
  diffFiles,
  diffModels,
  diffRules,
  type Frozen,
  freezeRelease,
  jcs,
  jcsDigest,
  loadFrozen,
  oracleDigests,
  RELEASE_FILE,
  RELEASE_SCHEMA,
  renderRelease,
  unreviewedDecisions,
  validateRelease,
  type Change,
} from "../src/release.ts";
import { ROOT } from "./helpers.ts";

const KERNEL = loadKernel(ROOT);
const CONSTRUCTORS = loadConstructors(ROOT);
const MAPPINGS = loadMappings(ROOT, join(ROOT, "mapping"));
const DECISIONS = loadDecisions(ROOT, join(ROOT, "decisions"));
const IR = JSON.parse(readFileSync(join(ROOT, "ir", "spec-ir.json"), "utf8")) as SpecIR;
const MAIN = resolveModel({ ir: IR, lock: "main", mappings: MAPPINGS, decisions: DECISIONS, kernel: KERNEL, constructors: CONSTRUCTORS }).model;
const emit = (m: ModelDoc) => emitSchemas(m, "schemas").files;
const FILES = emit(MAIN);
const VECTORS = loadVectors(ROOT);
const rulesOf = (m: ModelDoc): RulesDoc => {
  const emitted = emitSchemas(m, "schemas");
  const r = emitRules({ model: m, ir: IR, lock: "main", vectors: VECTORS, decisions: DECISIONS, schemaDir: "schemas", conditionsLeft: emitted.conditions.left });
  assert.deepEqual(r.problems, []);
  return r.doc;
};
const RULES = rulesOf(MAIN);
const corpusOf = (m: ModelDoc, rules: RulesDoc = RULES, files = emit(m)): CorpusDoc => generateCorpus({ model: m, files, rules, kernel: KERNEL, schemaDir: "schemas", oracle: "4.26.0" }).doc;
const CORPUS = corpusOf(MAIN);
const tree = (files: { path: string; schema: unknown }[]) => Object.fromEntries(files.map((f) => [f.path, f.schema]));
/** A release built from the model, frozen as the previous one. */
const frozenOf = (model: ModelDoc, rules: RulesDoc = RULES, files = emit(model)): Frozen => ({ release: buildRelease({ model, files, rules, previous: null }).doc, model, rules, corpus: corpusOf(model, rules, files), files: tree(files) });

const ch = (n: number) => String.fromCharCode(n);
const BS = ch(92);

test("jcs writes RFC 8785's own examples: numbers, string escapes, and keys sorted by UTF-16 code units", () => {
  const value = {
    numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27],
    string: `${ch(0x20ac)}$${ch(0x0f)}${ch(0x0a)}A'B"${BS}${BS}"/`,
    literals: [null, true, false],
  };
  const want = `{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"${ch(0x20ac)}$${BS}u000f${BS}nA'B${BS}"${BS}${BS}${BS}${BS}${BS}"/"}`;
  assert.equal(jcs(value), want);
  // RFC 8785 § 3.2.3: the order of these keys by UTF-16 code units.
  const keys = [ch(0x20ac), ch(13), ch(0xfb33), "1", String.fromCodePoint(0x1f600), ch(0x80), ch(0xf6)];
  const sorted = `{"${BS}r":1,"1":3,"${ch(0x80)}":5,"${ch(0xf6)}":6,"${ch(0x20ac)}":0,"${String.fromCodePoint(0x1f600)}":4,"${ch(0xfb33)}":2}`;
  assert.equal(jcs(Object.fromEntries(keys.map((k, i) => [k, i]))), sorted);
  assert.equal(jcs({ b: [1, { d: 2, c: 3 }], a: "x" }), '{"a":"x","b":[1,{"c":3,"d":2}]}');
  assert.throws(() => jcs({ x: ch(0xd800) }), /lone surrogate/);
  assert.equal(jcsDigest({ b: 1, a: 2 }), sha256('{"a":2,"b":1}'));
});

test("the first release is 1.0.0 for every file, and each digest is the JCS SHA-256 of the file's schema", () => {
  const { doc, problems } = buildRelease({ model: MAIN, files: FILES, rules: RULES, previous: null });
  assert.deepEqual(problems, []);
  assert.equal(doc.release, "1.0.0");
  assert.equal(doc.previous, null);
  assert.deepEqual(doc.changes, []);
  assert.deepEqual(Object.keys(doc.files), FILES.map((f) => f.path));
  for (const f of FILES) {
    assert.equal(doc.files[f.path]!.version, "1.0.0");
    assert.equal(doc.files[f.path]!.digest, sha256(jcs(JSON.parse(f.text))));
  }
  assert.equal(doc.model, sha256(jcs(MAIN)));
  assert.equal(doc.rules, sha256(jcs(RULES)));
  assert.equal(doc.digest, sha256(jcs(Object.fromEntries(FILES.map((f) => [f.path, f.schema])))));
  assert.deepEqual(validateRelease(ROOT, doc), []);
  assert.equal(renderRelease(buildRelease({ model: MAIN, files: emit(MAIN), rules: RULES, previous: null }).doc), renderRelease(doc), "deterministic");
});

test("the digests recompute from the files' bytes, and a changed, missing, or unlisted file fails", () => {
  const { doc } = buildRelease({ model: MAIN, files: FILES, rules: RULES, previous: null });
  const bytes = new Map(FILES.map((f) => [f.path, Buffer.from(f.text)]));
  assert.deepEqual(checkDigests(doc, bytes, MAIN, RULES), []);
  // Whitespace isn't part of the value, so reformatting keeps every digest.
  const compact = new Map(FILES.map((f) => [f.path, Buffer.from(JSON.stringify(f.schema))]));
  assert.deepEqual(checkDigests(doc, compact), []);

  const path = FILES[0]!.path;
  const edited = new Map(bytes);
  edited.set(path, Buffer.from(canonicalJson({ ...FILES[0]!.schema, title: "Edited" })));
  assert.match(checkDigests(doc, edited).join("\n"), new RegExp(`${path}: the digest is`));
  const missing = new Map(bytes);
  missing.delete(path);
  assert.match(checkDigests(doc, missing).join("\n"), /which the tree lacks/);
  const extra = new Map(bytes).set("modules/stray/1/stray.json", Buffer.from("{}\n"));
  assert.match(checkDigests(doc, extra).join("\n"), /stray\.json isn't in release\.json/);
  const other = structuredClone(MAIN);
  other.counts.informative += 1;
  assert.match(checkDigests(doc, bytes, other).join("\n"), /the model digest is/);
  assert.match(checkDigests(doc, bytes, MAIN, { ...RULES, rules: RULES.rules.slice(1) }).join("\n"), /the rules digest is/);
});

test("the reference oracle's rfc8785 recomputes every digest of a written tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-"));
  try {
    const { doc } = buildRelease({ model: MAIN, files: FILES, rules: RULES, previous: null });
    for (const f of FILES) {
      mkdirSync(dirname(join(dir, f.path)), { recursive: true });
      writeFileSync(join(dir, f.path), f.text);
    }
    writeFileSync(join(dir, RELEASE_FILE), renderRelease(doc));
    writeFileSync(join(dir, "model.json"), canonicalJson(MAIN));
    writeFileSync(join(dir, "rules.json"), canonicalJson(RULES));
    const ok = oracleDigests(ROOT, [{ release: join(dir, RELEASE_FILE), schemas: dir, model: join(dir, "model.json"), rules: join(dir, "rules.json") }]);
    assert.deepEqual(ok.problems, []);
    writeFileSync(join(dir, FILES[0]!.path), canonicalJson({ ...FILES[0]!.schema, title: "Edited" }));
    writeFileSync(join(dir, "rules.json"), canonicalJson({ ...RULES, rules: [] }));
    const bad = oracleDigests(ROOT, [{ release: join(dir, RELEASE_FILE), schemas: dir, model: null, rules: join(dir, "rules.json") }]);
    assert.match(bad.problems.join("\n"), /rfc8785 gives/);
    assert.match(bad.problems.join("\n"), /the rules digest under rfc8785/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A copy of the model with one change made to it. */
function changed(edit: (types: Map<string, ModelType>, m: ModelDoc) => void): ModelDoc {
  const m = structuredClone(MAIN);
  edit(new Map(m.types.map((t) => [t.name, t])), m);
  return m;
}
const props = (t: ModelType | undefined) => {
  assert.ok(t && "properties" in t, "an object");
  return t.properties;
};
const only = (cs: Change[], cls: Change["class"]) => cs.filter((c) => c.class === cls).map((c) => `${c.type}${c.member !== undefined ? `.${c.member}` : ""}: ${c.change}`);

test("the differ finds no change between a model and itself", () => {
  assert.deepEqual(diffModels(MAIN, structuredClone(MAIN)), []);
});

test("the differ flags removed fields as breaking", () => {
  const next = changed((t) => {
    delete props(t.get("LineItem")).min_spend;
  });
  assert.deepEqual(only(diffModels(MAIN, next), "breaking"), ["LineItem.min_spend: removed-property"]);
  const gone = changed((_, m) => {
    m.types = m.types.filter((t) => t.name !== "Visibility");
  });
  assert.ok(only(diffModels(MAIN, gone), "breaking").includes("Visibility: removed-type"));
});

test("the differ flags narrowed types as breaking, and widened ones as additive", () => {
  // A property whose type accepts less: Text, any string, becomes CatalogRef, a pattern.
  const toCatalogRef = changed((t) => {
    props(t.get("LineItem")).serving_platform!.type = { kind: "named", name: "CatalogRef" };
  });
  const c = diffModels(MAIN, toCatalogRef);
  assert.deepEqual(only(c, "breaking"), ["LineItem.serving_platform: changed-type"]);
  assert.match(c.find((x) => x.change === "changed-type")!.detail, /pattern added/);
  // A primitive whose constraint tightens narrows every field that uses it.
  const capped = changed((t) => {
    const amount = t.get("Amount");
    assert.ok(amount?.kind === "primitive");
    amount.schema = { ...amount.schema, maximum: 1000 };
  });
  assert.deepEqual(only(diffModels(MAIN, capped), "breaking"), ["Amount: narrowed-type"]);
  // A closed vocabulary that loses a term, and a union that loses a branch.
  const fewer = changed((t) => {
    const v = t.get("Visibility");
    assert.ok(v?.kind === "vocabulary");
    v.terms = v.terms.filter((x) => x.value !== "named");
    const u = t.get("MaterialsDue");
    assert.ok(u?.kind === "union");
    u.any_of = u.any_of.filter((r) => !(r.kind === "named" && r.name === "Duration"));
  });
  assert.deepEqual(only(diffModels(MAIN, fewer), "breaking"), ["MaterialsDue.Duration: removed-branch", "Visibility.named: removed-term"]);
  // An open object that closes.
  const closed = changed((t) => {
    const o = t.get("Approval");
    assert.ok(o?.kind === "object");
    o.open = false;
  });
  assert.deepEqual(only(diffModels(MAIN, closed), "breaking"), ["Approval: closed-object"]);
  // The reverse changes widen.
  assert.deepEqual(only(diffModels(toCatalogRef, MAIN), "breaking"), []);
  assert.deepEqual(only(diffModels(toCatalogRef, MAIN), "additive"), ["LineItem.serving_platform: widened-type"]);
  assert.deepEqual(only(diffModels(capped, MAIN), "additive"), ["Amount: widened-type"]);
  assert.deepEqual(only(diffModels(fewer, MAIN), "additive"), ["MaterialsDue.Duration: added-branch", "Visibility.named: added-term"]);
  assert.deepEqual(only(diffModels(closed, MAIN), "additive"), ["Approval: opened-object"]);
});

test("the differ flags new required members as breaking, and a new optional one as additive", () => {
  const required = changed((t) => {
    props(t.get("LineItem")).serving_mode!.presence = "required";
  });
  assert.deepEqual(only(diffModels(MAIN, required), "breaking"), ["LineItem.serving_mode: required-property"]);
  const added = changed((t) => {
    props(t.get("Billing")).po_number = { type: { kind: "named", name: "Id" }, presence: "required", sources: [] };
  });
  assert.deepEqual(only(diffModels(MAIN, added), "breaking"), ["Billing.po_number: required-property"]);
  const conditional = changed((t) => {
    props(t.get("Billing")).po_number = { type: { kind: "named", name: "Id" }, presence: "conditional", condition: "REQUIRED when `x = y`", sources: [] };
  });
  assert.deepEqual(only(diffModels(MAIN, conditional), "breaking"), ["Billing.po_number: required-property"]);
  const optional = changed((t) => {
    props(t.get("Billing")).po_number = { type: { kind: "named", name: "Id" }, presence: "optional", sources: [] };
  });
  assert.deepEqual(only(diffModels(MAIN, optional), "breaking"), []);
  assert.deepEqual(only(diffModels(MAIN, optional), "additive"), ["Billing.po_number: added-property"]);
  // An open object accepted the member with any value, so typing it narrows.
  const typed = changed((t) => {
    props(t.get("Approval")).state = { type: { kind: "named", name: "Id" }, presence: "optional", sources: [] };
  });
  assert.deepEqual(only(diffModels(MAIN, typed), "breaking"), ["Approval.state: constrained-property"]);
  assert.deepEqual(only(diffModels(required, MAIN), "additive"), ["LineItem.serving_mode: relaxed-property"]);
});

test("the differ flags a changed marker as breaking and a changed description as an annotation", () => {
  const marker = changed((t) => {
    props(t.get("LineItem")).serving_mode!.marker = "immutable";
  });
  assert.deepEqual(only(diffModels(MAIN, marker), "breaking"), ["LineItem.serving_mode: changed-marker"]);
  const prose = changed((t) => {
    props(t.get("LineItem")).serving_mode!.description = "Edited.";
    const amount = t.get("Amount");
    assert.ok(amount?.kind === "primitive");
    amount.schema = { ...amount.schema, description: "Edited." };
  });
  const c = diffModels(MAIN, prose);
  assert.deepEqual(only(c, "breaking"), []);
  assert.deepEqual(only(c, "additive"), []);
  assert.deepEqual(only(c, "annotation"), ["Amount: description", "LineItem.serving_mode: description"]);
});

test("the version follows from the last frozen release: minor for additive, patch for annotations, unchanged files keep theirs", () => {
  const previous = frozenOf(MAIN);
  const first = previous.release;

  const same = buildRelease({ model: MAIN, files: FILES, rules: RULES, previous });
  assert.deepEqual(same.problems, []);
  assert.deepEqual(same.doc, first, "with no change, the manifest is the frozen one");

  const added = changed((t) => {
    props(t.get("Billing")).po_number = { type: { kind: "named", name: "Id" }, presence: "optional", sources: [] };
  });
  const minor = buildRelease({ model: added, files: emit(added), rules: RULES, previous });
  assert.deepEqual(minor.problems, []);
  assert.equal(minor.doc.release, "1.1.0");
  assert.equal(minor.doc.previous, "1.0.0");
  const moved = Object.entries(minor.doc.files).filter(([, e]) => e.version === "1.1.0").map(([p]) => p);
  assert.deepEqual(moved, ["modules/settlement/1/settlement.json"]);
  assert.deepEqual(validateRelease(ROOT, minor.doc), []);

  const prose = changed((t) => {
    props(t.get("LineItem")).serving_mode!.description = "Edited.";
  });
  const patch = buildRelease({ model: prose, files: emit(prose), rules: RULES, previous });
  assert.equal(patch.doc.release, "1.0.1");
  assert.deepEqual(only(patch.doc.changes, "annotation"), ["LineItem.serving_mode: description"]);
  assert.deepEqual(Object.entries(patch.doc.files).filter(([, e]) => e.version === "1.0.1").map(([p]) => p), ["documents/1/line-item.json"]);

  const removed = changed((t) => {
    delete props(t.get("LineItem")).min_spend;
  });
  const breaking = buildRelease({ model: removed, files: emit(removed), rules: RULES, previous });
  assert.match(breaking.problems[0]!, /^breaking change within major 1, against 1\.0\.0: LineItem min_spend: removed-property/);
  assert.match(breaking.problems.join("\n"), /documents\/1\/line-item\.json: narrowed-schema: .*"min_spend" is removed/);
});

test("a schema file change the model doesn't show is classed from the files: narrowing is breaking, widening bumps the minor", () => {
  const previous = frozenOf(MAIN);
  const kernelFile = FILES.find((f) => f.path === "kernel/1/kernel.json")!;
  const withDef = (edit: (defs: Record<string, Record<string, unknown>>) => void) =>
    FILES.map((f) => {
      if (f !== kernelFile) return f;
      const schema = structuredClone(f.schema);
      edit(schema.$defs as Record<string, Record<string, unknown>>);
      return { path: f.path, schema, text: canonicalJson(schema) };
    });
  // The emitter caps a kernel primitive, with the model unchanged.
  const capped = buildRelease({ model: MAIN, files: withDef((d) => (d.CatalogReference!.maxLength = 1)), rules: RULES, previous });
  assert.equal(capped.doc.release, "1.1.0");
  assert.deepEqual(only(capped.doc.changes, "breaking"), ["kernel/1/kernel.json.CatalogReference: narrowed-schema"]);
  assert.match(capped.problems.join("\n"), /maxLength added/);
  // Dropping a constraint widens; a description alone only bumps the patch.
  const loose = buildRelease({ model: MAIN, files: withDef((d) => delete d.CatalogRef!.pattern), rules: RULES, previous });
  assert.deepEqual(loose.problems, []);
  assert.equal(loose.doc.release, "1.1.0");
  assert.deepEqual(only(loose.doc.changes, "additive"), ["kernel/1/kernel.json.CatalogRef: widened-schema"]);
  const prose = buildRelease({ model: MAIN, files: withDef((d) => (d.CatalogRef!.description = "Edited.")), rules: RULES, previous });
  assert.deepEqual(prose.problems, []);
  assert.equal(prose.doc.release, "1.0.1");
  assert.deepEqual(prose.doc.changes, []);
  // A removed entry or file is breaking.
  const gone = buildRelease({ model: MAIN, files: FILES.filter((f) => f.path !== "documents/1/proposal-summary.json"), rules: RULES, previous });
  assert.deepEqual(only(gone.doc.changes, "breaking"), ["documents/1/proposal-summary.json: removed-file"]);
});

test("the file differ follows references across files, so a type that widens to a union keeps every value", () => {
  assert.deepEqual(diffFiles(tree(FILES), tree(emit(structuredClone(MAIN)))), []);
  const toCatalogRef = changed((t) => {
    props(t.get("LineItem")).serving_platform!.type = { kind: "named", name: "CatalogRef" };
  });
  assert.deepEqual(only(diffFiles(tree(FILES), tree(emit(toCatalogRef))), "breaking"), ["documents/1/line-item.json: narrowed-schema"], "Text to CatalogRef narrows in the files too");
  assert.deepEqual(only(diffFiles(tree(emit(toCatalogRef)), tree(FILES)), "breaking"), [], "CatalogRef to Text widens");
  // A union that gains a branch, and a property typed by one of its branches that becomes the union.
  const union = MAIN.types.find((t) => t.kind === "union" && t.any_of.some((r) => r.kind === "named"))!;
  assert.ok(union.kind === "union");
  const branch = (union.any_of.find((r) => r.kind === "named") as { name: string }).name;
  const host = MAIN.types.find((t) => t.kind === "object" && Object.values(t.properties).some((p) => p.type.kind === "named" && p.type.name === branch));
  assert.ok(host?.kind === "object", `an object with a property typed ${branch}`);
  const key = Object.entries(host.properties).find(([, p]) => p.type.kind === "named" && p.type.name === branch)![0];
  const wider = changed((t) => {
    props(t.get(host.name))[key]!.type = { kind: "named", name: union.name };
  });
  assert.deepEqual(only(diffFiles(tree(FILES), tree(emit(wider))), "breaking"), [], `${host.name}.${key}: ${branch} to ${union.name} widens`);
  assert.deepEqual(only(diffFiles(tree(FILES), tree(emit(wider))), "additive"), [`modules/${host.module}/1/${host.module}.json.${host.name}: widened-schema`]);
  assert.deepEqual(only(diffModels(MAIN, wider), "breaking"), []);
});

/** The rules with one rule edited. */
function ruleEdited(id: string, edit: (r: Rule) => void): RulesDoc {
  const doc = structuredClone(RULES);
  const r = doc.rules.find((x) => x.id === id);
  assert.ok(r, id);
  edit(r);
  return doc;
}

test("the rule differ compares a kept rule's content, not only its ID", () => {
  assert.deepEqual(diffRules(RULES, structuredClone(RULES), MAIN), []);
  // A kernel rule keeps its ID while its statement and vectors change: at least the minor.
  const tightened = ruleEdited("kernel:CurrencyCode:assigned", (r) => {
    r.statement += " It MUST be upper case.";
    r.vectors.invalid.push({ value: "usd" });
  });
  assert.deepEqual(only(diffRules(RULES, tightened, MAIN), "additive"), ["CurrencyCode.kernel:CurrencyCode:assigned: changed-rule"]);
  const minor = buildRelease({ model: MAIN, files: FILES, rules: tightened, previous: frozenOf(MAIN) });
  assert.deepEqual(minor.problems, []);
  assert.equal(minor.doc.release, "1.1.0");
  // A vector valid under the last release that is now invalid is breaking.
  const flipped = ruleEdited("kernel:CurrencyCode:assigned", (r) => {
    r.vectors.invalid.push(r.vectors.valid.shift()!);
  });
  assert.deepEqual(only(diffRules(RULES, flipped, MAIN), "breaking"), ["CurrencyCode.kernel:CurrencyCode:assigned: narrowed-rule"]);
  // A marker rule is compared too: its severity rising, or a target it gains on an existing type.
  const marker = RULES.rules.find((r) => r.id.startsWith("marker:") && r.applies_to.length > 0)!;
  const warned = ruleEdited(marker.id, (r) => (r.severity = "warning"));
  assert.deepEqual(only(diffRules(warned, RULES, MAIN), "breaking"), [`Marker.${marker.id}: narrowed-rule`]);
  assert.deepEqual(only(diffRules(RULES, warned, MAIN), "additive"), [`Marker.${marker.id}: changed-rule`]);
  const wider = ruleEdited(marker.id, (r) => r.applies_to.push("LineItem.line_item_id"));
  assert.match(diffRules(RULES, wider, MAIN).find((c) => c.class === "breaking")?.detail ?? "", /now applies to LineItem\.line_item_id/);
  // Citations alone are an annotation.
  const cited = ruleEdited(marker.id, (r) => r.decisions.push("D-999"));
  assert.deepEqual(only(diffRules(RULES, cited, MAIN), "annotation"), [`Marker.${marker.id}: rule-annotation`]);
});

test("an added error-level rule on an existing type is breaking; a removed one, or one at warning severity, is additive", () => {
  const base = structuredClone(RULES);
  const extra = structuredClone(base.rules.find((r) => r.id === "kernel:CurrencyCode:assigned")!);
  extra.id = "rule:2.2:deadbeef";
  const added = { ...base, rules: [...base.rules, extra] };
  assert.deepEqual(only(diffRules(base, added, MAIN), "breaking"), ["CurrencyCode.rule:2.2:deadbeef: added-rule"]);
  assert.match(buildRelease({ model: MAIN, files: FILES, rules: added, previous: frozenOf(MAIN) }).problems.join("\n"), /added-rule/);
  assert.deepEqual(only(diffRules(added, base, MAIN), "additive"), ["CurrencyCode.rule:2.2:deadbeef: removed-rule"]);
  const soft = { ...base, rules: [...base.rules, { ...extra, severity: "warning" as const }] };
  assert.deepEqual(only(diffRules(base, soft, MAIN), "additive"), ["CurrencyCode.rule:2.2:deadbeef: added-rule"]);
  // On a type the last release didn't have, no old payload can fail it.
  const fresh = { ...base, rules: [...base.rules, { ...extra, applies_to: ["BrandNewType"] }] };
  assert.deepEqual(only(diffRules(base, fresh, MAIN), "additive"), ["CurrencyCode.rule:2.2:deadbeef: added-rule"]);
});

test("the differ flags a changed kind and a profile that lists less as breaking", () => {
  const kind = changed((t) => {
    const o = t.get("AssetsEntry");
    assert.ok(o?.kind === "object");
    const d = o as unknown as { kind: string; open?: boolean; includes?: string };
    d.kind = "document";
    delete d.open;
    delete d.includes;
  });
  assert.ok(only(diffModels(MAIN, kind), "breaking").includes("AssetsEntry: changed-kind"));
  const profile = MAIN.types.find((t) => t.kind === "profile")!;
  assert.ok(profile.kind === "profile");
  const fewer = changed((t) => {
    const p = t.get(profile.name);
    assert.ok(p?.kind === "profile");
    p.paths = p.paths.slice(1);
  });
  assert.deepEqual(only(diffModels(MAIN, fewer), "breaking"), [`${profile.name}.${profile.paths[0]}: removed-path`]);
  assert.deepEqual(only(diffModels(fewer, MAIN), "additive"), [`${profile.name}.${profile.paths[0]}: added-path`]);
  const other = changed((t) => {
    const p = t.get(profile.name);
    assert.ok(p?.kind === "profile");
    p.document = "Elsewhere";
  });
  assert.deepEqual(only(diffModels(MAIN, other), "breaking"), [`${profile.name}: changed-document`]);
});

test("a frozen release keeps its model, rules, corpus, and schema tree, can't change, and loads as the previous release", () => {
  const root = mkdtempSync(join(tmpdir(), "frozen-"));
  try {
    mkdirSync(join(root, "releases"));
    writeFileSync(join(root, RELEASE_SCHEMA), readFileSync(join(ROOT, RELEASE_SCHEMA)));
    const first = buildRelease({ model: MAIN, files: FILES, rules: RULES, previous: null }).doc;
    assert.equal(freezeRelease(root, first, MAIN, RULES, CORPUS, FILES), true);
    assert.equal(freezeRelease(root, first, MAIN, RULES, CORPUS, FILES), false, "the same bytes again do nothing");
    assert.throws(() => freezeRelease(root, { ...first, digest: "0".repeat(64) }, MAIN, RULES, CORPUS, FILES), /a frozen release can't change/);
    const frozen = loadFrozen(root, "main");
    assert.equal(frozen.length, 1);
    assert.deepEqual(checkFrozen(root, "main", frozen[0]!), []);
    assert.deepEqual(frozen[0]!.files, tree(FILES));
    assert.deepEqual(frozen[0]!.rules, RULES);
    assert.deepEqual(frozen[0]!.corpus, CORPUS);
    assert.equal(buildRelease({ model: MAIN, files: FILES, rules: RULES, previous: frozen[0]! }).doc.release, "1.0.0");
    const at = join(root, "releases", "main", "1.0.0");
    const oracle = oracleDigests(ROOT, [{ release: join(at, RELEASE_FILE), schemas: join(at, "schemas"), model: join(at, "model.json"), rules: join(at, "rules.json") }]);
    assert.deepEqual(oracle.problems, []);
    writeFileSync(join(at, "model.json"), canonicalJson({ ...MAIN, counts: { informative: 0, rendered: 0 } }));
    assert.match(checkFrozen(root, "main", loadFrozen(root, "main")[0]!).join("\n"), /the model digest is/);
    writeFileSync(join(at, "schemas", FILES[0]!.path), canonicalJson({ ...FILES[0]!.schema, title: "Edited" }));
    writeFileSync(join(at, "schemas", "modules", "stray.json"), "{}");
    const problems = checkFrozen(root, "main", loadFrozen(root, "main")[0]!).join("\n");
    assert.match(problems, new RegExp(`${FILES[0]!.path}: the digest is`));
    assert.match(problems, /modules\/stray\.json isn't in release\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the manifest format's version and digest patterns are the Semantic Versioning core and the kernel's Digest", () => {
  const format = JSON.parse(readFileSync(join(ROOT, RELEASE_SCHEMA), "utf8"));
  const kernel = new Map(KERNEL.primitives.map((p) => [p.name, p]));
  assert.equal(format.$defs.digest.pattern, kernel.get("Digest")!.constraints.pattern);
  // The core of the Semantic Versioning 2.0.0 grammar, MAJOR.MINOR.PATCH with no leading zero.
  assert.equal(format.$defs.version.pattern, "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$");
});

test("release: a release rests on reviewed decisions only, cited in the model's decisions lists, a fallback's decision, or the rules'", () => {
  const model = { types: [{ decisions: ["D-002", "D-001"], fallback: { decision: "D-003" } }], rules: [{ decisions: [] }], notes: { decision_text: "D-009" } } as unknown as ModelDoc;
  const rules = { rules: [{ decisions: ["D-004"] }] } as unknown as RulesDoc;
  assert.deepEqual(citedDecisions(model, rules), ["D-001", "D-002", "D-003", "D-004"]);
  const records = [
    { id: "D-001", status: "accepted" },
    { id: "D-002", status: "proposed" },
    { id: "D-003", status: "filed" },
  ];
  assert.deepEqual(unreviewedDecisions(model, rules, records), ["rests on D-002, which is still proposed", "cites D-004, which has no decision record"]);
  assert.deepEqual(unreviewedDecisions(model, rules, [...records.filter((r) => r.id !== "D-002"), { id: "D-002", status: "superseded" }, { id: "D-004", status: "accepted" }]), []);
});

test("release: a decision only property entries cite still blocks the freeze, because the model lists every mapping entry's decisions", () => {
  // D-020 sits next to D-018 on property entries only, so it reaches no type's or rule's list.
  const fromEntries = new Set(MAPPINGS.flatMap((m) => m.entries.filter((e) => e.locks === undefined || e.locks.includes("main")).flatMap((e) => decisionsOf(e.source))));
  assert.deepEqual(MAIN.decisions.filter((d) => fromEntries.has(d)), [...fromEntries].sort());
  for (const id of ["D-020"]) {
    assert.ok(fromEntries.has(id), `the mapping cites ${id}`);
    assert.ok(citedDecisions(MAIN, RULES).includes(id), `the model and rules cite ${id}`);
    const records = DECISIONS.map((d) => ({ id: d.id, status: d.id === id ? "proposed" : "accepted" }));
    assert.deepEqual(unreviewedDecisions(MAIN, RULES, records), [`rests on ${id}, which is still proposed`]);
  }
});
