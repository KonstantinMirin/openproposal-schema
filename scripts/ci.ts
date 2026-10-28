/**
 * The one gate script, run locally and in CI: `npm run ci`.
 *
 * Every gate is defined under `gates/` (gates/index.ts lists them), with its
 * check and its known-bad fixtures; this script collects each gate's input
 * from the pipeline and runs the gate, per lock where it is per lock. After
 * the last gate it reruns every gate on each of its fixtures, which must
 * fail it with the message the fixture expects.
 *
 * 1. Typecheck. Toolchain: Node satisfies `engines.node`, each npm package
 *    is at its exact pin, the venv's Python is the one `setup:oracle` names
 *    and each distribution a `tools/<tool>/requirements.txt` pins is at its
 *    pin, and Go is exactly the `toolchain` directive a tracked go.mod
 *    pins. The workflow runs on a push to main and on every pull request,
 *    installs with `npm ci --ignore-scripts`, runs every `setup:*` script,
 *    sets GATE_BASE and fetches it, and ends with this script, at those
 *    versions; no step or job carries an `if` or a `continue-on-error`.
 * Each spec has its folder under `specs/`, and its locks under
 * `specs/<spec>/spec-input/`. Sections 2 to 18 run for each spec in turn,
 * reading its locks, records, and generated files from its folder; the
 * paths below are relative to it, apart from `sdk/`, `kernel/`, `tools/`,
 * and `gates/`, which sit at the repository's root.
 *
 * 2. For each lock: its snapshot holds the locked specification and every
 *    file under `examples/` at the commit, each blob and the directory's
 *    tree SHA as the lock pins them, and a reachable clone agrees, so CI
 *    runs every gate on every lock without the clone. Then materialize the
 *    spec (blob SHA verified), extract it in this process, schema-valid and
 *    with the exception registry current, run the extractor twice in
 *    separate processes and byte-compare, then compare with the committed
 *    IR and findings. Extraction itself fails on an unknown table layout, an
 *    unparsed row, an invalid IR, or a stale exception. The committed IR and
 *    findings validate and name the lock's blob, which is all an optional
 *    lock with no reachable source is checked by.
 * 3. The mapping files and decision records validate against their schemas,
 *    and against each lock's committed IR: no unknown element, no stale
 *    digest, no altered quote, no element mapped twice, and every cited
 *    decision exists and covers its entry.
 * 4. The kernel primitives validate against their schema; no pattern uses a
 *    construct the engines read differently, every vector (with the
 *    trailing-newline mutants) gets its verdict from Ajv, and every design
 *    source and decision exists. Every pattern gets the same verdicts in
 *    ECMA-262, Go's RE2, and Python `re` (`$` written `\Z`), and the
 *    reference oracle, python-jsonschema as tools/oracle/requirements.txt
 *    pins it, gives every stated vector its verdict, or a numbered gap in
 *    tools/oracle/gaps.yaml lists the vector with the oracle's verdict and
 *    says why, and every listed gap still occurs. Per lock, every spec
 *    source is current.
 * 5. The constructors validate against their schema; every slot names a
 *    primitive, a part, a parameter, or an application that fits, every
 *    vector gets its verdict from Ajv, the schema accepts every rule vector,
 *    and every design source and decision exists. Per lock, every spec
 *    source is current and each constructor cites a row. No constructor
 *    nests inside itself, in a template or in the mapping, and every
 *    application in the mapping fits its constructor and gets a unique name
 *    that is a model type name, derived from the field or object member its
 *    entry names. Every constructor is applied on some lock, by a mapping
 *    entry or inside the shell of an applied constructor or a reached part,
 *    or its `kept` cites a decision that says why it stays.
 * 5a. Value domains (type rules § 3a): kernel/domains.yaml validates
 *    against its schema (it loads with the kernel); every concept's type and
 *    components declare the concept back, every primitive and part declares
 *    a concept that names it, and every decision a concept or a homonym
 *    cites exists. Per lock, every concept's spec sources are current, and a
 *    concept whose type the lock publishes cites an element in scope or a
 *    standard.
 * 6. Duplication: each named type, a primitive, a part, or a copy, is
 *    defined once, and no two have the same normalized structure unless they
 *    represent different concepts of the domain model or both copy one
 *    application.
 * 7. Mapping bijection, per lock: every IR element has exactly one entry,
 *    in the module that owns its section, and every section has one module.
 *    Every field and key row is a property of the object its path names,
 *    with the presence the specification states, and every inline object's
 *    members are the IR's. Every rule entry and rule declaration is what its
 *    mapping rule derives, and every type the mapping names is defined once.
 *    The mapping files are what `npm run map` writes.
 * 8. Mapping sources, per lock: every member the mapping types beyond an
 *    inline object's, and every declared term, is written by its own element
 *    or by an element a cited decision covers; a required member has a
 *    covered element that states REQUIRED, MUST, or SHALL for it; an object
 *    that includes a profile doesn't restate it. Every object the mapping
 *    defines is named after the field or member that holds it, or a cited
 *    decision names it.
 * 9. Resolve, per lock: the IR, the mapping, the decisions, and the kernel
 *    resolve into the model with no problem, and two runs in separate
 *    processes write byte-identical `model.json`, equal to the in-process
 *    model. The conventions hold on it: no reference to a higher layer and
 *    no cycle; references to other modules only as `depends` lists them;
 *    every type position named or a list or map of named types; nothing
 *    beside a `$ref`; standard 2020-12 keywords only; `oneOf` only tagged,
 *    no `allOf`, and `anyOf` only where type rules § 8 allows it; each list
 *    defined once; and no undeclared structural twins among the model's
 *    named types. The domain rules hold on it: every primitive and part the
 *    lock publishes is reached from a document and cites an element or a
 *    standard; every scalar property resolves to a concept and none is typed
 *    by the term grammar or a component; and every object that carries money
 *    carries its currency, or the decision that asks for one covers it.
 *    Across locks, every recurring member name resolves to one concept or is
 *    a homonym a decision explains, every `depends` entry is used, and the
 *    declared module graph is a DAG.
 * 10. Schemas, per lock: the model emits its JSON Schema 2020-12 files with
 *     no problem, two runs of `npm run emit` in separate processes write the
 *     same files as the in-process emitter, and the committed tree under
 *     `schemas/` holds exactly those files, byte for byte. Every file has its
 *     `$schema`, its `$id` at its path, a title, and a description; uses
 *     standard 2020-12 keywords only; carries nothing beside a `$ref`; has
 *     no `allOf`, only tagged `oneOf`, and `anyOf` only where type rules § 8
 *     allows it; and requires only properties its object has. Ajv 2020
 *     (strict) and the reference oracle both accept every file as a 2020-12
 *     schema and resolve every `$ref`.
 * 10a. Fidelity, per lock (src/fidelity.ts): an oracle built from the IR
 *     alone reads every REQUIRED and OPTIONAL row, conditional REQUIRED,
 *     value list (in a cell, an inline object, a sentence "`x` is `a` or
 *     `b`", or a named list's codes), MUST-contain list, "MAY be empty",
 *     stated type, and YAML example, and gives each a valid and an invalid
 *     vector; the emitted schemas give each vector its expected verdict, or
 *     a decision of kind `departure` covers its exact element with the form
 *     under that cover's `departs`, or `gates/fidelity-expected.yaml` lists
 *     it: under the open task that removes it, or as left to a rule that
 *     applies on its path and gives an invalid vector it rules out. A
 *     listed disagreement that no longer occurs fails, and so does a
 *     departure's form that excuses nothing.
 * 11. Rules, per lock: the vectors files validate against their schema, and
 *     the model and the vectors emit the rules with no problem: every rule
 *     JSON Schema can't express has an ID, its source text, its owner, and at
 *     least one valid and one invalid vector, so a rule without vectors
 *     fails; every vector entry names a rule on the lock, has its rule's
 *     current digest, sits in the file of the module that owns the rule's
 *     section, and cites a decision that covers the rule and every source
 *     the entry adds; every marker rule's vector is a pair of versions; and
 *     every condition the schema leaves to the rules has its row listed as a
 *     source by a rule's vectors entry. The schema of each rule's
 *     vector type accepts every payload, so the rule alone decides each
 *     vector. Every rule one payload decides has a deterministic check
 *     (src/rule-checks.ts, or the spec's plugin for its own rules) that gives each of its vectors its verdict, or
 *     rests on a list the repository doesn't pin; the examples gate runs the
 *     checks over the examples. Two runs of `npm run rules` in separate processes write the
 *     same bytes as the in-process emitter, and the committed `rules.json`
 *     equals them. Across the locks, every file git tracks under `rules/` is
 *     one that some lock emits.
 * 12. Corpus, per lock: the conformance corpus generates from the schemas,
 *     the kernel's vectors, and the rules with no problem, so every
 *     constraint the schemas state has an isolating case, and every rule its
 *     vectors. The committed `cases.json` passes the isolation check on its
 *     own: its cases are exactly the schemas' constraints, each baseline is
 *     valid, and each mutant is invalid and valid with its one keyword
 *     removed. Two runs of `npm run corpus` in separate processes write the
 *     in-process bytes, and the committed file equals them. The reference
 *     oracle reaches every label, except the trailing-newline mutants the
 *     stock oracle accepts, which it counts. Across the locks, every file
 *     git tracks under `corpus/` is one that some lock generates.
 * 12a. Type examples, per lock (src/type-examples.ts): every named type the
 *     schemas emit gets a minimal example, its corpus baseline, and a full
 *     one, with every member, one item per list, one key per map, the first
 *     branch of each union, and two options in each selection, or notes that
 *     say why a member holds less; their values are the specification's
 *     examples' where the property's schema accepts them, and else the
 *     primitives' showcase values and the vocabularies' representative
 *     terms; each is valid against its schema and breaks no rule one payload
 *     decides. Where the specification's examples give a member no value,
 *     the member shows its per-field example value
 *     (`field-examples/field-examples.yaml`), which loads valid against its
 *     schema; each entry names a member that exists on the lock by its IR
 *     element, holds against the member's schema and the rules, alone and in
 *     its type's full example, is no value the specification's examples
 *     give the member, and, for a vocabulary with core terms, is one of
 *     them. Two runs of `npm run type-examples` in separate processes
 *     write the in-process bytes, the committed file equals them, and the
 *     committed file passes the same check on its own. Across the locks,
 *     every file git tracks under `type-examples/` is one that some lock
 *     generates.
 * 13. SDK types, per lock: the TypeScript, Python, and Go types generate
 *     from the model with no problem; each named type the schema emits is
 *     one declaration of the same name in each SDK, and no other type is;
 *     two runs of `npm run sdk` in separate processes write the same files as
 *     the in-process emitters, and the committed tree under `sdk/` holds
 *     exactly those files. The TypeScript SDK typechecks, and the Go SDK is
 *     gofmt-clean and vets clean. Parity: each SDK reaches the reference
 *     verdict on every case of the committed corpus and on every primitive
 *     and constructor vector, the constructors' through the generics, and on
 *     each integer vector and term written as an integral float, sent as
 *     JSON text; and encodes each value it accepts back unchanged. Across
 *     the locks, every file git tracks under `sdk/` is one that some lock
 *     generates.
 *     Plain generator, type rules § 10: datamodel-code-generator, as
 *     tools/plaingen/requirements.txt pins it, writes classes from each
 *     committed schema file of the lock alone, and they reach the reference
 *     verdict on every parity case with a concrete type, raise nothing, and
 *     encode each accepted value back unchanged, or the divergence is a
 *     numbered exemption in `plain-generator/exemptions.yaml`, which must be
 *     schema-valid and written for the pinned version. A listed case that
 *     no longer diverges, or that no lock it applies to runs, fails.
 *     A spec whose profile names no SDK packages, as AdCOM's until its
 *     emitter phase, has no SDK types, so none of section 13's gates runs
 *     on it, provided optional-outputs passes: the default spec, which owns
 *     sdk/, must name its packages.
 * 14. Round trip, per lock: the field, key, marker, and value-definition
 *     tables and Appendix A and B, rendered from the model, equal the tables
 *     the lock's IR records, cell by cell after normalizing whitespace,
 *     escaped pipes, and backticks, with the distribution's figures. Every
 *     difference is recorded in `roundtrip/differences.yaml` with its current
 *     text and a decision that covers its row, and every recorded difference
 *     still occurs. Across the locks, every recorded difference names known
 *     locks.
 * 15. Examples, per lock: the lock's example files are blob-verified, and
 *     the lock lists exactly the files the specification names as examples
 *     and, where a clone shows them, every file under `examples/` at the
 *     commit. Every example the model lists, each file and each code block a
 *     decision maps to an example, loads under YAML 1.2 core with JSON types
 *     only and validates against the document it shows, under Ajv 2020 with
 *     `format` asserted, and the model defines every key it uses, an open
 *     object's included. Every failure is a finding in
 *     `examples/findings.yaml`, with its current value and a decision that
 *     covers an element its location rests on, and every recorded finding
 *     still occurs. The reference oracle reaches Ajv's verdict on every
 *     example. An optional lock with no reachable source is skipped. Across
 *     the locks, every finding names known locks.
 * 15a. Variants (src/variant.ts): each variant file under `variants/`
 *     validates against its schema; every departure has exactly one switch,
 *     with an option its record lists and doesn't choose; every replaced type
 *     is one the record introduces and every retyped element one it covers;
 *     and the variant's primitives hold their vectors in Ajv, the engines,
 *     and the reference oracle, with current sources. Per lock, the
 *     variant's model resolves and differs from the proposed one only where
 *     a switch says; its schemas, rules, type examples, and SDK types pass
 *     the gates of sections 10 to 13, SDK parity on a corpus generated in
 *     process; the fidelity gate passes with no departure in force; and its
 *     example failures are the recorded gap findings and its switches' own
 *     findings, each still failing. Section 17 writes its report.
 * 16. Release, per lock: the manifest `release.json` at the root of the
 *     lock's schema tree builds from the model and the lock's last frozen
 *     release under `releases/<lock>/`, two runs of `npm run release` in
 *     separate processes write the in-process bytes, and the committed
 *     manifest equals them. Its digests recompute byte for byte from the
 *     committed files: each file's JCS SHA-256, the tree's, the model's, and
 *     the rules', in TypeScript and under the reference oracle's rfc8785.
 *     Against the last frozen release, no change is breaking within the
 *     major: in the model, no removed type, property, term, or branch, no
 *     narrowed type, no new required member, and no changed marker or kind;
 *     in the rules, compared by ID and content, no new error-level rule on
 *     an existing type and no rule that rejects a vector it accepted; in the
 *     schema files, compared entry by entry, no removed or narrowed entry.
 *     Every valid case of the last frozen release's corpus still validates
 *     under the new schemas, and no kept rule lists an old valid vector as
 *     invalid; with none frozen yet, the committed corpus stands in for it.
 *     Every frozen release validates, sits at its lock and version, holds
 *     the schema tree it lists, and its digests recompute; it rests on
 *     reviewed decisions only, none of the ones its model or rules cite
 *     still proposed, which `npm run release -- --freeze` also refuses; and
 *     every file git tracks under `releases/` is the format schema or part
 *     of a frozen release.
 * 17. Lock comparison: the pipeline runs clean on every lock, and each lock
 *     other than the default has its comparison with the default lock:
 *     `comparison/<lock>.json` and `comparison/<lock>.md`, the elements, the
 *     schema changes as the release differ classes them, the statements,
 *     the decisions, and the findings. Two runs of `npm run compare` in
 *     separate processes write the in-process bytes, the committed files
 *     equal them, and every file git tracks under `comparison/` is one that
 *     the comparison writes.
 * 18. Implementation feedback: from the same builds, the report for the
 *     working group (`feedback/feedback.json`, `comment.md`, and
 *     `details.md`) places every decision a lock cites in the group of the
 *     first stage that cites it, every open lint finding under the
 *     authoring rule its kind names, and every example failure, untagged
 *     union, condition left to the rules, and round-trip difference; and
 *     no decision's feedback, recorded reason, or line of the rendered
 *     comment and details cites a document of this repository or a decision
 *     ID. Two runs of `npm run feedback` in separate processes
 *     write the in-process bytes, the committed files equal them, and every
 *     file git tracks under `feedback/` is one the report writes. A spec
 *     whose profile names no feedback target has no report yet, and
 *     optional-outputs fails where git tracks any file under its
 *     `feedback/`. Every spec's decision records, whatever their
 *     status but superseded, keep each question, chosen answer, and
 *     feedback in the specification owners' terms (record-wording): no
 *     document or record of this repository and no type name the
 *     specification never writes.
 * 18a. Enum drift (src/enum-drift.ts), for a spec with an `enum-drift/` folder, AdCOM's:
 *     enum-drift/sources.yaml validates; each artifact's snapshot holds its whole
 *     folder, which hashes to the pinned git tree, and its license at the
 *     pinned blob, and nothing else, and a reachable clone has the commit
 *     and both SHAs; every list of the registry is paired once with each
 *     artifact's enum or none, and every enum with one list; every line in
 *     an enum, and every line that names one, reads. Two runs of
 *     `npm run enum-drift` in separate processes write the in-process bytes, the
 *     committed report equals them, and every file git tracks under enum-drift/
 *     is the sources file, a pinned snapshot file, or one the report writes.
 * 18b. The public site (src/site/build.ts), once after every spec: one site
 *     for the specs specs/site.yaml lists, each under its path, and the
 *     root's page that lists them. It builds, every internal link and
 *     resource names a file of the site and every type-map link a type of
 *     the build it opens, every link into the public repository names a
 *     path its export publishes (a registry spec's page of its code lists
 *     included, whose links name the citing specs' types and lines), no
 *     page runs inline script or style or loads another origin's
 *     resource, and no text names an internal ID or
 *     a local path; two runs of `npm run site` in separate processes write
 *     the in-process bytes. The site isn't committed: `site/` is ignored.
 * 19. No untracked files under specs/, the root's kernel/, sdk/, gates/,
 *     src/, scripts/, test/, tools/, and the format schemas' folders, or the
 *     single-spec layout's spec-input/, schemas/, rules/, corpus/,
 *     type-examples/, comparison/, and feedback/ (gates/setup.ts).
 * 20. The test suite, including the golden snapshots, as `npm test` runs
 *     package.json's test script, with at least the tests it holds.
 * 21. The gates themselves (gates/harness.ts): every gate fails on each of
 *     its known-bad fixtures with the message the fixture expects; every
 *     gate has a fixture and ran; and the guard: each gate's fingerprint,
 *     over its definition and the code it names with every declaration
 *     they reach in any repository file, its fixtures' data, the whole
 *     files and directories it names, and the exemption files it reads, is
 *     the one the latest gate decision under
 *     `gates/decisions/` that names it accepts, so a gate can't be relaxed
 *     in the change that needs it relaxed to pass; and a concept a gate
 *     decision accepted leaves `kernel/domains.yaml` only through a gate
 *     decision that retires it, and a gate only through one that lists it
 *     under `retires_gates`. Gate decisions are append-only: none that the
 *     base holds (GATE_BASE, which the workflow sets to the pull request's
 *     base or the push's previous commit and fetches, or else origin/main)
 *     is edited, deleted, or renamed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { loadExceptions } from "../src/exceptions.ts";
import { materialize } from "../src/fetch.ts";
import { loadLock, repoRoot, type SpecLock } from "../src/lock.ts";
import { DEFAULT_SPEC, lockFiles, specNames, specRoot } from "../src/repo.ts";
import { loadConstructors, type Model } from "../src/constructors.ts";
import { kernelTypes, type KernelType } from "../src/domains.ts";
import { loadKernel, type Kernel } from "../src/kernel.ts";
import { loadLists } from "../src/lists.ts";
import { checksOf, codesOf } from "../src/rule-checks.ts";
import { specOf } from "../src/specs/index.ts";
import type { SpecPlugin } from "../src/specs/plugin.ts";
import { reaches, stageOf, type SpecNames, type Stage } from "../src/profile.ts";
import { loadDecisions, loadMappings, inScope, type DecisionRecord, type MappingFile } from "../src/mapping.ts";
import { renderModel, resolveModel, type ModelDoc } from "../src/model.ts";
import { emitSchemas, schemaDirOf, SCHEMA_ROOTS, type SchemaNames } from "../src/emit.ts";
import { emitRules, loadVectors, renderRules, RULES_FILE, rulesDirOf, type RulesDoc, type VectorFile, VECTORS_DIR } from "../src/rules.ts";
import type { FindingsDoc } from "../src/pipeline.ts";
import { FINDING_KINDS } from "../src/lint.ts";
import { DIFFERENCES_FILE, type DifferencesFile, loadDifferences } from "../src/render.ts";
import { checkExamples, FINDINGS_FILE, type FindingsFile, loadFindings, lockExamples } from "../src/examples.ts";
import { buildRelease, FROZEN_MODEL, FROZEN_RULES, FROZEN_SCHEMAS, loadFrozen, RELEASE_FILE, RELEASE_SCHEMA, RELEASES_DIR, renderRelease, type Frozen, type OracleCheck, type ReleaseDoc } from "../src/release.ts";
import { canonicalJson } from "../src/canonical.ts";
import { CORPUS_FILE, corpusDirOf, generateCorpus, renderCorpus, type CorpusDoc } from "../src/corpus.ts";
import { FIELD_EXAMPLES_FILE, loadFieldExamples } from "../src/field-examples.ts";
import { generateTypeExamples, renderTypeExamples, TYPE_EXAMPLES_DIR, TYPE_EXAMPLES_FILE, typeExamplesDirOf, type TypeExamplesDoc } from "../src/type-examples.ts";
import { loadOracleGaps, pinnedOracle } from "../src/engines.ts";
import { sdkDirOf } from "../src/sdk.ts";
import { emitSdk, SDK_ROOTS } from "../src/sdk-emit.ts";
import { runGo, runPython, runTypeScript, sdkCases, type SdkCase, type SdkRun } from "../src/sdk-parity.ts";
import { EXEMPTIONS_FILE, type ExemptionsFile, loadExemptions, pinnedPlainGenerator, plainTarget } from "../src/plain-parity.ts";
import { trackedGoMods } from "../src/toolchain.ts";
import { buildLock, COMPARISON_DIR, compareLocks, DEFAULT_LOCK_FILE, renderComparison, renderComparisonMarkdown, type LockBuild } from "../src/compare.ts";
import { buildFeedback, feedbackOf, FEEDBACK_DIR, FEEDBACK_FILES, internalTypeNames, renderComment, renderDetails, renderFeedback, type FeedbackInput } from "../src/feedback.ts";
import { gitTracked } from "../gates/common.ts";
import { fingerprint, overlay, runCheck, runFixture, ROOT, type FixtureRun, type Gate } from "../gates/harness.ts";
import { REGISTRY } from "../gates/index.ts";
import * as G from "../gates/setup.ts";
import * as I from "../gates/input.ts";
import * as M from "../gates/mapping.ts";
import * as K from "../gates/kernel.ts";
import * as D from "../gates/model.ts";
import * as O from "../gates/outputs.ts";
import * as S from "../gates/sdk.ts";
import * as C from "../gates/checks.ts";
import * as R from "../gates/release.ts";
import * as P from "../gates/reports.ts";
import { fidelity, loadExpected } from "../gates/fidelity.ts";
import { readingsOf } from "../src/fidelity.ts";
import { appendOnly, fixturesExist, guard, loadGateDecisions, selfTests } from "../gates/meta.ts";
import { exceptionsFileOf } from "../gates/input.ts";
import * as V from "../gates/variant.ts";
import * as Site from "../gates/site.ts";
import * as EnumDrift from "../gates/enum-drift.ts";
import { allSnapshotFiles, ENUM_DRIFT_DIR, ENUM_DRIFT_FILES, ENUM_DRIFT_SOURCES, enumDriftFiles, loadEnumDriftSources } from "../src/enum-drift.ts";
import { buildSite, exportTree } from "../src/site/build.ts";
import { loadSiteConfig } from "../src/site/config.ts";
import { resolveBuild, variantNames, type Build } from "../src/builds.ts";
import { loadVariant, type Variant } from "../src/variant.ts";
import { variantReportFiles } from "../src/variant-report.ts";

const isPlainMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The folder of the spec the gates check now, `specs/<spec>/`: its locks,
 * records, and generated files are read from it, as the paths a lock names
 * are relative to it. `main` sets it for each spec in turn.
 */
