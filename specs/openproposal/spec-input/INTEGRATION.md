# OpenProposal integration branch

`integration`, a branch of a local OpenProposal clone,
applies every open upstream PR, plus our two draft PRs, on top of `main`. It is
the input to the schema-extraction pipeline. Nothing was pushed.

| | |
| :--- | :--- |
| Base | `main` = `44dfaaf618736219426c311ec997b6d37e94b950` (spec blob `694095837432671ac8103e3c7be9b1c03d8a9482`) |
| Tip | `integration` = `beed0ff95a9e266c478a5424f73ef37b0c29354d` |
| Spec blob | `spec/openproposal-3.0.md` = `340a8eab5eb8ba61bdd6cba23142759a836acf30` (also in `integration-spec.sha`) |
| Appendix generator | `tools/regen_appendices.py` (sha256 `b39f5bb1c9d2606bc86599769ba6941135c403ff723ba17a9ee33da755631c97`) |

## Resolution summary

- **SEMANTIC hunks: none.** Every edit that touched the same sentence or row
  as another PR had a coherent union, so no hunk took the later PR's text over
  the earlier one.
- Four hunks needed a union written by hand, after reading both PRs' intent:
  merge 7 hunks 1 and 2, merge 12 hunk 1, and merge 13 hunk 1. Each one only
  combines both PRs' words, but review these first.
- Two edits were made outside a conflict hunk: merge 12 (5.2 block order) and
  merge 13 (cross-reference updates).

## PR order and head SHAs

Merges 1 to 5 were already on `integration` when this work started, and all
of them were clean. Every `pr-N` head matches upstream `pull/N/head`, checked
with `gh pr view N -R IABTechLab/OpenProposal`. Those 11 are exactly the open
upstream PRs. The last two branches are our local drafts for issues #90 and #89.

| # | Branch | PR / issue | Head SHA | Merge commit | Spec blob after merge | Appendix A rows |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | `pr-17` | PR #17 (issue #15) | `dc0e37c8890b1ad6f197fd4a9418b7b231fab454` | `aabfb55` | `927ad3bb` | 71 |
| 2 | `pr-18` | PR #18 (issue #16) | `ff53dc5a7d436ac42995f9842394369901e9eb70` | `7653fc5` | `bc7e1720` | 71 |
| 3 | `pr-70` | PR #70 (issue #23) | `ecec3d74f484dbb4ea4404fb7fe847cbbd94aafe` | `e9593dc` | `f0792757` | 73 |
| 4 | `pr-73` | PR #73 (issue #24) | `74a25448baf9e38048a5bd417b4372d46faaa77f` | `769ef5f` | `2d03b32a` | 73 |
| 5 | `pr-117` | PR #117 | `841c9c8eead273f5541722f9ccf09d572db4fa31` | `f0d040b` | `2d03b32a` | 73 |
| 6 | `pr-71` | PR #71 (issue #25) | `63712c0683b1f67e032450f7400979be60b5cde4` | `12b8e64` | `4ad921d5` | 75 |
| 7 | `pr-72` | PR #72 (issue #14) | `208f0c2c2aa1fe7551b2adbcc2489ed649ca70b7` | `3a5be69` | `f9646d65` | 75 |
| 8 | `pr-74` | PR #74 (issue #26) | `7a8938579c6339b3c397ab6e40d2b47e1860e195` | `8376758` | `62e3a66d` | 76 |
| 9 | `pr-75` | PR #75 (issue #27) | `b88e9a0719180303917efdf59d20ba1769172d27` | `01f442f` | `fee618bb` | 78 |
| 10 | `pr-76` | PR #76 (issue #29) | `8e1f614a5c0546e88d993ed239ffcdc71b395a78` | `54ed8bd` | `365619a3` | 78 |
| 11 | `pr-118` | PR #118 (issue #42) | `8fde92cefc82e806c71889fe0468032f6943d314` | `59dd150` | `632e30e7` | 78 |
| 12 | `channel-environment-definitions` | our draft for issue #90 | `49ad2e29af93db6e0fefd91db53bbda0b30281b1` | `e85ed7d` | `f9d4e9ee` | 78 |
| 13 | `impression-placement-attributes` | our draft for issue #89 | `0bc3f7e05240fab93e6dcf9ee180df264602d35f` | `beed0ff` | `340a8eab` | 79 |

