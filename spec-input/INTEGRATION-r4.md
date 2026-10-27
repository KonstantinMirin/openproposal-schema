# OpenProposal integration branch, revision 4

`integration-r4`, a branch of a local OpenProposal clone,
applies the 14 open upstream PRs on top of `main`, each at its live head on
2026-10-26. It is rebuilt from `main` in the same merge order as
`integration-r3`, with #123 last. Since `integration-r3`, two PRs moved: their
author updated #117 and #118 on 2026-10-25. Nothing was pushed to `upstream`
or `fork`. The branches `integration`, `integration-final`, `integration-r2`,
and `integration-r3` are unchanged.

| | |
| :--- | :--- |
| Base | `main` = `44dfaaf618736219426c311ec997b6d37e94b950` (unchanged upstream) |
| Tip | `integration-r4` = `292bb51e654c2eef563d721eb6af8317371c906a` |
| Spec blob | `spec/openproposal-3.0.md` = `fdb303f07c669c21c0c1196e1c8e441790a62d3c` (53,316 bytes) |
| `examples/` tree | `37144b6616e5dc83a7aad9ecd03a205caf0ce5dc` |
| Appendix generator | `tools/regen_appendices.py`, sha256 `b39f5bb1c9d2606bc86599769ba6941135c403ff723ba17a9ee33da755631c97` (unchanged) |
| Previous integration | `integration-r3` = `707ccbb`, spec blob `966ffb70` |

## Summary

- **Two PRs moved.** #117 from `841c9c8` to `e51ee17`, and #118 from
  `8fde92c` to `395ca83`. The other 12 heads are unchanged.
- **SEMANTIC hunks: none.**
- **Merges 1 to 4 have the same trees as on `integration-r2`.** Merges 5 to
  10 differ from theirs only by #117's update. Each conflict in merges 6 to 10
  had the same hunks as before, and its file was taken from the
  corresponding `integration-r2` merge commit.