let SPEC = "";

/** The plugin of the spec the gates check now, which reads its text: its rule checks, its fidelity readers, and its round-trip notation. */
let PLUGIN!: SpecPlugin;

/** The names the spec's outputs carry, from its profile: its packages, its `$id` base, and its name in prose. */
let NAMES!: SpecNames;

/** What the spec's schema files are named by. */
const specSchemaNames = (): SchemaNames => ({ base: NAMES.schema_base, short: NAMES.short, sections: PLUGIN.text.sections });

/** Every check a rule of the spec's locks may have: the kernel's, the constructors', and the plugin's. */
const ruleChecks = () => checksOf(PLUGIN.ruleChecks);
const results: { gate: string; ok: boolean; note: string }[] = [];
const record = (gate: string, ok: boolean, note = "") => {
  results.push({ gate, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"}  ${gate}${note ? `  (${note})` : ""}`);
};

/** Each gate's inputs, by spec and then by lock ("" for a gate across the locks or the specs), for its fixtures. */
const captured = new Map<string, Map<string, Map<string, unknown>>>();
const capture = <I>(g: Gate<I>, input: I, lock?: SpecLock) => {
  const bySpec = captured.get(g.id) ?? new Map<string, Map<string, unknown>>();
  const spec = SPEC === "" ? "" : posix.basename(SPEC);
  const m = bySpec.get(spec) ?? new Map<string, unknown>();
  if (!m.has(lock?.name ?? "")) m.set(lock?.name ?? "", input);
  bySpec.set(spec, m);
  captured.set(g.id, bySpec);
};
/** The input a fixture changes: of the spec it names, else OpenProposal's, else the first spec's that ran the gate; of the lock it names, else that spec's first. */
function fixtureInput<I>(bySpec: Map<string, Map<string, unknown>>, f: { spec?: string; lock?: string }): I | undefined {
  const m = bySpec.get(f.spec ?? DEFAULT_SPEC) ?? (f.spec === undefined ? bySpec.values().next().value : undefined);
  if (!m) return undefined;
  return (f.lock !== undefined ? m.get(f.lock) : m.values().next().value) as I | undefined;
}
const titleOf = <I>(g: Gate<I>, input?: I) => (typeof g.title === "function" ? (input === undefined ? g.id : g.title(input)) : g.title);
/** A gate's line: the spec's folder, where more than one spec runs, and the lock's name, before the gate's title. */
const label = (lock: SpecLock | undefined, title: string) => {
  const spec = SPEC !== "" && specNames(ROOT).length > 1 ? posix.basename(SPEC) : "";
  const where = [spec, lock?.name].filter(Boolean).join("/");
  return `${where ? `${where}: ` : ""}${title}`;
};

/** Runs a gate on its input, records its line, and keeps the input for the gate's fixtures. */
async function gate<I>(g: Gate<I>, input: I, lock?: SpecLock): Promise<boolean> {
  capture(g, input, lock);
  const r = await runCheck(g, input);
  const ok = r.problems.length === 0;
  record(label(lock, titleOf(g, input)), ok, ok ? (r.note ?? "") : r.problems.slice(0, 20).join("; "));
  return ok;
}
/** A gate whose input didn't load: it fails, so a green run has skipped nothing. */
const skipped = <I>(g: Gate<I>, why: string, lock?: SpecLock) => record(label(lock, titleOf(g)), false, `SKIPPED: ${why}`);

function run(cmd: string, args: string[]): { ok: boolean; output: string } {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } });
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

