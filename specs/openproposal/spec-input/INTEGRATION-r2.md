# OpenProposal integration branch, revision 2

`integration-r2`, a branch of a local OpenProposal clone,
applies the 13 open upstream PRs on top of `main`. Since the first integration
(`INTEGRATION.md`), our two local branches have been posted as PR #119 (issue
#90) and PR #120 (issue #89). This revision merges them at their posted heads.
Nothing was pushed to `upstream` or `fork`. The branches `integration`
(`beed0ff`) and `integration-final` (`ea2bb7d`) are unchanged.

| | |
| :--- | :--- |
| Base | `main` = `44dfaaf618736219426c311ec997b6d37e94b950` |
| Tip | `integration-r2` = `4dc9f6c2bc5c28b1e8990833f8a7695501b52976` |
| Spec blob | `spec/openproposal-3.0.md` = `bb94f96332ba094056ba669b05683e316f773b72` (51,689 bytes) |
| `examples/` tree | `727b6e6f7c03549a338b8d3218563e58f24ce65f` |
| Appendix generator | `tools/regen_appendices.py`, sha256 `b39f5bb1c9d2606bc86599769ba6941135c403ff723ba17a9ee33da755631c97` (unchanged) |
| Previous integration | `integration` = `beed0ff`, spec blob `340a8eab` |

## Summary

- **SEMANTIC hunks: none.** Every conflict had a coherent union, in PR order.
- **Merges 1 to 11 match the first integration exactly.** Each merge commit
  has the same tree as the corresponding merge on `integration`. Where a merge
  conflicted, the resolved files were taken from that earlier merge commit, so
  the resolutions in `INTEGRATION.md` apply unchanged. The conflict counts
  matched: merge 6 had 2 hunks, merge 7 had 4, merge 8 had 3, merge 9 had 3,
  merge 10 had 1 and merge 11 had 2.
