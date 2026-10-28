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
proposal's line items, unless the proposal explicitly mandates linked execution
through its binding terms.

### 2.1 Summary and full representations

Every line item has two representations.

**Summary Representation** — what a buying agent reads when screening many
sellers' shelves. A catalog response MAY return it. It MUST contain, per line
item:

`line_item_id` · `channel` · `content_detail` · property names ·
`formats.included[]` · `pricing.cost_method` · `pricing.gross_rate` ·
`min_spend` · `addressable_scale` · `committed_metrics[]` ·
`transaction_mechanism`

plus, from the parent proposal: `proposal_id` · `seller_name` · `description` ·
`valid_from` · `valid_until`.

`catalog_ref` values MUST remain unresolved in a summary.

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

Because audiences, properties and formats are `selectable`, `addressable_scale`
and `availability` MUST be recomputed against the buyer's actual selection. A
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
| `version` | Integer | derived | Monotonically increasing revision number |
| `seller_id` | String | immutable | IAB Tech Lab registry reference |
| `seller_name` | String | immutable | Canonical legal seller entity name, from the registry |
| `type` | Enum | immutable | `standard` \| `custom` |
| `status` | Enum | derived | `draft` \| `published` \| `under_review` \| `agreed` \| `withdrawn` \| `expired` |
| `assent` | Object | derived | Buyer and seller assent records and timestamps for the binding version. Signature scheme is WS1 |
| `valid_from` · `valid_until` | Timestamp | seller-set | ISO-8601 window the offer holds. **This is the offer window, not the campaign flight** |
| `brief_ref` | String | supplied | Reference to the buyer's brief. REQUIRED when `type` is `custom` |
| `negotiation_history[]` | Array[Object] | derived | Ordered, append-only. `{ version, actor: buyer \| seller, action: proposed \| countered \| accepted \| declined \| withdrawn, fields_changed[], at }`. Entries MUST NOT be edited or removed |

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
| `channel` | Enum | immutable | `display` \| `video` \| `audio` \| `ctv` \| `dooh` \| `native`. The discriminator for how the rest of the line item is read |

### 5.2 Inventory composition

| Field | Type | Mutability | Description |
| :--- | :--- | :--- | :--- |
| `properties` | Object | selectable | `available[]` of `{ id, name, domains, supported_formats }`, `included[]`, `pricing`, `max_select` |
| `content_detail` | Object | seller-set | Shows, series, sections, network verticals |
| `environments` | Object | selectable | `available[]` from `web_desktop` \| `web_mobile` \| `app_mobile` \| `ctv` \| `dooh` \| `audio_streaming` |

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

### 5.5 Targeting envelope

Each field declares bounds, not a value. A bare value means the field is
`seller-set`.

| Field | Type | Mutability | Description |
| :--- | :--- | :--- | :--- |
| `geo` | Object | settable | `allowed[]` of geo codes the buyer may select within |
| `device` | Object | settable | `allowed[]` of device categories |
| `daypart` | Object | settable | `allowed[]` of time windows |
| `frequency_cap` | Object | settable | `{ max: { min, max }, period, basis: device \| household \| listener }`. Basis matters: CTV typically caps at household, audio at listener |

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
| `pricing[].floor` | Number | seller-set | OPTIONAL. The lowest rate the seller will consider. Enables a `requestable` counter to be evaluated without a round trip |
| `availability` | Object | derived | `{ unit, basis, as_of, granularity, type: forecast \| reservable, quantity }`. Recomputed against the buyer's selection |
| `commitment_bounds` | Object | seller-set | The envelope inside which a buyer may commit: `{ min_impressions, max_impressions, min_budget, max_budget }` |
| `commitment` | Object | settable | **The buyer's actual commitment.** See 5.6.1 |
| `hold_status` | Object | requestable | See 5.6.2 |
| `min_spend` | Number | seller-set | Minimum spend for this line item |
| `cancellation_policy` | Object | selectable | `available[]` of cancellation rights with `pricing` per option |
| `exclusivity` | Object | selectable | `available[]` of exclusivity terms with `pricing` |
| `creative_policy` | Object | seller-set | Content and category restrictions on creative |

#### 5.6.1 commitment

Absent on a published standard proposal. Populated during composition. Frozen
when status becomes `agreed`.

| Key | Required | Meaning |
| :--- | :--- | :--- |
| `basis` | REQUIRED | `spend` \| `units` |
| `amount` | REQUIRED | The figure committed |
| `currency` | REQUIRED when `basis = spend` | ISO-4217 |
| `flight_start` | REQUIRED | The buyer's campaign start. **Distinct from `valid_from`** |
| `flight_end` | REQUIRED | The buyer's campaign end. **Distinct from `valid_until`** |
| `derived_units` | derived | Computed from `amount`, `agreed_rate` and `cost_method`. Informative, not binding |
| `idempotency_key` | REQUIRED | Buyer-generated, unique per commitment attempt |

A request carrying an `idempotency_key` already seen MUST return the original
result and MUST NOT create a second commitment.

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
| `external_references[]` | Array[Object] | derived | `{ system, namespace, id, role }`. Replaces platform-specific key names. A buyer-owned reference such as a Prisma `io_id` is supplied |
| `correlation_id` | String | derived | One identity for this line item's commitment, carried across every system it touches |
| `billing` | Object | seller-set | `{ supplier_id, billing_supplier_id, payment_terms, invoicing_party }`. Who delivers is not always who invoices |
| `supported_order_systems[]` | Array[String] | seller-set | Declared up front so the agent knows it will reconcile |

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