const bin = (name: string) => join(ROOT, "node_modules", ".bin", name);
/** A file of the spec's folder, by path from it, or null when it is missing. */
const read = (p: string) => (existsSync(join(SPEC, p)) ? readFileSync(join(SPEC, p)) : null);
/** Runs a CLI twice into fresh build directories, and returns what each run wrote to `file` there. */
function twoRuns(lock: SpecLock | null, name: string, cli: string, file: string, extra: string[] = []): (Buffer | null)[] {
  return [1, 2].map((n) => {
    const out = join(ROOT, "build", "ci", ...(lock ? [lock.name] : []), `${name}-run${n}`);
    rmSync(out, { recursive: true, force: true });
    run(bin("tsx"), [cli, ...(lock ? ["--lock", lock.file] : []), "--out", out, ...extra]);
    return existsSync(join(out, file)) ? readFileSync(join(out, file)) : null;
  });
}

const committedIr = (lock: SpecLock) => JSON.parse(readFileSync(join(repoRoot(lock), lock.ir_dir, "spec-ir.json"), "utf8"));

async function checkLock(lock: SpecLock, through: Stage): Promise<void> {
  await gate(I.snapshot, { lock }, lock);
  // A spec that has reached only its input has no IR yet: its snapshot and its specification's bytes are what there is to check.
  if (!reaches(through, "extract")) {
    try {
      await materialize(lock);
    } catch {
      // The spec-input gate reports why no source yields the bytes.
    }
    await gate(I.specInput, { lock }, lock);
    return;
  }
  const committed = { lock, ir: committedIr(lock), findings: JSON.parse(readFileSync(join(repoRoot(lock), lock.ir_dir, "findings.json"), "utf8")) as FindingsDoc, exceptions: loadExceptions(exceptionsFileOf(repoRoot(lock))) };
  await gate(I.committedFiles, committed, lock);
  let bytes: Buffer;
  try {
    bytes = (await materialize(lock)).bytes;
  } catch (e) {
    if (lock.required) {
      await gate(I.specInput, { lock }, lock);
      return;
    }
    record(label(lock, titleOf(I.specInput)), true, `SKIPPED: optional lock, no reachable source; checked from its committed files only (${(e as Error).message.split("\n")[0]})`);
    return;
  }
  await gate(I.specInput, { lock }, lock);
  await gate(I.extraction, { lock, bytes, exceptions: loadExceptions(exceptionsFileOf(repoRoot(lock))) }, lock);
  const outs = [1, 2].map((n) => join(ROOT, "build", "ci", lock.name, `run${n}`));
  for (const dir of outs) {
    rmSync(dir, { recursive: true, force: true });
    run(bin("tsx"), ["src/cli/extract.ts", "--lock", lock.file, "--out", dir]);
  }
  for (const f of ["spec-ir.json", "findings.json"]) {
    const runs = outs.map((d) => (existsSync(join(d, f)) ? readFileSync(join(d, f)) : null));
    const want = runs[0] ?? Buffer.from("");
    await gate(I.irDeterministic, { label: f, want, runs, from: "extraction" }, lock);
    await gate(I.irCommitted, { file: `${lock.ir_dir}/${f}`, want, committed: read(join(lock.ir_dir, f)), regenerate: `npm run extract -- --lock ${relative(ROOT, lock.file)}` }, lock);
  }
}

interface Loaded {
  mappings: MappingFile[];
  decisions: DecisionRecord[];
}

/** What the spec-profile gate reads of the spec's folder: its top-level entries, which show the stages it has reached. */
const folderEntries = () => readdirSync(SPEC).sort();

async function checkMappingAndDecisions(locks: SpecLock[], through: Stage): Promise<Loaded | null> {
  // A spec still being added is checked through the stage its profile names, and holds no file of a later one.
  if (!reaches(through, "model")) {
    await gate(I.specProfile, { profile: specOf(SPEC).profile, text: PLUGIN.text, roles: [], findingKinds: FINDING_KINDS, locks: locks.length, entries: folderEntries() });
    return null;
  }
  const ok = await gate(M.mappingLoad, { mappingDir: join(SPEC, "mapping"), decisionsDir: join(SPEC, "decisions") });
  if (!ok) return null;
  const loaded = { mappings: loadMappings(join(SPEC, "mapping")), decisions: loadDecisions(join(SPEC, "decisions")) };
  await gate(I.specProfile, { profile: specOf(SPEC).profile, text: PLUGIN.text, roles: [...new Set(loaded.mappings.flatMap((m) => m.entries.map((e) => e.as.role)))].sort(), findingKinds: FINDING_KINDS, locks: locks.length, entries: folderEntries() });
  for (const lock of locks) await gate(M.mappingCurrent, { ir: committedIr(lock), lock: lock.name, ...loaded }, lock);
  return loaded;
}

async function checkKernelGates(locks: SpecLock[], loaded: Loaded | null): Promise<Kernel | null> {
  if (!(await gate(K.kernelLoad, { spec: SPEC }))) return null;
  const kernel = loadKernel(ROOT, SPEC);
  if (loaded) await gate(K.kernelCheck, { kernel, decisions: loaded.decisions });
  else skipped(K.kernelCheck, "the decision records didn't load");
  await gate(K.kernelEngines, { kernel, gaps: loadOracleGaps(ROOT) });
  for (const lock of locks) await gate(K.kernelSources, { ir: committedIr(lock), lock: lock.name, kernel }, lock);
  return kernel;
}

async function checkConstructorGates(locks: SpecLock[], kernel: Kernel, loaded: Loaded | null): Promise<Model | null> {
  if (!(await gate(K.constructorsLoad, { spec: SPEC }))) return null;
  const model: Model = { kernel, constructors: loadConstructors(ROOT, SPEC) };
  if (loaded) await gate(K.constructorsCheck, { model, decisions: loaded.decisions });
  else skipped(K.constructorsCheck, "the decision records didn't load");
  for (const lock of locks) await gate(K.constructorSources, { ir: committedIr(lock), lock: lock.name, constructors: model.constructors }, lock);
  const mappings = loaded?.mappings ?? [];
  await gate(K.nesting, { model, mappings });
  await gate(K.mappingConstructors, { model, mappings });
  if (loaded) await gate(K.constructorsApplied, { model, mappings, decisions: loaded.decisions });
  else skipped(K.constructorsApplied, "the decision records didn't load");
  return model;
}

