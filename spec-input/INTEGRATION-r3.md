# OpenProposal integration branch, revision 3

`integration-r3`, a branch of a local OpenProposal clone,
applies the 14 open upstream PRs on top of `main`. It starts from
`integration-r2` (`4dc9f6c`, merges 1 to 13, recorded in `INTEGRATION.md` and
`INTEGRATION-r2.md`) and merges PR #123 last. Nothing was pushed to `upstream`
or `fork`. The branches `integration`, `integration-final`, and
`integration-r2` are unchanged.

| | |
| :--- | :--- |
| Base | `main` = `44dfaaf618736219426c311ec997b6d37e94b950` |
| Tip | `integration-r3` = `707ccbbeb577f019cd9de7e3c213459025f2e24d`, rebuilt with #123 at `9783ec8` (see [Rebuild with #123 at 9783ec8](#rebuild-with-123-at-9783ec8)); the first build, `5319533`, is kept as `integration-r3-97a5b10` |
| Spec blob | `spec/openproposal-3.0.md` = `966ffb70a25e5ef2cbc8f7d82be9570439df411d` (53,176 bytes); the first build's was `281b9384` (53,105 bytes) |
| `examples/` tree | `cdec5662843d16b84416725227773fe914173b81` |
| Appendix generator | `tools/regen_appendices.py`, sha256 `b39f5bb1c9d2606bc86599769ba6941135c403ff723ba17a9ee33da755631c97` (unchanged) |
| Previous integration | `integration-r2` = `4dc9f6c`, spec blob `bb94f963` |

## Summary

