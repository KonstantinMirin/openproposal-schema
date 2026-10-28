# Deals API extraction report: stages 1 and 2

This report covers the deterministic extractor (stage 1) and the spec lint (stage 2) on the IAB Tech Lab Deals API 1.0 text, `deal1.0.md`, at both locks: `main` at `3028ddc` (the default) and the tag `1.0-202602` at `938a5d1`. Its numbers are generated from the committed IR and findings under [`specs/dealsapi/ir/`](../specs/dealsapi/ir/); `npm run extraction-report` rewrites them, and a test fails when they're stale.

## How the text is read

- **Sections.** Each heading follows an anchor on a line of its own, `<a name="object-deal"></a>`, which is the section's ID. The first H1, "Deal Sync API Specification", is the title; the table of contents before the next H1 is front matter, and each later H1 opens a part of the body: Introduction, Deal API Specification, Receiving System Endpoint, and Implementation Guidance.
- **Attribute rows.** Each `Object:` section holds an `Attribute | Type | Description` table. A row's owner is the object its heading names, in snake case, as `buyer_seat` for `Object: BuyerSeat`. The Type cell states the base type and, after a `;` or a `,`, the presence and the default: `string; **required**`, `int, default 0, recommended`, `string; default "USD"`. Any other form fails extraction.
- **Value lists.** A Description cell lists a code's meanings as `` `n` = label `` lines split by `<br>`, and the `guar` row's cell in a sentence, "where 0 = not a guaranteed deal, 1 = guaranteed deal". Each code is an item with its label. Two rows cite AdCOM's lists instead, `devicetype` ("List: Device Type") and `cattax` ("List: Category Taxonomies"); stage 3 takes those from the AdCOM registry.
- **Statements.** The text states no RFC 2119 convention and writes its keywords in lowercase, so a sentence with a keyword in any case is a statement, and "strongly encouraged" reads as RECOMMENDED; plain "encouraged" makes none. Some sentences use a keyword in its ordinary sense, as "Some level of trust is required" and "Future versions may include that functionality" do; extraction keeps each one, and stage 3 maps each to what it says, as for AdCOM. A sentence goes on past "i.e." and "e.g.".
- **Parts.** Implementation Guidance is part of the body, as the other H1s after the title are: its sentences state what implementers should do, which the mapping reads, and the IR's appendix part holds no statement.
- **Example Scenarios.** The one table whose header names attributes, `Scenario | curationfee | auxdata | pubcount | dinventory`, is read as rows of values, which stage 3 maps as partial `Deal` payloads.

## Counts

<!-- generated:counts -->
### Tables by layout

| Layout | Header | `main` tables / rows | `tag-1.0-202602` tables / rows |
| :--- | :--- | ---: | ---: |
| `attribute` | Attribute \| Type \| Description | 6 / 46 | 6 / 46 |
| `scenario` | Scenario \| curationfee \| auxdata \| pubcount \| dinventory | 1 / 5 | 1 / 5 |
| **Total** | | **7 / 51** | **7 / 51** |

Every row of every table produced a typed record. No layout was unknown.

### Elements

| Element | `main` | `tag-1.0-202602` |
| :--- | ---: | ---: |
| Sections | 33 | 33 |
| Field rows, by owner (`deal`, `terms`, `inventory`, `curation`, `buyer_seat`, `buyer_status`) | 46 (17, 10, 8, 4, 4, 3) | 46 (17, 10, 8, 4, 4, 3) |
| Field rows whose Type cell states a default | 3 | 3 |
| Field rows that state their presence: required / recommended | 5 / 4 | 5 / 4 |
| Key rows | 0 | 0 |
| Value definitions | 0 | 0 |
| Other table rows, as examples | 5 | 5 |
| Value lists: in table cells / in prose | 10 / 0 | 10 / 0 |
| Rows that cite another standard's list ("List: …") | 2 | 2 |
| RFC 2119 sentences in the body | 54 | 54 |
| Other prose sentences that name an identifier (code span) | 13 | 13 |
| Code spans | 34 | 34 |
| Fenced code blocks | 0 | 0 |

### RFC 2119 sentences by strongest keyword

| Level | `main` | `tag-1.0-202602` |
| :--- | ---: | ---: |
| MUST | 5 | 5 |
| REQUIRED | 1 | 1 |
| SHOULD | 28 | 28 |
| RECOMMENDED | 4 | 4 |
| MAY | 16 | 16 |

### Findings by kind

Each cell shows open findings, plus findings with a verdict in brackets. A `presence_unstated` finding is one per owner; the rows it names are counted below it.