async function checkDomainGates(locks: SpecLock[], model: Model, loaded: Loaded | null): Promise<KernelType[]> {
  const d = model.kernel.domains!;
  const types = kernelTypes(model.kernel.primitives, model.constructors.parts, { kernel: model.kernel.file, constructors: model.constructors.file });
  if (loaded) await gate(K.domainsCheck, { domains: d, types, decisions: loaded.decisions });
  else skipped(K.domainsCheck, "the decision records didn't load");
  for (const lock of locks) await gate(K.domainSources, { ir: committedIr(lock), lock: lock.name, domains: d, types }, lock);
  return types;
}

async function checkCoverageGates(locks: SpecLock[], model: Model, loaded: Loaded | null): Promise<void> {
  if (!loaded) {
    skipped(M.mappingBijection, "the mapping files didn't load");
    return;
  }
  for (const lock of locks) {
    const input = { ir: committedIr(lock), lock: lock.name, mappings: loaded.mappings, kernel: model.kernel, constructors: model.constructors };
    await gate(M.mappingBijection, input, lock);
    await gate(M.mappingLocation, input, lock);
    await gate(M.mappingRules, input, lock);
    const sources = { ir: committedIr(lock), lock: lock.name, mappings: loaded.mappings, decisions: loaded.decisions, lists: model.kernel.lists };
    await gate(M.mappingSources, sources, lock);
    await gate(M.mappingNames, sources, lock);
  }
  const lockIrs = locks.map((l) => ({ name: l.name, ir: committedIr(l) }));
  const texts = new Map(readdirSync(join(SPEC, "mapping")).filter((f) => f.endsWith(".yaml")).map((f) => [join(SPEC, "mapping", f), readFileSync(join(SPEC, "mapping", f), "utf8")]));
  await gate(M.mapDrift, { locks: lockIrs, mappings: loaded.mappings, kernel: model.kernel, constructors: model.constructors, texts });
}

/** Each convention gate, by the key `checkConventions` gives it. */
const CONVENTIONS = [D.layers, D.modules, D.inline, D.besideReference, D.keywords, D.unions, D.lists];

async function checkModelGates(locks: SpecLock[], model: Model, loaded: Loaded | null): Promise<Map<SpecLock, ModelDoc>> {
  const resolved = new Map<SpecLock, ModelDoc>();
  if (!loaded) {
    skipped(D.modelResolves, "the mapping files didn't load");
    return resolved;
  }
  for (const lock of locks) {
    const input = { ir: committedIr(lock), lock: lock.name, mappings: loaded.mappings, decisions: loaded.decisions, kernel: model.kernel, constructors: model.constructors };
    if (!(await gate(D.modelResolves, input, lock))) continue;
    const doc = resolveModel(input).model;
    resolved.set(lock, doc);
    await gate(D.modelDeterministic, { label: "model.json", want: Buffer.from(renderModel(doc)), runs: twoRuns(lock, "model", "src/cli/resolve.ts", "model.json"), from: "model" }, lock);
    const conventions = { model: doc, mappings: loaded.mappings, kernel: model.kernel, constructors: model.constructors, decisions: loaded.decisions };
    for (const c of CONVENTIONS) await gate(c, conventions, lock);
    await gate(D.duplicationModel, { model: doc, kernel: model.kernel, constructors: model.constructors, decisions: loaded.decisions }, lock);
    const types = kernelTypes(model.kernel.primitives, model.constructors.parts, { kernel: model.kernel.file, constructors: model.constructors.file });
    await gate(D.domainsUsed, { model: doc, lock: lock.name, types }, lock);
    await gate(D.domainsProperties, { model: doc, lock: lock.name, domains: model.kernel.domains!, decisions: loaded.decisions }, lock);
  }
  if (resolved.size === locks.length) {
    await gate(D.homonyms, { models: [...resolved.values()], domains: model.kernel.domains! });
    await gate(D.depends, { models: [...resolved.values()], mappings: loaded.mappings });
  }
  return resolved;
}

/** Every file under a directory's trees, by path in the tree, the directory by path from `base`; Python's bytecode caches, which git ignores, aren't part of it. */
function tree(base: string, dir: string, roots: readonly string[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (rel: string) => {
    const abs = join(base, dir, rel);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.name === "__pycache__") continue;
      const p = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else out.set(p, readFileSync(join(base, dir, p)));
    }
  };
  for (const d of roots) walk(d);
  return out;
}
/** Runs a CLI twice into fresh build directories, and returns the tree each wrote. */
function twoTreeRuns(lock: SpecLock, name: string, cli: string, roots: readonly string[], extra: string[] = []): Map<string, Buffer>[] {
  return [1, 2].map((n) => {
    const out = join(ROOT, "build", "ci", lock.name, `${name}-run${n}`);
    rmSync(out, { recursive: true, force: true });
    run(bin("tsx"), [cli, "--lock", lock.file, "--out", out, ...extra]);
    return tree(ROOT, relative(ROOT, out), roots);
  });
}

async function checkSchemaGates(models: Map<SpecLock, ModelDoc>, locks: SpecLock[], variantFiles: VariantFiles): Promise<void> {
  const expected = new Set<string>(variantFiles.schemas);
  let complete = models.size === locks.length;
  for (const [lock, model] of models) {
    const dir = schemaDirOf(lock.ir_dir);
    if (!(await gate(O.schemasEmit, { model, dir, names: specSchemaNames() }, lock))) {
      complete = false;
      continue;
    }
    const emitted = emitSchemas(model, dir, specSchemaNames());
    for (const f of emitted.files) expected.add(posix.join(dir, f.path));
    // The release manifest sits at the root of the tree; the release gates check it.
    expected.add(posix.join(dir, RELEASE_FILE));
    const want = new Map(emitted.files.map((f) => [f.path, Buffer.from(f.text)]));
    await gate(O.schemasDeterministic, { label: "schemas", want, runs: twoTreeRuns(lock, "schemas", "src/cli/emit.ts", SCHEMA_ROOTS), from: "emitter" }, lock);
    await gate(O.schemasCommitted, { dir, want, committed: tree(SPEC, dir, SCHEMA_ROOTS), regenerate: "npm run emit" }, lock);
    await gate(O.schemasConventions, { files: emitted.files, model, dir, base: NAMES.schema_base }, lock);
    await gate(O.schemasAjv, { files: emitted.files }, lock);
    await gate(O.schemasOracle, { files: emitted.files }, lock);
  }
  if (!complete) return;
  await gate(O.schemasTracked, { dir: "schemas", tracked: gitTracked("schemas", SPEC), expected: [...expected], remedy: "remove it, or emit it from the model" });
}

async function checkRuleGates(models: Map<SpecLock, ModelDoc>, locks: SpecLock[], loaded: Loaded | null, variantFiles: VariantFiles): Promise<{ vectors: VectorFile[]; rules: Map<string, RulesDoc> }> {
  const emittedRules = new Map<string, RulesDoc>();
  if (!(await gate(O.vectorsLoad, { dir: join(SPEC, VECTORS_DIR) }))) return { vectors: [], rules: emittedRules };
  const vectors = loadVectors(join(SPEC, VECTORS_DIR));
  if (!loaded) {
    skipped(O.rulesEmit, "the decision records didn't load");
    return { vectors, rules: emittedRules };
  }
  const expected = new Set<string>(variantFiles.rules);
  let complete = models.size === locks.length;
  for (const [lock, model] of models) {
    const ir = committedIr(lock);
    const schemaDir = schemaDirOf(lock.ir_dir);
    const emitted = emitSchemas(model, schemaDir, specSchemaNames());
    const input = { model, ir, lock: lock.name, vectors, decisions: loaded.decisions, schemaDir, conditionsLeft: emitted.conditions.left, schemaBase: NAMES.schema_base };
    if (!(await gate(O.rulesEmit, input, lock)) || emitted.problems.length > 0) {
      complete = false;
      continue;
    }
    const doc = emitRules(input).doc;
    emittedRules.set(lock.name, doc);
    await gate(O.ruleVectors, { doc, model, files: emitted.files, schemaDir }, lock);
    await gate(O.ruleChecks, { doc, model, codes: codesOf(loadLists(ROOT)), ruleChecks: ruleChecks() }, lock);
    const file = posix.join(rulesDirOf(lock.ir_dir), RULES_FILE);
    expected.add(file);
    const want = Buffer.from(renderRules(doc));
    await gate(O.rulesDeterministic, { label: RULES_FILE, want, runs: twoRuns(lock, "rules", "src/cli/rules.ts", RULES_FILE), from: "emitter" }, lock);
    await gate(O.rulesCommitted, { file, want, committed: read(file), regenerate: "npm run rules" }, lock);
  }
  if (complete) await gate(O.rulesTracked, { dir: "rules", tracked: gitTracked("rules", SPEC), expected: [...expected], remedy: "remove it, or emit it from the model" });
  return { vectors, rules: emittedRules };
}

async function checkFidelityGates(models: Map<SpecLock, ModelDoc>, rulesOf: Map<string, RulesDoc>, kernel: Kernel, loaded: Loaded | null): Promise<void> {
  if (!loaded) {
    skipped(fidelity, "the decision records didn't load");
    return;
  }
  const expected = loadExpected();
  for (const [lock, model] of models) {
    const schemaDir = schemaDirOf(lock.ir_dir);
    const rules = rulesOf.get(lock.name);
    if (rules === undefined) {
      skipped(fidelity, "the rules didn't emit", lock);
      continue;
    }
    await gate(fidelity, { ir: committedIr(lock), lock: lock.name, model, files: emitSchemas(model, schemaDir, specSchemaNames()).files, kernel, rules, decisions: loaded.decisions, readings: readingsOf(loaded.mappings, lock.name), schemaDir, expected, readers: PLUGIN.fidelity!, names: specSchemaNames() }, lock);
  }
}

async function checkCorpusGates(models: Map<SpecLock, ModelDoc>, rulesOf: Map<string, RulesDoc>, kernel: Kernel, locks: SpecLock[]): Promise<void> {
  const expected = new Set<string>();
  let complete = models.size === locks.length;
  if (!(await gate(O.corpusOraclePin, { root: ROOT }))) return;
  const pinned = pinnedOracle(ROOT);
  for (const [lock, model] of models) {
    const schemaDir = schemaDirOf(lock.ir_dir);
    const emitted = emitSchemas(model, schemaDir, specSchemaNames());
    const rules = rulesOf.get(lock.name);
    if (emitted.problems.length > 0 || rules === undefined) {
      skipped(O.corpusGenerates, "the schemas or the rules didn't emit", lock);
      complete = false;
      continue;
    }
    const input = { model, files: emitted.files, rules, kernel, schemaDir, oracle: pinned };
    if (!(await gate(O.corpusGenerates, input, lock))) {
      complete = false;
      continue;
    }
    const doc = generateCorpus(input).doc;
    const file = posix.join(corpusDirOf(lock.ir_dir), CORPUS_FILE);
    expected.add(file);
    const want = Buffer.from(renderCorpus(doc));
    await gate(O.corpusDeterministic, { label: CORPUS_FILE, want, runs: twoRuns(lock, "corpus", "src/cli/corpus.ts", CORPUS_FILE), from: "generator" }, lock);
    const committedBytes = read(file);
    await gate(O.corpusCommitted, { file, want, committed: committedBytes, regenerate: "npm run corpus" }, lock);
    if (committedBytes === null) continue;
    const committed = JSON.parse(committedBytes.toString("utf8")) as CorpusDoc;
    await gate(O.corpusIsolation, { doc: committed, files: emitted.files, model, rules, schemaDir }, lock);
    await gate(O.corpusLabels, { files: emitted.files, doc: committed, pinned }, lock);
  }
  if (complete) await gate(O.corpusTracked, { dir: "corpus", tracked: gitTracked("corpus", SPEC), expected: [...expected], remedy: "remove it, or generate it" });
}