See [`examples/line-item-ctv.yaml`](../examples/line-item-ctv.yaml).

### 6.4 Audio line item

See [`examples/line-item-audio.yaml`](../examples/line-item-audio.yaml).

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
| `status` | 4.1 Identity and lifecycle | Enum | derived |
| `assent` | 4.1 Identity and lifecycle | Object | derived |
| `valid_from` · `valid_until` | 4.1 Identity and lifecycle | Timestamp | seller-set |
| `brief_ref` | 4.1 Identity and lifecycle | String | supplied |
| `negotiation_history[]` | 4.1 Identity and lifecycle | Array[Object] | derived |
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
| `geo` | 5.5 Targeting envelope | Object | settable |
| `device` | 5.5 Targeting envelope | Object | settable |
| `daypart` | 5.5 Targeting envelope | Object | settable |
| `frequency_cap` | 5.5 Targeting envelope | Object | settable |
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
| `committed_metrics[]` | 5.7 Guarantees | Array[Object] | requestable |
| `measurement_source` | 5.7 Guarantees | Object | selectable |
| `shortfall_remedy` | 5.7 Guarantees | Object | selectable |
| `reporting` | 5.7 Guarantees | Object | selectable |
| `visibility` | 5.8 Transaction eligibility | Enum | seller-set |
| `required_credentials[]` | 5.8 Transaction eligibility | Array[Object] | seller-set |
| `eligible_bidders[]` | 5.8 Transaction eligibility | Array[String] | seller-set |
| `terms_acceptance_required` | 5.8 Transaction eligibility | Boolean | seller-set |
| `buying_route` | 5.9 Execution | Enum | seller-set |
| `transaction_mechanism` | 5.9 Execution | Object | selectable |
| `serving_mode` | 5.9 Execution | Enum | seller-set |
| `deal_id_issuance` | 5.9 Execution | String | derived |
| `buyer_requirements` | 5.9 Execution | Object | mixed |
| `serving_platform` | 5.9 Execution | String | seller-set |
| `external_references[]` | 5.10 External references and settlement | Array[Object] | derived |
| `correlation_id` | 5.10 External references and settlement | String | derived |
| `billing` | 5.10 External references and settlement | Object | seller-set |
| `supported_order_systems[]` | 5.10 External references and settlement | Array[String] | seller-set |

---

## Appendix B — Fields by marker

| Marker | Count | Meaning | Fields |
| :--- | :--- | :--- | :--- |
| immutable | 6 | Set once at creation. Neither party may change it. | `proposal_id`, `seller_id`, `seller_name`, `type`, `line_item_id`, `channel` |
| seller-set | 29 | Seller sets and may revise while `draft` or `published`. | `valid_from` · `valid_until`, `description`, `specifications`, `best_for[]`, `not_suitable_for[]`, `seasonality_notes`, `content_detail`, `specs`, `third_party_tags`, `creative_delivery`, `approval`, `pricing[].cost_method`, `pricing[].gross_rate`, `pricing[].seller_rate`, `pricing[].price_valid_until`, `pricing[].currency`, `pricing[].floor`, `commitment_bounds`, `min_spend`, `creative_policy`, `visibility`, `required_credentials[]`, `eligible_bidders[]`, `terms_acceptance_required`, `buying_route`, `serving_mode`, `serving_platform`, `billing`, `supported_order_systems[]` |
| selectable | 12 | Buyer chooses from a declared set. Resolves without assent. | `properties`, `environments`, `audiences`, `activation_route`, `formats`, `production`, `cancellation_policy`, `exclusivity`, `measurement_source`, `shortfall_remedy`, `reporting`, `transaction_mechanism` |
| settable | 5 | Buyer sets a value within declared bounds. Resolves without assent. | `geo`, `device`, `daypart`, `frequency_cap`, `commitment` |
| supplied | 3 | Buyer provides data or an artifact. | `brief_ref`, `buyer_supplied`, `assets[]` |
| requestable | 3 | Buyer may ask outside the declared space. Requires seller assent. | `materials_due`, `hold_status`, `committed_metrics[]` |
| derived | 11 | Computed. Neither party sets it directly. | `version`, `status` (proposal), `assent`, `negotiation_history[]`, `status` (line item), `addressable_scale`, `pricing[].agreed_rate`, `availability`, `deal_id_issuance`, `external_references[]`, `correlation_id` |
| mixed | 2 | Sub-fields carry different markers; see the section. | `pricing[]`, `buyer_requirements` |

### What the distribution says

Of 71 fields, **23 are touched by the buyer** — 12 `selectable`, 5 `settable`, 3
`supplied` and 3 `requestable`. The remaining 48 are `seller-set`, `immutable`,
`derived` or `mixed`.

Only the 3 `requestable` fields require a round trip. Everything else the buyer
touches — 20 fields — resolves against bounds the seller declared up front. That
ratio is the design claim: composition is constraint satisfaction, and
negotiation is the exception.
