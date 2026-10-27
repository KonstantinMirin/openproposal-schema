# Extraction report: stages 1 and 2

This report covers the deterministic extractor (stage 1) and the spec lint (stage 2), run on both locked inputs on 2026-10-26.

| Lock | Input | Spec blob | Output |
| :--- | :--- | :--- | :--- |
| `main` (default) | upstream `main` at `44dfaaf` | `69409583` | [`ir/`](../ir/) |
| `with-open-prs` (optional) | integration tip `292bb51`: `main` plus the 14 open PRs, including #119, #120, and #123 | `fdb303f0` | [`ir/with-open-prs/`](../ir/with-open-prs/) |

## How it works

- **Input.** `npm run fetch` materializes a lock's spec into `build/spec/<lock>/` and verifies its git blob SHA. Sources are tried in order: a local clone, then the lock's snapshot under `spec-input/snapshots/`, then the raw GitHub URL. The `with-open-prs` integration branch exists only in a local clone, so CI regenerates its IR from the snapshot.
- **Stage 1.** `src/extract.ts` parses the spec with `remark-parse` and `remark-gfm`, and reads cells, code spans, and positions from the mdast tree. It classifies each table by its header signature against [`src/layouts.ts`](../src/layouts.ts). It fails on an unknown layout, a layout outside its allowed sections, a row with the wrong number of cells, an unknown marker, an unparsed type expression, an unparsed inline object, a duplicate ID, or a row that yields no typed record.
- **Stage 2.** `src/lint.ts` runs over the IR only. Its findings go to `findings.json`, and [`ir/exceptions.yaml`](../ir/exceptions.yaml) gives some of them a fixed verdict. A stale exception fails the build; an open finding doesn't.
- **IDs.** Element IDs come from the structure, such as `field:5.6:pricing[].cost_method`, `key:5.6.1:commitment.basis`, and `def:5.1.1:channel.dooh`. Statement IDs are `rule:<section>:<sha8 of the sentence>`, and a prose sentence with no RFC 2119 keyword that names an identifier gets `sentence:<section>:<sha8>`, so both survive renumbering. Every row carries a SHA-256 digest for stage 3's staleness check.
- **Gates.** `npm run ci` typechecks, extracts twice in separate processes and byte-compares, checks that the committed IR is current, validates against [`ir/spec-ir.schema.json`](../ir/spec-ir.schema.json), sweeps `ir/` for untracked files, and runs `npm test`. The tests include golden snapshots under [`test/golden/`](../test/golden/). The appendix tests also run the checks against a deliberately corrupted copy of `main`.

## Counts

<!-- generated:counts -->
### Tables by layout

| Layout | Header | `main` tables / rows | `with-open-prs` tables / rows |
| :--- | :--- | ---: | ---: |
| `field` | Field \| Type \| Mutability \| Description | 12 / 71 | 12 / 80 |
| `key-required-meaning` | Key \| Required \| Meaning | 2 / 11 | 3 / 17 |
| `key-required-meaning-mapping` | … \| AdCOM 1.0, OpenRTB 2.6 | 0 / 0 | 1 / 8 |
| `key-meaning` | Key \| Meaning | 1 / 5 | 2 / 8 |
| `value-condition` | `` `channel` `` \| Condition | 0 / 0 | 1 / 6 |
| `value-distribution-device` | Value \| Distribution channel \| Device types | 0 / 0 | 1 / 5 |
| `marker-meaning` | Marker \| Meaning | 1 / 7 | 1 / 7 |
| `concept-standard` | OpenProposal concept \| Downstream standard | 1 / 4 | 1 / 4 |
| `appendix-a` | Field \| Section \| Type \| Marker | 1 / 71 | 1 / 80 |
| `appendix-b` | Marker \| Count \| Meaning \| Fields | 1 / 8 | 1 / 8 |
| **Total** | | **19 / 177** | **24 / 223** |

Every row of every table produced a typed record. No layout was unknown.

### Elements