Every merge is `git merge --no-ff`, with the default message
`Merge branch '<branch>' into integration`. `.git/info/attributes` sets
`spec/CHANGELOG.md merge=union`, so the CHANGELOG never conflicted. I checked
after each merge that the union kept one entry per PR, all under
`[Unreleased]`.

## Appendix regeneration

Appendix A and Appendix B were never merged by hand. For a conflict inside
them, the merge took HEAD's side, then `tools/regen_appendices.py` rebuilt
both appendices from the body tables:

- Appendix A rows, in document order.
- Appendix B per-marker counts and field lists, in document order. A field
  name declared twice gets an owner suffix, as in "`status` (proposal)" and
  "`status` (line item)".
- The figures in "What the distribution says". Only the numbers change; the
  prose and its line breaks are kept.

Its parsing rules mirror `scripts/check_appendix.py`. Run it as
`regen_appendices.py [SPEC]` to rewrite the file, or with `--check` to verify
without writing.

**Idempotency proof (done before any merge):**

- On `main`, the output is byte-identical to the input (blob `6940958`,
  29,693 bytes).
- The same holds on `integration` as handed over, and on all 8 branch tips
  still to merge, so every PR author's hand-maintained appendices agree with
  the generator.
- On a corrupted copy of `main`, the generator restored it byte for byte: one
  Appendix A row was deleted, one count, two totals and one field-list order
  were altered.
- After the work, I ran `--check` against the spec at all 13 merge commits.
  Every one is a fixed point.

## Conflict hunks

"Took HEAD" inside an appendix is arbitrary by policy, because the
regeneration overwrites it.

### Merge 6: pr-71 (`12b8e64`)

| Hunk | File / location | Resolution | Class |
| :--- | :--- | :--- | :--- |
| 1 | spec, Appendix B `seller-set` row | Took HEAD, then regenerated: `seller-set` 31 to 32 (adds `exclusions_accepted`) | MECHANICAL |
| 2 | spec, "What the distribution says" totals | Took HEAD, then regenerated: 73 to 75 fields, buyer-touched 23 to 24, `supplied` 3 to 4, without a round trip 20 to 21 | MECHANICAL |

### Merge 7: pr-72 (`3a5be69`)