async function checkTypeExampleGates(models: Map<SpecLock, ModelDoc>, kernel: Kernel, locks: SpecLock[], variantFiles: VariantFiles): Promise<void> {
  const expected = new Set<string>(variantFiles.typeExamples);
  let complete = models.size === locks.length;
  const codes = codesOf(loadLists(ROOT));
  if (!(await gate(O.fieldExamplesLoad, { file: join(SPEC, FIELD_EXAMPLES_FILE) }))) {
    for (const lock of models.keys()) {
      skipped(O.typeExamplesGenerate, "the per-field example values didn't load", lock);
      skipped(O.fieldExamples, "the per-field example values didn't load", lock);
    }
    return;
  }
  const fields = loadFieldExamples(join(SPEC, FIELD_EXAMPLES_FILE)).fields;
  for (const [lock, model] of models) {
    const schemaDir = schemaDirOf(lock.ir_dir);
    const emitted = emitSchemas(model, schemaDir, specSchemaNames());
    if (emitted.problems.length > 0) {
      skipped(O.typeExamplesGenerate, "the schemas didn't emit", lock);
      skipped(O.fieldExamples, "the schemas didn't emit", lock);
      complete = false;
      continue;
    }
    let spec;
    try {
      spec = await lockExamples(lock, model);
    } catch (e) {
      skipped(O.typeExamplesGenerate, `no source yields the specification's examples (${(e as Error).message.split("\n")[0]})`, lock);
      skipped(O.fieldExamples, `no source yields the specification's examples (${(e as Error).message.split("\n")[0]})`, lock);
      complete = false;
      continue;
    }
    const input = { model, files: emitted.files, kernel, schemaDir, codes, ruleChecks: ruleChecks(), spec, fields };
    await gate(O.fieldExamples, input, lock);
    if (!(await gate(O.typeExamplesGenerate, input, lock))) {
      complete = false;
      continue;
    }
    const doc = generateTypeExamples(input).doc;
    const file = posix.join(typeExamplesDirOf(lock.ir_dir), TYPE_EXAMPLES_FILE);
    expected.add(file);
    const want = Buffer.from(renderTypeExamples(doc));
    await gate(O.typeExamplesDeterministic, { label: TYPE_EXAMPLES_FILE, want, runs: twoRuns(lock, "type-examples", "src/cli/type-examples.ts", TYPE_EXAMPLES_FILE), from: "generator" }, lock);
    const committedBytes = read(file);
    await gate(O.typeExamplesCommitted, { file, want, committed: committedBytes, regenerate: "npm run type-examples" }, lock);
    if (committedBytes === null) continue;
    await gate(O.typeExamplesValid, { doc: JSON.parse(committedBytes.toString("utf8")) as TypeExamplesDoc, model, files: emitted.files, schemaDir, codes, ruleChecks: ruleChecks() }, lock);
  }
  if (complete) await gate(O.typeExamplesTracked, { dir: TYPE_EXAMPLES_DIR, tracked: gitTracked(TYPE_EXAMPLES_DIR, SPEC), expected: [...expected], remedy: "remove it, or generate it" });
}

async function checkSdkGates(models: Map<SpecLock, ModelDoc>, locks: SpecLock[], model: Model, variantFiles: VariantFiles): Promise<void> {
  const expected = new Set<string>(variantFiles.sdk);
  let complete = models.size === locks.length;
  let exemptions: ExemptionsFile | null = null;
  try {
    exemptions = loadExemptions(join(SPEC, EXEMPTIONS_FILE));
    await gate(S.plainExemptionsFile, { exemptions, pinned: pinnedPlainGenerator(ROOT), locks: locks.map((l) => l.name) });
  } catch (e) {
    record(titleOf(S.plainExemptionsFile), false, (e as Error).message);
  }
  /** For each listed case a lock doesn't run, by `<id> <label> [<kind>]`, how many locks don't run it. */
  const absent = new Map<string, number>();
  const checked = new Set<string>();
  for (const [lock, doc] of models) {
    const dir = sdkDirOf(lock.ir_dir, undefined);
    if (!(await gate(S.sdkGenerate, { model: doc, dir, schemaDir: schemaDirOf(lock.ir_dir), names: NAMES, schemaNames: specSchemaNames() }, lock))) {
      complete = false;
      continue;
    }
    const emitted = emitSdk(doc, dir, schemaDirOf(lock.ir_dir), NAMES, specSchemaNames());
    for (const f of emitted.files) expected.add(posix.join(dir, f.path));
    const schemas = emitSchemas(doc, schemaDirOf(lock.ir_dir), specSchemaNames());
    const schemaNames = schemas.files.flatMap((f) => (isPlainMap(f.schema.$defs) ? Object.keys(f.schema.$defs) : [String(f.schema.title)])).sort();
    await gate(S.sdkNames, { schemaNames, emitted: emitted.sdk.emitted, templates: [...emitted.sdk.templates.keys()] }, lock);
    const want = new Map(emitted.files.map((f) => [f.path, Buffer.from(f.text)]));
    await gate(S.sdkDeterministic, { label: "SDK types", want, runs: twoTreeRuns(lock, "sdk", "src/cli/sdk.ts", SDK_ROOTS), from: "emitters" }, lock);
    if (!(await gate(S.sdkCommitted, { dir, want, committed: tree(ROOT, dir, SDK_ROOTS), regenerate: "npm run sdk" }, lock))) continue;
    await gate(S.sdkTypecheck, { project: posix.join(dir, "ts", "tsconfig.json") }, lock);
    await gate(S.sdkGo, { dir: posix.join(dir, "go") }, lock);
    const corpusFile = posix.join(corpusDirOf(lock.ir_dir), CORPUS_FILE);
    if (!existsSync(join(SPEC, corpusFile))) {
      skipped(S.sdkParity, `no committed corpus at ${corpusFile}; generate it with: npm run corpus`, lock);
      continue;
    }
    const cases: SdkCase[] = sdkCases(doc, JSON.parse(readFileSync(join(SPEC, corpusFile), "utf8")) as CorpusDoc, model.kernel, model.constructors);
    const legs: [string, () => Promise<SdkRun> | SdkRun][] = [
      ["TypeScript", () => runTypeScript(join(ROOT, dir, "ts"), cases)],
      ["Python", () => runPython(ROOT, join(ROOT, dir, "python"), cases)],
      ["Go", () => runGo(join(ROOT, dir, "go"), join(ROOT, "build", "ci", lock.name, "sdk-go-verdicts"), cases)],
    ];
    for (const [language, leg] of legs) {
      let r: SdkRun;
      try {
        r = await leg();
      } catch (e) {
        record(label(lock, S.sdkParity.title instanceof Function ? S.sdkParity.title({ language, cases, run: { engine: "", verdicts: [], dumps: [], errors: [] } }) : S.sdkParity.title), false, (e as Error).message);
        continue;
      }
      await gate(S.sdkParity, { language, cases, run: r }, lock);
    }
    if (exemptions) await checkPlainGates(lock, doc, cases, exemptions, absent, checked);
  }
  if (exemptions && checked.size === locks.length) {
    const scope = exemptions.exemptions.map((e) => [e.id, locks.filter((l) => inScope(e.locks, l.name)).length] as [string, number]);
    await gate(S.plainStale, { exemptions, absent: [...absent], scope });
  }
  if (complete) await gate(S.sdkTracked, { dir: "sdk", tracked: gitTracked("sdk"), expected: [...expected], remedy: "remove it, or generate it from the model" });
}

/** Type rules § 10 on one lock: the plain generator's classes, generated from each published schema file alone. */
async function checkPlainGates(lock: SpecLock, model: ModelDoc, cases: SdkCase[], exemptions: ExemptionsFile, absent: Map<string, number>, checked: Set<string>): Promise<void> {
  const schemaDir = join(SPEC, schemaDirOf(lock.ir_dir));
  const out = join(ROOT, "build", "ci", lock.name, "plain-python");
  if (!(await gate(S.plainGenerates, { schemaDir, out }, lock))) return;
  const { runPlain, checkExemptions, plainDivergences } = await import("../src/plain-parity.ts");
  const targets = cases.map((c) => plainTarget(model, c.target));
  const concrete = cases.flatMap((c, i) => (targets[i] === null ? [] : [{ c, t: targets[i] }]));
  let r: SdkRun;
  try {
    r = runPlain(ROOT, out, concrete.map((x) => x.t), concrete.map((x) => x.c));
  } catch (e) {
    record(label(lock, titleOf(S.plainParity)), false, (e as Error).message);
    return;
  }
  const input = { lock: lock.name, cases: concrete.map((x) => x.c), ran: concrete.map((x) => x.c.label), run: r, exemptions };
  await gate(S.plainParity, input, lock);
  for (const k of checkExemptions(plainDivergences(input.cases, r), new Set(input.ran), exemptions, lock.name).absent) absent.set(k, (absent.get(k) ?? 0) + 1);
  checked.add(lock.name);
}

async function checkRoundTripGates(models: Map<SpecLock, ModelDoc>, locks: SpecLock[], loaded: Loaded | null): Promise<void> {
  if (!(await gate(C.differencesLoad, { file: join(SPEC, DIFFERENCES_FILE) }))) return;
  const recorded: DifferencesFile = loadDifferences(join(SPEC, DIFFERENCES_FILE));
  await gate(C.differencesLocks, { recorded, locks: locks.map((l) => l.name) });
  if (!loaded) {
    skipped(C.roundTripGate, "the decision records didn't load");
    return;
  }
  for (const [lock, model] of models) await gate(C.roundTripGate, { model, ir: committedIr(lock), recorded, lock: lock.name, decisions: loaded.decisions, notation: PLUGIN.roundTrip! }, lock);
}

async function checkExampleGates(models: Map<SpecLock, ModelDoc>, locks: SpecLock[], loaded: Loaded | null): Promise<void> {
  if (!(await gate(C.findingsLoad, { file: join(SPEC, FINDINGS_FILE) }))) return;
  const recorded: FindingsFile = loadFindings(join(SPEC, FINDINGS_FILE));
  await gate(C.findingsLocks, { recorded, locks: locks.map((l) => l.name) });
  if (!loaded) {
    skipped(C.examplesValidate, "the decision records didn't load");
    return;
  }
  for (const [lock, model] of models) {
    let got;
    try {
      got = await lockExamples(lock, model);
    } catch (e) {
      if (lock.required) await gate(C.examplesListing, { lock, model }, lock);
      else record(label(lock, titleOf(C.examplesListing)), true, `SKIPPED: optional lock, no reachable source (${(e as Error).message.split("\n")[0]})`);
      continue;
    }
    await gate(C.examplesListing, { lock, model }, lock);
    const schemaDir = schemaDirOf(lock.ir_dir);
    const emitted = emitSchemas(model, schemaDir, specSchemaNames());
    const input = { model, files: emitted.files, schemaDir, examples: got.examples, values: got.values, codes: codesOf(loadLists(ROOT)), ruleChecks: ruleChecks(), recorded, lock: lock.name, decisions: loaded.decisions };
    await gate(C.examplesValidate, input, lock);
    await gate(C.examplesOracle, { files: emitted.files, cases: checkExamples(input).cases }, lock);
  }
}