| Element | `main` | `with-open-prs` |
| :--- | ---: | ---: |
| Field rows (names; `valid_from` · `valid_until` is one row) | 71 (72) | 80 (81) |
| Key rows | 16 | 33 |
| Value definitions (`channel`, `environments` tables) | 0 | 11 |
| Value lists: in table cells / in inline objects / in prose | 14 / 8 / 1 | 20 / 9 / 2 |
| Inline objects: in table cells / in prose | 19 / 0 | 26 / 3 |
| RFC 2119 sentences in the body | 32 | 79 |
| Other prose sentences that name an identifier (code span) | 28 | 78 |
| Code spans | 132 | 346 |
| `·` identifier lists (Summary Representation) | 2 | 3 |
| Fenced code blocks | 2 | 6 |

RFC 2119 sentences by strongest keyword. The front-matter status sentence is excluded, and so is the conventions sentence that lists the keywords. A Required cell is a structured attribute, not a sentence.

| Level | `main` | `with-open-prs` |
| :--- | ---: | ---: |
| MUST | 16 | 37 |
| MUST NOT | 3 | 15 |
| SHOULD NOT | 0 | 1 |
| REQUIRED | 2 | 7 |
| MAY | 10 | 15 |
| OPTIONAL | 1 | 4 |

### Findings by kind

Each cell shows open findings, plus findings with a verdict in brackets.

| Kind | `main` | `with-open-prs` |
| :--- | ---: | ---: |
| Appendix A and B (rows, section, type, marker, counts, distribution) | 0 | 0 |
| `duplicate_field_disagrees` | 1 | 1 |
| `name_reused_with_different_values` | 2 | 2 |
| `value_set_duplicate` | 0 | 2 |
| `value_set_subset` | 1 (+1) | 1 (+1) |
| `unresolved_identifier` | 6 (+3) | 13 (+26) |
| `array_suffix_mismatch` | 4 | 6 |
| `expression_value_unknown` | 0 | 2 |
| `object_without_structure` | 7 | 7 |
| `option_shape_missing` | 6 | 5 |
| `enum_without_values` | 1 | 1 |
| `must_without_field` | 13 | 26 |
| `marker_undefined` | 1 | 1 |
| `key_presence_unstated` | 1 | 2 |
| `key_required_is_marker` | 1 | 1 |
| `presence_unstated` | 2 | 2 |
| `unnumbered_heading` | 0 | 1 |
| **Total** | **46 (+4)** | **73 (+27)** |

The appendices agree with the body on both locks. That's expected: `tools/regen_appendices.py` reproduces `main` byte for byte, and the integration build regenerated the appendices after every merge.

On `with-open-prs`, the verdicts are 26 `accepted` and 1 `false_positive`; `main` has 3 and 1.
<!-- /generated:counts -->

The accepted ones are AdCOM, OpenRTB, VAST, HTTP, and `app-ads.txt` names, plus three deliberate references: `audience_pricing`, `io_id`, and `min_line_items`. The false positive is the § 5.6.2 transitions sentence, which the lint reads as a second value set.

## Findings that matter for the schema

These become implementation feedback once stage 3 has decided them. Each item names its finding IDs.