- **Merge 11 (#118) is now conflict-free.** #118 no longer adds the
  `creative-inspection` CI job, so the `.github/workflows/validate.yml` hunk of
  `INTEGRATION.md`, merge 11, hunk 1, is gone.
- **Merges 12 to 14 are as before, plus #118's update.** Merge 13 has the same
  4 hunks, and merge 14 the same 3, each resolved as before: the § 5.5 lead
  sentence union of `INTEGRATION-r3.md`, merge 14, hunk 1, and the
  regenerated Appendix B and distribution totals.
- **Edits outside a conflict hunk:** the same four as before. Merge 12 moves
  App identity above § 5.2.1. Merge 13 sets the rewarded-video example header
  to § 6.7. Merge 14 adds `time_zone: viewer_local` to the #70 and #120
  examples.
- **Cross-check.** The tip differs from `integration-r3` (`707ccbb`) by
  exactly the two PRs' updates: `git diff 707ccbb 292bb51` has the same file
  list and line counts as `git diff 841c9c8 e51ee17` plus
  `git diff 8fde92c 395ca83`.

## What the two updates change

**#117, `e51ee17` ("Clarify fee basis and allow zero-rate unit
commitments").** It changes only
`docs/proposals/pricing-commitment-arithmetic.md`,
`fixtures/pricing/cases.json`, and `scripts/check_pricing_fixtures.py`. The
specification is unchanged. The fixture check now has 60 vectors, up from 49.

**#118, `395ca83` ("Narrow creative inspection wording and separate fixture
tooling").** In the specification:

- § 5.4, "Creative inspection and previews": "MUST NOT send production
  impression, playback, click, viewability, verification or ad-error
  notifications" becomes "MUST NOT send any production notification".
- § 5.4: a new paragraph on landing pages. A URL in VAST `<ClickThrough>`
  doesn't make it safe to request, and "The inspector MUST NOT request a
  destination or redirect that sends a production notification; it MAY use a
  separate inspection URL or the receiving service's documented test mode".
- § 5.4: the two failure-reporting MUST sentences and the skipped-check MUST
  NOT become "Inspection failures MUST be reported through diagnostics,
  without firing a production VAST `<Error>` or `verificationNotExecuted`
  URL. An implementation MUST NOT report a check that was skipped or could not
  finish as passed." The sentence "This section does not waive any required
  checks." is gone.
- § 6.3: the two MUST sentences become "Inspecting this line item's VAST
  creative is subject to section 5.4.", with no keyword.

Outside the specification, #118 drops its fixture tooling:
`docs/creative-inspection-fixtures.md`, `fixtures/creative/`, the four
`scripts/*creative*` and preview scripts, and the `creative-inspection` job in
`.github/workflows/validate.yml`. The CTV example's closing comment becomes
"Inspecting this line item's VAST creative is subject to spec section 5.4.",
and the CHANGELOG entry drops "and executable synthetic fixtures".

## PR order and head SHAs

Every head matches upstream `pull/N/head`, checked with
`gh pr view N -R IABTechLab/OpenProposal --json headRefOid` on 2026-10-26.
All 14 PRs are open. Each merge is `git merge --no-ff` with the message
`Merge branch '<branch>' into integration-r4`. The local branches `pr-117` and
`pr-118` now point at the live heads; the earlier heads stay reachable from
`integration-r3`. `.git/info/attributes` sets `spec/CHANGELOG.md merge=union`,
so the CHANGELOG did not conflict.

| # | Branch | PR / issue | Head SHA | Merge commit | Compared with `integration-r2`/`-r3` | Spec blob |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | `pr-17` | PR #17 (issue #15) | `dc0e37c8890b1ad6f197fd4a9418b7b231fab454` | `c332a7c` | same tree as `e5f1d80` | `927ad3bb` |
| 2 | `pr-18` | PR #18 (issue #16) | `ff53dc5a7d436ac42995f9842394369901e9eb70` | `f0aa306` | same tree as `3375217` | `bc7e1720` |
| 3 | `pr-70` | PR #70 (issue #23) | `ecec3d74f484dbb4ea4404fb7fe847cbbd94aafe` | `af8dbd7` | same tree as `9fea02a` | `f0792757` |
| 4 | `pr-73` | PR #73 (issue #24) | `74a25448baf9e38048a5bd417b4372d46faaa77f` | `1e74e8c` | same tree as `82c6620` | `2d03b32a` |
| 5 | `pr-117` | PR #117 | **`e51ee17d2c74d166dd75c3da29698de4e8a998fa`** (was `841c9c8`) | `86cc272` | `c1a9a90` plus #117's update | `2d03b32a` |
| 6 | `pr-71` | PR #71 (issue #25) | `63712c0683b1f67e032450f7400979be60b5cde4` | `24e3f0e` | `a0918db` plus #117's update | `4ad921d5` |
| 7 | `pr-72` | PR #72 (issue #14) | `208f0c2c2aa1fe7551b2adbcc2489ed649ca70b7` | `ca0a7e9` | `5ca6a07` plus #117's update | `f9646d65` |
| 8 | `pr-74` | PR #74 (issue #26) | `7a8938579c6339b3c397ab6e40d2b47e1860e195` | `679e9ca` | `9eed3e8` plus #117's update | `62e3a66d` |
| 9 | `pr-75` | PR #75 (issue #27) | `b88e9a0719180303917efdf59d20ba1769172d27` | `4e92626` | `778f772` plus #117's update | `fee618bb` |
| 10 | `pr-76` | PR #76 (issue #29) | `8e1f614a5c0546e88d993ed239ffcdc71b395a78` | `7e4f4f4` | `2055a1f` plus #117's update | `365619a3` |
| 11 | `pr-118` | PR #118 (issue #42) | **`395ca8357533843450083d1676b6cc6cab2c87c0`** (was `8fde92c`) | `a3320b1` | `097caf2` plus both updates | `16fe7fbf` |
| 12 | `pr-119` | PR #119 (issue #90) | `0125d5549c4cc1790bd3ab847e8d5826b66de82d` | `be26b1e` | `7357dca` plus both updates | `48905a01` |
| 13 | `pr-120` | PR #120 (issue #89) | `81de4d827440cc42d8e027d5f88843e8da109bdd` | `4619705` | `4dc9f6c` plus both updates | `869368a1` |
| 14 | `daypart-clock` | PR #123 (refs #111, #58) | `9783ec87d102ccb60c106f4b6782650aa1f0a249` | `292bb51` | `707ccbb` plus both updates | `fdb303f0` |

"Plus #117's update" means that `git diff <old merge> <new merge>` is exactly
`git diff 841c9c8 e51ee17`. "Plus both updates" adds `git diff 8fde92c
395ca83`.

## Appendix regeneration

The policy is the same as in `INTEGRATION.md`. For a conflict inside Appendix
B or the distribution figures, the merge took HEAD's side, and then
`tools/regen_appendices.py` rebuilt both appendices and the "What the
distribution says" figures from the body tables. #118's update touches no
field table, so the appendices are as on `integration-r3`. The spec at every
one of the 14 merge commits is a fixed point of `regen_appendices.py
--check`, and `regen_appendices.py` on the tip reports "already up to date".

## New conflict hunks

None. Against the earlier revisions:

| Merge | Before | Now |
| :--- | :--- | :--- |
| 6 to 10 | 2, 4, 3, 3, and 1 hunks, as in `INTEGRATION.md` | The same hunks in the same files, each file taken from the `integration-r2` merge commit. #117's update touches none of those files |
| 11 (#118) | 1 hunk, `.github/workflows/validate.yml`: kept both the `pricing-fixtures` (#117) and the `creative-inspection` (#118) jobs | **No conflict.** #118 adds no job, so only `pricing-fixtures` follows `appendix-drift` |
| 12 (#119) | No conflict | No conflict |
| 13 (#120) | 4 hunks in the spec, as in `INTEGRATION-r2.md` | The same 4 hunks, resolved as before: the spec is `4dc9f6c`'s with #118's update applied |
| 14 (#123) | 3 hunks in the spec, as in `INTEGRATION-r3.md` | The same 3 hunks, resolved as before, including the § 5.5 lead sentence union: the spec is `707ccbb`'s with #118's update applied |

#118's update lands outside every conflict hunk: § 5.4 and § 6.3 conflict
with no other PR. In merges 13 and 14, the resolved spec was written as the
earlier merge's resolved spec with the four changed blocks of `git diff
8fde92c 395ca83 -- spec/openproposal-3.0.md` applied, and the diff against
the earlier merge then equals that update line for line.

**Edits outside a conflict hunk.** The same as before, each in its merge
commit, and each MECHANICAL:

- Merge 12: #17's **App identity** block moves back to directly under the
  § 5.2 table, above #119's `#### 5.2.1 environments`, as in
  `INTEGRATION-r2.md`.
- Merge 13: the `examples/line-item-rewarded-video.yaml` header is
  `(spec § 6.7)`, as in `INTEGRATION-r2.md`.
- Merge 14: `time_zone: viewer_local` directly under `frequency_cap` in
  `examples/line-item-ctv-bonus.yaml` (#70) and
  `examples/line-item-rewarded-video.yaml` (#120), as in
  `INTEGRATION-r3.md`.

`examples/line-item-ctv.yaml` merged cleanly in every merge: it carries #73's
`proposal_id` and `version`, #120's `placement`, #123's `time_zone`, and
#118's new closing comment.

## Renumbering

None beyond `INTEGRATION.md` and `INTEGRATION-r2.md`: § 6.6 Publication
manifest, § 5.2.2 placement, and § 6.7 Rewarded video line item.

## Check results

These ran on the tip (`292bb51`).

| Check | Source | Result |
| :--- | :--- | :--- |
| `tools/regen_appendices.py --check` | integration tooling | pass at all 14 merges |
| `python3 scripts/check_appendix.py` | `main` | pass: 78 fields, markers agree |
| `python3 scripts/check_pricing_fixtures.py` | #117 | 60/60 vectors pass |
| `examples/*.yaml` and `examples/manifest.json` parse | `main` and extra | pass: 6 YAML examples, `manifest.json` |
| `.github/workflows/validate.yml` parses | extra | pass: jobs `Examples parse`, `Issue forms parse`, `Appendix A matches the body`, `Pricing discussion fixtures` |
| No conflict markers in tracked files | extra | pass |

`scripts/check_creative_fixtures.py` and `scripts/check_preview_observations.mjs`
no longer exist: #118's update removes them.

## Problems the PRs still cause together

The list in `INTEGRATION-final.md` ("Problems the final branches still cause
together") applies, apart from the § 5.5 intro wording, which
`INTEGRATION-r3.md` resolves. #118's update adds none. Its § 6.3 sentence now
only points to § 5.4, so the CTV example no longer restates the inspection
requirements, and its new landing-page MUST NOT names no field, as the § 5.4
statements before it don't.

Updated 2026-10-26: first version.