async function checkReleaseGates(models: Map<SpecLock, ModelDoc>, rulesOf: Map<string, RulesDoc>, locks: SpecLock[], loaded: Loaded | null): Promise<void> {
  await gate(R.frozenReleases, { root: SPEC, locks: locks.map((l) => l.name) });
  const frozen: [string, Frozen[]][] = [];
  for (const lock of locks) {
    try {
      frozen.push([lock.name, loadFrozen(SPEC, lock.name)]);
    } catch {
      // The frozen-releases gate above reports a release that doesn't load.
    }
  }
  const oracleChecks: OracleCheck[] = frozen.flatMap(([l, list]) =>
    list.map((f) => {
      const at = posix.join(relative(ROOT, SPEC), RELEASES_DIR, l, f.release.release);
      return { release: posix.join(at, RELEASE_FILE), schemas: posix.join(at, FROZEN_SCHEMAS), model: posix.join(at, FROZEN_MODEL), rules: posix.join(at, FROZEN_RULES) };
    }),
  );
  const first = [...models][0];
  const firstRules = first ? rulesOf.get(first[0].name) : undefined;
  if (!loaded) skipped(R.frozenReviewed, "the decision records didn't load");
  else if (first && firstRules) await gate(R.frozenReviewed, { frozen, decisions: loaded.decisions, current: { model: first[1], rules: firstRules } });

  const current: OracleCheck[] = [];
  for (const [lock, model] of models) {
    const dir = schemaDirOf(lock.ir_dir);
    const emitted = emitSchemas(model, dir, specSchemaNames());
    if (emitted.problems.length > 0) continue;
    const rules = rulesOf.get(lock.name);
    if (rules === undefined) {
      skipped(R.releaseBuilds, "the rules didn't emit", lock);
      continue;
    }
    const previous = frozen.find(([l]) => l === lock.name)?.[1].at(-1) ?? null;
    const input = { model, files: emitted.files, rules, previous };
    await gate(R.releaseBuilds, input, lock);
    await gate(R.breaking, input, lock);
    // With no release frozen yet, the committed corpus stands in for the last release's.
    const old = previous?.corpus ?? (JSON.parse(readFileSync(join(SPEC, corpusDirOf(lock.ir_dir), CORPUS_FILE), "utf8")) as CorpusDoc);
    await gate(R.breakingCorpus, { old, files: emitted.files, rules, of: previous ? `the corpus of ${previous.release.release}` : "the committed corpus, with no release frozen yet," }, lock);
    const doc = buildRelease(input).doc;
    const want = Buffer.from(renderRelease(doc));
    await gate(R.releaseDeterministic, { label: RELEASE_FILE, want, runs: twoRuns(lock, "release", "src/cli/release.ts", RELEASE_FILE), from: "manifest" }, lock);
    const file = posix.join(dir, RELEASE_FILE);
    await gate(R.releaseCommitted, { file, want, committed: read(file), regenerate: "npm run release" }, lock);
    const committedDoc = read(file);
    if (committedDoc === null) continue;
    await gate(R.releaseDigests, { doc: JSON.parse(committedDoc.toString("utf8")) as ReleaseDoc, files: tree(SPEC, dir, SCHEMA_ROOTS), model, rules }, lock);
    const modelFile = posix.join("build", "ci", lock.name, "release-model.json");
    mkdirSync(join(ROOT, "build", "ci", lock.name), { recursive: true });
    writeFileSync(join(ROOT, modelFile), canonicalJson(model));
    // The oracle reads each file by its path from the repository's root.
    const inSpec = (p: string) => posix.join(relative(ROOT, SPEC), p);
    const check = { release: inSpec(file), schemas: inSpec(dir), model: modelFile, rules: inSpec(posix.join(rulesDirOf(lock.ir_dir), RULES_FILE)) };
    current.push(check);
    await gate(R.releaseOracle, { checks: [check] }, lock);
  }
  // The frozen trees, or, with none frozen yet, the current manifests, so the gate's fixtures still run against real files.
  if (oracleChecks.length > 0) await gate(R.frozenOracle, { checks: oracleChecks });
  else {
    capture(R.frozenOracle, { checks: current });
    record(titleOf(R.frozenOracle), true, "none frozen yet");
  }
  // The root's releases/ holds the format schema, and each spec's releases/ its frozen releases.
  await gate(R.releasesTracked, { tracked: [...gitTracked(RELEASES_DIR), ...gitTracked(RELEASES_DIR, SPEC)], schema: RELEASE_SCHEMA });
}

/** What the feedback gates read: the inputs and every lock's build, the default lock's first. */
type FeedbackContext = FeedbackInput & { root: string };

async function checkComparisonGates(locks: SpecLock[], loaded: Loaded | null, model: Model, vectors: VectorFile[]): Promise<FeedbackContext | null> {
  if (!loaded) {
    skipped(P.comparison, "the decision records didn't load");
    return null;
  }
  const input = { root: SPEC, mappings: loaded.mappings, decisions: loaded.decisions, kernel: model.kernel, constructors: model.constructors, vectors };
  if (!(await gate(P.comparison, { locks, input }))) return null;
  const builds: { file: string; build: LockBuild }[] = [];
  for (const lock of locks) {
    const r = await buildLock(lock, input);
    if (r.build) builds.push({ file: lock.file.split("/").pop()!, build: r.build });
  }
  const base = builds.find((b) => b.file === DEFAULT_LOCK_FILE)!.build;
  const others = builds.filter((b) => b.file !== DEFAULT_LOCK_FILE);
  const recordedFindings = loadFindings(join(SPEC, FINDINGS_FILE));
  const recordedDifferences = loadDifferences(join(SPEC, DIFFERENCES_FILE));
  const want = new Map<string, Buffer>();
  for (const { build } of others) {
    const doc = compareLocks({ base, lock: build, decisions: input.decisions, recordedFindings, recordedDifferences });
    want.set(`${build.lock.name}.json`, Buffer.from(renderComparison(doc)));
    want.set(`${build.lock.name}.md`, Buffer.from(renderComparisonMarkdown(doc)));
  }
  const variants = await variantReportFiles([base, ...others.map((o) => o.build)], input, recordedFindings);
  for (const [name, text] of variants.files) want.set(name, Buffer.from(text));
  await gate(P.comparisonDeterministic, { label: "comparison", want, runs: reportRuns("compare", "src/cli/compare.ts", [...want.keys()]), from: "comparison" });
  await gate(P.comparisonCommitted, { dir: COMPARISON_DIR, want, committed: reportTree(COMPARISON_DIR, [...want.keys()]), regenerate: "npm run compare" });
  await gate(P.comparisonTracked, { dir: COMPARISON_DIR, tracked: gitTracked(COMPARISON_DIR, SPEC), expected: [...want.keys()].map((f) => posix.join(COMPARISON_DIR, f)), remedy: "remove it, or write it with: npm run compare" });
  return { ...input, builds: [base, ...others.map((o) => o.build)], recordedFindings, recordedDifferences };
}

/**
 * The enum drift report's gates: its sources' pins and pairs against the model of
 * the lock the sources file names, two runs of `npm run enum-drift`, the
 * committed report, and every tracked file under enum-drift/.
 */
async function checkEnumDriftGates(models: Map<SpecLock, ModelDoc>): Promise<void> {
  let sources;
  try {
    sources = loadEnumDriftSources(SPEC);
  } catch (e) {
    record(`${posix.basename(SPEC)}: enum drift sources`, false, (e as Error).message);
    return;
  }
  const entry = [...models].find(([l]) => l.name === sources.lock);
  if (!entry) {
    skipped(EnumDrift.enumDriftSources, `the model of the lock "${sources.lock}" the enum drift sources name didn't resolve`);
    return;
  }
  const [lock, model] = entry;
  const files = allSnapshotFiles(SPEC, sources);
  if (!(await gate(EnumDrift.enumDriftSources, { sources, files, ir: committedIr(lock), model }))) return;
  const { files: report, problems } = await enumDriftFiles(SPEC, sources, files);
  if (problems.length > 0) {
    record(`${posix.basename(SPEC)}: enum drift report`, false, problems.join("; "));
    return;
  }
  const want = new Map([...report].map(([f, t]) => [f, Buffer.from(t)]));
  await gate(EnumDrift.enumDriftDeterministic, { label: "enum-drift", want, runs: reportRuns("enum-drift", "src/cli/enum-drift.ts", [...want.keys()]), from: "enum drift report" });
  await gate(EnumDrift.enumDriftCommitted, { dir: ENUM_DRIFT_DIR, want, committed: reportTree(ENUM_DRIFT_DIR, [...want.keys()]), regenerate: "npm run enum-drift" });
  // The snapshot's files are each source's folder, which hashes to its pinned tree, and its license.
  const pinned = [ENUM_DRIFT_SOURCES, ...sources.sources.flatMap((s) => [...(files.get(s.id) ?? new Map()).keys()].filter((p) => p === s.license.path || p.startsWith(`${s.folder}/`)).map((p) => posix.join(ENUM_DRIFT_DIR, "snapshots", s.id, p)))];
  await gate(EnumDrift.enumDriftTracked, { dir: ENUM_DRIFT_DIR, tracked: gitTracked(ENUM_DRIFT_DIR, SPEC), expected: [...pinned, ...Object.values(ENUM_DRIFT_FILES).map((f) => posix.join(ENUM_DRIFT_DIR, f))], remedy: "remove it, pin it in enum-drift/sources.yaml, or write it with: npm run enum-drift" });
}

/** Two runs of a report CLI on the spec, each the files it wrote by name. */
function reportRuns(name: string, cli: string, files: string[]): Map<string, Buffer>[] {
  return [1, 2].map((n) => {
    const out = join(ROOT, "build", "ci", `${name}-run${n}`);
    rmSync(out, { recursive: true, force: true });
    run(bin("tsx"), [cli, "--spec", posix.basename(SPEC), "--out", out]);
    return new Map(files.flatMap((f) => (existsSync(join(out, f)) ? [[f, readFileSync(join(out, f))] as const] : [])));
  });
}
const reportTree = (dir: string, files: string[]) => new Map(files.flatMap((f) => (existsSync(join(SPEC, dir, f)) ? [[f, readFileSync(join(SPEC, dir, f))] as const] : [])));

async function checkFeedbackGates(ctx: FeedbackContext): Promise<void> {
  if (!(await gate(P.feedback, ctx))) return;
  const { doc } = buildFeedback(ctx);
  const want = new Map<string, Buffer>([
    [FEEDBACK_FILES.data, Buffer.from(renderFeedback(doc))],
    [FEEDBACK_FILES.comment, Buffer.from(renderComment(doc))],
    [FEEDBACK_FILES.details, Buffer.from(renderDetails(doc, feedbackOf(SPEC)))],
  ]);
  await gate(P.feedbackDeterministic, { label: "feedback", want, runs: reportRuns("feedback", "src/cli/feedback.ts", [...want.keys()]), from: "report" });
  await gate(P.feedbackCommitted, { dir: FEEDBACK_DIR, want, committed: reportTree(FEEDBACK_DIR, [...want.keys()]), regenerate: "npm run feedback" });
  await gate(P.feedbackTracked, { dir: FEEDBACK_DIR, tracked: gitTracked(FEEDBACK_DIR, SPEC), expected: [...want.keys()].map((f) => posix.join(FEEDBACK_DIR, f)), remedy: "remove it, or write it with: npm run feedback" });
}

