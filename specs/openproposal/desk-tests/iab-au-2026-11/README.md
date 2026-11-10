# IAB Australia desk-test line items (November 2026)

These 23 line items are synthetic payloads that Jonas Jaanimagi ([@jaanijuk](https://github.com/jaanijuk)) of IAB Australia's AAMP lab wrote to desk-test the OpenProposal 3.0 open-PR stack, branch `op30-packages` of [KonstantinMirin/OpenProposal](https://github.com/KonstantinMirin/OpenProposal). They are copied unchanged from his gist, <https://gist.github.com/jaanijuk/8ab1ede477027e0db81a1be02f6914b8>, at revision `c9435ae0105d25c1daa4a60becd7f9d2c1910549`. He gave permission on 2026-11-10 to include them in this repository; they are used with that permission.

Every screen, ID, coordinate, domain, and figure in them is invented, and the prices are placeholders, not any media owner's rate. The gist's own README describes each scenario and holds the logs of the first runs.

## What they check

[`expected.yaml`](expected.yaml) records the verdict each file must get on the `with-our-stack` lock. Two engines judge every file:

- **Schemas and rules.** The lock's schemas, Ajv 2020 with `format` asserted, and every rule that one payload decides, as the examples gate checks an example.
- **The stack's own checker.** `scripts/check_examples.py` at the lock's commit, which the lock pins by blob and keeps in its snapshot, run on the lock's specification and examples with these files added to `examples/`.

Nine files must be rejected, each at one location, the same in both engines. The other 14 must pass both. On every file, the rule that makes `format_specs` REQUIRED once the proposal leaves `draft` (`rule:5.4:3a677601`) is undecided, because a line item alone shows no proposal status.

`npm run ci` runs the desk-tests gate, so a verdict that changes in either engine fails CI. After a lock move, review each verdict that changed before you change `expected.yaml`.

| File | What it tests | Verdict |
|:--|:--|:--|
| `dooh-v2-a0-direct-12wk` | Direct IO, `TIME` by the week, 12 local weeks across the Sydney spring clock change | Clean |
| `dooh-v2-a0-direct-12wk-end-1h-later` | The same flight, ending one hour later | Clean |
| `dooh-v2-a1-direct-burst1`, `-a2-direct-burst2`, `-a3-direct-burst3` | Three weighted bursts written as three line items | Clean |
| `dooh-v2-b-pg` | Programmatic guaranteed: `CPM` on audience impressions through a multiplier | Clean |
| `dooh-v2-c-both` | Both routes in one line item: `TIME` with a loop-time share of voice, and `CPM` with guaranteed impressions | Clean |
| `dooh-v2-p6-hold-by-route` | `hold_terms.transaction_mechanisms` | Rejected at `/hold_terms/transaction_mechanisms` |
| `dooh-v2-p7-exclusivity-by-route` | The same key on an exclusivity option | Rejected at `/exclusivity/available/0/transaction_mechanisms` |
| `dooh-v2-p8-phases` | `commitment.phases[]` | Rejected at `/commitment/phases` |
| `dooh-v2-p9-demographic` | `demographic` on the multiplier, as a bare dataset code | Rejected at `/delivery_counting/impression_multiplier/demographic` |
| `dooh-v2-p9b-demographic-domain` | The same, domain-qualified | Clean |
| `dooh-v2-p10-screen-policy` | `creative_policy` on one screen | Rejected at `/properties/available/0/screens/0/creative_policy` |
| `dooh-v2-p11-c-no-multiplier` | A line item that counts impressions with no multiplier | Rejected at `/delivery_counting` (`rule:5.6.4:e58650b7`) |
| `dooh-v2-p12-offset-instant` | A flight start with a `+10:00` offset | Rejected at `/commitment/flight/start` |
| `loopshare-s01-q01-a-pg-guaranteed` | `CPM`, 8,610 guaranteed impressions, more than the screen runs in its open hours | Clean: availability is the seller's check at commit, not a document rule |
| `loopshare-s01-q01-b-pg-share-and-impressions` | A loop-time share of voice, a daypart, and an impressions commitment in one line item | Clean, as q01-a |
| `loopshare-s01-q01-c-plays-metric` | A bare `plays` committed metric beside `impressions` | Rejected at `/committed_metrics/1/metric` |
| `loopshare-s01-p7a-q01-domain-plays` | The same with `outdoor-owner.example:plays` | Clean |
| `loopshare-s01-p7b-q01-bad-term-control` | Negative control: a term with a space in it | Rejected at `/committed_metrics/1/metric` |
| `loopshare-s01-q02-a-play-commitment` | `PLAY`, 2,870 plays, no multiplier | Clean |
| `loopshare-s01-q03-a-operable-windows-commit` | A commitment sized to the windows the screen is open in | Clean |
| `loopshare-s01-q03-b-daypart-outside-hours` | A daypart entirely outside operating hours | Clean, as q01-a |
