# IAB Australia billable-day and `calendar_zone` desk-test line items (November 2026)

These 30 line items are synthetic payloads that Jonas Jaanimagi ([@jaanijuk](https://github.com/jaanijuk)) of IAB Australia wrote to desk-test billing a `TIME` entry with `rate_unit: day` on the OpenProposal 3.0 open-PR stack, branch `op30-packages` of [KonstantinMirin/OpenProposal](https://github.com/KonstantinMirin/OpenProposal), as discussed on [IABTechLab/OpenProposal#146](https://github.com/IABTechLab/OpenProposal/pull/146). The rule they exercise comes from a publisher in the Australian pilot; in his words on #146 ([comment](https://github.com/IABTechLab/OpenProposal/pull/146#issuecomment-6789529385)): "Interplay Media sells sponsorships by the day on this rule: a billable day is a calendar day, midnight to midnight Sydney time, and any delivery inside a calendar day counts as a full day."

They are copied unchanged from his gist, <https://gist.github.com/jaanijuk/945498af2f9ddb0b510fccc10c6cc4bd> (ID `945498af2f9ddb0b510fccc10c6cc4bd`), at revision `18af0615981797e182f13ad832e79ff01d1ba7f1`, read on 2026-11-13 with `npm run desk:add`. He shared the link on #146 on 2026-11-12 ([comment](https://github.com/IABTechLab/OpenProposal/pull/146#issuecomment-6837986175)): "feel free to share the link". They are used with his permission. The gist's own `00-README.md` and its checker log, `results-checker-6d5a6f9b.txt`, aren't payloads and aren't copied.

The gist's README says: "Every name, domain and figure is invented. **Prices are placeholders (A$1,500 a day): nothing here is any media owner's rate.**" The `calendar-zone-` files say of themselves:

> OpenProposal 3.0 desk test at op30-packages 38f5cfa2, IAB Australia, 12 Nov 2026. THEORETICAL: every name and figure is invented.

Two things in them aren't his, as his README says: the `calendar-zone-` files are built on the stack's own `examples/line-item-display.yaml`, with `commitment_bounds`, `hold_terms`, `cancellation_policy`, and `deal_origin` removed, a direct-IO guaranteed mechanism, and invented verification-vendor names in `measurement_source`, so they keep its `registry.iabtechlab.ai` credential issuer; and the two `billable-day-c` extension-term files carry an all-zero placeholder digest for a definition document that doesn't exist. Dates are Monday 1 to Wednesday 3 March 2027, when Sydney is UTC+11, except where a file says otherwise, and flight ends are inclusive: the last second of the last hour, unless the file name says the end is exactly midnight.

His own run of the stack's checker at `6d5a6f9b` rejects the same eight files at the same places as the checker run here.

## What they check

[`expected.yaml`](expected.yaml) records the verdict each file must get on the `with-our-stack` lock. Five engines judge every file: the lock's schemas and rules, the stack's own checker, `scripts/check_examples.py` at the lock's commit, and the TypeScript, Python, and Go SDKs the lock's schemas generate, under [`sdk/proposed/with-our-stack/`](../../../../sdk/proposed/with-our-stack/).

Three files are rejected by every engine at one location: `d09` and `d10`, where `calendar_zone` sits beside an hourly or weekly rate, and `d11`, whose `calendar_zone` is no name in the IANA time zone database; the schemas list the names of release 2026e (D-064). Five files are rejected by the checker alone, at the root, the line item, which the arithmetic reads: `a3`, `a4`, `b3`, `d06`, and `d08`. § 5.6.5 states how a `TIME` entry counts its units, elapsed or by calendar day, in sentences with no RFC 2119 keyword, so no rule carries the count, and neither the rules nor the SDKs compute it yet. `expected.yaml` records each under `checker_only`, with the elements of the specification its check reads and the reason; they close when the rules compute the arithmetic. The other 22 files pass every engine, `d13` and `d14` among them: an `Interval`'s `end` is the last second, inclusive (§ 2.2), and § 5.6.5 counts the calendar day of `commitment.flight.end`, so `d13`'s end of exactly Tuesday 00:00:00 counts Tuesday, 2 days, and `d14`'s end of Monday 23:59:59 counts 1. On every file, the rule that makes `format_specs` REQUIRED once the proposal leaves `draft` (`rule:5.4:3a677601`) is undecided, because a line item alone shows no proposal status.

`npm run ci` runs the desk-tests gate, so a verdict that changes in any engine fails CI. After a lock move, review each verdict that changed before you change `expected.yaml`.

What each file tests is his README's description, summarized.

### `billable-day-`: elapsed units, no `calendar_zone`, the files behind his table on #146

| File | What it tests | Verdict |
|:--|:--|:--|
| `billable-day-a1-mon-0600-1800` | Mon 06:00 to 18:00 Sydney, 1 calendar day, written as 1 unit, A$1,500 | Clean |
| `billable-day-a2-mon-1800-tue-0600` | Mon 18:00 to Tue 06:00, 2 calendar days, written as 1 unit, A$1,500 | Clean |
| `billable-day-a3-mon-1800-tue-0600-two-days-spend` | As `a2`, written as 2 units, A$3,000 | Rejected by the checker alone, at the root: the commitment is for 1 unit, and `derived_units` recomputes to 1 (checker only) |
| `billable-day-a4-mon-1800-tue-0600-two-days-units` | As `a2`, `basis: units`, 2 | Rejected by the checker alone, at the root: the commitment is for 1 unit (checker only) |
| `billable-day-b1-mon-2300-tue-0100` | Mon 23:00 to Tue 01:00, 2 calendar days, 0 units | Clean |
| `billable-day-b2-mon-0900-1100` | Mon 09:00 to 11:00, 1 calendar day, 0 units | Clean |
| `billable-day-b3-mon-0900-1100-min1` | As `b2`, with `unit_bounds: { min: 1 }`, 0 units | Rejected by the checker alone, at the root: 0 units are outside `unit_bounds` (checker only) |
| `billable-day-b4-mon-full-calendar-day` | Mon 00:00:00 to 23:59:59, 1 calendar day, 1 unit | Clean |
| `billable-day-b5-mon-1200-tue-1200` | Mon 12:00 to Tue 12:00, 2 calendar days, 1 unit | Clean |
| `billable-day-b6-mon-1800-wed-0600` | Mon 18:00 to Wed 06:00, 3 calendar days, 2 units | Clean |
| `billable-day-c1-calendar-day-flight-daypart` | Mon 00:00:00 to Tue 23:59:59, the hours as a `daypart`, 2 units | Clean |
| `billable-day-c2-extension-term-billable-day` | As `a2`, under an extension `cost_method`, `basis: units`, 2 | Clean |
| `billable-day-c3-extension-term-seven-units` | Control: `c2` with 7 units | Clean |

### `calendar-zone-`: `calendar_zone` on a `TIME` entry with `rate_unit: day`

Each file has one `TIME` entry at A$1,500 a day with `calendar_zone: Australia/Sydney`, unless the row says otherwise.

| File | What it tests | Verdict |
|:--|:--|:--|
| `calendar-zone-d01-mon-0600-1800` | Mon 06:00 to 18:00, 1 day | Clean |
| `calendar-zone-d02-mon-1800-tue-0600` | Mon 18:00 to Tue 06:00, 2 days | Clean |
| `calendar-zone-d03-mon-2300-tue-0100` | Mon 23:00 to Tue 01:00, 2 days | Clean |
| `calendar-zone-d04-mon-1200-tue-1200` | Mon 12:00 to Tue 12:00, 2 days | Clean |
| `calendar-zone-d05-mon-1800-wed-0600` | Mon 18:00 to Wed 06:00, 3 days | Clean |
| `calendar-zone-d06-two-day-flight-one-unit-spend` | The `d02` flight written as 1 day, A$1,500 | Rejected by the checker alone, at the root: the commitment is for 2 units, A$3,000 (checker only) |
| `calendar-zone-d07-two-day-flight-units-2` | The `d02` flight, `basis: units`, 2 | Clean |
| `calendar-zone-d08-two-day-flight-units-1` | The `d02` flight, `basis: units`, 1 | Rejected by the checker alone, at the root: 2 units (checker only) |
| `calendar-zone-d09-zone-with-hour` | The `d02` flight, `rate_unit: hour`, 12 hours | Rejected at `/pricing/0/cost_parameters/rate_unit`: `calendar_zone` without `rate_unit` `day` |
| `calendar-zone-d10-zone-with-week` | The `d02` flight, `rate_unit: week`, 0 weeks | Rejected at `/pricing/0/cost_parameters/rate_unit`: `calendar_zone` without `rate_unit` `day` |
| `calendar-zone-d11-bad-zone-name` | The `d02` flight, `calendar_zone: Sydney/Australia`, 2 days | Rejected at `/pricing/0/cost_parameters/calendar_zone`: not an `IanaZone` |
| `calendar-zone-d12-utc-zone-same-flight` | The `d02` flight, `calendar_zone: UTC`, 1 day: both ends fall on Monday in UTC | Clean |
| `calendar-zone-d13-end-exactly-tue-0000` | Mon 18:00 to exactly Tue 00:00:00, 2 days: the end instant is on Tuesday, so Tuesday counts | Clean |
| `calendar-zone-d14-end-mon-235959` | Mon 18:00 to Mon 23:59:59, 1 day | Clean |
| `calendar-zone-d15-dst-sat-1800-mon-0600` | Sat 3 April 18:00 to Mon 5 April 06:00, across the 4 April clock change, 3 days (the elapsed rule gives 2: the flight is 37 hours) | Clean |
| `calendar-zone-d16-la-zone-mon-2300-tue-0100` | The `d03` flight, `calendar_zone: America/Los_Angeles`, 1 day: both ends fall on Monday in Los Angeles; Sydney gives 2 | Clean |
| `calendar-zone-d17-no-zone-d15-flight-elapsed` | The `d15` flight, no `calendar_zone`, 2 units, elapsed | Clean |

As his README says, delivery isn't counted anywhere in the checker, so nothing here tests what makes a delivered day.