1. **Presence is almost never stated** (`presence_unstated`). On `main`, 55 of 56 line-item fields and 13 of 15 proposal fields don't say REQUIRED or OPTIONAL. Field tables have no Required column. JSON Schema `required` can't be derived, so every `required` list is a mapping decision.
2. **Seven object fields have no structure anywhere** (`object_without_structure`): `assent`, `specifications` (String/Object), `content_detail`, `specs`, `third_party_tags`, `approval`, and `creative_policy`. Type rules § 4 makes every object a named type, so each one needs a decision. That decision is either a shape or an explicitly open object. These are where an agent is tempted to invent fields.
3. **Six selectable or settable fields have no option type** (`option_shape_missing`): `formats`, `geo`, `device`, `daypart`, `cancellation_policy`, and `exclusivity`. `Selectable<T>` and `Settable<T>` can't be monomorphized without `T`. "Geo codes", "device categories", and "time windows" are prose.
4. **`Settable<T>` has no definition table.** § 3.2 states `allowed[]`, `min`, and `max` only in prose (`unresolved_identifier:allowed[]`). § 3.1 has a key table for `Selectable<T>`.
5. **`mixed` is not a marker** (`marker_undefined:mixed`). § 3 defines seven markers and says every field carries exactly one. `pricing[]` and `buyer_requirements` carry `mixed`. `buyer_requirements` puts two inline objects in one cell, and their markers appear only as "are seller-set" and "are supplied".
6. **`pricing[].cost_method` is an Enum with no values** (`enum_without_values`): "CPM, CPC, flat, etc.". § 5.6.3 then uses `cost_method: flat` (`expression_value_unknown`). The open-versus-closed decision has no core list to start from.
7. **The same name carries different vocabularies.** `status` lists six values on the proposal and seven on the line item (`duplicate_field_disagrees:status`). `type` names three value sets on `main` and four with the PRs. `basis` names two (`name_reused_with_different_values`). Type rules § 7 derives type names from field names, so these need distinct names, each with a decision record.
8. **Lists declared more than once** (PRs only, `value_set_duplicate`). `0` \| `1` appears three times in § 5.2.2. The store-platform list appears in both § 5.2 and § 5.5. Type rules § 5 allows each list to be defined only once, so both become one named vocabulary. The platform list says "and other store platforms", which makes it an open vocabulary.
9. **Array notation drifts from the tables** (`array_suffix_mismatch`). The § 2.1 Summary Representation writes `pricing.cost_method` and `pricing.gross_rate`, but `pricing[]` is an array, so the summary profile doesn't say which entry. § 7 writes `best_for` for `best_for[]`. § 8 writes `environments[]` for the Object `environments`. The PRs add `apps` against `apps[]`, and `exclusions_accepted.types` against `types[]`.
10. **Prose-only identifiers** (`unresolved_identifier`, open). `catalog_ref` has a grammar only in a code block (§ 2.2), so `CatalogRefOr<T>` has no table. `has_requires`, `full_url`, and `proposals[]` define the manifest and summary only in prose. Also prose-only: `deal_id`, the metrics `viewable_rate` and `completion_rate`, `remedy_terms`, the enforcement values `pre_serve` and `best_effort` (written "or", not as a list), and the `role` values `io` and `agreement`.
11. **Keys with no presence.** `hold_status` (§ 5.6.2) and `requires` (§ 5.6.3) have no Required column (`key_presence_unstated`). `commitment.derived_units` has the marker `derived` in its Required column (`key_required_is_marker`).
12. **Behavior rules, not schema rules.** Some MUST sentences name no field or key (`must_without_field`; the findings table counts them). Examples are "Each line item MUST be fully self-contained" and the § 5.4 creative inspection rules. Stage 3 classifies them as conformance obligations; they can't become schema keywords.
13. **An unnumbered heading** (PR #118). "Creative inspection and previews" has no number, so its rules are cited as § 5.4 (`unnumbered_heading`). The extractor gives it the ID `5.4/creative-inspection-and-previews`.

## What stage 1 leaves to stage 3

The extractor records what the text says and decides nothing. These are left to the mapping:

- **Types of inline object members.** Members are names with optional `[]` and value lists; the spec gives them no types. The `anchor` field links "`available[]` of `{ … }`" to its selectable option, but whether an unanchored object is the option shape, as in `production`, is a mapping question.
- **Conditions.** "REQUIRED when `basis = spend`", "REQUIRED for video ads (…)", and "REQUIRED with either" are parsed into level and qualifier. A `with` clause also lists its members: the code spans it names, or for "either" the two code spans of the sentence before it, which is the only reading the extractor resolves. The condition stays text; stage 3 turns it into `if`/`then`, `dependentRequired`, `dependentSchemas`, or a rule.
- **Vocabulary identity.** Which value lists are the same vocabulary, and which are open or closed. The lint only reports exact duplicates and subsets.
- **Statement buckets.** Each RFC 2119 sentence has an ID, a level, and its identifiers. Stage 3 sorts it into schema keyword, rule, behavior obligation, or informative.
- **The summary profile.** The § 2.1 `·` lists are captured as identifier lists, including the plain-text item "property names". They aren't yet resolved into a profile.
- **Prose forms that aren't value lists.** "`a` or `b`", comma lists, code-system lists such as the `plcmt` values "Instream (1), …", and the hold-state arrow chain in § 5.6.2 aren't parsed. The sentence that holds one is still an element, such as "`enforcement` is `pre_serve` or `best_effort` per type", so a decision that reads it quotes and digests it.
- **Code blocks and examples.** The YAML blocks in § 5.5 and § 5.6.3 are stored verbatim. The `examples/` directory isn't read, though it carries structure the spec doesn't, such as `suppression_list` keys.
- **External mappings.** The § 5.2.2 AdCOM/OpenRTB column and the § 5.1.1 and § 5.2.1 condition columns are kept as text.

## Difference between the locks

This section covers stages 1 and 2. [`comparison/with-open-prs.md`](../comparison/with-open-prs.md), which `npm run compare` generates, covers the whole pipeline: the schema changes, decisions, and findings the open PRs bring.

<!-- generated:lock-additions -->
The open PRs add 9 fields, 17 keys, 3 table layouts, 8 value lists, 10 inline objects, and 47 RFC 2119 sentences.
<!-- /generated:lock-additions -->

They change one marker.

- **Fields added:** `proposal_template_id` and `linked_execution` on the proposal. `placement`, `exclusions_accepted`, `exclusions`, `time_zone`, `requires`, `terms_ref`, and `agreement_ref` on the line item.
- **Marker changed:** `geo` moves from `settable` to `selectable` (PR #72), though § 5.5 still lets a `geo` with only `allowed[]` be settable. That makes `geo`'s marker conditional on its content, which no other field does.
- **Descriptions changed:** `version`, `channel`, `properties`, `environments`, `geo`, `daypart`, `pricing[].floor`, and `external_references[]`. `daypart` now writes its window, `{ days[], start, end }`, which the § 5.5 Window shape block repeats, and `time_zone` is "REQUIRED with either" of the two members the sentence before names, which the presence grammar reads as REQUIRED with `daypart` or `frequency_cap.period`.
- **Keys added:** App identity (4 keys, a table parented by a bold label rather than a heading), § 5.2.2 `placement` (8, with a mapping column), `commitment.proposal_id` and `commitment.version`, and § 5.6.3 `requires` (3).
- **Value lists:** `environments` drops `audio_streaming`. New lists are `linked_execution`, the store platforms (twice), `0` \| `1` (three times), and `agreement_ref.type`. The `channel` and `environments` definition tables add 11 value definitions.
- **New layouts:** `key-required-meaning-mapping`, `value-condition`, and `value-distribution-device`, plus a second `key-meaning` table.

<!-- generated:lock-findings -->
**Findings:** 51 new findings, and 1 removed: `option_shape_missing:field:5.5:daypart`. 23 of the new findings have a verdict: 23 `accepted`. The 28 open additions, by kind: 2 `value_set_duplicate` (`0 | 1`, `android | fire_tv | ios | roku | samsung_tv`), 7 `unresolved_identifier` (`agreement`, `best_effort`, `full_url`, `has_requires`, `io`, `pre_serve`, `proposals[]`), 2 `array_suffix_mismatch` (`apps[]`, `exclusions_accepted.types`), 2 `expression_value_unknown` (`cost_method: flat`, `role: agreement`), 13 `must_without_field`, 1 `key_presence_unstated` (`table:5.6.3:1`), and 1 `unnumbered_heading` (`5.4/creative-inspection-and-previews`).
<!-- /generated:lock-findings -->
