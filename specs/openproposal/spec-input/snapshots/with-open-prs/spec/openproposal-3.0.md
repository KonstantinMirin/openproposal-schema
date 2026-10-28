# OpenProposal — Object Model Specification

**AAMP 3.0 · Draft for public comment**

**Version 3.0 draft 1** · *Published for comment 2026-09-22*

> **Status:** Draft. This document is open for public comment. It is not a
> ratified IAB Tech Lab standard and MUST NOT be treated as one. See
> [CONTRIBUTING.md](../CONTRIBUTING.md) for how to comment and
> [docs/comment-process.md](../docs/comment-process.md) for what happens to
> your comment.

**License.** OpenProposal Specification by IAB Tech Lab is licensed under a
Creative Commons Attribution 3.0 License. To view a copy of this license, visit
[creativecommons.org/licenses/by/3.0/](https://creativecommons.org/licenses/by/3.0/).
See [LICENSE](../LICENSE).

OpenProposal is the core AAMP 3.0 object: the descriptive specification for
what is being bought and sold, engineered so a buying agent can parse and
evaluate it at machine speed. It pulls through from initial brief to binding
commercial terms, and is the canonical object a seller manages alongside its
OMS and ad server.

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY and OPTIONAL in this document are to be interpreted as
described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

---

## 1. Preamble and scope

OpenProposal defines commercial and operational offers across their lifecycle,
from proposal creation to binding agreement. It carries both the shape of an
offer and the states and interactions that act on it.

Two shapes of the object exist:

- **Standard proposal** — published unilaterally by the seller's agent. No brief required.
- **Custom proposal** — built in response to a buyer's agent brief, referenced via `brief_ref`.

### 1.1 Downstream standards

OpenProposal does not replace IAB Tech Lab execution standards. Each line item
lands in the one its `transaction_mechanism` maps to:

| OpenProposal concept | Downstream standard |
| :--- | :--- |
| Direct buy | OpenDirect 2.1 · Order + Line |
| Programmatic guaranteed | OpenDirect 2.1 + Deals API · `deal_id` |
| PMP deal | Deals API + OpenRTB 2.6 · Deal |
| Open market | OpenRTB 2.6 · open auction, no deal |

---

## 2. Object shape

```
Proposal          → the merchandising pitch, identity, lifecycle state and assent
Line Items[]      → fully self-contained buyable units, each in exactly one channel
```

**No-inheritance rule.** Each line item MUST be fully self-contained. A field on
a line item MUST NOT inherit its value from the proposal or from a sibling line
item. There is no "overridable unless restated" semantics anywhere in this
specification.

**Subsettable proposals.** A buyer MAY select and commit a subset of a
proposal's line items, unless the proposal sets `linked_execution` to `all`
(§ 4.1). A line item that declares `requires` (§ 5.6.3) may be committed only
when its conditions are met.

### 2.1 Summary and full representations

Every line item has two representations.

**Summary Representation** — what a buying agent reads when screening many
sellers' shelves. A catalog response MAY return it. It MUST contain, per line
item:

`line_item_id` · `channel` · `environments.available[]` ·
`content_detail` · property names ·
`formats.included[]` · `pricing.cost_method` · `pricing.gross_rate` ·
`min_spend` · `addressable_scale` · `committed_metrics[]` ·
`transaction_mechanism` · `has_requires`

plus, from the parent proposal: `proposal_id` · `seller_name` · `description` ·
`valid_from` · `valid_until` · `linked_execution`.

`has_requires` is `true` when the line item declares `requires` (§ 5.6.3), so a
screening agent does not recommend a line item that cannot be bought on its own.

`catalog_ref` values MUST remain unresolved in a summary.

A line item that carries `placement` (§ 5.2) MUST also give, in its summary,
whichever of `placement.reward` · `placement.instl` · `placement.plcmt` ·
`placement.skip` it declares.

**Full Representation** — every field, with all `catalog_ref` values resolved.
A full fetch MUST return it.

### 2.2 Catalog references

Any field whose value is drawn from a seller-maintained catalog MAY carry a
reference in place of an inline value:

```
catalog_ref: "<seller_namespace>/<collection>/<entry_id>@<version>"
example:     "examplepub/audiences/smb-decision-makers@3"
```

- A field MUST carry either an inline value or a `catalog_ref`, never both.
- A `catalog_ref` is **not inheritance**. There are no override semantics, and
  nothing is implied by a field's position in the document. The no-inheritance
  rule stands.
- References MUST be version-pinned. A catalog entry MUST be immutable once
  referenced; a change creates a new version.
- References MUST resolve during discovery.
- When a proposal reaches status `agreed`, every `catalog_ref` MUST be replaced
  by its resolved value in the stored record, so the committed artifact is
  self-contained and immutable.

### 2.3 Publication

A seller MAY publish `https://<seller domain>/.well-known/openproposal.json`.

Contents: `{ seller_id, generated_at, spec_version, proposals[] }`, where each
entry in `proposals[]` carries `proposal_id`, `version`, the Summary
Representation (§ 2.1) of each line item, and a `full_url` for the second
phase.

- `ETag` / `Last-Modified` are REQUIRED, so buyers can poll cheaply.
- Only standard proposals appear, and within them only line items whose
  `visibility` (§ 5.8) is `public`. `registry_gated` and `named` line items do
  not.
- Manifest entries MUST match the current version of each proposal. A stale
  entry is a seller error.
- Property lists stay as names in the summary; large lists use `catalog_ref`
  (§ 2.2).

Two-phase flow:

1. **Discover:** fetch the manifest and screen the summaries. No language model
   is required.
2. **Propose:** fetch the Full Representation of shortlisted line items from
   `full_url`, then compose and commit as usual.

---

## 3. Field mutability

Every field carries exactly one marker.

| Marker | Meaning |
| :--- | :--- |
| `immutable` | Set once at creation. Neither party may change it. |
| `seller-set` | The seller sets it and MAY revise it while status is `draft` or `published`. The buyer cannot change it directly. |
| `selectable` | The buyer chooses from a seller-declared set. Each option MAY carry a price delta. Resolves without seller assent. |
| `settable` | The buyer supplies a value within seller-declared bounds. Resolves without seller assent. |
| `supplied` | The buyer provides data or an artifact. The seller does not pre-populate it. |
| `requestable` | The buyer MAY ask for a value outside the declared space. Requires explicit seller assent. |
| `derived` | Computed from other fields. Neither party sets it directly. |

**Resolution without a round trip.** `selectable`, `settable` and `supplied`
fields MUST resolve without a round trip — everything needed to validate and
price them is declared in the proposal. Only `requestable` fields require the
counterparty to respond.

A field is never silently reverted. An unset `selectable` or `settable` field
takes its declared `included[]` or default, and that default MUST be explicit in
the proposal.

### 3.1 Selectable structure

Every field marked `selectable` MUST declare:

| Key | Required | Meaning |
| :--- | :--- | :--- |
| `available[]` | REQUIRED | The options the seller offers |
| `included[]` | REQUIRED | Which options are in the base rate. MAY be empty |
| `pricing` | OPTIONAL | Delta per option beyond those included, as `{ option_id: { delta_cpm \| delta_flat \| delta_pct } }` |
| `max_select` | OPTIONAL | Cap on how many options the buyer may choose |

A field marked `selectable` that carries a bare value and no `available[]` MUST
be treated as `seller-set`.

`audience_pricing` in earlier drafts was the precedent for this pattern — it
expressed "if you change X, the price moves by Y". `pricing` generalises it to
every dimension a seller is willing to vary, and replaces it.

### 3.2 Settable bounds

Every field marked `settable` MUST declare its bounds: either `allowed[]` (an
enumerated set) or `min` / `max` (a numeric or date range).

A field marked `settable` that carries a bare value and no bounds MUST be
treated as `seller-set`.

### 3.3 Re-computation

Because audiences, properties, formats and, where it is selectable, `geo` are
`selectable`, and buyer `exclusions` (§ 5.5) narrow delivery,
`addressable_scale` and `availability` MUST be recomputed against the buyer's
actual selection and exclusions. A
single declared figure is correct only for the default composition.

---

## 4. Proposal

The proposal establishes identity, lifespan, negotiation state and the
merchandising case for the line items beneath it. Nothing here is a commercial
commitment, and nothing here is channel-specific — that all lives on the line
items.

### 4.1 Identity and lifecycle

| Field | Type | Mutability | Description |
| :--- | :--- | :--- | :--- |
| `proposal_id` | String | immutable | Unique identity for the proposal object |
| `version` | Integer | derived | Monotonically increasing revision number. Each revision while status is `published` increments it |
| `seller_id` | String | immutable | IAB Tech Lab registry reference |
| `seller_name` | String | immutable | Canonical legal seller entity name, from the registry |
| `type` | Enum | immutable | `standard` \| `custom` |
| `proposal_template_id` | String | immutable | OPTIONAL. Links an issued proposal to the seller's template. Opaque to buyers; used for the seller's reporting |
| `status` | Enum | derived | `draft` \| `published` \| `under_review` \| `agreed` \| `withdrawn` \| `expired` |
| `assent` | Object | derived | Buyer and seller assent records and timestamps for the binding version. Signature scheme is WS1 |
| `valid_from` · `valid_until` | Timestamp | seller-set | ISO-8601 window the offer holds. **This is the offer window, not the campaign flight** |
| `brief_ref` | String | supplied | Reference to the buyer's brief. REQUIRED when `type` is `custom` |
| `negotiation_history[]` | Array[Object] | derived | Ordered, append-only. `{ version, actor: buyer \| seller, action: proposed \| countered \| accepted \| declined \| withdrawn, fields_changed[], at }`. Entries MUST NOT be edited or removed |
| `linked_execution` | Enum | seller-set | `none` (default, subsettable) \| `all` (every published line item must be committed together) |

- Each issued proposal has an independent `status`, `version` and
  `negotiation_history[]`.
- `proposal_template_id` MUST NOT be required for a buyer to transact. Buyers
  never resolve it.

### 4.2 Agent comprehension

The case a buying agent reads to decide whether to look further.

| Field | Type | Mutability | Description |
| :--- | :--- | :--- | :--- |
| `description` | String | seller-set | REQUIRED. Prose, not a name. Where the "why buy" case is made, including which channels a multi-channel proposal spans |
| `specifications` | String/Object | seller-set | Structured detail at media-kit depth |
| `best_for[]` | Array[String] | seller-set | Advisory planning hints. Non-normative, and never the basis for a match |
| `not_suitable_for[]` | Array[String] | seller-set | Advisory exclusion guidance. Non-normative |
| `seasonality_notes` | String | seller-set | When the proposal performs differently |

---

## 5. Line items

Everything a buying agent needs to transact, per buyable unit, in exactly one
channel.

### 5.1 Identity

| Field | Type | Mutability | Description |
| :--- | :--- | :--- | :--- |
| `line_item_id` | String | immutable | Identity within the proposal |
| `status` | Enum | derived | `draft` \| `published` \| `under_review` \| `agreed` \| `withdrawn` \| `sold_out` \| `expired`. Independent of the proposal's status, so one line item may sell out while the rest of the shelf stays live |
| `channel` | Enum | immutable | `display` \| `video` \| `audio` \| `ctv` \| `dooh` \| `native`, each defined in 5.1.1. The discriminator for how the rest of the line item is read |

#### 5.1.1 channel

An impression's channel is the first row of this table that the impression
matches. Conditions are stated in
[AdCOM 1.0](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md)
terms: the
[distribution channel](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#abstract_distributionchannel),
the ad's media
([`Placement`](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#object_placement)
subtypes) and the
[device type](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#list_devicetypes).
Where an impression accepts more than one medium, its media is that of the ad
served.

| `channel` | Condition |
| :--- | :--- |
| `dooh` | Distribution channel `Dooh` |
| `audio` | Audio ad (`AudioPlacement`) |
| `ctv` | Device type Connected TV (3), Connected Device (6) or Set Top Box (7) |
| `native` | Native ad (`DisplayPlacement.nativefmt`), including native ads with video assets |
| `video` | Video ad (`VideoPlacement`) |
| `display` | Any other display ad (`DisplayPlacement`) |

Device types are values of AdCOM 1.0 List: Device Types, each written as its
name followed by its code.

- The seller MUST serve a line item only on impressions of its `channel`.
  Placement type, such as interstitial or rewarded
  ([OpenRTB 2.6](https://github.com/InteractiveAdvertisingBureau/openrtb2.x/blob/1debba8001f40eb14597102dec3205afddf811d4/2.6.md#objectimp)
  `video.plcmt`, `imp.instl` and `imp.rwdd`), does not change the channel.
- A consumer MUST skip a line item whose `channel` it does not recognise, and
  MUST NOT reject the proposal because of it.
- Impressions in linear TV, including addressable linear, are outside this
  table: they have no `channel` value in 3.0.

### 5.2 Inventory composition

| Field | Type | Mutability | Description |
| :--- | :--- | :--- | :--- |
| `properties` | Object | selectable | `available[]` of `{ id, name, domains, apps, supported_formats }`, `included[]`, `pricing`, `max_select`. Each property MUST carry `domains`, `apps` or both |
| `content_detail` | Object | seller-set | Shows, series, sections, network verticals |
| `environments` | Object | selectable | `available[]` from `web_desktop` \| `web_mobile` \| `app_mobile` \| `ctv` \| `dooh`, each defined in 5.2.1 |
| `placement` | Object | seller-set | What every impression of this line item is: rewarded, interstitial, video placement subtype, skippability, playback, API frameworks and refresh. `plcmt` is REQUIRED for video ads. See 5.2.2 |

**App identity.** `apps[]` identifies the apps behind a property sold in
`app_mobile` or `ctv`. Keys follow the OpenRTB 2.6 `app` object where one
exists.

| Key | Required | Meaning |
| :--- | :--- | :--- |
| `platform` | REQUIRED | `ios` \| `android` \| `roku` \| `fire_tv` \| `samsung_tv` and other store platforms. No OpenRTB equivalent |
| `bundle` | REQUIRED | Store ID. As OpenRTB 2.6 `app.bundle` |
| `storeurl` | OPTIONAL | Store listing URL. As `app.storeurl` |
| `domain` | RECOMMENDED | Developer domain, against which `app-ads.txt` is checked. As `app.domain` |

Seller authorisation for an app is checked through `app-ads.txt` on its
developer domain, not through the property's `domains`.

#### 5.2.1 environments

Each environment value is the set of (distribution channel, device type) pairs
formed from its row, in AdCOM 1.0 terms. An impression matches the value when
both its distribution channel and its device type are in the row. Device types
are as in 5.1.1.

| Value | Distribution channel | Device types |
| :--- | :--- | :--- |
| `web_desktop` | `Site` | Personal Computer (2) |
| `web_mobile` | `Site` | Mobile/Tablet - General (1), Phone (4), Tablet (5) |
| `app_mobile` | `App` | Mobile/Tablet - General (1), Phone (4), Tablet (5) |
| `ctv` | `Site` or `App` | Connected TV (3), Connected Device (6), Set Top Box (7) |
| `dooh` | `Dooh` | Any |

Each `environments.available[]` value MUST match at least one impression to
which 5.1.1 gives the line item's `channel`.

#### 5.2.2 placement

Keys follow [AdCOM 1.0 `Placement`](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#object_placement) and its
[`DisplayPlacement`](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#object_displayplacement),
[`VideoPlacement`](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#object_videoplacement) and
[`AudioPlacement`](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#object_audioplacement) subtypes, and the matching
[OpenRTB 2.6 `Imp`](https://github.com/InteractiveAdvertisingBureau/openrtb2.x/blob/1debba8001f40eb14597102dec3205afddf811d4/2.6.md#objectimp) attributes.

Each key takes an integer, except `playmethod[]` and `api[]`, which take
arrays of integers, and `refresh`, an object whose `min_interval_s` is a
REQUIRED integer. `plcmt`, `playmethod[]` and `api[]` take any code in
[List: Plcmt Subtypes - Video](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#list_plcmtsubtypesvideo),
[List: Playback Methods](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#list_playbackmethods) and
[List: API Frameworks](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#list_apiframeworks) respectively. This
section names each code by its AdCOM name followed by the code, such as
Instream (1).

| Key | Required | Meaning | AdCOM 1.0, OpenRTB 2.6 |
| :--- | :--- | :--- | :--- |
| `reward` | OPTIONAL | `0` (no) \| `1` (yes). The user receives a reward for viewing the ad | `Placement.reward`, `imp.rwdd` |
| `instl` | OPTIONAL | `0` (no) \| `1` (yes). The ad is interstitial or full screen | `DisplayPlacement.instl`, `imp.instl` |
| `plcmt` | REQUIRED for video ads (`channel` `video`, or video on `channel` `ctv`); otherwise OPTIONAL | One value from List: Plcmt Subtypes - Video: Instream (1), Accompanying Content (2), Interstitial (3), No Content/Standalone (4), Pause (5), Screensaver (6), Overlay (7), Squeezeback (8), In-scene (9) | `VideoPlacement.ptype`, `video.plcmt` |
| `skip` | OPTIONAL | Video or audio. `0` (no) \| `1` (yes). The placement lets the user skip the ad | `VideoPlacement.skip`, `AudioPlacement.skip`, `video.skip` |
| `skipafter` | OPTIONAL | When `skip` is `1`: seconds the ad plays before the placement enables skipping | `VideoPlacement.skipafter`, `AudioPlacement.skipafter`, `video.skipafter` |
| `playmethod[]` | OPTIONAL | Video or audio. Values from List: Playback Methods in use, such as Initiates without any specific user interaction with Sound On (1), Initiates without any specific user interaction Sound Off by Default (2), Initiates on Click with Sound On (3) and Continuous Playback (7) | `VideoPlacement.playmethod`, `AudioPlacement.playmethod`, `video.playbackmethod` |
| `api[]` | OPTIONAL | Values from List: API Frameworks that every impression supports, such as MRAID 3.0 (6), OMID 1.0 (7) and SIMID 1.1 (9) | `DisplayPlacement.api`, `VideoPlacement.api`, `AudioPlacement.api`, `banner.api`, `video.api`, `audio.api` |
| `refresh` | OPTIONAL | `{ min_interval_s }`: minimum seconds a creative renders before the slot refreshes | OpenRTB 2.6 only: `imp.refresh.refsettings[].minint` |

`plcmt` takes its OpenRTB 2.6 name. AdCOM 1.0 carries the same list as
`VideoPlacement.ptype`. OpenRTB 2.6 `Audio` has no `skip`, `skipafter` or
`playbackmethod`, so for audio those keys map to AdCOM 1.0 `AudioPlacement`
only.

- A key that is present holds for every impression of the line item. An absent
  key does not constrain it: a line item that omits `instl` can deliver to
  interstitial and non-interstitial impressions alike. AdCOM 1.0 reads an
  absent `reward` or `instl` as `0`; here it means either value.
- The seller MUST NOT deliver the line item to an impression that does not
  match a key that is present. An impression matches `api[]` when it supports
  every listed framework, `playmethod[]` when its playback method is one of the
  listed values, and `refresh` when the slot renders each creative for at least
  `min_interval_s` seconds before it refreshes, or does not refresh. It matches
  any other key when its value is equal.
- Unless `api[]` includes OMID 1.0 (7), a line item whose `committed_metrics[]`
  includes `viewable_rate` and whose `environments.available[]` includes
  `app_mobile` or `ctv` SHOULD NOT offer a `measurement_source` vendor other
  than the seller.

### 5.3 Audience reach

| Field | Type | Mutability | Description |
| :--- | :--- | :--- | :--- |
| `audiences` | Object | selectable | `available[]` of `{ id, name, taxonomy_ref, provenance, addressable_scale }`, `included[]`, `pricing` as `delta_cpm` per option, `max_select` |
| `addressable_scale` | Integer | derived | Reachable units in the flight, recomputed against the buyer's selection. Not segment size |
| `activation_route` | Object | selectable | `available[]` from `publisher_side` \| `clean_room` \| `id_partner`, `included[]`, `pricing` |
| `buyer_supplied` | Object | supplied | `{ segments_allowed, suppression_allowed, match_rate_expected, segments[], suppression_list }`. `match_rate_expected` is the seller's stated expectation; `segments[]` and `suppression_list` are buyer-populated |

### 5.4 Creative requirements

| Field | Type | Mutability | Description |
| :--- | :--- | :--- | :--- |
| `formats` | Object | selectable | `available[]` of registry format ids namespaced by channel (`display/300x250`, `audio/host-read-30s`), `included[]`, `pricing`, `max_select` |
| `specs` | Object | seller-set | As defined by the referenced format registry entry. OpenProposal does not hardcode a shape per channel |
| `third_party_tags` | Object | seller-set | Accepted wrapper types and VAST versions |
| `creative_delivery` | Object | seller-set | `{ method: buyer_hosted \| seller_hosted \| api \| platform_managed, protocol, secure_required, endpoint }` |
| `assets[]` | Array[Object] | supplied | Buyer-delivered. `{ asset_id, format_ref, url_or_tag, submitted_at, approval_status }` |
| `materials_due` | Timestamp/Offset | requestable | Deadline for creative to land. A buyer MAY request a later date |
| `approval` | Object | seller-set | Review SLA and revision policy |
| `production` | Object | selectable | Custom units. `available[]` of build options with `pricing` and `lead_time`; `{ custom_unit, build_owner, lead_time, cost }` |

#### Creative inspection and previews

For this section, inspection means evaluating a creative outside live campaign
delivery, including discovery, composition, submission checks and previews. A
production notification is an event report intended for a campaign's live
measurement or delivery diagnostics.

An implementation performing inspection MUST NOT send any production
notification. This includes requesting an event URL solely to check its
availability, regardless of the HTTP method used.

An implementation MAY retrieve creative documents, follow VAST wrappers and
inspect referenced media as needed for its checks. Permission to retrieve these
resources does not extend to firing their event URLs. Retrieval can itself be
logged by the resource owner; this requirement does not imply that inspection
produces no server activity.

A landing-page inspection remains subject to the same notification prohibition,
including any redirect requests. The presence of a URL in VAST `<ClickThrough>`
does not establish that requesting it is safe for inspection. The inspector
MUST NOT request a destination or redirect that sends a production notification;
it MAY use a separate inspection URL or the receiving service's documented test
mode under the conditions below.

A preview that executes creative or verification code MUST prevent that code
from sending production notifications. Synthetic events MAY be sent to test
endpoints, or through a test mode that the receiving service documents as
excluding those events from production measurement and delivery diagnostics. An
inspector's own test flag is insufficient unless the receiving service supports
it.

Inspection failures MUST be reported through diagnostics, without firing a
production VAST `<Error>` or `verificationNotExecuted` URL. An implementation
MUST NOT report a check that was skipped or could not finish as passed.

These requirements apply to inspection only. During live delivery,
implementations remain subject to the tracking and error-reporting requirements
of the applicable execution standard.

### 5.5 Targeting envelope

Each targeting field except `time_zone`, `exclusions_accepted`, and
`exclusions` declares bounds, not a value. A bare value means the field is
`seller-set`. For `exclusions_accepted` and `exclusions`, the seller declares
what it can enforce, and the buyer supplies its lists. `geo` MAY instead
declare the selectable structure of § 3.1, so a line item can be priced by
market.

| Field | Type | Mutability | Description |
| :--- | :--- | :--- | :--- |
| `geo` | Object | selectable | `available[]` of geo codes with `included[]`, `pricing` deltas and `max_select` (§ 3.1), for a line item priced by market. A `geo` that declares only `allowed[]` is `settable`. See below |
| `device` | Object | settable | `allowed[]` of device categories |
| `daypart` | Object | settable | `allowed[]` of `{ days[], start, end }`: `days[]` from `monday` \| `tuesday` \| `wednesday` \| `thursday` \| `friday` \| `saturday` \| `sunday`, HH:MM civil time, `end` exclusive, up to `24:00` |
| `time_zone` | String | seller-set | IANA time zone name, or `viewer_local` (where the ad renders). The clock for `daypart` and `frequency_cap.period`. REQUIRED with either |
| `frequency_cap` | Object | settable | `{ max: { min, max }, period, basis: device \| household \| listener }`. Basis matters: CTV typically caps at household, audio at listener |
| `exclusions_accepted` | Object | seller-set | What the seller can enforce: `{ types[], max_entries, enforcement, verification[] }`. See below |
| `exclusions` | Object | supplied | The buyer's block lists: `{ domain[], app_bundle[], iab_content_category[], keyword[], list_ref }`. See below |

**Block lists.** The seller declares which exclusion types it accepts and how it
enforces each; the buyer supplies its lists within that declaration.

```yaml
exclusions_accepted:
  types:        [domain, app_bundle, iab_content_category, keyword]
  max_entries:  { domain: 5000, keyword: 500 }
  enforcement:  { domain: pre_serve, app_bundle: pre_serve,
                  iab_content_category: pre_serve, keyword: best_effort }
  verification: ["IAS", "DoubleVerify"]

exclusions:
  domain:           ["example-gambling.example"]
  app_bundle:       [{ platform: roku, bundle: "123456" }]
  iab_content_category: ["IAB-CT3.0:<id>"]   # IAB Content Taxonomy ids
  keyword:          ["crypto"]
  list_ref:         { url: "<url>", sha256: "<hash>" }
```

- Each `app_bundle[]` entry is `{ platform, bundle }`. `bundle` is the OpenRTB
  2.6 `app.bundle` value; `platform` names the store (`ios` \| `android` \|
  `roku` \| `fire_tv` \| `samsung_tv` and other store platforms). A seller MUST
  reject an entry whose platform it cannot determine, rather than apply it
  across stores.
- `iab_content_category[]` entries are IAB Content Taxonomy ids.
- `enforcement` is `pre_serve` or `best_effort` per type.
- A buyer MUST NOT supply an exclusion type absent from
  `exclusions_accepted.types`. A seller MUST reject it deterministically
  rather than ignore it.
- A seller MUST NOT present `best_effort` enforcement as a guarantee.
- `list_ref` MUST be hash-pinned, and resolved into the stored record at
  `agreed`, as for `catalog_ref` (§ 2.2).

**Market-priced lines.** A seller whose rate differs by market MAY declare `geo`
with the selectable structure of § 3.1:

```yaml
geo:
  available:  ["SGP", "THA", "IDN", "MYS"]
  included:   ["SGP", "THA"]
  pricing:    { "IDN": { delta_cpm: 18.00 }, "MYS": { delta_cpm: 21.00 } }
  max_select: 4
```

- A `geo` that declares `allowed[]` and no `available[]` MUST be treated as
  `settable` (§ 3.2). A `geo` MUST NOT declare both.
- `pricing` deltas add to `agreed_rate` as for any selectable field (§ 3.1).

**Window shape.** A `daypart` window is `{ days[], start, end }`, with `days[]`
from Monday to Sunday, `start` and `end` as HH:MM, and `end` exclusive,
later than `start`, and allowed to be `24:00`. A window that crosses midnight
is two windows:

```yaml
# Late fringe, 23:00 to 01:00, Monday night into Tuesday
daypart:
  allowed:
    - { days: [monday],  start: "23:00", end: "24:00" }
    - { days: [tuesday], start: "00:00", end: "01:00" }
time_zone: "America/New_York"
```

**Clock.** `time_zone` names a zone in the
[IANA time zone database](https://www.iana.org/time-zones), such as
America/New_York or UTC. Windows follow daylight-saving rules: a skipped
hour matches no instant; a repeated hour matches both. Like the calendar Day of
[OpenDirect 2.1 `Line.frequencyinterval`](https://github.com/InteractiveAdvertisingBureau/OpenDirect/blob/82bc294314aba017fc639ba634aecc53adfd675f/OpenDirect.v2.1.final.md#object_line),
`frequency_cap.period` is a calendar period in `time_zone`; weeks start on
Monday.

### 5.6 Commercial terms

| Field | Type | Mutability | Description |
| :--- | :--- | :--- | :--- |
| `pricing[]` | Array[Object] | mixed | See below |
| `pricing[].cost_method` | Enum | seller-set | CPM, CPC, flat, etc. |
| `pricing[].gross_rate` | Number | seller-set | The list rate the buyer pays |
| `pricing[].agreed_rate` | Number | derived | The transacted rate after selections and any agreed request |
| `pricing[].seller_rate` | Number | seller-set | What the publisher receives |
| `pricing[].price_valid_until` | Timestamp | seller-set | How long the posted rate holds. Distinct from the proposal's `valid_until` |
| `pricing[].currency` | String | seller-set | ISO-4217 |
| `pricing[].floor` | Number | seller-set | OPTIONAL. The seller's offer floor: the lowest rate it will consider at proposal time, so a `requestable` counter can be evaluated without a round trip. Not the downstream auction floor, and not a guarantee that bids at or above it will clear |
| `availability` | Object | derived | `{ unit, basis, as_of, granularity, type: forecast \| reservable, quantity }`. Recomputed against the buyer's selection |
| `commitment_bounds` | Object | seller-set | The envelope inside which a buyer may commit: `{ min_impressions, max_impressions, min_budget, max_budget }` |
| `commitment` | Object | settable | **The buyer's actual commitment.** See 5.6.1 |
| `hold_status` | Object | requestable | See 5.6.2 |
| `min_spend` | Number | seller-set | Minimum spend for this line item |
| `cancellation_policy` | Object | selectable | `available[]` of cancellation rights with `pricing` per option |
| `exclusivity` | Object | selectable | `available[]` of exclusivity terms with `pricing` |
| `creative_policy` | Object | seller-set | Content and category restrictions on creative |
| `requires` | Object | seller-set | OPTIONAL. Conditions that must hold in the same commitment for this line item to be committable. See 5.6.3 |

#### 5.6.1 commitment

Absent on a published standard proposal. Populated during composition. Frozen
when status becomes `agreed`.

| Key | Required | Meaning |
| :--- | :--- | :--- |
| `proposal_id` | REQUIRED | The proposal the commitment is made against |
| `version` | REQUIRED | The proposal `version` the commitment was priced against |
| `basis` | REQUIRED | `spend` \| `units` |
| `amount` | REQUIRED | The figure committed |
| `currency` | REQUIRED when `basis = spend` | ISO-4217 |
| `flight_start` | REQUIRED | The buyer's campaign start. **Distinct from `valid_from`** |
| `flight_end` | REQUIRED | The buyer's campaign end. **Distinct from `valid_until`** |
| `derived_units` | derived | Computed from `amount`, `agreed_rate` and `cost_method`. Informative, not binding |
| `idempotency_key` | REQUIRED | Buyer-generated, unique per commitment attempt |

An `idempotency_key` is opaque and scoped to one buyer and seller pair. The
seller MUST NOT interpret it.

The seller MUST reject a new commitment attempt whose `version` is not the
current version of the proposal named by `proposal_id`, whose proposal is past
`valid_until`, or whose `pricing[].price_valid_until` has passed. The rejection
MUST return the current version number, so the buyer can fetch it again. These
checks MUST be deterministic, as for `idempotency_key`.

For a replay from the same buyer of a commitment attempt the seller has
already processed, with the same `idempotency_key` and the same commitment
terms, the seller MUST return the original result and MUST NOT create a second
commitment. The version and expiry checks apply to a new attempt, not to
returning a stored result. Reusing an `idempotency_key` with different
commitment terms MUST produce an explicit conflict and MUST NOT create or
modify a commitment.

#### 5.6.2 hold_status

| Key | Meaning |
| :--- | :--- |
| `hold_available` | Whether this line item may be held |
| `hold_duration` | ISO-8601 duration the hold runs for |
| `hold_scope` | `line_item` \| `proposal` |
| `state` | `none` \| `requested` \| `held` \| `expired` \| `released` \| `converted` |
| `hold_expires_at` | Absolute timestamp, set when the hold is granted |

Transitions: `none` → `requested` → `held` → (`expired` | `released` |
`converted`). `converted` is terminal and occurs when the line item reaches
`agreed`.

#### 5.6.3 requires

| Key | Meaning |
| :--- | :--- |
| `all_of[]` | Line items that MUST all be in the same commitment |
| `any_of[]` | Line items of which at least one MUST be in the same commitment |
| `min_commitment[]` | Purchase-level thresholds: `{ line_item_id, basis, amount, currency }` |

```yaml
requires:
  all_of:  ["business-daily-display", "weather-app-ctv"]
  any_of:  []
  min_commitment:
    - { line_item_id: "business-daily-display", basis: spend, amount: 50000.00, currency: USD }
```

A bonus line item is a line item with `requires` and its own pricing, such as
a discounted `gross_rate` or `cost_method: flat` at 0. A conditional discount
is modelled as a separate line item that `requires` unlocks, not as a price
that changes according to the other line items selected. Every price remains
self-contained.

- References in `requires` MUST point to line items in the same proposal and
  version.
- A seller MUST reject a commitment that includes a line item whose `requires`
  is unmet. This check MUST be deterministic.
- If a line item referenced in `requires` becomes `sold_out` or `withdrawn`
  before commitment, the dependent line item becomes non-committable. After
  `agreed`, cancellation of a referenced line item is governed by the
  dependent line item's `cancellation_policy`.
- A seller MUST reject a proposal at publication if `requires` references
  form a cycle.

### 5.7 Guarantees

| Field | Type | Mutability | Description |
| :--- | :--- | :--- | :--- |
| `committed_metrics[]` | Array[Object] | requestable | `{ metric, value, basis }` tuples — `viewable_rate` for display, `completion_rate` for video/audio/CTV, an audience-modelled metric for DOOH. Seller declares a ceiling; a buyer MAY request above it |
| `measurement_source` | Object | selectable | `available[]` of `{ vendor, attribution_window, qualifier }` with `pricing`. Lets a buyer transact in its own currency |
| `shortfall_remedy` | Object | selectable | `available[]` from `makegood` \| `credit` \| `none`, plus `remedy_terms` |
| `reporting` | Object | selectable | `available[]` of `{ feed_type: log_level \| aggregate \| none, cadence, delivery_mechanism, metrics_provided[], latency }` with `pricing` |

### 5.8 Transaction eligibility

| Field | Type | Mutability | Description |
| :--- | :--- | :--- | :--- |
| `visibility` | Enum | seller-set | `public` \| `registry_gated` \| `named` |
| `required_credentials[]` | Array[Object] | seller-set | `{ type: iab_registry \| dsp_seat \| custom, scheme: api_key \| oauth2_client_credentials \| jwt_keypair \| oidc_federated \| none, issuer, id_required }` |
| `eligible_bidders[]` | Array[String] | seller-set | Permitted seat or buyer ids |
| `terms_acceptance_required` | Boolean | seller-set | Whether legal terms must be accepted before assent |
| `terms_ref` | Object | seller-set | OPTIONAL; REQUIRED when `terms_acceptance_required` is `true`. `{ url, sha256, version }`: the legal terms or IO template the buyer accepts at assent. Hash-pinned, so assent (§ 4.1) binds to an exact document |

`terms_ref` MUST be hash-pinned and frozen at `agreed`.

`exclusions` (§ 5.5) reveal the buyer's strategy. A seller MUST NOT disclose a
buyer's `exclusions` to any party other than that buyer.

### 5.9 Execution

| Field | Type | Mutability | Description |
| :--- | :--- | :--- | :--- |
| `buying_route` | Enum | seller-set | `DIRECT_PUBLISHER` \| `PUBLISHER_AD_SERVER` \| `SSP_PLATFORM` \| `DSP` \| `SEARCH_SOCIAL` |
| `transaction_mechanism` | Object | selectable | `available[]` from `DIRECT_IO` \| `PROGRAMMATIC_GUARANTEED` \| `PREFERRED_DEAL` \| `PRIVATE_AUCTION` \| `OPEN_AUCTION`. A seller MAY offer the same inventory through more than one |
| `serving_mode` | Enum | seller-set | `client_side` \| `ssai` \| `dai` |
| `deal_id_issuance` | String | derived | When and how the deal id is minted. Issued at commitment time |
| `buyer_requirements` | Object | mixed | `{ seat_required, dsp_allowed[] }` are seller-set; `{ dsp_seat_id, dsp_id, seat_owner_entity }` are supplied |
| `serving_platform` | String | seller-set | Where the line item serves |

### 5.10 External references and settlement

| Field | Type | Mutability | Description |
| :--- | :--- | :--- | :--- |
| `external_references[]` | Array[Object] | derived | `{ system, namespace, id, role }`. Replaces platform-specific key names. A buyer-owned reference such as a Prisma `io_id` is supplied. Documented `role` values: `io`, an IO id generated by an order management system and carried back on the line item; `agreement`, a buyer-held agreement id |
| `agreement_ref` | Object | seller-set | OPTIONAL. Reference to a master or annual agreement the line item is priced under: `{ agreement_id, parties[], type: upfront \| annual \| master_services \| other, valid_from, valid_until }`, where `parties[]` names the seller by its `seller_id` and the buyer by the id it holds in `eligible_bidders[]` (§ 5.8). An informative pointer; the agreement itself is outside this specification. A buyer-held agreement id travels as an `external_references[]` entry with `role: agreement` |
| `correlation_id` | String | derived | One identity for this line item's commitment, carried across every system it touches |
| `billing` | Object | seller-set | `{ supplier_id, billing_supplier_id, payment_terms, invoicing_party }`. Who delivers is not always who invoices |
| `supported_order_systems[]` | Array[String] | seller-set | Declared up front so the agent knows it will reconcile |

This specification does not define IO generation. IO creation is a connector
concern. OpenProposal supplies the agreed record, `terms_ref` and
`correlation_id` a connector needs.

---

## 6. Examples

Runnable copies of every example below live in [`examples/`](../examples/).

### 6.1 Proposal

See [`examples/proposal.yaml`](../examples/proposal.yaml).

### 6.2 Display line item — fully worked

Shows `selectable` audiences with per-option pricing, a catalog reference, a
buyer commitment, and `settable` bounds. See
[`examples/line-item-display.yaml`](../examples/line-item-display.yaml).

### 6.3 CTV line item

Shows a buyer commitment naming the `proposal_id` and `version` it was priced
against (§ 5.6.1). See
[`examples/line-item-ctv.yaml`](../examples/line-item-ctv.yaml).

Inspecting this line item's VAST creative is subject to section 5.4.

### 6.4 Audio line item

See [`examples/line-item-audio.yaml`](../examples/line-item-audio.yaml).

### 6.5 Bonus line item

A CTV line item unlocked by buying the display and CTV line items together,
priced on its own. See
[`examples/line-item-ctv-bonus.yaml`](../examples/line-item-ctv-bonus.yaml).

### 6.6 Publication manifest

A manifest (§ 2.3) listing the public line items of the example proposal. The
display line item is `registry_gated`, so it is not listed. See
[`examples/manifest.json`](../examples/manifest.json).

### 6.7 Rewarded video line item

Shows `placement` on in-app rewarded video, with OMID support that lets a
buyer select a third-party `measurement_source`. See
[`examples/line-item-rewarded-video.yaml`](../examples/line-item-rewarded-video.yaml).

---

## 7. Why this split

- **No inheritance mechanism to specify or debug.** Fields live at exactly one
  level, so there is no "overridable unless restated" rule to maintain.
- **The proposal reads as a pitch, not a schema dump.** `description`,
  `specifications`, `best_for` and `seasonality_notes` are what a model needs to
  decide whether to look further.
- **Every line item is independently transactable, in exactly one channel.** A
  buying agent can hand a single line item to a downstream system without
  resolving proposal-level defaults or cross-channel ambiguity.
- **Channel support cost one new field and one generalisation** — `channel`, and
  `committed_metrics[]` as tuples — rather than a schema fork per channel. The
  format registry, not OpenProposal, carries what is channel-specific about
  creative shape.
- **Composition resolves without a round trip.** Because the seller declares the
  option set and its pricing up front, a buyer agent performs constraint
  satisfaction rather than negotiation. Only genuinely out-of-envelope asks
  require the counterparty to respond.

**Templates and issued proposals (non-normative).**

- **Template:** seller-side only. It lives in the seller's own systems (its
  proposal store), is not part of the public object, and is never transacted
  directly.
- **Issued proposal:** what buyers see and commit against. Each has its own
  `proposal_id` per counterparty or destination, and may carry
  `proposal_template_id` (§ 4.1) to trace it back to its template.
- Buyer-specific terms, such as annual rates and named visibility, live on the
  issued proposal's line items: `visibility: named`, `eligible_bidders[]` and
  their own `pricing[]`.

**Relationships, agreements and IOs (non-normative).** Buyer–seller
relationships are expressed as issued proposals (`visibility: named`,
`eligible_bidders[]` set to that buyer, with the negotiated `pricing[]`) plus
the buyer agent's business rules. "Preferred partner" weighting is a buyer-side
ranking rule, not part of this specification. `agreement_ref` and `terms_ref`
(§ 5.10, § 5.8) point at the agreement and terms a line item is executed under;
IO generation happens through connectors.

---

## 8. Open questions

Comment is specifically invited on the following. Each has a tracking issue —
see [docs/open-questions.md](../docs/open-questions.md).

1. **Does per-field mutability belong in 3.0?** Sections 3 and 5 make
   composition part of the object. The alternative is a catalog format where a
   buyer selects whole line items and everything else is a round trip.
2. **Do seller catalogs (`catalog_ref`) belong in 3.0**, or should the object
   stay fully inline until a later version?
3. **Cross-channel guarantee comparability is unsolved.** Once one line item
   guarantees `viewable_rate` and another `completion_rate`, there is no
   normalised way for a buying agent to compare or optimise across them. Likely
   WS4, but worth stating rather than pretending 3.0 covers it.
4. **The format registry has no entries for `audio/*`, `ctv/*` or `dooh/*`.**
   `specs` delegates to a registry that cannot currently answer for half the
   declared channels.
5. **Is a `min_line_items` field needed** on the proposal to require a bundle
   purchase, or is that left to buyer discretion?
6. **Should `payment_terms` and `invoicing_party` be catalog references** rather
   than repeated on every line item, given they are usually identical across a
   seller's shelf?
7. **`environments[]` needs validation against real inventory.** The enum is
   proposed, not derived from implementation experience.

---

## Appendix A — Field index

Every field in the specification, in document order, with its mutability
marker. Generated from the body of this document; **if the two disagree, the
body is normative.**

| Field | Section | Type | Marker |
| :--- | :--- | :--- | :--- |
| `proposal_id` | 4.1 Identity and lifecycle | String | immutable |
| `version` | 4.1 Identity and lifecycle | Integer | derived |
| `seller_id` | 4.1 Identity and lifecycle | String | immutable |
| `seller_name` | 4.1 Identity and lifecycle | String | immutable |
| `type` | 4.1 Identity and lifecycle | Enum | immutable |
| `proposal_template_id` | 4.1 Identity and lifecycle | String | immutable |
| `status` | 4.1 Identity and lifecycle | Enum | derived |
| `assent` | 4.1 Identity and lifecycle | Object | derived |
| `valid_from` · `valid_until` | 4.1 Identity and lifecycle | Timestamp | seller-set |
| `brief_ref` | 4.1 Identity and lifecycle | String | supplied |
| `negotiation_history[]` | 4.1 Identity and lifecycle | Array[Object] | derived |
| `linked_execution` | 4.1 Identity and lifecycle | Enum | seller-set |
| `description` | 4.2 Agent comprehension | String | seller-set |
| `specifications` | 4.2 Agent comprehension | String/Object | seller-set |
| `best_for[]` | 4.2 Agent comprehension | Array[String] | seller-set |
| `not_suitable_for[]` | 4.2 Agent comprehension | Array[String] | seller-set |
| `seasonality_notes` | 4.2 Agent comprehension | String | seller-set |
| `line_item_id` | 5.1 Identity | String | immutable |
| `status` | 5.1 Identity | Enum | derived |
| `channel` | 5.1 Identity | Enum | immutable |
| `properties` | 5.2 Inventory composition | Object | selectable |
| `content_detail` | 5.2 Inventory composition | Object | seller-set |
| `environments` | 5.2 Inventory composition | Object | selectable |
| `placement` | 5.2 Inventory composition | Object | seller-set |
| `audiences` | 5.3 Audience reach | Object | selectable |
| `addressable_scale` | 5.3 Audience reach | Integer | derived |
| `activation_route` | 5.3 Audience reach | Object | selectable |
| `buyer_supplied` | 5.3 Audience reach | Object | supplied |
| `formats` | 5.4 Creative requirements | Object | selectable |
| `specs` | 5.4 Creative requirements | Object | seller-set |
| `third_party_tags` | 5.4 Creative requirements | Object | seller-set |
| `creative_delivery` | 5.4 Creative requirements | Object | seller-set |
| `assets[]` | 5.4 Creative requirements | Array[Object] | supplied |
| `materials_due` | 5.4 Creative requirements | Timestamp/Offset | requestable |
| `approval` | 5.4 Creative requirements | Object | seller-set |
| `production` | 5.4 Creative requirements | Object | selectable |
| `geo` | 5.5 Targeting envelope | Object | selectable |
| `device` | 5.5 Targeting envelope | Object | settable |
| `daypart` | 5.5 Targeting envelope | Object | settable |
| `time_zone` | 5.5 Targeting envelope | String | seller-set |
| `frequency_cap` | 5.5 Targeting envelope | Object | settable |
| `exclusions_accepted` | 5.5 Targeting envelope | Object | seller-set |
| `exclusions` | 5.5 Targeting envelope | Object | supplied |
| `pricing[]` | 5.6 Commercial terms | Array[Object] | mixed |
| `pricing[].cost_method` | 5.6 Commercial terms | Enum | seller-set |
| `pricing[].gross_rate` | 5.6 Commercial terms | Number | seller-set |
| `pricing[].agreed_rate` | 5.6 Commercial terms | Number | derived |
| `pricing[].seller_rate` | 5.6 Commercial terms | Number | seller-set |
| `pricing[].price_valid_until` | 5.6 Commercial terms | Timestamp | seller-set |
| `pricing[].currency` | 5.6 Commercial terms | String | seller-set |
| `pricing[].floor` | 5.6 Commercial terms | Number | seller-set |
| `availability` | 5.6 Commercial terms | Object | derived |
| `commitment_bounds` | 5.6 Commercial terms | Object | seller-set |
| `commitment` | 5.6 Commercial terms | Object | settable |
| `hold_status` | 5.6 Commercial terms | Object | requestable |
| `min_spend` | 5.6 Commercial terms | Number | seller-set |
| `cancellation_policy` | 5.6 Commercial terms | Object | selectable |
| `exclusivity` | 5.6 Commercial terms | Object | selectable |
| `creative_policy` | 5.6 Commercial terms | Object | seller-set |
| `requires` | 5.6 Commercial terms | Object | seller-set |
| `committed_metrics[]` | 5.7 Guarantees | Array[Object] | requestable |
| `measurement_source` | 5.7 Guarantees | Object | selectable |
| `shortfall_remedy` | 5.7 Guarantees | Object | selectable |
| `reporting` | 5.7 Guarantees | Object | selectable |
| `visibility` | 5.8 Transaction eligibility | Enum | seller-set |
| `required_credentials[]` | 5.8 Transaction eligibility | Array[Object] | seller-set |
| `eligible_bidders[]` | 5.8 Transaction eligibility | Array[String] | seller-set |
| `terms_acceptance_required` | 5.8 Transaction eligibility | Boolean | seller-set |
| `terms_ref` | 5.8 Transaction eligibility | Object | seller-set |
| `buying_route` | 5.9 Execution | Enum | seller-set |
| `transaction_mechanism` | 5.9 Execution | Object | selectable |
| `serving_mode` | 5.9 Execution | Enum | seller-set |
| `deal_id_issuance` | 5.9 Execution | String | derived |
| `buyer_requirements` | 5.9 Execution | Object | mixed |
| `serving_platform` | 5.9 Execution | String | seller-set |
| `external_references[]` | 5.10 External references and settlement | Array[Object] | derived |
| `agreement_ref` | 5.10 External references and settlement | Object | seller-set |
| `correlation_id` | 5.10 External references and settlement | String | derived |
| `billing` | 5.10 External references and settlement | Object | seller-set |
| `supported_order_systems[]` | 5.10 External references and settlement | Array[String] | seller-set |

---

## Appendix B — Fields by marker

| Marker | Count | Meaning | Fields |
| :--- | :--- | :--- | :--- |
| immutable | 7 | Set once at creation. Neither party may change it. | `proposal_id`, `seller_id`, `seller_name`, `type`, `proposal_template_id`, `line_item_id`, `channel` |
| seller-set | 36 | Seller sets and may revise while `draft` or `published`. | `valid_from` · `valid_until`, `linked_execution`, `description`, `specifications`, `best_for[]`, `not_suitable_for[]`, `seasonality_notes`, `content_detail`, `placement`, `specs`, `third_party_tags`, `creative_delivery`, `approval`, `time_zone`, `exclusions_accepted`, `pricing[].cost_method`, `pricing[].gross_rate`, `pricing[].seller_rate`, `pricing[].price_valid_until`, `pricing[].currency`, `pricing[].floor`, `commitment_bounds`, `min_spend`, `creative_policy`, `requires`, `visibility`, `required_credentials[]`, `eligible_bidders[]`, `terms_acceptance_required`, `terms_ref`, `buying_route`, `serving_mode`, `serving_platform`, `agreement_ref`, `billing`, `supported_order_systems[]` |
| selectable | 13 | Buyer chooses from a declared set. Resolves without assent. | `properties`, `environments`, `audiences`, `activation_route`, `formats`, `production`, `geo`, `cancellation_policy`, `exclusivity`, `measurement_source`, `shortfall_remedy`, `reporting`, `transaction_mechanism` |
| settable | 4 | Buyer sets a value within declared bounds. Resolves without assent. | `device`, `daypart`, `frequency_cap`, `commitment` |
| supplied | 4 | Buyer provides data or an artifact. | `brief_ref`, `buyer_supplied`, `assets[]`, `exclusions` |
| requestable | 3 | Buyer may ask outside the declared space. Requires seller assent. | `materials_due`, `hold_status`, `committed_metrics[]` |
| derived | 11 | Computed. Neither party sets it directly. | `version`, `status` (proposal), `assent`, `negotiation_history[]`, `status` (line item), `addressable_scale`, `pricing[].agreed_rate`, `availability`, `deal_id_issuance`, `external_references[]`, `correlation_id` |
| mixed | 2 | Sub-fields carry different markers; see the section. | `pricing[]`, `buyer_requirements` |

### What the distribution says

Of 80 fields, **24 are touched by the buyer** — 13 `selectable`, 4 `settable`, 4
`supplied` and 3 `requestable`. The remaining 56 are `seller-set`, `immutable`,
`derived` or `mixed`.

Only the 3 `requestable` fields require a round trip. Everything else the buyer
touches — 21 fields — resolves against bounds the seller declared up front. That
ratio is the design claim: composition is constraint satisfaction, and
negotiation is the exception.