- **SEMANTIC hunks: none.** Every conflict had a coherent union, in PR order.
- **Merges 1 to 13 are `integration-r2`**, unchanged.
- **Merge 14 (#123) has 3 conflict hunks**, all in
  `spec/openproposal-3.0.md`: the § 5.5 lead sentence, the Appendix B rows,
  and the distribution totals.
- **Hand-written union left to review:** merge 14, hunk 1 (§ 5.5 lead
  sentence). It also removes the wording nit that `INTEGRATION.md` records for
  merge 7, hunk 2, where "are the exception" sat next to a second exception.
- **Edits outside a conflict hunk:** two, both in merge 14. The #70 and #120
  line-item examples gain `time_zone: viewer_local`.

## PR order and head SHAs

The head matches upstream `pull/123/head`, checked with
`gh pr view 123 -R IABTechLab/OpenProposal` and `git fetch upstream
pull/123/head`. PR #123 is open. Its branch is `daypart-clock` on the fork
`KonstantinMirin/OpenProposal`. The merge is `git merge --no-ff` with the
message `Merge branch 'daypart-clock' into integration-r3`.
`.git/info/attributes` sets `spec/CHANGELOG.md merge=union`, so the CHANGELOG
did not conflict: #123's entry follows #120's.

| # | Branch | PR / issue | Head SHA | Merge commit | Spec blob |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 to 13 | as in `INTEGRATION-r2.md` | | | `4dc9f6c` | `bb94f963` |
| 14 | `daypart-clock` | PR #123 (refs #111, #58) | `97a5b10fc893e3d6d74d174cb64518b70cad9d89` | `5319533` | `281b9384` |

## Appendix regeneration

The policy is the same as in `INTEGRATION.md`. For a conflict inside Appendix
B or the distribution figures, the merge took HEAD's side, and then
`tools/regen_appendices.py` rebuilt both appendices and the "What the
distribution says" figures from the body tables. The spec at the merge commit
is a fixed point of `regen_appendices.py --check`.

## New conflict hunks

### Merge 14: daypart-clock, PR #123 (`5319533`)

| Hunk | File / location | Resolution | Class |
| :--- | :--- | :--- | :--- |
| 1 | spec, § 5.5 lead sentence | #71 and #72 (HEAD) append sentences after "Each field declares bounds, not a value. A bare value means the field is `seller-set`." #123 rewrites the first sentence to "Each targeting field except `time_zone` declares bounds, not a value." I wrote the union, so the three exceptions read as one list and each PR keeps its meaning: "Each targeting field except `time_zone`, `exclusions_accepted`, and `exclusions` declares bounds, not a value. A bare value means the field is `seller-set`. For `exclusions_accepted` and `exclusions`, the seller declares what it can enforce, and the buyer supplies its lists. `geo` MAY instead declare the selectable structure of § 3.1, so a line item can be priced by market." This is a hand-written union. | MECHANICAL |
| 2 | spec, Appendix B rows (`immutable` through `supplied`) | Took HEAD, then regenerated: `seller-set` 35 to 36 (`time_zone`, after `approval`). #123's own counts (29 to 30) were against `main` | MECHANICAL |
| 3 | spec, distribution totals | Took HEAD, then regenerated: 79 to 80 fields, 24 buyer-touched, 55 to 56 other | MECHANICAL |

The § 5.5 table merged cleanly: #72's selectable `geo` row, #123's `daypart`
and `time_zone` rows, `frequency_cap`, then #71's `exclusions_accepted` and
`exclusions`. #123's **Window shape** and **Clock** blocks follow #71's
**Block lists** and #72's **Market-priced lines**, in PR order. Appendix A
gained the `time_zone` row from #123 with no conflict.

**Edits outside a conflict hunk.** Under #123's "REQUIRED with either", a line
item with `frequency_cap.period` needs `time_zone`. #123's description says
that the examples of #70 and #120 need `time_zone: viewer_local`, added by
whichever PR merges later. #123 merges last here, so the merge commit adds
`time_zone: viewer_local` directly under `frequency_cap` in:

- `examples/line-item-ctv-bonus.yaml` (#70)
- `examples/line-item-rewarded-video.yaml` (#120)

`viewer_local` matches #123's own CTV and audio examples. Both files still
parse. MECHANICAL.

## Renumbering

None.

## Check results

These ran on the final tree (`5319533`).

| Check | Source | Result |
| :--- | :--- | :--- |
| `tools/regen_appendices.py --check` | integration tooling | pass |
| `python3 scripts/check_appendix.py` | `main` | pass: 78 fields, markers agree |
| `python3 scripts/check_pricing_fixtures.py` | #117 | 49/49 vectors pass |
| `python3 scripts/check_creative_fixtures.py` | #118 | 41/41 cases pass |
| `node scripts/check_preview_observations.mjs` | #118 | 10/10 assertions pass |
| `examples/*.yaml` parse | `main` and extra | pass: 6 YAML examples |
| No conflict markers in tracked files | extra | pass |

Every line-item example with `frequency_cap.period` now carries `time_zone`:
display `America/New_York`; CTV, audio, CTV bonus, and rewarded video
`viewer_local`.

## Problems the PRs still cause together

The list in `INTEGRATION-final.md` ("Problems the final branches still cause
together") applies unchanged, apart from the § 5.5 intro wording, which hunk 1
resolves. #123 adds no new one: its `time_zone` requirement on the #70 and
#120 examples is met by the edits above.

## Rebuild with #123 at 9783ec8

PR #123's head moved to `9783ec87d102ccb60c106f4b6782650aa1f0a249` ("Write
the daypart day names as one value list"), which changes only § 5.5 wording:
the `daypart` row lists `days[]` as one value list, `monday` \| `tuesday` \|
… \| `sunday`, and HH:MM, America/New_York, and UTC become plain text. The
meaning is unchanged. The head matches upstream `pull/123/head` and the fork's
`daypart-clock`.

`integration-r3` was rebuilt from `integration-r2` (`4dc9f6c`) with `git merge
--no-ff 9783ec8` and the message `Merge branch 'daypart-clock' into
integration-r3`, as merge `707ccbb`. The merge hit the same 3 conflict hunks as
`5319533`, each resolved the same way (merge 14 above): the tree is
`5319533`'s with #123's three changed lines applied, so `git diff 5319533
707ccbb` touches only those 3 lines of `spec/openproposal-3.0.md`. The two
example edits outside a conflict hunk (`time_zone: viewer_local` in the #70 and
#120 examples) are kept, and the `examples/` tree is unchanged
(`cdec5662`). The first build stays reachable as the local branch
`integration-r3-97a5b10`. Nothing was pushed.

| # | Branch | PR / issue | Head SHA | Merge commit | Spec blob |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 14 | `daypart-clock` | PR #123 (refs #111, #58) | `9783ec87d102ccb60c106f4b6782650aa1f0a249` | `707ccbb` | `966ffb70` |

The checks above pass on `707ccbb`: `regen_appendices.py --check`, Appendix A
(78 fields, markers agree), the pricing (49/49), creative (41/41), and preview
(10/10) fixtures, and the 6 YAML examples parse. No conflict markers.

Updated 2026-10-25: first version.
Updated 2026-10-26: rebuilt with #123 at `9783ec8`.