/** One variant (src/variant.ts) and its build on each lock whose model resolves and differs only where a switch says. */
interface VariantBuilds {
  variant: Variant;
  builds: Map<SpecLock, Build>;
}

/** The files each variant's builds write, by path from the repository root, which the tracked-file gates expect. */
interface VariantFiles {
  schemas: string[];
  rules: string[];
  typeExamples: string[];
  sdk: string[];
}

/** A lock as a gate's line names a variant's build of it, such as `main (as-written)`; the gate's inputs still name the lock. */
const asBuild = (b: Build): SpecLock => ({ ...b.lock, name: b.label });

/**
 * The variants' model gates: each variant file loads and checks against the
 * decision records, its primitives' patterns hold in every engine and their
 * sources are current, and on each lock its model resolves and differs from
 * the proposed one only where a switch says.
 */
async function checkVariantModelGates(locks: SpecLock[], model: Model, loaded: Loaded | null, proposed: Map<SpecLock, ModelDoc>): Promise<VariantBuilds[]> {
  const out: VariantBuilds[] = [];
  for (const name of variantNames(SPEC)) {
    const file = join(SPEC, "variants", `${name}.yaml`);
    if (!(await gate(V.variantLoad, { file, name }))) continue;
    if (!loaded) {
      skipped(V.variantCheck, "the decision records didn't load");
      continue;
    }
    const variant = loadVariant(SPEC, name);
    await gate(V.variantCheck, { variant, decisions: loaded.decisions, kernel: model.kernel, mappings: loaded.mappings });
    const own: Kernel = { ...model.kernel, primitives: variant.primitives, file: variant.file };
    // The engines gate reads the oracle's listed gaps against the whole kernel, so the variant's primitives join the kernel's.
    await gate(K.kernelEngines, { kernel: { ...model.kernel, primitives: [...model.kernel.primitives, ...variant.primitives], file: variant.file }, gaps: loadOracleGaps(ROOT) });
    const builds = new Map<SpecLock, Build>();
    for (const lock of locks) {
      await gate(K.kernelSources, { ir: committedIr(lock), lock: lock.name, kernel: own }, lock);
      const p = proposed.get(lock);
      if (!p) {
        skipped(V.variantDiff, "the proposed model didn't resolve", lock);
        continue;
      }
      const b = resolveBuild({ lock, root: SPEC, mappings: loaded.mappings, decisions: loaded.decisions, kernel: model.kernel, constructors: model.constructors, variant });
      const ok = await gate(V.variantDiff, { variant, proposed: p, written: b.model, decisions: loaded.decisions, lock: lock.name, problems: b.problems }, asBuild(b));
      if (ok) builds.set(lock, b);
    }
    out.push({ variant, builds });
  }
  return out;
}

function expectedVariantFiles(variants: VariantBuilds[]): VariantFiles {
  const files: VariantFiles = { schemas: [], rules: [], typeExamples: [], sdk: [] };
  for (const { builds } of variants) {
    for (const b of builds.values()) {
      const schemaDir = b.dirOf(schemaDirOf(b.lock.ir_dir));
      for (const f of emitSchemas(b.model, schemaDir, specSchemaNames()).files) files.schemas.push(posix.join(schemaDir, f.path));
      files.rules.push(posix.join(b.dirOf(rulesDirOf(b.lock.ir_dir)), RULES_FILE));
      files.typeExamples.push(posix.join(b.dirOf(typeExamplesDirOf(b.lock.ir_dir)), TYPE_EXAMPLES_FILE));
      const sdkDir = sdkDirOf(b.lock.ir_dir, b.variant);
      for (const f of emitSdk(b.model, sdkDir, schemaDir, NAMES, specSchemaNames()).files) files.sdk.push(posix.join(sdkDir, f.path));
    }
  }
  return files;
}

/**
 * Each variant's outputs, held to the gates the proposed ones are: its
 * schemas emit, run twice to the committed bytes, follow the output
 * conventions, and pass Ajv and the reference oracle; the fidelity gate
 * passes with no departure in force, so the variant states what the text
 * states; its rules, with their vectors converted, emit with every vector
 * isolated and decided by its check, twice to the committed bytes; its type
 * examples generate, twice to the committed bytes, valid; its SDK types
 * generate, name every type, run twice to the committed bytes, typecheck,
 * vet, and reach the reference verdict on the variant's corpus, generated
 * in process; and its example failures are the gaps' findings and its
 * switches' own, with the oracle agreeing.
 */
async function checkVariantOutputGates(variants: VariantBuilds[], vectors: VectorFile[], loaded: Loaded, model: Model): Promise<void> {
  const recorded = loadFindings(join(SPEC, FINDINGS_FILE));
  const codes = codesOf(loadLists(ROOT));
  const fields = loadFieldExamples(join(SPEC, FIELD_EXAMPLES_FILE)).fields;
  const pinned = pinnedOracle(ROOT);
  const gaps = loaded.decisions.filter((d) => d.kind !== "departure");
  for (const { variant, builds } of variants) {
    const extra = ["--variant", variant.name];
    for (const [lock, b] of builds) {
      const at = asBuild(b);
      const tag = `-${variant.name}`;
      // Schemas.
      const schemaDir = b.dirOf(schemaDirOf(lock.ir_dir));
      if (!(await gate(O.schemasEmit, { model: b.model, dir: schemaDir, names: specSchemaNames() }, at))) continue;
      const emitted = emitSchemas(b.model, schemaDir, specSchemaNames());
      const want = new Map(emitted.files.map((f) => [f.path, Buffer.from(f.text)]));
      await gate(O.schemasDeterministic, { label: "schemas", want, runs: twoTreeRuns(lock, `schemas${tag}`, "src/cli/emit.ts", SCHEMA_ROOTS, extra), from: "emitter" }, at);
      await gate(O.schemasCommitted, { dir: schemaDir, want, committed: tree(SPEC, schemaDir, SCHEMA_ROOTS), regenerate: "npm run emit" }, at);
      await gate(O.schemasConventions, { files: emitted.files, model: b.model, dir: schemaDir, base: NAMES.schema_base }, at);
      await gate(O.schemasAjv, { files: emitted.files }, at);
      await gate(O.schemasOracle, { files: emitted.files }, at);
      // Rules.
      const converted = b.vectors(vectors);
      const input = { model: b.model, ir: b.ir, lock: lock.name, vectors: converted.vectors, decisions: loaded.decisions, schemaDir, conditionsLeft: emitted.conditions.left, schemaBase: NAMES.schema_base };
      if (!(await gate(O.rulesEmit, input, at))) continue;
      const rules = emitRules(input).doc;
      await gate(O.ruleVectors, { doc: rules, model: b.model, files: emitted.files, schemaDir }, at);
      await gate(O.ruleChecks, { doc: rules, model: b.model, codes, ruleChecks: ruleChecks() }, at);
      const rulesFile = posix.join(b.dirOf(rulesDirOf(lock.ir_dir)), RULES_FILE);
      const rulesWant = Buffer.from(renderRules(rules));
      await gate(O.rulesDeterministic, { label: RULES_FILE, want: rulesWant, runs: twoRuns(lock, `rules${tag}`, "src/cli/rules.ts", RULES_FILE, extra), from: "emitter" }, at);
      await gate(O.rulesCommitted, { file: rulesFile, want: rulesWant, committed: read(rulesFile), regenerate: "npm run rules" }, at);
      // Fidelity, with no departure in force: the variant states what the text states.
      await gate(fidelity, { ir: b.ir, lock: lock.name, model: b.model, files: emitted.files, kernel: b.kernel, rules, decisions: gaps, readings: readingsOf(b.mappings, lock.name), schemaDir, expected: loadExpected(), readers: PLUGIN.fidelity!, names: specSchemaNames() }, at);
      // Examples.
      let spec;
      try {
        spec = await lockExamples(lock, b.model);
      } catch (e) {
        skipped(V.variantExamples, `no source yields the specification's examples (${(e as Error).message.split("\n")[0]})`, at);
        continue;
      }
      const exInput = { model: b.model, files: emitted.files, schemaDir, examples: spec.examples, values: spec.values, codes, ruleChecks: ruleChecks(), variant, recorded, lock: lock.name, decisions: loaded.decisions };
      await gate(V.variantExamples, exInput, at);
      await gate(C.examplesOracle, { files: emitted.files, cases: checkExamples(exInput).cases }, at);
      // Type examples.
      const teInput = { model: b.model, files: emitted.files, kernel: b.kernel, schemaDir, codes, ruleChecks: ruleChecks(), spec, fields };
      if (await gate(O.typeExamplesGenerate, teInput, at)) {
        const doc = generateTypeExamples(teInput).doc;
        const file = posix.join(b.dirOf(typeExamplesDirOf(lock.ir_dir)), TYPE_EXAMPLES_FILE);
        const teWant = Buffer.from(renderTypeExamples(doc));
        await gate(O.typeExamplesDeterministic, { label: TYPE_EXAMPLES_FILE, want: teWant, runs: twoRuns(lock, `type-examples${tag}`, "src/cli/type-examples.ts", TYPE_EXAMPLES_FILE, extra), from: "generator" }, at);
        const committed = read(file);
        await gate(O.typeExamplesCommitted, { file, want: teWant, committed, regenerate: "npm run type-examples" }, at);
        if (committed !== null) await gate(O.typeExamplesValid, { doc: JSON.parse(committed.toString("utf8")) as TypeExamplesDoc, model: b.model, files: emitted.files, schemaDir, codes, ruleChecks: ruleChecks() }, at);
      }
      // SDK types.
      const sdkDir = sdkDirOf(lock.ir_dir, b.variant);
      if (!(await gate(S.sdkGenerate, { model: b.model, dir: sdkDir, schemaDir, names: NAMES, schemaNames: specSchemaNames() }, at))) continue;
      const sdk = emitSdk(b.model, sdkDir, schemaDir, NAMES, specSchemaNames());
      const schemaNames = emitted.files.flatMap((f) => (isPlainMap(f.schema.$defs) ? Object.keys(f.schema.$defs) : [String(f.schema.title)])).sort();
      await gate(S.sdkNames, { schemaNames, emitted: sdk.sdk.emitted, templates: [...sdk.sdk.templates.keys()] }, at);
      const sdkWant = new Map(sdk.files.map((f) => [f.path, Buffer.from(f.text)]));
      await gate(S.sdkDeterministic, { label: "SDK types", want: sdkWant, runs: twoTreeRuns(lock, `sdk${tag}`, "src/cli/sdk.ts", SDK_ROOTS, extra), from: "emitters" }, at);
      if (!(await gate(S.sdkCommitted, { dir: sdkDir, want: sdkWant, committed: tree(ROOT, sdkDir, SDK_ROOTS), regenerate: "npm run sdk" }, at))) continue;
      await gate(S.sdkTypecheck, { project: posix.join(sdkDir, "ts", "tsconfig.json") }, at);
      await gate(S.sdkGo, { dir: posix.join(sdkDir, "go") }, at);
      const corpusInput = { model: b.model, files: emitted.files, rules, kernel: b.kernel, schemaDir, oracle: pinned };
      if (!(await gate(O.corpusGenerates, corpusInput, at))) continue;
      const corpus = generateCorpus(corpusInput).doc;
      const cases: SdkCase[] = sdkCases(b.model, corpus, b.kernel, b.constructors);
      const legs: [string, () => Promise<SdkRun> | SdkRun][] = [
        ["TypeScript", () => runTypeScript(join(ROOT, sdkDir, "ts"), cases)],
        ["Python", () => runPython(ROOT, join(ROOT, sdkDir, "python"), cases)],
        ["Go", () => runGo(join(ROOT, sdkDir, "go"), join(ROOT, "build", "ci", lock.name, `sdk-go-verdicts${tag}`), cases)],
      ];
      for (const [language, leg] of legs) {
        let r: SdkRun;
        try {
          r = await leg();
        } catch (e) {
          record(label(at, titleOf(S.sdkParity, { language, cases, run: { engine: "", verdicts: [], dumps: [], errors: [] } })), false, (e as Error).message);
          continue;
        }
        await gate(S.sdkParity, { language, cases, run: r }, at);
      }
    }
  }
}