| Hunk | File / location | Resolution | Class |
| :--- | :--- | :--- | :--- |
| 1 | spec, § 3.3 Re-computation, first sentence | Both rewrote one sentence: #71 adds `exclusions` as a recompute input, #72 adds `geo` where it is selectable. I wrote the union: "Because audiences, properties, formats and, where it is selectable, `geo` are `selectable`, and buyer `exclusions` (§ 5.5) narrow delivery, `addressable_scale` and `availability` MUST be recomputed against the buyer's actual selection and exclusions." This is a hand-written union. | MECHANICAL |
| 2 | spec, § 5.5 intro | Each PR appends its own sentence after "`seller-set`.". I kept both, in PR order (#71, then #72). Wording nit: #71's "are the exception" now sits next to a second exception, `geo`. | MECHANICAL |
| 3 | spec, Appendix B rows (`seller-set` through `supplied`) | Took HEAD, then regenerated: `selectable` 12 to 13, `settable` 5 to 4 (`geo` moves) | MECHANICAL |
| 4 | spec, distribution totals | Took HEAD, then regenerated: 75 fields, 13 `selectable`, 4 `settable` | MECHANICAL |

Git merged #71's "Block lists" block and #72's "Market-priced lines" block
after the § 5.5 table without a conflict, already in PR order.

### Merge 8: pr-74 (`8376758`)

| Hunk | File / location | Resolution | Class |
| :--- | :--- | :--- | :--- |
| 1 | `examples/proposal.yaml`, after `type:` | Both add one top-level key. I kept both in PR order: `linked_execution` (#70), then `proposal_template_id` (#74). Parses, with no duplicate keys. | MECHANICAL |
| 2 | spec, Appendix B rows | Took HEAD, then regenerated: `immutable` 6 to 7 | MECHANICAL |
| 3 | spec, distribution totals | Took HEAD, then regenerated: 76 fields | MECHANICAL |

Git merged #74's 4.1 bullets after #70's `linked_execution` row without a
conflict.

### Merge 9: pr-75 (`01f442f`)

| Hunk | File / location | Resolution | Class |
| :--- | :--- | :--- | :--- |
| 1 | spec, end of § 7 | Both add a non-normative note at the same place. I kept both in PR order: "Templates and issued proposals" (#74), then "Relationships, agreements and IOs" (#75). This is what #75's description asks for. | MECHANICAL |
| 2 | spec, Appendix B rows | Took HEAD, then regenerated: `seller-set` 32 to 34 (`terms_ref`, `agreement_ref`) | MECHANICAL |
| 3 | spec, distribution totals | Took HEAD, then regenerated: 78 fields, 54 not buyer-touched | MECHANICAL |

Clean auto-merge, left as git produced it: in § 5.8, #75's sentence
"`terms_ref` MUST be hash-pinned and frozen at `agreed`." comes directly after
the table, ahead of #71's `exclusions` non-disclosure paragraph. Both stay in
§ 5.8.

### Merge 10: pr-76 (`54ed8bd`)

| Hunk | File / location | Resolution | Class |
| :--- | :--- | :--- | :--- |
| 1 | spec, § 6, two `### 6.5` headings | Kept both. "6.5 Bonus line item" (#70, merged earlier) stays 6.5; "Publication manifest" (#76) becomes **6.6**. | MECHANICAL |

There are no appendix conflicts, because § 2.3 adds no field table.

### Merge 11: pr-118 (`59dd150`)

| Hunk | File / location | Resolution | Class |
| :--- | :--- | :--- | :--- |
| 1 | `.github/workflows/validate.yml`, job key and name after `appendix-drift` | Kept both jobs: `pricing-fixtures` (#117), then `creative-inspection` (#118) | MECHANICAL |
| 2 | `.github/workflows/validate.yml`, job steps | Kept each job's own steps. Jobs are now `examples`, `issue-forms`, `appendix-drift`, `pricing-fixtures`, `creative-inspection`. | MECHANICAL |

The spec merged cleanly.

### Merge 12: channel-environment-definitions (`e85ed7d`)

| Hunk | File / location | Resolution | Class |
| :--- | :--- | :--- | :--- |
| 1 | spec, § 2.1 Summary Representation key list | Both edited the list: #70 appends `has_requires`; #90 inserts `environments.available[]` and rewraps. I wrote the union, with #90's wrapping and ending in "`transaction_mechanism` · `has_requires`". This is a hand-written union. | MECHANICAL |

**Edit outside a conflict hunk.** Git merged § 5.2 cleanly but placed `#### 5.2.1 environments` (#90) above #17's **App identity** block, so App identity read as part of 5.2.1. Under the PR-order rule (#17 before #90), I moved App identity back above 5.2.1, where it belongs in § 5.2 proper. MECHANICAL.

There are no appendix conflicts, because the counts are unchanged.

### Merge 13: impression-placement-attributes (`beed0ff`)

| Hunk | File / location | Resolution | Class |
| :--- | :--- | :--- | :--- |
| 1 | spec, § 2.1 Summary Representation key list | Union of HEAD (#70 and #90) and #89's "and, when present, `placement.reward` · `placement.instl` · `placement.plcmt` · `placement.skip`", rewrapped to 80 columns. This is a hand-written union. | MECHANICAL |
| 2 | spec, § 5.2 table and subsections | #89 did not change the `environments` row; it conflicts only because the lines are adjacent, so #90's row stands. #89's `placement` row follows it. Subsection order: App identity, then `5.2.1 environments` (#90), then `#### 5.2.1 placement` (#89), **renumbered to 5.2.2**. | MECHANICAL |
| 3 | spec, § 6, a third `### 6.5` | Kept all. "Rewarded video line item" (#89) becomes **6.7**, after 6.5 Bonus and 6.6 Publication manifest. | MECHANICAL |
| 4 | spec, Appendix B rows | Took HEAD, then regenerated: `seller-set` 34 to 35 (`placement`) | MECHANICAL |
| 5 | spec, distribution totals | Took HEAD, then regenerated: 79 fields, 24 buyer-touched, 55 other, 21 without a round trip | MECHANICAL |

## Renumbering

| Merge | Old | New | Cross-references updated |
| :--- | :--- | :--- | :--- |
| 10 (pr-76) | § 6.5 Publication manifest | **§ 6.6** | None needed. No file referred to it by number; `manifest.json` has no header comment. |
| 13 (#89 draft) | § 5.2.1 placement | **§ 5.2.2** | spec § 5.2 `placement` row, "See 5.2.1" to "See 5.2.2"; `examples/line-item-ctv.yaml` line 14 comment, `(§ 5.2.1)` to `(§ 5.2.2)`; `examples/line-item-rewarded-video.yaml` line 9 comment, same change |
| 13 (#89 draft) | § 6.5 Rewarded video line item | **§ 6.7** | `examples/line-item-rewarded-video.yaml` header, `(spec § 6.5)` to `(spec § 6.7)` |

The remaining § 5.2.1 references (the `environments` row, and "Device types
are as in 5.1.1" inside 5.2.1) point to #90's sections, which kept their
numbers. A repo-wide search, excluding `fixtures/`, finds no other `5.2.1` or
`6.5` section reference.

Final § 5 and § 6 outline:

- § 5.1 Identity, with § 5.1.1 channel.
- § 5.2 Inventory composition, with § 5.2.1 environments and § 5.2.2
  placement.
- § 5.3 to § 5.10.
- § 6.1 Proposal, § 6.2 Display, § 6.3 CTV, § 6.4 Audio, § 6.5 Bonus line
  item, § 6.6 Publication manifest, § 6.7 Rewarded video line item.

## Check results

These checks ran after every merge, before its commit (merges 6 to 13), and
again on the final committed tree:

| Check | Source | Result at every merge and on the final tree |
| :--- | :--- | :--- |
| `tools/regen_appendices.py --check` | this work | pass (spec is a fixed point) |
| `python3 scripts/check_appendix.py` | `main` | pass. Unique field keys: 73, 73, 74, 76, 76, 76, 76, 77 across merges 6 to 13. This is Appendix A rows minus the combined `valid_from` · `valid_until` row and the second `status`. |
| `python3 scripts/check_pricing_fixtures.py` | #117 | 49/49 vectors pass |
| `python3 scripts/check_creative_fixtures.py` | #118 | 41/41 cases pass (merges 11 to 13; uses a 127.0.0.1 server only) |
| `node scripts/check_preview_observations.mjs` | #118 | 10/10 assertions pass (merges 11 to 13) |
| validate.yml "Examples parse" (`yaml.safe_load` on `examples/*.yaml`) | `main` | pass. The final tree has 6 files, including the new `line-item-rewarded-video.yaml`. |
| validate.yml "Issue forms parse" | `main` | pass |
| `validate.yml` itself parses | extra | pass |
| `examples/*.json` parse | extra | pass (`manifest.json`) |
| No duplicate mapping keys in `examples/*.yaml` | extra; `safe_load` accepts duplicates silently | pass |
| No conflict markers in tracked files | extra | pass |

`node scripts/check_creative_preview.mjs` (#118) is not in CI. It drives
headless Chrome against loopback traps only, with no external network:

- At merge 11 and on the final tree, it reported **27/27 synthetic browser
  cases pass** (Chrome 155.0.8059.85).
- It is flaky: over 8 runs, 5 passed 27/27 and 3 crashed before reporting,
  with an unhandled `ECONNRESET` on a loopback socket.
- No case ever reported FAIL.
- The script and its fixtures are byte-identical to the `pr-118` tip, so the
  flakiness comes from #118's harness, not from the integration.

## Cross-PR findings with no textual conflict (left unresolved)

These came out of the combined tree. Fixing them would mean inventing example
data or changing a PR's normative text, which the policy does not cover. The
owning PRs should resolve them.

1. **`examples/line-item-ctv-bonus.yaml` (#70)** breaks two rules from other
   PRs:
   - Property `weather-app` has no `domains` or `apps`, which breaks #17's
     "Each property MUST carry `domains`, `apps` or both".
   - It is CTV in-stream video with no `placement.plcmt`, which breaks #89's
     "`plcmt` is REQUIRED for video ads".
2. **`examples/line-item-rewarded-video.yaml` (#89).** Property `puzzle-pack`
   has no `domains` or `apps`, which breaks #17's MUST. #89's description
   notes it uses the pre-#17 shape.
3. **`examples/manifest.json` (#76)** has the Summary Representation keys from
   before #70, #89 and #90. It lacks:
   - `has_requires` and `linked_execution` (#70);
   - `environments.available[]` (#90);
   - `placement.plcmt` and `placement.skip` on the CTV entry (#89).

   It is JSON, so validate.yml does not check it.
4. **§ 5.4 has an unnumbered heading.** #118 adds `#### Creative inspection
   and previews` with no number. An extractor keyed on section numbers will
   fold it into § 5.4. `check_appendix.py` ignores rows under unnumbered
   headings; that section has no field table, so nothing is lost.
5. **`docs/open-questions.md` OQ-7** still lists `audio_streaming`, which #90
   removes. #90's description already notes this.
6. **#71's CTV example change is still pending.** #71 deferred it until #17
   landed, and both are now in, but #71's head does not include the change.