| Kind | `main` | `tag-1.0-202602` |
| :--- | ---: | ---: |
| `value_set_duplicate` | 2 | 2 |
| `value_set_subset` | 6 | 7 |
| `value_list_duplicate_code` | 0 | 1 |
| `unresolved_identifier` | 6 | 6 |
| `object_without_structure` | 6 | 6 |
| `must_without_field` | 1 | 1 |
| `presence_unstated` | 6 | 6 |
| Rows that state no presence (`presence_unstated`) | 37 | 37 |
| **Total** | **27** | **29** |
<!-- /generated:counts -->

## Findings

Every finding but the per-owner `presence_unstated` ones, with the locks it is on.

<!-- generated:findings -->
- `must_without_field`, on every lock: A MUST statement in § terms-object-1 names no field or key: "Price attribute must be provided if the deal is a fixed price deal, especially if it's a programmatic guaranteed deal, but otherwise can be used as pricing guidance or not provided at all if there is no pricing guidance (for example, for a Run-of-Exchange deal where there is no pricing guidance)"
- `object_without_structure`, on every lock: `ext` is typed object, and nothing in the specification gives its structure. (`field:object-buyerseat:ext`)
- `object_without_structure`, on every lock: `ext` is typed object, and nothing in the specification gives its structure. (`field:object-buyerstatus:ext`)
- `object_without_structure`, on every lock: `ext` is typed object, and nothing in the specification gives its structure. (`field:object-curation:ext`)
- `object_without_structure`, on every lock: `ext` is typed object, and nothing in the specification gives its structure. (`field:object-deal:ext`)
- `object_without_structure`, on every lock: `ext` is typed object, and nothing in the specification gives its structure. (`field:object-inventory:ext`)
- `object_without_structure`, on every lock: `ext` is typed object, and nothing in the specification gives its structure. (`field:object-terms:ext`)
- `unresolved_identifier`, on every lock: `curationfee` resolves to no table row, key, or table-declared value.
- `unresolved_identifier`, on every lock: `imp.banner` resolves to no table row, key, or table-declared value; no table defines `imp`.
- `unresolved_identifier`, on every lock: `imp.video` resolves to no table row, key, or table-declared value; no table defines `imp`.
- `unresolved_identifier`, on every lock: `inclinventory.adtype` resolves to no table row, key, or table-declared value; no table defines `adtype`.
- `unresolved_identifier`, on every lock: `publisher.id` resolves to no table row, key, or table-declared value; no table defines `publisher`.
- `unresolved_identifier`, on every lock: `request.at` resolves to no table row, key, or table-declared value; no table defines `request`.
- `value_list_duplicate_code`, on `tag-1.0-202602` only: The value list gives `4` 2 times, as "deal is complete (ie. selling scomplete (ie. selling system shows deal has completed)" and as "deal is archived (cannot be active again)", so a value of `4` doesn't say which it means.
- `value_set_duplicate`, on every lock: The value set 0 | 1 | 2 is declared 2 times.
- `value_set_duplicate`, on every lock: The value set 0 | 1 | 2 | 3 | 4 is declared 3 times.
- `value_set_subset`, on every lock: The value set 0 | 1 is a strict subset of 0 | 1 | 2 | 3 | 4; and of 0 | 1 | 2; and of 0 | 1 | 2 | 3; and of 0 | 1 | 2 | 3 | 4 | 5 | 6.
- `value_set_subset`, on every lock: The value set 0 | 1 | 2 is a strict subset of 0 | 1 | 2 | 3 | 4; and of 0 | 1 | 2 | 3; and of 0 | 1 | 2 | 3 | 4 | 5 | 6.
- `value_set_subset`, on every lock: The value set 0 | 1 | 2 | 3 is a strict subset of 0 | 1 | 2 | 3 | 4; and of 0 | 1 | 2 | 3 | 4 | 5 | 6.
- `value_set_subset`, on every lock: The value set 0 | 1 | 2 | 3 | 4 is a strict subset of 0 | 1 | 2 | 3 | 4 | 5 | 6.
- `value_set_subset`, on `tag-1.0-202602` only: The value set 0 | 1 | 2 | 4 is a strict subset of 0 | 1 | 2 | 3 | 4; and of 0 | 1 | 2 | 3 | 4 | 5 | 6.
- `value_set_subset`, on every lock: The value set 1 | 2 | 3 | 4 is a strict subset of 0 | 1 | 2 | 3 | 4; and of 1 | 2 | 3 | 4 | 5 | 6; and of 0 | 1 | 2 | 3 | 4 | 5 | 6.
- `value_set_subset`, on every lock: The value set 1 | 2 | 3 | 4 | 5 | 6 is a strict subset of 0 | 1 | 2 | 3 | 4 | 5 | 6.
<!-- /generated:findings -->