- **Merge 12 (#119) is conflict-free.** The § 2.1 hand-written union from the
  first integration is not needed any more.
- **Merge 13 (#120) has 4 conflict hunks**, none in § 2.1. The § 2.1
  hand-written union from the first integration is not needed any more.
- **Hand-written union left to review:** merge 7, hunks 1 and 2 (§ 3.3 and
  § 5.5 intro), carried over unchanged.
- **Edits outside a conflict hunk:** two. In merge 12, App identity moves
  above § 5.2.1. In merge 13, the rewarded-video example header changes to
  § 6.7.
- **Cross-check.** The tip has the same tree as `integration-final`
  (`ea2bb7d`, tree `e2c5d04f`), which was built from the same heads in an
  earlier session.

## PR order and head SHAs

Every head matches upstream `pull/N/head`, checked with
`gh pr view N -R IABTechLab/OpenProposal` and `git ls-remote upstream`. All 13
PRs are open. Each merge is `git merge --no-ff` with the message
`Merge branch '<branch>' into integration-r2`. The local branches `pr-119` and
`pr-120` point at the posted heads, which are also the tips of
`channel-environment-definitions` and `impression-placement-attributes`.
`.git/info/attributes` sets `spec/CHANGELOG.md merge=union`, so the CHANGELOG
did not conflict.

| # | Branch | PR / issue | Head SHA | Merge commit | Same tree as `integration` merge | Spec blob |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | `pr-17` | PR #17 (issue #15) | `dc0e37c8890b1ad6f197fd4a9418b7b231fab454` | `e5f1d80` | yes (`aabfb55`) | `927ad3bb` |
| 2 | `pr-18` | PR #18 (issue #16) | `ff53dc5a7d436ac42995f9842394369901e9eb70` | `3375217` | yes (`7653fc5`) | `bc7e1720` |
| 3 | `pr-70` | PR #70 (issue #23) | `ecec3d74f484dbb4ea4404fb7fe847cbbd94aafe` | `9fea02a` | yes (`e9593dc`) | `f0792757` |
| 4 | `pr-73` | PR #73 (issue #24) | `74a25448baf9e38048a5bd417b4372d46faaa77f` | `82c6620` | yes (`769ef5f`) | `2d03b32a` |
| 5 | `pr-117` | PR #117 | `841c9c8eead273f5541722f9ccf09d572db4fa31` | `c1a9a90` | yes (`f0d040b`) | `2d03b32a` |
| 6 | `pr-71` | PR #71 (issue #25) | `63712c0683b1f67e032450f7400979be60b5cde4` | `a0918db` | yes (`12b8e64`) | `4ad921d5` |
| 7 | `pr-72` | PR #72 (issue #14) | `208f0c2c2aa1fe7551b2adbcc2489ed649ca70b7` | `5ca6a07` | yes (`3a5be69`) | `f9646d65` |
| 8 | `pr-74` | PR #74 (issue #26) | `7a8938579c6339b3c397ab6e40d2b47e1860e195` | `9eed3e8` | yes (`8376758`) | `62e3a66d` |
| 9 | `pr-75` | PR #75 (issue #27) | `b88e9a0719180303917efdf59d20ba1769172d27` | `778f772` | yes (`01f442f`) | `fee618bb` |
| 10 | `pr-76` | PR #76 (issue #29) | `8e1f614a5c0546e88d993ed239ffcdc71b395a78` | `2055a1f` | yes (`54ed8bd`) | `365619a3` |
| 11 | `pr-118` | PR #118 (issue #42) | `8fde92cefc82e806c71889fe0468032f6943d314` | `097caf2` | yes (`59dd150`) | `632e30e7` |
| 12 | `pr-119` | PR #119 (issue #90) | `0125d5549c4cc1790bd3ab847e8d5826b66de82d` | `7357dca` | no: new head | `4f716c55` |
| 13 | `pr-120` | PR #120 (issue #89) | `81de4d827440cc42d8e027d5f88843e8da109bdd` | `4dc9f6c` | no: new head | `bb94f963` |

## Appendix regeneration

The policy is the same as in `INTEGRATION.md`. Appendix A and B were never
merged by hand. For a conflict inside them, the merge took HEAD's side, and
then `tools/regen_appendices.py` rebuilt both appendices and the "What the
distribution says" figures from the body tables. The spec at every one of the
13 merge commits is a fixed point of `regen_appendices.py --check`.

## New conflict hunks

Merges 1 to 11 are as recorded in `INTEGRATION.md`.

### Merge 12: pr-119 (`7357dca`)

No conflict hunks. Against the first integration's merge 12:

- The § 2.1 key list merged cleanly, because #119 inserts
  `environments.available[]` without rewrapping the line #70 extends.
- `docs/open-questions.md` OQ-7 now comes from #119 and no longer lists
  `audio_streaming`.

**Edit outside a conflict hunk.** As before, git put #119's `#### 5.2.1
environments` above #17's **App identity** block, so App identity read as part
of § 5.2.1. Under the PR-order rule (#17 before #119), App identity moved back
to directly under the § 5.2 table, above § 5.2.1. The edit is in the merge
commit. MECHANICAL.

### Merge 13: pr-120 (`4dc9f6c`)

| Hunk | File / location | Resolution | Class |
| :--- | :--- | :--- | :--- |
| 1 | spec, § 5.2 table and subsections | HEAD's `environments` row (#119) stands; #120 did not change that row, and it conflicted only because the lines are adjacent. #120's `placement` row follows it, with "See 5.2.1" changed to "See 5.2.2". Subsection order: App identity, then `5.2.1 environments` (#119), then #120's `#### 5.2.1 placement`, **renumbered to 5.2.2**. #120's body text, including its new value-type and matching sentences, is unchanged. | MECHANICAL |
| 2 | spec, § 6, a third `### 6.5` | Kept all three. "Rewarded video line item" (#120) becomes **6.7**, after 6.5 Bonus line item (#70) and 6.6 Publication manifest (#76) | MECHANICAL |
| 3 | spec, Appendix B rows | Took HEAD, then regenerated: `seller-set` 34 to 35 (`placement`) | MECHANICAL |
| 4 | spec, distribution totals | Took HEAD, then regenerated: 79 fields, 24 buyer-touched, 55 other | MECHANICAL |

§ 2.1 merged cleanly: #120's summary rule is its own MUST sentence after the
`catalog_ref` rule, and #119's `environments.available[]` stays in the key
list. `examples/line-item-ctv.yaml` merged cleanly to
`placement: { plcmt: 1 }   # Instream (1) (§ 5.2)`.

**Edit outside a conflict hunk.** The `examples/line-item-rewarded-video.yaml`
header changed from `(spec § 6.5)` to `(spec § 6.7)`. The edit is in the merge
commit. MECHANICAL.

## Renumbering

| Merge | Old | New | Cross-references updated |
| :--- | :--- | :--- | :--- |
| 10 (pr-76) | § 6.5 Publication manifest | **§ 6.6** | None needed |
| 13 (pr-120) | § 5.2.1 placement | **§ 5.2.2** | spec § 5.2 `placement` row, "See 5.2.1" to "See 5.2.2". #120's example comments cite § 5.2, so they need no change |
| 13 (pr-120) | § 6.5 Rewarded video line item | **§ 6.7** | `examples/line-item-rewarded-video.yaml` header |

## Check results

These ran on the final tree (`4dc9f6c`). The appendix check also ran at every
merge commit.

| Check | Source | Result |
| :--- | :--- | :--- |
| `tools/regen_appendices.py --check` | integration tooling | pass at all 13 merges |
| `python3 scripts/check_appendix.py` | `main` | pass: 77 fields, markers agree |
| `python3 scripts/check_pricing_fixtures.py` | #117 | 49/49 vectors pass |
| `python3 scripts/check_creative_fixtures.py` | #118 | 41/41 cases pass (127.0.0.1 server only) |
| `node scripts/check_preview_observations.mjs` | #118 | 10/10 assertions pass |
| `examples/*.yaml`, `examples/*.json`, issue forms and `validate.yml` parse | `main` and extra | pass: 6 YAML examples, `manifest.json` |
| No conflict markers in tracked files | extra | pass |

## Problems the PRs still cause together

The tree is the same as `integration-final`, so the list in
`INTEGRATION-final.md` ("Problems the final branches still cause together")
applies unchanged: the #70 bonus example against #17 and #120, the #120
rewarded-video example against #17, the #76 manifest's pre-merge summary keys,
the two unnumbered headings in § 5.2 and § 5.4, #71's pending CTV example
change, and the § 5.5 intro wording.

Updated 2026-10-25: first version.