/** The public site, every spec's pages and the root's: it builds with no problem its own check finds, and two builds in separate processes write its bytes. */
async function checkSiteGates(): Promise<void> {
  let site;
  let exported;
  try {
    const config = loadSiteConfig();
    exported = { repo: config.repo, tree: exportTree() };
    site = buildSite(undefined, config, exported.tree);
  } catch (e) {
    record(titleOf(Site.siteBuilds), false, (e as Error).message);
    return;
  }
  // The site's own code, every file under src/site/, and the name each spec's profile gives.
  const sources = new Map(gitTracked("src/site").map((p) => [p, readFileSync(join(ROOT, p), "utf8")] as const));
  const names = specNames(ROOT).map((n) => specOf(specRoot(n, ROOT)).profile.names.short);
  await gate(Site.siteBuilds, { files: site.files, problems: site.problems, sources, names, exported });
  const runs = [1, 2].map((n) => {
    const out = join(ROOT, "build", "ci", `site-run${n}`);
    rmSync(out, { recursive: true, force: true });
    run(bin("tsx"), ["src/cli/site.ts", "--out", out]);
    const files = new Map<string, Buffer>();
    const walk = (rel: string) => {
      if (!existsSync(join(out, rel))) return;
      for (const e of readdirSync(join(out, rel), { withFileTypes: true })) {
        const p = rel === "" ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else files.set(p, readFileSync(join(out, p)));
      }
    };
    walk("");
    return files;
  });
  await gate(Site.siteDeterministic, { label: "site", want: site.files, runs, from: "builder" });
}

/**
 * Reruns every gate on each of its fixtures. The gates on the gates come
 * last: the guard over every gate's fingerprint, the meta-check that every
 * gate has a fixture and ran, and the self-tests over every fixture's run,
 * their own fixtures' runs included.
 */
async function checkTheGates(kernel: Kernel | null): Promise<void> {
  const META = new Set([selfTests.id, fixturesExist.id, guard.id]);
  const runs: FixtureRun[] = [];
  for (const { gate: g } of REGISTRY) {
    if (META.has(g.id)) continue;
    const inputs = captured.get(g.id);
    if (!inputs) continue;
    for (const f of g.fixtures) {
      const input = fixtureInput(inputs, f);
      runs.push(input === undefined ? { gate: g.id, fixture: f.name, failed: false, matched: false, problems: [`no input${f.spec ? ` of the spec "${f.spec}"` : ""}${f.lock ? ` on lock "${f.lock}"` : ""}`] } : await runFixture(g, input, f));
    }
  }
  let records;
  try {
    records = loadGateDecisions();
  } catch (e) {
    record(titleOf(guard), false, (e as Error).message);
  }
  const fingerprints = REGISTRY.map(({ gate: g, file, name }) => [g.id, fingerprint(g, file, name)] as [string, string]);
  const guardInput = {
    fingerprints,
    recompute: (changes: Record<string, ((text: string) => string) | null>, gates: string[]) => {
      const src = overlay(changes);
      return fingerprints.map(([id, fp]) => {
        const r = REGISTRY.find((x) => x.gate.id === id)!;
        return [id, gates.includes(id) ? fingerprint(r.gate, r.file, r.name, src) : fp] as [string, string];
      });
    },
    records: records ?? [],
    concepts: kernel?.domains?.domains.flatMap((d) => d.concepts.map((c) => c.name)) ?? [],
  };
  const metaInput = { gates: REGISTRY.map(({ gate: g }) => ({ id: g.id, fixtures: g.fixtures.length, ran: captured.has(g.id) || META.has(g.id) })) };
  const testsInput = { runs: [...runs] };
  for (const f of guard.fixtures) runs.push(await runFixture(guard, guardInput, f));
  for (const f of fixturesExist.fixtures) runs.push(await runFixture(fixturesExist, metaInput, f));
  for (const f of selfTests.fixtures) runs.push(await runFixture(selfTests, testsInput, f));
  if (records) await gate(guard, guardInput);
  await gate(fixturesExist, metaInput);
  await gate(selfTests, { runs });
}

/** Every gate on one spec, `SPEC`, and its locks; the kernel, when it loads, for the guard's concepts. */
async function checkSpec(): Promise<Kernel | null> {
  const locks = lockFiles(SPEC).map(loadLock);
  const through = stageOf(specOf(SPEC).profile);
  for (const lock of locks) await checkLock(lock, through);
  const loaded = await checkMappingAndDecisions(locks, through);
  if (!reaches(through, "model")) {
    record(`${posix.basename(SPEC)}: pipeline stage`, true, `the profile says the spec has reached "${through}", so the gates of later stages don't run on it yet, and the spec-profile gate holds it to no file of a later stage`);
    return null;
  }
  const kernel = await checkKernelGates(locks, loaded);
  if (kernel) {
    const model = await checkConstructorGates(locks, kernel, loaded);
    if (model) await checkDomainGates(locks, model, loaded);
    await gate(K.duplicationKernel, { kernel, model, mappings: loaded?.mappings ?? [] });
    if (model) {
      await checkCoverageGates(locks, model, loaded);
      const models = await checkModelGates(locks, model, loaded);
      // The records' text for the specification's owners, before any report renders it.
      if (loaded && models.size === locks.length) await gate(P.recordWording, { decisions: loaded.decisions, names: internalTypeNames([...models].map(([l, m]) => ({ model: m, ir: committedIr(l) }))) });
      else skipped(P.recordWording, "the models didn't resolve on every lock");
      if (!reaches(through, "outputs")) {
        record(`${posix.basename(SPEC)}: pipeline stage`, true, `the profile says the spec has reached "${through}", so the gates of its outputs don't run on it yet, and the spec-profile gate holds it to no output file`);
        return kernel;
      }
      const variants = await checkVariantModelGates(locks, model, loaded, models);
      const variantFiles = expectedVariantFiles(variants);
      await checkSchemaGates(models, locks, variantFiles);
      const { vectors, rules } = await checkRuleGates(models, locks, loaded, variantFiles);
      await checkFidelityGates(models, rules, kernel, loaded);
      await checkCorpusGates(models, rules, kernel, locks);
      await checkTypeExampleGates(models, kernel, locks, variantFiles);
      // A spec whose profile names no SDK packages or no feedback target has no SDK types or report to check, unless it has, or owns, such outputs (optional-outputs).
      const profile = specOf(SPEC).profile;
      const optional = { spec: posix.basename(SPEC), ownsSdkTree: posix.basename(SPEC) === DEFAULT_SPEC, sdk: NAMES.sdk !== undefined, feedback: profile.feedback !== undefined, trackedFeedback: gitTracked(FEEDBACK_DIR, SPEC) };
      const optionalOk = await gate(I.optionalOutputs, optional);
      if (NAMES.sdk || !optionalOk) await checkSdkGates(models, locks, model, variantFiles);
      if (loaded) await checkVariantOutputGates(variants, vectors, loaded, model);
      await checkRoundTripGates(models, locks, loaded);
      await checkExampleGates(models, locks, loaded);
      await checkReleaseGates(models, rules, locks, loaded);
      const feedback = await checkComparisonGates(locks, loaded, model, vectors);
      // A registry with an `enum-drift/` folder compares its lists with other artifacts' enums.
      if (existsSync(join(SPEC, ENUM_DRIFT_DIR))) await checkEnumDriftGates(models);
      // A spec with no feedback target has no report yet, which optional-outputs checks; its records are held to its owners' terms by the record-wording gate.
      if (profile.feedback) {
        if (feedback) await checkFeedbackGates(feedback);
        else skipped(P.feedback, "the lock comparison's pipeline didn't run clean, so the report has no input");
      }
    }
  }
  return kernel;
}

async function main(): Promise<void> {
  await gate(G.typecheck, { args: ["--noEmit"] });
  await gate(G.toolchain, { root: ROOT, pkg: G.packageJson() });
  await gate(G.workflow, { workflow: readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8"), pkg: G.packageJson(), goMods: trackedGoMods(ROOT) });

  // Each spec under specs/ with its locks under specs/<spec>/spec-input/.
  const specs = specNames(ROOT);
  if (specs.length === 0) record("specs", false, "specs/ holds no spec folder, so no lock was checked");
  let kernel: Kernel | null = null;
  for (const name of specs) {
    SPEC = specRoot(name, ROOT);
    let spec;
    try {
      spec = specOf(SPEC);
    } catch (e) {
      record(`${name}: ${titleOf(I.specProfile)}`, false, (e as Error).message);
      continue;
    }
    if (spec.plugin === null) {
      // A schema set imported as published has no locks to extract; its profile is all there is to check here.
      await gate(I.specProfile, { profile: spec.profile, text: null, roles: [], findingKinds: FINDING_KINDS, locks: existsSync(join(SPEC, "spec-input")) ? lockFiles(SPEC).length : 0, entries: folderEntries() });
      continue;
    }
    PLUGIN = spec.plugin;
    NAMES = spec.profile.names;
    kernel = (await checkSpec()) ?? kernel;
  }
  SPEC = "";

  // One site for every spec, once each spec's outputs are checked.
  await checkSiteGates();

  await gate(G.layoutTracked, { tracked: gitTracked(".").filter((p) => [...G.MOVED_DIRS, ...G.FORMAT_DIRS].includes(p.split("/")[0]!)) });
  const untracked = run("git", ["ls-files", "--others", "--exclude-standard", ...G.TRACKED_DIRS]);
  await gate(G.untracked, { untracked: untracked.ok ? untracked.output.split("\n").filter((p) => p !== "") : [untracked.output] });
  await gate(G.npmTest, { script: G.packageJson().scripts?.test ?? "", extra: [] });
  // The workflow sets GATE_BASE to the pull request's base or the push's previous commit, and fetches it; locally, the base is origin/main.
  await gate(appendOnly, { base: process.env.GATE_BASE || "origin/main", head: null });
  await checkTheGates(kernel);

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? `\nAll ${results.length} gates pass.` : `\n${failed.length} of ${results.length} gates fail.`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e: Error) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
