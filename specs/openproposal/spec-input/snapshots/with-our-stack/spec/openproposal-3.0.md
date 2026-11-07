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
- **Custom proposal** — built in response to a buyer's agent brief, referenced via `brief_id`.

### 1.1 Downstream standards

OpenProposal does not replace IAB Tech Lab execution standards. Each line item
lands in the one that the `transaction_mechanism` in effect (§ 5.9) maps to:

| `transaction_mechanism` | Downstream standard | `reference_type` (§ 5.10) | Change path |
| :--- | :--- | :--- | :--- |
| `direct_io` | OpenDirect 2.1 · Order + Line | `order`, `line` | An [OpenDirect 2.1 ChangeRequest](https://github.com/InteractiveAdvertisingBureau/OpenDirect/blob/82bc294314aba017fc639ba634aecc53adfd675f/OpenDirect.v2.1.final.md#object_changerequest) on the booked Line (`lineid`). `change_requests[]` (§ 4.4) records it against the baseline `VersionRef` (§ 2.2). A partial cancel uses ChangeRequestLine, and a full cancel uses Line `?cancel` at the effective date |
| `programmatic_guaranteed` | OpenDirect 2.1 · Order + Line, as the reservation; Deals API 1.0 · `Deal` | `order`, `line`, `deal` | The reservation: as for `direct_io`. The deal: as for `preferred_deal` |
| `preferred_deal` | Deals API 1.0 · `Deal` + OpenRTB 2.6 · `Deal` | `deal` | By agreement between implementers, against the same baseline. A full stop is `sellerstatus` 4 (archived) |
| `private_auction` | Deals API 1.0 · `Deal` + OpenRTB 2.6 · `Deal` | `deal` | As for `preferred_deal` |

Buying in the OpenRTB 2.6 open auction is outside this specification: with no deal
ID, no bid request can name a line item.

The deal rows name no operation: the Deals API, published as the
[Deal Sync API 1.0](https://github.com/IABTechLab/deal-api/blob/3028ddcb8d5faea44bdab272aeaa9be6b5980f81/deal1.0.md#matching-bid-requests-to-deals), "does not support deal revisions".

**Deals API handoff.** A line item agreed under a deal mechanism (§ 5.9) becomes a
Deals API 1.0 `Deal`. The system named by `deal_origin` (§ 5.9) pushes the `Deal` to
the DSP named by `buyer_requirements.seats.dsp`. The deal ID is in that system's namespace: it
assigns the ID, or accepts one the seller supplies. The `Deal` takes these
values from the agreed line item:

| Deals API 1.0 | OpenRTB 2.6 | From the agreed line item |
| :--- | :--- | :--- |
| `id` | `Deal.id`, `Bid.dealid` | None: the ID in `deal_origin`'s namespace. The `external_references[]` entry with `reference_type: deal` records it (§ 5.10) |
| `origin` | | `deal_origin` |
| `seller` | | The proposal's `seller.domain` |
| `wseat` | `Deal.wseat` | `buyer_requirements.seats.ids[]` |
| `adtypes` | | From `channel`: `display` 1, `video` 2, `audio` 3, `native` 4, and `ctv` 2 when `placement.plcmt` is present. Otherwise unset: the record doesn't state the ad's type |
| `terms.startdate`, `terms.enddate` | | `commitment.flight.start`, `commitment.flight.end` |
| `terms.countries` | | The countries of `geo` or `markets` in effect, in alpha-3 (below), without a country excluded whole. Unset when the line item declares neither |
| `terms.dealfloor` | `Deal.bidfloor` | `agreed_rate` of the committed `pricing[]` entry |
| `terms.cur` | `Deal.bidfloorcur` | That entry's `currency`, always sent |
| `terms.pricetype` | `Deal.at`, the same value, omitted for Dynamic (0) | That entry's `price_type`, always sent |
| `terms.guar` | `Deal.guar` | `1` when the mechanism in effect is `programmatic_guaranteed`, `0` otherwise |
| `terms.units` | | `commitment.amount` when `basis` is `units`, otherwise `derived_units` (§ 5.6.5) |
| `terms.totalcost` | | The seller total (§ 5.6.5) |
| `ext.baseline` | | The agreed baseline `VersionRef` (§ 2.2), with `seller_domain`, so a DSP can join the deal to its record. OPTIONAL. The Deals API 1.0 doesn't define this key |

`commitment.flight.end` and `terms.enddate` are the flight's last second,
inclusive. The Deals API 1.0 doesn't say whether `enddate` is inclusive, so this mapping
states it.

`terms.dealfloor` and `Deal.bidfloor` are prices per thousand impressions, so this
table maps a `CPM` entry. Other cost methods have no mapping yet.

A `GeoCode` (§ 5.5) converts for the
[OpenRTB 2.6 `Geo` object](https://github.com/InteractiveAdvertisingBureau/openrtb2.x/blob/1debba8001f40eb14597102dec3205afddf811d4/2.6.md#objectgeo):
`country` takes the ISO 3166-1 alpha-3 code of the country, and `region` takes the
part of an ISO 3166-2 code after the hyphen.

`terms.countries` takes the same alpha-3 code. The Deals API 1.0 says "ISO-3166-3", and
this mapping reads that as ISO 3166-1 alpha-3. The list names whole countries, so `US`
minus `US-TX` sends `USA`, and `geo` in the agreed record holds the exclusion. The record
holds no country for an extension term, so the system that pushes the `Deal` supplies the
one the term lies in.

The line item's `status` ends at `agreed` (§ 5.1). After the push, the deal's
state is the Deals API `sellerstatus` and, for each seat, `BuyerStatus.status`.
OpenProposal has no field for either.

**OpenDirect handoff.** A `direct_io` line item that books in
[OpenDirect 2.1](https://github.com/InteractiveAdvertisingBureau/OpenDirect/blob/82bc294314aba017fc639ba634aecc53adfd675f/OpenDirect.v2.1.final.md#object_line),
and the reservation of a `programmatic_guaranteed` line item, become a `Line` in an
`Order`. OpenDirect says who acts: on the seller's OpenDirect server, the buyer adds
the `Order` to its `Account`, adds the `Line`, and reserves or books it. The `Order`
and `Line` take these values from the agreed line item:

| OpenDirect 2.1 | From the agreed line item |
| :--- | :--- |
| `Order.currency` | The committed `pricing[]` entry's `currency` |
| `Line.startdate`, `Line.enddate` | `commitment.flight.start`, `commitment.flight.end` |
| `Line.ratetype` | That entry's `cost_method`: `CPM`, `CPMV`, and `CPC` as written, `FLAT` as `FlatRate`, and `TIME` with `rate_unit: day` as `CPD` |
| `Line.rate` | That entry's `agreed_rate` |
| `Line.qty` | `commitment.amount` when `basis` is `units`, `1` for `FLAT`, otherwise `derived_units` (§ 5.6.5) |
| `Line.cost` | The seller total (§ 5.6.5) |
| `Line.frequencycount`, `Line.frequencyinterval` | `frequency_cap.count` in effect, and `frequency_cap.period` in OpenDirect's spelling, with `flight` as `LineDuration` |

Any other `cost_method`, and `TIME` with another `rate_unit`, has no `ratetype` and no
mapping here. A `direct_io` line item under one books in another order system, which
its `order` entry names (§ 5.10), and changes there. OpenDirect's cap counts a unique user,
so it has no key for `frequency_cap.per`.

The record holds no value for `Order.name` and `Line.name`, or for `Order.accountid`,
`Order.publisherid`, `Order.advertiserbrandid`, and `Line.productid`, which name the
server's own `Account`, `Organization`, `AdvertiserBrand`, and `Product` resources.
OpenDirect 2.1 has the buyer obtain those ids from the publisher and its server, and no
key here says which `Product` a line item books. The ids of the `Order` and the `Line`
go in `external_references[]`, and the `Line`'s state is its `bookingstatus`. OpenProposal has no field for it.

### 1.2 Relationship to other AAMP artifacts

OpenProposal is normative for the proposal and line-item object: its fields,
their mutability, the declared option space, and the binding record. It is also
normative for the lifecycle of the object to its terminal statuses, and for what
a section of this document says a request or response carries, such as `errors[]`
(§ 2.4), an `AvailabilityRead` (§ 3.3), and a `Commit` and its `CommitResult` (§ 5.6.1).

OpenProposal is not normative for the envelope or binding of a message, or the
mapping of its values to the types of the AAMP wire and lifecycle contract
(provisional name), including monetary values. It is not normative for replay
semantics beyond the rule in § 5.6.1, for any lifecycle after `agreed`, or for how a
message states the buyer's `Party`, the form of a brief, or how an issued proposal
reaches the buyer. These belong to that contract.

That contract is not yet published on an IAB Tech Lab standards track. The nearest
artifact is the pre-release [`iab-agentic-primitives`](https://github.com/IABTechLab/iab-agentic-primitives/blob/ee9ea3c1c612b1be6ae00b75e0ab1b81435f62cc/README.md) library,
version 0.5.1. Its [OpenAPI 3.1 file](https://github.com/IABTechLab/iab-agentic-primitives/blob/ee9ea3c1c612b1be6ae00b75e0ab1b81435f62cc/spec/openapi/iab-agentic-api.yaml) and
JSON Schemas define quote, deal, negotiation, and change request messages, and the
IAB Tech Lab reference buyer and seller agents exchange the first three. Those
messages carry no proposal, `Commit`, or `errors[]`, so they are a model for the
binding, not the binding itself. Where they differ from this document, such as money
in integer micros or the replay rule in § 5.6.1, this document governs.

The correspondence between values defined in this document and the values of that
contract (status, negotiation actions, transaction mechanism, money, hold status) is for the
[AAMP hub](https://github.com/IABTechLab/AAMP/blob/0f3eaff7a979df835f6bee5290333c8e3666c95d/README.md)
to maintain. This document references that correspondence and does not define it.
Until that contract is published on an IAB Tech Lab standards track, the
correspondence is informative and this document governs. Once it is published,
where the two documents disagree on a concern this section assigns to the contract,
the contract governs. Where they disagree on a concern this section assigns to
OpenProposal, this document governs.

**Identity.** Three questions about a party stay separate, for the buyer and the
seller alike. An answer to one is not an answer to another.

| Layer | Question | Answered by | Owner | In the proposal object |
| :--- | :--- | :--- | :--- | :--- |
| Message authentication | Which origin sent this request or response? | An [HTTP Message Signature](https://www.rfc-editor.org/rfc/rfc9421), with the key in that origin's [Web Bot Auth](https://datatracker.ietf.org/doc/draft-ietf-webbotauth-httpsig-protocol/) directory | This specification's Web Bot Auth profile (§ 2.8) | Nothing. The object never carries or re-proves it |
| Authorization | What may this party, or its agent, do? | The seller's eligibility rules; a mandate the principal publishes or signs | This specification for the rules (§ 5.8); the AAMP authority document (provisional name) for mandates | The rules only, never the proof |
| Legal assent | Which legal entity agreed to which bytes? | Two matching `assent[]` entries over one `record_digest`, with both parties named in the record; as optional evidence, the signed messages that carried them | This specification for the record, digest, entry, and what each party keeps (§ 4.1.1, § 4.1.2); § 2.8 for how a message is signed and its key found | Parties, digest, entries |

A message signature proves an `https` origin. It does not prove which party that
origin speaks for: a hosted agent's origin is the host's, and a mandate the party
publishes or signs connects them. An `assent[]` entry travels in the body of a
signed message, as optional evidence, and § 4.1.2 states when the signature
attributes it to a party. Reading a public file (§ 2.3) needs none of this.

**After `agreed`.** This specification's lifecycle ends at `agreed`. The
downstream standard executes against the agreed line item as baseline: the
`VersionRef` (§ 2.2) that names the line item and the `version` of its agreed
record (§ 4.1.2). `external_references[]` (§ 5.10) holds the ids that join it to
downstream systems. The parties request and apply any change to its
terms downstream, against the options selected in that record,
`cancellation_policy` and `shortfall_remedy` included. A change is not a state or
action of this object, and it changes no agreed term; `change_requests[]` (§ 4.4)
records the request beside the agreed terms. The applying system answers which
terms are in force.

NOTE: The IAB Tech Lab
[`iab-agentic-primitives`](https://github.com/IABTechLab/iab-agentic-primitives/blob/ee9ea3c1c612b1be6ae00b75e0ab1b81435f62cc/README.md)
repository defines a post-booking change request and its lifecycle
(`ChangeRequest`, `ChangeRequestLifecycle`). `change_requests[]` (§ 4.4) takes the
OpenDirect 2.1 fields, not that model. A change request made under it against an
agreed line item is expected to name the baseline by the identity in this section.
Defining that reference is a matter for that repository.

---

## 2. Object shape

```
Proposal          → the merchandising pitch, identity, lifecycle state and assent
packages[]        → optional: sets of line items sold only together
line_items[]      → buyable units, each in exactly one channel
```

**No-inheritance rule.** A field on a line item MUST NOT inherit its value from
the proposal or from a sibling line item. There is no "overridable unless
restated" semantics anywhere in this specification. Every term of a line item is
on the line item. The proposal supplies only identity, `spec_version`, the offer
window, `version`, and its packages. No line item names another line item: what
applies to several line items is on the package that holds them (§ 4.1.4).

**Subsettable proposals.** A buyer MAY select and commit any subset of a
proposal's `line_items[]`. A package is sold only whole, and its add-ons only with
it (§ 4.1.4).

### 2.1 Summary and full representations

Every proposal and every line item has two representations.

**Full Representation:** every field the object holds, with a proposal's line items,
in packages or not, in their Full Representation. A full fetch MUST return it, except
for line items and packages the requester may not read (§ 5.8).

**Summary Representation:** what a buying agent reads when screening many
sellers' shelves. A manifest entry holds it (§ 2.3), and a response over the message binding
(§ 1.2) MAY carry it. A summary is a strict path
subset of the full object: a listed path has the type and value it has in the
Full Representation, it appears when the full form has it, and no other path
appears. A summary's own table adds keys beside these paths: the `line_items[]` and
`packages[]` of `ProposalSummary`, whose entries are summaries.

**`LineItemSummary`** lists these paths of a line item (§ 5):

```text
line_item_id
channel
environments.available[]
episodes
programs.available[].id
programs.available[].content.series
programs.available[].content.title
placement.reward
placement.instl
placement.plcmt
placement.skip
placement.feed
break_position.available[].id
break_position.available[].delay
break_position.available[].slotinpod
properties.available[].id
properties.available[].name
properties.available[].domains[]
properties.available[].apps[].store
properties.available[].apps[].bundle
properties.available[].child_audience
properties.available[].seller_relationship
properties.available[].venue_type
audiences.available[].id
audiences.available[].name
formats.included[]
geo
markets
pricing[].pricing_id
pricing[].cost_method
pricing[].list_rate
pricing[].currency
pricing[].price_type
pricing[].unit_bounds
commitment_bounds
addressable_scale
committed_metrics[]
delivery_counting.impression_multiplier.impression_type
delivery_counting.impression_multiplier.source_type
required_credentials[]
buyer_requirements.allowed_dsps[]
transaction_mechanism.available[]
```

`ProposalSummary` lists these paths of a proposal (§ 4):

```text
proposal_id
version
seller.domain
seller.legal_name
description
offer_window
```

**`ProposalSummary`** adds this key:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `line_items[]` | Array[LineItemSummary] | REQUIRED when the full form holds `line_items[]` | The full form's line items, each as a summary. In a manifest entry, only those § 2.3 lists |
| `packages[]` | Array[PackageSummary] | REQUIRED when the full form holds `packages[]` | The full form's packages, each as a summary. In a manifest entry, only those § 2.3 lists |

**`PackageSummary`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `package_id` | String | REQUIRED | The package's `package_id` (§ 4.1.4) |
| `line_items[]` | Array[LineItemSummary] | REQUIRED | Its `line_items[]`, each as a summary |
| `add_ons[]` | Array[LineItemSummary] | OPTIONAL | Its `add_ons[]`, each as a summary. In a manifest entry, only those § 2.3 lists |
| `min_commitments[]` | Array[MinCommitment] | OPTIONAL | Its `min_commitments[]` |

### 2.2 Shared types

One concept has one type, and every field that holds the concept uses it. A field
that holds a shared type states what the value means there, not its form. Its row
MAY narrow the type for that field, by requiring a key the type leaves OPTIONAL or by
limiting the values or count the type allows, and says so. A row never loosens a
shared type or changes its form.

| Type | Form | Rules |
| :--- | :--- | :--- |
| `Digest` | String of 71 characters: `sha256:` followed by the 64 lowercase hexadecimal characters of the SHA-256 of its input | The value carries the algorithm, and a field name never names it. `sha256` is the only algorithm in this version. Each field that holds a `Digest` states its input |
| `Domain` | String: lowercase ASCII, internationalized labels in A-label form ([RFC 5890](https://www.rfc-editor.org/rfc/rfc5890)), with no scheme, port, path, or trailing dot | Producers MUST write this form. Consumers MUST compare byte for byte and MUST NOT normalize a value before comparing it. A value read from ads.txt or sellers.json is converted to this form before comparison |
| `RegistrableDomain` | A `Domain` that is the [Public Suffix List](https://publicsuffix.org/) registrable domain, taken over the whole list, PRIVATE section included | It names a business |
| `Side` | `buyer` \| `seller` | It says which side, never who that side is. `Party` says who |
| `ProposalStatus` | `draft` \| `published` \| `under_review` \| `agreed` \| `withdrawn` \| `expired` | A proposal's `status`, computed by § 4.3.3 |
| `LineItemStatus` | A `ProposalStatus`, or `sold_out` | A line item's `status`, moved as § 4.3.2 states |
| `ApprovalStatus` | `PENDING` \| `APPROVED` \| `REJECTED` | An approval outcome, in the spelling of OpenDirect 2.1's ChangeRequest `status` |
| `Measurer` | A `Side`, or a `RegistrableDomain` | Who counts or measures. A seller writes `seller`, never its own domain. Two values name one party only when they are equal byte for byte. A `qualifier` beside a value names a product or method of that party and is not compared |
| `EntryRef` | String: `<domain>/<collection>/<entry_id>@<version>`, with no `/` or `@` inside a part | A named entry at one exact version, whose content does not change. `<domain>` is a `Domain`. It carries no digest |
| `VocabularyTerm` | String: a bare core term, or `<domain>:<term>` with `<domain>` a `Domain` the definer controls. A term is ASCII letters, digits, `_`, and `-` | See below |
| `CalendarUnit` | `hour` \| `day` \| `week` \| `month` | A calendar bucket |
| `TimeUnit` | A `CalendarUnit`, or `flight` | `flight` is the whole of `commitment.flight` |
| `IntegerFlag` | Integer: `0` (no) \| `1` (yes) | A yes or no that another standard writes as an integer. Each field says what `1` affirms |
| `Amount` | Number within the limits of § 4.1.1 | Money. It carries no currency: § 5.6 states which one it reads in |
| `Fraction` | Number from 0 to 1 | A proportion |
| `FractionDelta` | Number greater than -1 | Used only by `delta_fraction` (§ 3.1) |
| `Instant` | String: an RFC 3339 `date-time` in whole seconds, ending in `Z` | A point in time. One written form, so one instant has one digest input |
| `Duration` | String: the ISO 8601 grammar of RFC 3339 Appendix A without its week form (`P14D`, not `P2W`) | A length of time. A comparison names its anchor. A length within the playback of an ad or a placement, such as a play, view, read, loop, slot, or refresh, is instead an Integer whose key ends `_s` or `_ms`, except a key imported from another standard, which keeps its spelling (§ 2.6) |
| `IanaZone` | String: a name in the [IANA time zone database](https://www.iana.org/time-zones), such as `America/New_York` or `UTC` | A time zone |
| `ZoneName` | An `IanaZone`, or `viewer_local` | `viewer_local` is where the ad renders. On a `dooh` line item that is each screen's own zone, which its `time_zone` names when present |
| `Url` | String: an absolute `http` or `https` URL ([RFC 3986](https://www.rfc-editor.org/rfc/rfc3986)) | A location a client can fetch |
| `HttpsUrl` | A `Url` whose scheme is `https` | A location fetched over TLS |
| `FieldPointer` | String: a JSON Pointer ([RFC 6901](https://www.rfc-editor.org/rfc/rfc6901)) | A location in the object this specification defines |
| `Ext` | `Map[Domain, Object]` | The extension container. § 2.5 states its rules |

**`VocabularyTerm` rules.** A field that takes a `VocabularyTerm` lists its core
terms. Anyone MAY define an extension term. Terms compare byte for byte. A
published meaning never changes; a changed meaning takes a new term. IAB Tech Lab
keeps core lists apart from the schema, so a new core term needs no schema change.
A receiver that doesn't know a term treats the option or entry that holds it as
unavailable. A term in an `Array[VocabularyTerm]` is not an entry of its own: it
belongs to the option or entry that holds the array. Where the term binds outside
any option or entry, the receiver skips the line item and doesn't reject the
proposal because of it. For a `channel` (§ 5.1.1) or `cost_method` (§ 5.6.5) term,
these effects are a MUST. A receiver never assents to what it can't read. A field MAY
state another effect.

**`DocumentRef`** pins a binding document. The object is open, so its publisher can
add a version or a date. It is never inlined. The publisher keeps every version
retrievable, and the counterparty stores a copy.

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `url` | HttpsUrl | REQUIRED | The document. It MAY need authentication |
| `digest` | Digest | REQUIRED | Over the exact bytes served, with no content coding |

**`VersionRef`** locates an offer at a version. It carries no digest. A `proposal_id`
is unique only within a `seller.domain` (§ 4.1): a `VersionRef` inside a proposal
resolves against that proposal's `seller`, and one outside a proposal carries
`seller_domain`.

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `proposal_id` | String | REQUIRED | The proposal |
| `version` | Integer | REQUIRED | The proposal's `version` |
| `line_item_id` | String | OPTIONAL | A line item in that version |
| `seller_domain` | RegistrableDomain | REQUIRED when the `VersionRef` is outside its proposal | The proposal's `seller.domain` |

**`Party`** names a legal party. `domain` is the identifier, and `registry_id` is
an attestation. An absent or unresolvable `registry_id` MUST NOT make a document
malformed, and a consumer MUST ignore a resolved entry whose verified domain is
not `domain`. The Agent Registry defines its reference format and how it exposes the
verified domain.

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `domain` | RegistrableDomain | REQUIRED | The party's domain |
| `legal_name` | String | OPTIONAL | The party's legal name. A `registry_id` entry that applies can attest it; the value alone attests nothing |
| `registry_id` | String | OPTIONAL | An IAB Tech Lab Agent Registry reference for the entity controlling `domain` |

**`SeatRef`** names a buyer's seats. A seat always travels with its DSP.

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `dsp` | RegistrableDomain | REQUIRED | The DSP's primary domain |
| `ids[]` | Array[String] | OPTIONAL | The ids the DSP issues, the same values OpenRTB 2.6 carries in `Deal.wseat` |

**`TaxonomyCodes`** holds codes in one taxonomy. Each field that holds it names the
list `taxonomy` comes from and whether an id covers its descendants.

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `taxonomy` | Integer | REQUIRED | A value from the list the field names |
| `ids[]` | Array[String] | REQUIRED | Ids in that taxonomy |

**`Interval`** is an absolute window, with `end` later than `start`.

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `start` | Instant | REQUIRED | The first second |
| `end` | Instant | REQUIRED | The last second, inclusive |

**`Range`** bounds a value of type `T`, written `Range[T]`. At least one bound is
present, and `min` is no greater than `max`.

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `min` | T | OPTIONAL | The lower bound |
| `max` | T | OPTIONAL | The upper bound |

### 2.3 Publication

A seller MAY publish `https://<seller.domain>/.well-known/openproposal.json`, a
`ProposalManifest`.

**`ProposalManifest`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `generated_at` | Instant | REQUIRED | When the seller generated the file |
| `spec_version` | String | REQUIRED | The version of this specification the file follows |
| `proposals[]` | Array[ManifestEntry] | REQUIRED | One per listed proposal |
| `hold_limits` | HoldLimits | OPTIONAL | The most holds (§ 5.6.2) the seller grants at once across its line items |

**`ManifestEntry`** holds the keys of `ProposalSummary` (§ 2.1) and this one:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `full_url` | Url | REQUIRED | Where the second phase fetches the Full Representation |

- At least one of `ETag` and `Last-Modified` is REQUIRED, so buyers can poll cheaply.
  § 8 asks whether both are.
- Only shared proposals (§ 4.3) appear, and within them only line items whose
  `visibility` (§ 5.8) is `public` and whose `status` is `published`.
  `registry_gated` and `named` line items do not. A package appears only when
  every line item in its `line_items[]` does, with only the add-ons that do.
- A buyer discards an entry whose `seller.domain` differs from the domain in the
  URL it requested, before any redirect.
- `full_url` returns only what the requester may read (§ 5.8), so a request with
  no authenticated identity gets only `public` line items.
- Manifest entries MUST match the current version of each proposal. A stale
  entry is a seller error.

A seller that limits concurrent holds SHOULD declare the limit in `hold_limits`.

**`HoldLimits`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `per_buyer` | Integer | OPTIONAL | Holds whose `status` is `held` on proposals issued to one `buyer.domain` |
| `per_advertiser` | Integer | OPTIONAL | Holds whose `status` is `held` for one advertiser, counted by the `commitment.advertisers[]` in each hold's `requested_terms`. A hold that names several advertisers counts once for each |

- A seller declines a hold request that would exceed a declared limit (§ 5.6.2).
- A seller that declares `per_advertiser` MAY decline a hold request whose
  `requested_terms` names no advertiser.
- The holds on the line items in a package's `line_items[]`, which move as a unit
  (§ 4.1.4), count as one.
- Lowering a limit doesn't release a hold already granted.
- A seller that declares `hold_limits` publishes the manifest even when `proposals[]`
  is empty.

Two-phase flow:

1. **Discover:** fetch the manifest and screen the summaries. No language model
   is required.
2. **Propose:** fetch the Full Representation of shortlisted line items from
   `full_url`. Asks, holds, and commits run on a proposal issued to the buyer
   (§ 4.3).

### 2.4 Errors

A party that rejects a request MUST return `errors[]`, one or more
`ErrorObject`s. This specification defines the object. The message binding that
carries the request carries the errors.

A seller's decline of a resolved `commitment`, or of a hold, answers a valid
request and is not an error. What a party answers when a request fails message
authentication is § 2.8's to state.

**`ErrorObject`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `code` | VocabularyTerm | REQUIRED | A core code (below) or an extension code |
| `detail` | String | REQUIRED | Human-readable. A receiver SHOULD NOT parse it |
| `pointer` | FieldPointer | OPTIONAL | Into the object this specification defines that the request carries, to the value that caused the error |
| `version` | Integer | REQUIRED when the request names a proposal the requester may read | The proposal's `version` when the error was decided |
| `retry` | Enum | REQUIRED | `same` \| `refetch` \| `none`. `same`: the same request can succeed later. `refetch`: a new attempt, composed on the current `version`, can succeed. `none`: only a changed request can succeed. On a `commit`, `same` keeps the `idempotency_key` and such an error is not a stored result (§ 5.6.1), and `refetch` and `none` take a new `idempotency_key` |

Core codes: `validation` \| `not_found` \| `not_offered` \| `unresolved_reference` \|
`not_committable` \| `stale_version` \| `expired` \| `idempotency_conflict` \|
`not_eligible` \| `record_mismatch`.

| `code` | Returned when |
| :--- | :--- |
| `validation` | A value breaks a rule of this specification and no other code applies |
| `not_found` | A named proposal or line item does not exist, or the requester may not read it (§ 5.8) |
| `not_offered` | A buyer value is outside what the seller declared (§ 3.1, § 3.2, § 4.3.2, § 5.3, § 5.5, § 5.6, § 5.6.1), or a buyer asks for a hold where `hold_terms` offers none (§ 5.6.2) |
| `unresolved_reference` | A `DocumentRef` (§ 2.2) does not resolve, or its content does not match its `digest` |
| `not_committable` | A line item's `status` rules out an ask (§ 4.3.2), a `commit` names part of a package or an add-on without its package (§ 4.1.4), a live `commitment` entry already names a line item (§ 4.1.2), or a seller rejects a `commit` before `offer_window.start` (§ 5.6.1) |
| `stale_version` | An ask is stale (§ 4.1.3) |
| `expired` | `offer_window.end` or `price_valid_until` has passed |
| `idempotency_conflict` | An `idempotency_key` is reused with a different `Commit` (§ 5.6.1) |
| `not_eligible` | The buyer or the sender fails an eligibility or authority check the seller applies (§ 5.8) |
| `record_mismatch` | A `record_digest` in the request does not equal the one the receiver recomputes, and § 5.6.1 gives no other code (§ 4.1.1) |

An `ErrorObject` is open. A receiver that does not recognize a code, or a key of
the object, acts on `retry`.

Informative: over HTTP, `validation`, `not_offered`, and
`unresolved_reference` fit 400 Bad Request; `not_eligible` 403 Forbidden;
`not_found` 404 Not Found; `not_committable`, `stale_version`, and
`record_mismatch` 409 Conflict; `expired` 410 Gone; `idempotency_conflict` 422
Unprocessable Content. An error with `retry: same` fits 503 Service Unavailable.

### 2.5 Extensions

The proposal, each line item, and each `change_requests[]` entry (§ 4.4) MAY carry
`ext`, an `Ext`. Each key MUST be a `Domain` that its owner controls, and each value
is an object that the owner defines. A seller's own entries MUST use its
`seller.domain` as the key.

```yaml
ext:
  examplepub.example: { placement_code: "BD-ROS-300x250-Q4" }
```

- An `ext` entry MUST NOT change the meaning of a field this specification
  defines. A term the counterparty must understand to transact MUST NOT be an
  `ext` entry; it is a field or a vocabulary term.
- A receiver MUST ignore an `ext` entry it does not understand, and MUST NOT
  reject a document because of it. It MUST keep `ext` unchanged when it
  stores or forwards the document.
- In an object whose keys this specification lists, a key outside `ext` that
  it does not list is invalid. An object whose content another definition
  sets, such as a `FormatSpec`'s `spec` (§ 5.4), is unaffected, and so are the
  open objects `DocumentRef` (§ 2.2), `ErrorObject` (§ 2.4), and `CostParameters`
  (§ 5.6.5).
- On the proposal and a line item, `ext` is part of the Full Representation and
  of the record frozen at `agreed` (§ 4.1.1), and a seller change to it is a
  revision. On a `change_requests[]` entry, it is outside the record, as the
  entry is (§ 4.4).
- Apart from an unknown term (§ 2.2), a receiver MAY skip a whole line item it
  cannot read, without assenting to it. It MUST NOT keep a line item after removing
  fields from it.

### 2.6 Table and naming conventions

**Tables.** A field table has the columns Field, Type, Required, Mutability, and
Description. A key table has the columns Key, Type, Required, and Meaning, and MAY
add a last column that names a source standard. The key table of a `mixed` field adds
Mutability as its last column. A row names one key, and a key that holds an array ends
`[]`. A key table follows a lead-in that names its type in bold. The type of an object
option in a `Selectable[T]` ends `Option`.

A value table has one row per value of a list. Its first header cell is the code name
of the key that holds the list. Its first column equals the list, so it defines no
second one, unless the text names the table as the list. The § 2.2 table has one row
per shared type. A Form that adds a value to a type reads ``A `T`, or `b` ``, and one
that adds a second type reads ``A `T`, or a `U` ``. The § 3 table
has one row per marker. Any other table states rules as prose does, and defines no
key, type, or list.

**Presence.** A Required cell is `REQUIRED`, `OPTIONAL`, `RECOMMENDED`, or `REQUIRED
when <condition>`. Presence is relative to the object that holds the key, and a row
that narrows a shared type (§ 2.2) may require a key of it. A key that must be absent
under a condition says so in its Meaning or Description. A lead-in may limit its
table's keys instead, with `holds exactly one key` or `At least one <noun> is present`.

**Types.** A Type cell holds `String`, `Integer`, `Number`, `Boolean`, `Enum`,
`Object`, a shared type (§ 2.2), a type its section names, or a named key table.
`Array[T]`, `Map[K, V]`, `Range[T]`, `Selectable[T]` (§ 3.1), `Settable[T]`,
`Narrowing[T]`, and `SettableRange[T]` (§ 3.2) take other types. `T`, `K`, and `V`
stand for a type's arguments, and a Type cell inside that type's table may name them.
`Enum` is a closed list of strings, written in the row that uses it, and a generic
never takes it: a list a generic takes has a name. A closed list of integers written in a row has Type `Integer`.
`Object` holds keys that another definition sets. A lead-in that reads "`X` holds the
keys of `Y`" gives `X` every key of `Y`, with the rules `Y` states on them, and the rows
of its own table. The keys sit flat in `X`, and `X` doesn't repeat them. `Y` may take a
type, such as `Range[T]`. A lead-in that adds "each `<marker>`" gives the composed keys that marker. A lead-in that reads
"`X` lists these paths" is followed by a `text` block with one path per line. The first
segment of a path is a key of `X`, and later segments nest as they do in the object `X`
is a subset of. A segment written `<name>` stands for what the lead-in says. A key
table led in by "`X` adds this key" or "`X` adds these keys" follows that block and
gives `X` those keys beside the listed paths.

**Value lists.** A list is written once, as `` `a` \| `b` ``, or `` `a` `` alone when it
has one value, or as the first column of a value table the text names as the list.
Other mentions point to it. A `VocabularyTerm` field says so and lists its core terms,
or points to other lists, whole or in part, and adds any others;
every other list is closed, and in a row it opens the Meaning cell.

**Keys.** Every key is snake_case, except in an object that a section copies from
another standard and says so; that object keeps the standard's spelling and cites
it. A key name repeats only where it means the same thing, and each row's Type cell
states its form there. An array named by a noun is plural, except the mass nouns
`assent[]`, `pricing[]`, `evidence[]`, `verification[]`, and `negotiation_history[]`,
and a name another standard spells, such as `playmethod[]`. A name that isn't a noun
keeps its form, such as `available[]`, `include[]`, `best_for[]`, and `all_of[]`. The
suffix `_ref` is reserved for `DocumentRef` and `EntryRef`. A Boolean flag may end
`_allowed` or `_required`, and a list never does.

**Values.** Every term compares byte for byte. A list this specification owns is
lower snake case. A list taken from another standard keeps that standard's spelling
and names it, such as `ApprovalStatus`. A list built on another standard's list follows
its case and names it: `cost_method` is upper case, like OpenDirect 2.1 `Line.ratetype`,
and § 1.1 maps it to that list.

**Yes or no.** A key from another standard keeps that standard's values, as
`IntegerFlag` does. Every other flag is a Boolean.

**Nothing.** `none` is a value only where it has its own meaning or the key is
required. Otherwise, absence means none.

**Paths.** Prose names a field by its full table path, such as
`properties.available[].apps[].store`. The key alone is enough in the section that
holds its table, beside the object it belongs to, or beside a reference to that
section. A value that points into a document is a `FieldPointer`.

### 2.7 Security considerations

This section is informative. It sets no requirement on a party to a transaction.

**Text is data.** Agents that can spend read this object, and much of it is text
the counterparty wrote: `description`, `media_kit_detail`, `best_for[]`,
`not_suitable_for[]`, `seasonality_notes`, `approval`, `creative_policy`, `ext` values,
a `FormatSpec`'s `spec`, a change request's `comments`, an error's `detail`, and the document behind a
`DocumentRef`. That text is data, and it can hold instructions aimed at a language
model. An agent keeps it apart from its own instructions, and rests a decision to
assent or spend on the structured fields, not on prose alone.

**URLs.** A document names URLs its author chose: `proposals[].full_url`,
a `DocumentRef`'s `url`, an `Asset`'s `url`, a `CreativeDelivery`'s `endpoint`, and an `App`'s `store_url`. Fetching one lets the
author choose where a client connects. A client uses `https`, bounds the size of a
response and the number of redirects, and refuses an address inside its own
network, on every redirect as well. § 5.4.1 covers what inspecting a creative may
request.

**Digests.** A `digest` shows that the bytes are the ones a `DocumentRef` names. It
does not show who wrote them, or that they are safe to act on. A client compares
it before reading the bytes, and `unresolved_reference` (§ 2.4) reports a mismatch.

**Buyer lists.** `exclusions`, `buyer_supplied.segments[]`, and
`buyer_supplied.suppression_list` show a buyer's strategy and can hold data about
people. A party that holds them limits who can read them, in stored records and
logs as well as in responses. § 5.5 states the disclosure rule for `exclusions`.

### 2.8 Web Bot Auth profile

This section is the OpenProposal profile of [Web Bot Auth](https://datatracker.ietf.org/doc/draft-ietf-webbotauth-httpsig-protocol/), the IETF
protocol for signing automated HTTP traffic with
[HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421). It selects options
those documents define and adds no header, tag, key field, or error code. A party
that signs an OpenProposal request or response signs it under this profile. Signing
is OPTIONAL: § 4.1.2 states what a signature shows, and `agreed` never depends on one.
When the AAMP agent identity and signing profile (provisional name) is published, it
replaces this section.

| Rule | Profile choice |
| :--- | :--- |
| Identity | An `https` origin. The signer names it in a covered `Signature-Agent` member, as the ASCII serialization of the origin ([RFC 6454 § 6.2](https://www.rfc-editor.org/rfc/rfc6454#section-6.2)): a lowercase host, no default port, and no path, query, fragment, or userinfo |
| Keys | The origin's key directory, at `/.well-known/http-message-signatures-directory` with the media type `application/http-message-signatures-directory+json`. Each signing key is an Ed25519 key (`kty` `OKP`, `crv` `Ed25519`), and its `kid` is its JWK thumbprint ([RFC 7638](https://www.rfc-editor.org/rfc/rfc7638)) |
| Signature | One signature, with `tag="web-bot-auth"`, `alg="ed25519"`, `keyid` set to the key's thumbprint, `created`, and `expires` no more than 300 seconds after `created`. A request also carries a `nonce` |
| Request components | `@method`, `@target-uri`, `@authority`, and `"signature-agent";key=<label>` |
| Response components | `@status`, `"@method";req`, `"@target-uri";req`, and `"signature-agent";key=<label>` |
| Body | A message with a body carries `Content-Digest` ([RFC 9530](https://www.rfc-editor.org/rfc/rfc9530)) with `sha-256`, and its signature also covers `content-type` and `content-digest`. A verifier checks the digest against the body bytes |
| Failures | A request whose signature fields do not parse gets `400`. One that fails verification or a rule of this profile gets `403`. A party that cannot verify a response MAY refuse to write its own entry (§ 4.1.2) |

Requests and responses are both signed, so the seller's answers carry the same
evidence as the buyer's entries. A standard Web Bot Auth verifier configured with
these rules checks a request before the application reads its body.

---

## 3. Field mutability

Every field carries exactly one marker.

| Marker | Meaning |
| :--- | :--- |
| `immutable` | Set once at creation. Neither party may change it. |
| `seller-set` | The seller sets it and MAY revise it while the `status` of the object that carries it is `draft`, `published` or `under_review`. § 4.3.2 states what a revision does to a line item `under_review`. The buyer cannot change it directly. |
| `selectable` | The buyer chooses from a seller-declared set. Each option MAY carry a price delta. Resolves without a round trip. |
| `settable` | The buyer supplies a value within seller-declared bounds. Resolves without a round trip. |
| `supplied` | The buyer provides data or an artifact. The seller does not pre-populate it. |
| `requestable` | The buyer MAY ask for a value outside the declared space. An ask changes the value only through a seller `grant` or `counter` (§ 4.3.1). A change on the seller's own initiative follows § 4.1.3. |
| `derived` | Computed by a rule this specification states. Neither party sets it directly. |
| `lifecycle` | Live state of the object. The party its section names moves it between the stated values. Not a term. |
| `recorded` | Written by the party that acted. Append-only: an entry is never edited or removed. Not a term. |
| `asserted` | The seller states it from data the buyer can't recompute. Not a term, and it changes without a new version. |
| `mixed` | The keys of the object carry different markers: in the Mutability column of its key table, in its lead-in for composed keys, or on its rows for `pricing[]`. |

**Whose `status`.** The proposal's (§ 4.1) for a field defined in § 4; the line
item's (§ 5.1) for a field defined in § 5, including `seller-set` sub-fields of
a `mixed` field.

§ 4.3, not the `seller-set` revision rule, governs the seller's answer to a `requestable` ask.

**Resolution without a round trip.** `selectable`, `settable` and `supplied`
fields MUST resolve without a round trip — everything needed to validate and
price them is declared in the proposal. Only `requestable` fields require the
counterparty to respond.

Resolution is validation and pricing, not acceptance. A resolved `commitment` is
an offer to buy (§ 5.6.1).

A field is never silently reverted. With no buyer write, what § 3.1 and § 3.2 put in
effect applies, and the seller declares it in the proposal.

`selected[]`, `value`, and `excluded[]` (§ 5.3) are keys of the field and carry no
marker of their own. The buyer MUST NOT alter the keys the seller declares beside them.

### 3.1 Selectable structure

Every field marked `selectable` is a `Selectable[T]`, or a named type that holds its
keys, where `T` is the option type.

**`Selectable`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `available[]` | Array[T] | REQUIRED | The options the seller offers |
| `included[]` | Array[String] | REQUIRED | The options in the base rate, by option id |
| `selected[]` | Array[String] | OPTIONAL | The buyer's choice, by option id |
| `deltas` | Map[String, Delta] | OPTIONAL | The price of an option outside `included[]`, keyed by option id. An option with no entry has no delta |
| `max_select` | Integer | OPTIONAL | The most options that may be in effect |

**Option ids.** A string option's id is its value. An object option's id is its
REQUIRED `id`, unique in the field.

**In effect.** `selected[]` is the complete set in effect and replaces `included[]`.
With no `selected[]`, `included[]` is in effect. `max_select` counts the whole set. An
empty set is valid only where the field gives it a meaning. Dropping an option in
`included[]` doesn't lower the rate.

Options of different fields combine freely, apart from a rule this specification
states between them. A seller whose options don't combine publishes separate line
items.

**`Delta`** keys. At least one key is present. § 5.6 states how they enter `agreed_rate`.

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `delta_cpm` | Amount | OPTIONAL | Added to the rate of a `CPM` or `CPMV` entry (§ 5.6.5), and to no other |
| `delta_fraction` | FractionDelta | OPTIONAL | Multiplies the rate of any entry by 1 plus this value. `0.20` is 20 percent more |
| `delta_flat` | Amount | OPTIONAL | A charge on any entry, outside the rate |

An option priced only by `delta_cpm` MUST NOT resolve against any other entry.

### 3.2 Settable bounds

A field marked `settable` declares its bounds in one of two forms, and the buyer
writes one key, `value`. `frequency_cap` holds its form in `count`. The keys of
`commitment` are the one exception: `commitment_bounds.spend` and the committed entry's
`unit_bounds` hold its bounds (§ 5.6, § 5.6.1).

**`Settable`** is the envelope form. `value` only narrows `allowed[]`.

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `allowed[]` | Array[T] | REQUIRED | The entries the buyer narrows within |
| `default` | Narrowing[T] | REQUIRED | In effect when `value` is absent |
| `value` | Narrowing[T] | OPTIONAL | The buyer's value |

**`Narrowing`** keys. Exclusion wins.

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `include[]` | Array[T] | REQUIRED | Each entry MUST be covered by an `allowed[]` entry |
| `exclude[]` | Array[T] | OPTIONAL | Each entry MUST be covered by an `include[]` entry |

An entry covers itself and what the field says it contains. Nothing else is assumed.

**`SettableRange`** holds the keys of `Range[T]` (§ 2.2) and these. It is the range
form.

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `default` | T | REQUIRED | In effect when `value` is absent, between the bounds |
| `value` | T | OPTIONAL | The buyer's value, between the bounds inclusive |

### 3.3 Re-computation

Because audiences, properties, formats, and `markets` are `selectable`, and a
`settable` targeting `value` and buyer `exclusions` (§ 5.5) narrow delivery,
`addressable_scale` and `availability` MUST be recomputed against the buyer's
actual selection, values, and exclusions.
`availability` MUST also be recomputed against the `break_position` and `programs`
options in effect. A single declared figure is correct only for the default
composition. On a `dooh` line item, they recompute on the screens of the properties in
effect, over hours inside both `operating_hours[]` and `daypart`.

A buyer reads these figures by sending the seller an `AvailabilityRead`. The read changes
no `status`, writes no history, reserves nothing, and doesn't limit a later decline
(§ 5.6.1).

**`AvailabilityRead`** holds the keys of `BuyerWrites` (§ 3.4) and these:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `offer` | VersionRef | REQUIRED | The line item and the `version` whose options the figures are computed against. `line_item_id` is REQUIRED here |
| `flight` | Interval | REQUIRED | The flight, as `commitment.flight` (§ 5.6.1) |
| `pricing_id` | String | OPTIONAL | The entry the buyer means to commit under, as `commitment.pricing_id`, so that the figure can count that entry's `unit` (§ 5.6.5) |

### 3.4 Buyer writes

**`BuyerWrites`** holds what a buyer writes on one line item. It is a strict path
subset of the line item: a listed path has the type it has there, and no other path
appears. Every path is OPTIONAL. A buyer delivery (§ 4.1.1) is not a write.

`BuyerWrites` lists these paths, where `<selectable>` is a field marked `selectable`,
and `<settable>` is a field marked `settable` other than `frequency_cap`:

```text
<selectable>.selected[]
<settable>.value
audiences.excluded[]
audiences.combine.selected[]
frequency_cap.count.value
exclusions
buyer_requirements.seats
buyer_requirements.seat_owner
```

**`LineItemWrites`** holds the keys of `BuyerWrites` and this one. It is the buyer's writes
on one line item, which a `Commit` (§ 5.6.1) and a hold's `requested_terms` (§ 5.6.2) carry.

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `commitment` | Commitment | REQUIRED | The line item's `commitment` (§ 5.6.1) |

---

## 4. Proposal

The proposal establishes identity, lifespan, negotiation state and the
merchandising case for the line items beneath it. The commitment and everything
channel-specific live on the line items.

### 4.1 Identity and lifecycle

| Field | Type | Required | Mutability | Description |
| :--- | :--- | :--- | :--- | :--- |
| `proposal_id` | String | REQUIRED | immutable | Identifies the proposal. Unique within `seller.domain` |
| `version` | Integer | REQUIRED | derived | Monotonically increasing revision number, starting at 1, held by the seller. Each version is a snapshot of the proposal's offered terms (§ 4.1.3). A version is frozen at the earliest of: the proposal's `status` leaving `draft`; a `negotiation_history[]` or `assent[]` entry naming it; a counterparty receiving it in any representation (§ 2.1). The offered terms of a frozen version MUST NOT change; a change to them creates version `n+1`. The values § 4.1.3 lists as not offered terms change without a new version |
| `spec_version` | String | REQUIRED | seller-set | The version of this specification the document follows, such as `3.0` |
| `seller` | Party | REQUIRED | immutable | The selling entity. `seller.domain` is the seller's identifier for all purposes, including `assent[]`. `legal_name` is REQUIRED here |
| `buyer` | Party | REQUIRED when `type` is `custom` or `assent[]` is present | immutable | The entity that assents, usually the agency. Its presence makes the proposal issued to that buyer (§ 4.3). Whom the spend is for is `commitment.advertisers[]` (§ 5.6.1), and whether the buyer may bind that advertiser is authorization (§ 1.2). `legal_name` is REQUIRED here |
| `type` | Enum | REQUIRED | immutable | `standard` \| `custom` |
| `proposal_template_id` | String | OPTIONAL | immutable | Links a proposal to the seller's template. Opaque to buyers; used for the seller's reporting |
| `issued_from` | VersionRef | OPTIONAL | immutable | The shared proposal and version an issued proposal was made from (§ 4.3). A pointer: nothing is inherited through it |
| `status` | ProposalStatus | REQUIRED | derived | Computed from the line items (§ 4.3.3) |
| `assent[]` | Array[AssentEntry] | OPTIONAL | recorded | The parties' acts (§ 4.1.2). Each entry is written whole by the party its `role` implies. Entries MUST NOT be edited or removed |
| `offer_window` | Interval | OPTIONAL | seller-set | The window the offer holds: it does not hold before `start` or after `end`. **This is the offer window, not the campaign flight** |
| `brief_id` | String | REQUIRED when `type` is `custom` | immutable | The buyer's brief this proposal answers |
| `negotiation_history[]` | Array[HistoryEntry] | REQUIRED when the current `version` is frozen (§ 4.1.3) | recorded | Ordered, append-only. Entries MUST NOT be edited or removed. A commit and its answers are in `assent[]`, not here, and an entry here voids nothing |
| `line_items[]` | Array[LineItem] | REQUIRED when `packages[]` is absent | seller-set | The line items (§ 5), in the order the seller wrote them. A proposal holds `line_items[]` or `packages[]`, not both |
| `packages[]` | Array[Package] | REQUIRED when `line_items[]` is absent | seller-set | The line items in packages (§ 4.1.4), in the order the seller wrote them |
| `ext` | Ext | OPTIONAL | seller-set | See Extensions (§ 2.5) |

**`HistoryEntry`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `version` | Integer | REQUIRED | The version the act created or refers to (§ 4.1.3) |
| `actor` | Side | REQUIRED | The side that acted |
| `action` | Enum | REQUIRED | `published` \| `requested` \| `granted` \| `countered` \| `declined` \| `withdrawn`. § 4.3.1 says which interaction writes each |
| `paths[]` | Array[HistoryPath] | REQUIRED | The fields the act changed or asked about. MAY be empty |
| `at` | Instant | REQUIRED | When the side acted |

**`HistoryPath`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `line_item_id` | String | REQUIRED when `requested_value` is present | The line item. When absent, `pointer` is into the proposal |
| `pointer` | FieldPointer | REQUIRED | Into that line item or the proposal |
| `requested_value` | RequestedValue | REQUIRED when the entry's `action` is `requested` | On a `requested` entry, the value the buyer asked for. On a `declined` entry, or a buyer's `withdrawn` entry, the value of the `request` it ended. Absent on every other entry |

**`RequestedValue`** holds exactly one key: the `requestable` field `pointer` names, in the
form its row states. `pointer` says which `pricing[]` entry.

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `list_rate` | Amount | OPTIONAL | A `pricing[].list_rate` |
| `unit_bounds` | Range[Integer] | OPTIONAL | A `pricing[].unit_bounds` |
| `commitment_bounds` | CommitmentBounds | OPTIONAL | The line item's `commitment_bounds` |
| `materials_due` | MaterialsDue | OPTIONAL | The line item's `materials_due` |
| `committed_metrics[]` | Array[CommittedMetric] | OPTIONAL | The line item's `committed_metrics[]` |

`proposal_template_id` MUST NOT be required for a buyer to transact. Buyers never
resolve it.

**Seller identity.** A proposal names exactly one `seller.domain`. A seller MUST
NOT name a domain it does not control. For this specification one `seller.domain`
is one seller: entities that transact under one domain are one seller here, and
`seller.legal_name` carries the legal name. A selling entity that controls several
registrable domains SHOULD use the same `seller.domain` for every proposal it
publishes as one seller; a seller that publishes proposals under several domains
holds an Agent Registry entry for each, or the entry does not apply. The field is immutable,
so a seller that moves to another domain publishes new proposals. Where a third party
hosts a seller's agent or published files, `seller.domain` is the selling
entity's own registrable domain, never the host's. Continuity of a legal entity
across domains, rebrands, or acquisitions is a fact the Agent Registry attests; this
object does not encode it. Whether to deal with a seller that has no Agent
Registry entry is buyer policy.

#### 4.1.1 Binding record and record_digest

The binding record of a document for a set of line items S is the JSON form of
that document in its Full Representation (§ 2.1), restricted to the line items in
S, with the following paths removed and no others, apart from the one exception below.
The paths are RFC 9535 JSONPath.
Arrays hash in document order, and no party reorders an array it did not write.

```
$.version
$.status
$.assent
$.negotiation_history
$.change_requests
$.best_for
$.not_suitable_for
$.seasonality_notes
$.line_items[*].status
$.line_items[*].availability
$.line_items[*].addressable_scale
$.line_items[*].assets
$.line_items[*].buyer_supplied.expected_match_rate
$.line_items[*].buyer_supplied.segments
$.line_items[*].buyer_supplied.suppression_list
$.line_items[*].pricing[*].min_rate
$.line_items[*].hold
$.line_items[*].commitment.derived_units
$.line_items[*].external_references
```

Restricting to S leaves `line_items[]` an array of the line items in S, in document
order however S is named. In a proposal with `packages[]`, it leaves each package that
holds a line item in S, with only the line items and add-ons in S, and each
`$.line_items[*]` path above also selects that path under `$.packages[*].line_items[*]`
and `$.packages[*].add_ons[*]`. Nothing else narrows: a proposal-level value such as
`description` stays as it is. Removing a path takes out the member it selects
and nothing else: a path that selects nothing removes nothing, and an object left empty
stays. The one exception is `buyer_supplied`: if it holds no key after these removals, it
is removed too, whether the removals emptied it or it was written empty.

Each removed path is one of three things: lifecycle state or sequence position
(`version`, `status`, `assent[]`, `negotiation_history[]`, `change_requests[]`,
`hold`); a seller assertion, advisory text, an informative figure, or an
identifier minted downstream of agreement (`best_for[]`, `not_suitable_for[]`,
`seasonality_notes`, `availability`, `addressable_scale`, `expected_match_rate`,
`min_rate`, `derived_units`, `external_references[]`); or a
delivery (`assets[]`, `segments[]`, `suppression_list`). The requirement on creative
(`formats`, `format_specs`, `creative_policy`, `materials_due`) is a term, and so is the
permission to deliver a list (`segments_allowed`, `suppression_allowed`,
`accepted_exclusions`).

Every other value is inside the record, named here or not: `proposal_id`,
`spec_version`, `seller`, `buyer`, `type`, `proposal_template_id`, `brief_id`,
`issued_from`, `offer_window`, `ext`, and each package's `package_id` and
`min_commitments[]`; every
`seller-set` field, including `hold_terms` and prose (`description`, `media_kit_detail`,
`creative_policy`, `format_specs`); the seller's value of a `requestable` field, such as
`pricing[].list_rate`, including one a `grant` or `counter` put in force; every option
space (`available[]`, `included[]`, `deltas`, `max_select`, `allowed[]`, `min` / `max`,
`default`); every `BuyerWrites` value (§ 3.4) and `commitment`, as they stand at `agreed`; `pricing[].agreed_rate`; and every `DocumentRef` (§ 2.2) whole, with any key its publisher
added, whose `url` and `digest` pin the bytes. A list the buyer delivers after `agreed` is a delivery and does
not change the agreed record (§ 4.1.2).

**Typed fields govern.** Where a value whose Type cell is `String` (§ 2.6) conflicts
with a typed field of the same `version` in the binding record, the typed field
governs. This applies to every such value that is not an identifier or code. A value
of an `Enum` or of a § 2.2 type, such as an `Instant`, `Duration`, or `VocabularyTerm`,
is a typed field. A `description` that offers an 8.00 `CPM` doesn't change a
`list_rate` of 12.00.

**Composed record.** The binding record is cut from the composed record: the Full
Representation of `version` as the seller published it to this buyer, with the buyer's
writes (§ 3.4) applied. A write sets the key it names and changes nothing else. A stored line
item holds the writes of a `commit` only while its `commitment` entry is live or matched by
an `acceptance`. Otherwise, as for a rejected `commit`, a full fetch doesn't show them
and they enter no later composed record. A document
that already holds those writes at that `version` is its own composed record. A `Commit`
(§ 5.6.1) carries the buyer's entry and writes, not a copy of the seller's terms. A value
no party exchanged is not a term. Nothing is filled in: a key the document doesn't hold
stays absent, whatever default its row states or § 3.1 or § 3.2 puts in effect, so writing a
default and omitting it give different digests.

**`derived` values.** Every party computes the digest by the same steps. The only
`derived` value inside the record is `pricing[].agreed_rate` on the committed entry. On
a line item with a `commitment`, a party sets it to the § 5.6 result before serializing,
replacing a written value or adding an absent one. The value serialized is the double
nearest that result.

**Canonical form.** The digest input is the RFC 8785 (JSON Canonicalization
Scheme) serialization of the binding record, encoded as UTF-8. This
specification names no wire format; for this section JSON is the data model. A
document carried as YAML is a single YAML document, converted to JSON under the YAML 1.2
core schema: aliases expand, and `<<` is an ordinary key. A non-string mapping key,
`.inf`, `.nan`, a recursive alias, an explicit tag, or a second document in the stream
has no JSON form and makes the document invalid for this section, and so do duplicate
object keys in its JSON form.

A string is the value the JSON form holds, so a final line break that a YAML block scalar
keeps is part of it. Strings, `Instant` values included, are hashed as that value; a party
MUST NOT trim, normalize, or reformat a value it did not write. Numbers serialize as
RFC 8785 § 3.2.2.3 prescribes (IEEE-754 double precision, shortest round-trip form). A
producer MUST NOT write a Number that this serialization does not reproduce as
the numeric value written; a Number with at most 15 significant digits inside
the range of a double always does, and a document containing one that does not
is invalid for this section. `24.00`, `24`, and the YAML `0x18` are the same value. Each
test of validity here reads the whole document, before any path is removed.

`record_digest` is the `Digest` (§ 2.2) of the digest input. It sits only on `assent[]`
entries.

A receiving party MUST recompute `record_digest` and compare it byte-for-byte
before relying on a live `commitment` entry, over the line items as they stand plus the
writes its `commit` carries (§ 5.6.1), or on a matching pair, from its agreed record
(§ 4.1.2). A `withdrawal` or `decline` acts on the entries it matches (§ 4.1.2), so its
`record_digest` is compared, not recomputed.

#### 4.1.2 Assent

`assent[]` holds the parties' acts in the order they were written, and only it
decides whether a line item is agreed.

**`AssentEntry`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `role` | Enum | REQUIRED | `commitment` \| `acceptance` \| `withdrawal` \| `decline`. It says what the entry does, and it implies the party |
| `version` | Integer | REQUIRED | The `version` of the record the digest was computed over. `version` is outside the binding record, so the entry binds it |
| `record_digest` | Digest | REQUIRED | Of the binding record for the line items in `line_item_ids[]` (§ 4.1.1) |
| `line_item_ids[]` | Array[String] | REQUIRED | The line items the entry names. MUST be non-empty |
| `at` | Instant | REQUIRED | When the party wrote the entry, by its own statement. No rule reads order from it |
| `idempotency_key` | String | REQUIRED when `role` is `commitment` | Buyer-generated, unique per `commit`, opaque, and scoped to one buyer and seller pair. The seller MUST NOT interpret it (§ 5.6.1) |
| `ground` | VocabularyTerm | REQUIRED when `role` is `decline` | Why the seller declined. Core terms: `availability` \| `exclusivity` \| `terms`, the grounds of § 4.3.2. Absent on any other entry. A receiver that doesn't know a term still reads the entry as a `decline` |

Two entries *match* when their `version`, `record_digest`, and `line_item_ids[]` are
equal. `line_item_ids[]` compare as sets, so an acceptance cannot cover part of a
commitment.

- `role: commitment` is written by the buyer. Its `line_item_ids[]` MUST name line
  items whose `commitment` object (§ 5.6.1) is populated in the record, and on their
  own MUST meet the package rules (§ 4.1.4). The
  entry accepts every `terms_refs[]` entry (§ 5.8) of the line items it names, at the
  bytes each `digest` pins, so a buyer compares each document with its `digest` first.
- `role: acceptance` is written by the seller, only while a `commitment` entry it
  matches is live. An `acceptance` that matches no live entry is invalid.
- `role: withdrawal` is written by the buyer, and `role: decline` by the seller. Each
  ends the `commitment` entries before it that it matches.
- A `commitment` entry is *live* until the first of these: a matching `withdrawal` or
  `decline`, its `commit` going stale (§ 4.1.3) or void (§ 4.3.2, § 4.3.4), or
  `offer_window.end`. Once a matching `acceptance` exists, nothing ends it. An entry
  that is not live stays in `assent[]`, and the line items it names MAY appear in a new
  `commitment` entry.
- A line item MUST NOT be named by more than one live `commitment` entry, nor by more
  than one `acceptance` entry. A later entry that would break this is invalid, and the
  earlier entry stands. A retry after a lost response re-sends the same entry and
  writes no new one (§ 5.6.1).
- The line items of a `commitment` entry are `agreed` when, and only when, `assent[]`
  holds a matching `acceptance` entry. A line item for which no such pair exists is not
  agreed, whatever its `status` says.
- Adding an `assent[]` entry does not change `version`.
- `agreed` is terminal for a line item. Every `seller-set`, `selectable`,
  `settable`, and `requestable` value of it and its `pricing[].agreed_rate` MUST
  remain as in the version `assent[]` names. A change to a value inside the record is
  applied outside it, in the downstream standard the line item lands in (§ 1.1),
  against the agreed record as its baseline (§ 1.2).

**Agreed record.** The agreed record of a matching pair is its digest input (§ 4.1.1)
and the two entries. To check a pair, a party recomputes `record_digest` from the
agreed record, not from the current document, and tests that the two entries match. A
later version of the proposal does not touch the agreed record. Each party keeps the
agreed record, and a copy of every document a `DocumentRef` in it pins.
This specification does not set how long.

**Signed messages.**

- An entry travels in the body of an HTTP message signed under the Web Bot Auth
  profile (§ 2.8), which defines how a message is signed and its key found. The key
  sits in the signing origin's key directory.
  Requests and responses are both signed, so the seller's `acceptance` and `decline`
  arrive signed, as the buyer's entries do.
- The signature attributes the entry to the record's party that `role` implies
  when it covers the body, through `Content-Digest`
  ([RFC 9530](https://www.rfc-editor.org/rfc/rfc9530)), and the host of the signing
  origin is that party's `domain` or a subdomain of it, such as `signing.<domain>`.
  Which of those origins a party accepts for its counterparty is that party's own
  configuration, such as an allowlist in a seller's admin.
  `record_digest` covers `seller` and `buyer`, so the signed body also binds the
  party's name.
- A party that keeps this evidence keeps it with the agreed record: the signed
  message that carried the counterparty's entry, as received (its signature fields,
  the values of the components they cover, and the exact body bytes), and the bytes
  of the key directory it verified against.
  Entries are append-only, so any signed message that carries an entry is evidence
  of the same entry.
- The evidence is OPTIONAL. An entry is complete without it. No check in this
  specification requires or verifies a signature, and `agreed` does not depend on one.
- A valid signature shows that the holder of a key in the signing origin's directory
  sent the entry. It does not show that the holder had authority to bind the party, or
  that anyone read the referenced documents. Authority to bind a party is a separate
  question (§ 1.2), and this specification does not settle it.
- Within the limits on a decline (§ 4.3.2, § 5.6.1), a party MAY refuse to write its own entry
  for any reason, including a counterparty message it cannot verify. Once a matching
  pair exists, an absent or failed signature, or a key later removed from its
  directory, does not change `agreed`.

#### 4.1.3 Offered terms and versions

**Offered terms.** The offered terms of a version are every value the seller
writes: `immutable` and `seller-set` fields; the seller's value of a `requestable`
field, such as `pricing[].list_rate`; the seller-declared structure of `selectable`
and `settable` fields (`available[]`, `included[]`, `deltas`, `max_select`,
`allowed[]`, `min`, `max`, `default`); and the set of `line_item_id`s the version
carries. The following are not offered terms and MAY change without a new version: `status` (proposal
and line item), `assent[]`, `negotiation_history[]`, `change_requests[]`,
`availability`,
`addressable_scale`, `hold`,
`external_references[]`, `assets[].approval_status`, a `built_by: seller` entry of
`assets[]`; `best_for[]`,
`not_suitable_for[]`, and `seasonality_notes`, which are advisory (§ 4.2);
`pricing[].min_rate`, which is a hint; `buyer_supplied.expected_match_rate`, which is
the seller's stated expectation; every value the buyer writes (a `BuyerWrites` value,
`commitment`, any other `supplied` field, and a `requestable` ask); and
every `derived` value computed from a buyer's writes (`pricing[].agreed_rate`,
`commitment.derived_units`). A buyer composes against a named `version` and never increments it.

**Freezing.** A seller MAY edit a proposal in place only while its current
version is not yet frozen (§ 4.1). Two representations of the same
`(proposal_id, version)` whose offered terms differ, compared on the fields and line
items both carry, are non-conformant. A line item that
appears in a frozen version MUST NOT be removed from the proposal or moved to another
package; it leaves the
shelf by its `status` (§ 5.1), which is a lifecycle change. Adding a line item
changes the offered terms.

**Versions.** Each change to the offered terms of a frozen version MUST create
version `n+1` and MUST append exactly one `negotiation_history[]` entry carrying
that `version`, with `actor: seller` and `paths[]` naming every offered-terms
field whose value differs from version `n`. Its `action` is one of
the following:

- `published` for version 1, appended no later than the moment version 1 is
  frozen, and for a change the seller makes on its own initiative, including a
  change to `seller-set` prose.
- `granted` or `countered` for a change that answers a buyer's `requestable`
  ask: `granted` puts the requested value into force, `countered` puts a different
  value into force in its place.

Only the seller changes offered terms, so only these entries create versions.
Every other entry (`requested`, `declined`, `withdrawn`) carries the version it
refers to.

**Staleness.** An ask or a hold is on a `version`. It is *stale* when the binding
record (§ 4.1.1) for the line items it names, with any buyer writes applied,
differs between that `version` and the current one. `version` is outside the
record, so a revision that touches only another line item does not make it stale,
and a change to a proposal-level term does. A change to the `line_item_id`s of a
package that holds a line item it names also makes it stale. The seller computes the test
from the versions it retains, and no digest is published for it. § 5.6.1 states the
test for a `commit`.

**Retention.** A seller MUST keep every version that a `negotiation_history[]`
or `assent[]` entry names retrievable by
`(proposal_id, version)` for as long as the proposal is retrievable. This
specification does not define how a party fetches a version.

#### 4.1.4 Packages

A package is a set of line items the seller sells only together, with the line items
that can be added to it. A proposal that holds `packages[]` holds each of its line
items in a package, so a line item the seller sells alone is a package of one. A line
item sold both alone and in a package appears twice, under two `line_item_id`s, as two
offers. A proposal sold only whole holds one package.

**`Package`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `package_id` | String | REQUIRED | Identity within the proposal |
| `line_items[]` | Array[LineItem] | REQUIRED | The line items sold only together. It holds at least one entry |
| `add_ons[]` | Array[LineItem] | OPTIONAL | Line items sold only with all of `line_items[]`, such as a bonus line item (§ 5.6.3) |
| `min_commitments[]` | Array[MinCommitment] | OPTIONAL | Thresholds a `commit` meets to include an add-on |

**`MinCommitment`** holds the keys of `CommitmentAmount` and this one. Whatever
`basis` the commitment on `line_item_id` uses, a `spend` threshold reads against its
seller total (§ 5.6.5), in the currency of the entry committed (§ 5.6), and a `units`
threshold reads against the units that entry commits, as `pricing[].unit_bounds` counts
them.

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `line_item_id` | String | REQUIRED | A line item in the package's `line_items[]` |

- `package_id` values are unique within the proposal, and so are `line_item_id` values.
- A `commit` that names a line item in a package's `line_items[]` MUST name all of them.
- A `commit` that names an add-on MUST name every line item in its package's
  `line_items[]` and meet each of the package's `min_commitments[]`.
- A seller MUST reject a `commit` that breaks either rule with `not_committable`
  (§ 2.4). This check MUST be deterministic.

A package can't be bought while a line item in its `line_items[]` is `sold_out` or
`withdrawn`, since that line item can't be committed. Each line item keeps its own
`status` (§ 5.1). The holds on the line items in a package's `line_items[]` move as a
unit (§ 5.6.2).

In an agreed package whose `line_items[]` holds more than one line item, a buyer
exercises their `cancellation_policy` options only together. It sends one request
(§ 4.4), whose entries share an `id`, with a `cancellation` (§ 5.6.6) for each. Every
notice states the same `cancelled_share` and `requested_effective_at`. Each
cancellation takes effect on the latest effective date any of them yields (§ 5.6.6),
and cancels no more than the smallest `max_share` that applies on that date. A notice
on only some of them, or a request whose notices differ in `cancelled_share` or
`requested_effective_at`, exercises no option. It asks for a change those options don't
give, and the seller MAY decline it unless `terms_refs[]` (§ 5.8) gives it. Cancelling
the line items doesn't cancel an add-on: a buyer cancels it under its own
`cancellation_policy`.

### 4.2 Agent comprehension

The case a buying agent reads to decide whether to look further.

| Field | Type | Required | Mutability | Description |
| :--- | :--- | :--- | :--- | :--- |
| `description` | String | REQUIRED | seller-set | Prose, not a name. Where the "why buy" case is made, including which channels a multi-channel proposal spans |
| `media_kit_detail` | String | OPTIONAL | seller-set | Detail at media-kit depth |
| `best_for[]` | Array[String] | OPTIONAL | seller-set | Advisory planning hints. Non-normative, and never the basis for a match |
| `not_suitable_for[]` | Array[String] | OPTIONAL | seller-set | Advisory exclusion guidance. Non-normative |
| `seasonality_notes` | String | OPTIONAL | seller-set | When the proposal performs differently |

`best_for[]`, `not_suitable_for[]`, and `seasonality_notes` are advisory. They are
outside the binding record (§ 4.1.1) and the offered terms (§ 4.1.3), so editing them
creates no `version`.

### 4.3 Lifecycle

**Shared and issued.** A proposal with no `buyer` is *shared*. A proposal with a
`buyer` is *issued* to that buyer. The seller creates one with `publish`: a new
`proposal_id`, version 1, `buyer`, and, when it is made from a shared proposal,
`issued_from`. A `custom` proposal is issued from the start. `buyer` is immutable,
so every later version stays with that buyer. Each issued proposal has an
independent `status`, `version` and `negotiation_history[]`.

A buyer that wants an issued proposal sends, over the message binding, the ask, hold, or commit
it would make, naming the shared proposal and `version` it read, or a brief. A seller
that issues one answers with `publish`, and the buyer sends its ask, hold, or commit
against the new `proposal_id`.

Asks, `under_review`, holds, and assent live on a proposal issued to one buyer; a
shared proposal, or any other record more than one buyer can read (§ 5.8), carries
none of them.

**Asks.** A buyer `request` (`requestable`, not a hold) or `commit`
(§ 5.6.1) is an *ask*: it names a `version` and stays *open* until answered or
withdrawn, or until it goes stale (§ 4.1.3) or void (§ 4.3.2, § 4.3.4). A `commit` is one
act, a `Commit` (§ 5.6.1): the buyer's `assent[]` entry and the writes of each line item that
entry names. A `commit` that goes stale or void is no longer open, and its `commitment` entry
is no longer live (§ 4.1.2). A `request` is identified by its `line_item_id`, `pointer`, and `requested_value` (§ 4.1). Two equal ones
are one ask while that ask is open, and an equal `request` after it ends is a new ask.

#### 4.3.1 Interactions

| Interaction | Actor | Effect; history `action` |
| :--- | :--- | :--- |
| `publish` | seller | version 1 of a new or `draft` proposal, or the next `version` for a change to offered terms (§ 4.1.3); `published`. Moving a `draft` line item in a frozen version: neither (§ 4.3.2) |
| availability read | buyer | an `AvailabilityRead` (§ 3.3), answered with the figures § 3.3 names, with no change of state; no entry |
| `request` | buyer | asks a `requestable` value on one line item against a named `version`, stated as a `HistoryPath` (§ 4.1) with `requested_value`; `requested` |
| `grant` | seller | of a `request`: new `version` with the requested value in force as an offered term; `granted` |
| `counter` | seller | of a `request`: new `version` with another value; `countered`. A `counter` of `pricing[].list_rate` MAY also change `included[]`, with `paths[]` naming both |
| `decline` | seller | no new `version`. Of a `request`: `declined`. Of a `commit`: the seller's `assent[]` entry; no entry |
| `commit` | buyer | a `Commit` (§ 5.6.1): the buyer's `assent[]` entry, which pins the `version`, and its writes (§ 3.4); no entry |
| `accept` | seller | of a `commit`: the seller's `assent[]` entry, no new `version`; no entry |
| `withdraw` | seller: line item or proposal; buyer: its own ask | `withdrawn`. A seller's is one entry. For each line item it moved to `withdrawn`, its `paths[]` holds a `HistoryPath` with that `line_item_id` and the `pointer` `/status`. Of the buyer's `commit`: the buyer's `assent[]` entry; no entry |
| hold request, grant, decline, release, re-offer | buyer; seller; seller; buyer, or seller on a revision (rule 2); seller on a revision (rule 2) | `hold` only; no entry |

A buyer that turns down an offer, including a counter, takes no action and leaves no entry.

#### 4.3.2 Line-item status transitions

A line item moves between `status` values as follows. These transitions are
exhaustive, so a status with none leading out of it is terminal.

- `draft` → `draft` at a new `version`: seller `publish`.
- `draft` → `published`: seller `publish`. In a frozen version this changes only `status`,
  so it makes no new `version` and no entry (§ 4.1.3).
- `draft` → `withdrawn`: seller.
- `published` → `published` at a new `version`: seller `publish`.
- `published` → `under_review`: buyer ask.
- `under_review` → `under_review`: another buyer ask, a seller or buyer act that
  ends one ask while another stays open, or a seller `publish` that makes no open
  ask stale.
- `under_review` → `published`: the last open ask ends by seller `grant`,
  `counter`, or `decline`, by buyer `withdraw`, or by going stale on a new
  `version` (rule 2).
- `under_review` → `agreed`: seller `accept` of a `commit` (§ 4.1.2); open asks are void.
- `published` | `under_review` → `sold_out`: seller, never while `hold.status` is
  `held`; open asks are void.
- `published` | `under_review` | `sold_out` → `withdrawn`: seller, never while
  `hold.status` is `held`, nor until the latest `price_valid_until` of its `pricing[]`
  entries; open asks are void.
- `sold_out` → `published`: seller, when quantity returns, with no new `version`,
  because `availability` is not an offered term.
- `published` | `under_review` | `sold_out` → `expired`: `offer_window.end` passes
  (§ 4.3.4).

A *firm entry* is a `pricing[]` entry with a `price_valid_until`. It holds until
that date or `offer_window.end`, whichever comes first. While it holds, a seller
revision MUST NOT change that entry, `pricing_id` included, and MUST NOT end it
sooner by moving `offer_window.end`. A `grant` or `counter` of a `request` on that
entry MAY lower its `list_rate` or widen its `unit_bounds`. A revision that narrows
who may commit (§ 5.8) does not apply, while the entry holds, to a buyer that was
eligible when the entry was first offered. The seller of an issued proposal MUST answer
a resolved `commit` under it that arrives while the entry holds, on or after
`offer_window.start`, and passes the checks of § 5.6.1 and any authority check the seller applies (§ 5.8):
accept it, or decline it on an allowed ground. The allowed grounds are lack of
availability, an exclusivity conflict (§ 5.6.7), and a ground stated in the
`terms_refs[]` in force when the entry was first offered. The answer MUST come before the entry stops holding: otherwise silence
works as a decline on no ground.
`sold_out` is lack of availability: a `commit` that arrives while the line item is
`sold_out` returns `not_committable` (§ 2.4).

Two rules apply:

1. A stale ask (§ 4.1.3) is not open and not evaluated. The seller rejects it with
   `stale_version` (§ 2.4).
2. A seller MAY revise a line item while an ask is open or a hold runs. The
   revision is a new `version` (§ 4.1.3). An ask it makes stale ends (rule 1), and
   the seller MUST release a `held` hold it makes stale or re-offer it at the new
   `version`, where `hold.status` stays `held`. A `commit` MUST NOT carry a `requestable`
   ask: `accept` makes no new `version`, so another value takes a separate `request`.

#### 4.3.3 Proposal status

A proposal's `status` is the first of the following that applies:

1. `draft` when every line item is `draft`.
2. `under_review` when any line item is.
3. `published` when any line item is `draft`, `published` or `sold_out`.
4. `agreed` when any line item is `agreed`.
5. Otherwise `expired` when any line item is `expired`, else `withdrawn`.

A seller `withdraw` of the proposal moves to `withdrawn` every line item that
§ 4.3.2 lets the seller withdraw.

#### 4.3.4 Expiry

| Instant | Ends | Effect when passed |
| :--- | :--- | :--- |
| `offer_window.end` | the offer window | every `published`, `under_review`, or `sold_out` line item is `expired`; open asks are void |
| `pricing[].price_valid_until` | the firm entry | `status` unchanged; a later `commit` under that entry is rejected (§ 5.6.1), and the seller SHOULD `publish` or `withdraw` |
| `hold.valid_until` | the hold | `hold.status` becomes `expired`; `status` unchanged |

`hold.valid_until` MUST NOT exceed `offer_window.end` or the earliest
`pricing[].price_valid_until`.

### 4.4 Change requests

The history of changes requested after a line item is `agreed`, under any
`transaction_mechanism`. The agreed terms stay frozen (§ 4.1.2): an entry records a
request and makes no change. The change itself belongs downstream (§ 1.2), and this
section defines no workflow.

| Field | Type | Required | Mutability | Description |
| :--- | :--- | :--- | :--- | :--- |
| `change_requests[]` | Array[ChangeRequest] | OPTIONAL | recorded | Ordered post-`agreed` history. Each entry carries the fields of the [OpenDirect 2.1 ChangeRequest](https://github.com/InteractiveAdvertisingBureau/OpenDirect/blob/82bc294314aba017fc639ba634aecc53adfd675f/OpenDirect.v2.1.final.md#object_changerequest), except its `webhook`, plus `baseline`, `actor`, `at`, and `cancellation`. Outside the binding record (§ 4.1.1) and the offered terms (§ 4.1.3), like `negotiation_history[]`, so an entry changes neither `record_digest` nor `version` |

**`ChangeRequest`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `id` | String | REQUIRED | Opaque identifier of the change request |
| `baseline` | VersionRef | REQUIRED | The agreed line item the request is against, at the `version` of its agreed record (§ 4.1.2). `line_item_id` is REQUIRED here |
| `actor` | Side | REQUIRED | The side that wrote the entry |
| `at` | Instant | REQUIRED | When that side wrote it |
| `accountid` | String | OPTIONAL | The account of the advertiser and buyer that own the change, the same as the OpenDirect Order's. An OpenDirect 2.1 ChangeRequest requires it |
| `comments` | String | OPTIONAL | Why the change is requested. Free text |
| `contacts[]` | Array[Object] | OPTIONAL | Contacts for this change, in addition to the buyer's and the advertiser's, one per contact type. As OpenDirect 2.1 Contact |
| `orderid` | String | REQUIRED when the line item has an `order` reference (§ 5.10) | The order the change is requested for: the id in the `order` entry |
| `lineid` | String | OPTIONAL | The Line in that Order, for a change at line level |
| `requesterid` | String | OPTIONAL | The organization that requests the change: usually the agency, or the publisher. An OpenDirect 2.1 ChangeRequest requires it |
| `providerdata` | Object | OPTIONAL | Structured references a buyer uses to identify its order in the seller's system |
| `status` | ApprovalStatus | OPTIONAL | The outcome of the request |
| `cancellation` | CancellationNotice | OPTIONAL | The notice, when the request is to cancel under the option in effect (§ 5.6.6) |
| `ext` | Ext | OPTIONAL | See Extensions (§ 2.5) |

A change of `status` is a new entry with the same `id` and `baseline`. A request
that covers several line items takes one entry for each.

The OpenDirect 2.1 ChangeRequest has no structured statement of the change, only
free-text `comments`. § 8 asks how an entry states a change other than a cancellation.

---

## 5. Line items

Everything a buying agent needs to transact, per buyable unit, in exactly one
channel.

### 5.1 Identity

| Field | Type | Required | Mutability | Description |
| :--- | :--- | :--- | :--- | :--- |
| `line_item_id` | String | REQUIRED | immutable | Identity within the proposal |
| `status` | LineItemStatus | REQUIRED | lifecycle | Independent of the proposal's status, so one line item may sell out while the rest of the shelf stays live |
| `channel` | MediaChannel | REQUIRED | immutable | Core terms in § 5.1.1. The discriminator for how the rest of the line item is read |
| `ext` | Ext | OPTIONAL | seller-set | See Extensions (§ 2.5) |

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
| `ctv` | A TV device type |
| `native` | Native ad (`DisplayPlacement.nativefmt`), including native ads with video assets |
| `video` | Video ad (`VideoPlacement`) |
| `display` | Any other display ad (`DisplayPlacement`) |

**`MediaChannel`** is a `VocabularyTerm` (§ 2.2) whose core terms are the rows of this
table. An impression a row matches has that row's channel, so an extension term
covers only impressions no row matches.

Device types are values of AdCOM 1.0 List: Device Types, each written as its
name followed by its code. The *TV device types* are Connected TV (3), Connected
Device (6), and Set Top Box (7). The *mobile device types* are Mobile/Tablet -
General (1), Phone (4), and Tablet (5).

- The seller MUST serve a line item only on impressions of its `channel`.
  Placement type, such as interstitial or rewarded
  ([OpenRTB 2.6](https://github.com/InteractiveAdvertisingBureau/openrtb2.x/blob/1debba8001f40eb14597102dec3205afddf811d4/2.6.md#objectimp)
  `video.plcmt`, `imp.instl` and `imp.rwdd`), does not change the channel.
- Impressions in linear TV, including addressable linear, are outside this
  table: they have no core `channel` term in 3.0.

### 5.2 Inventory composition

| Field | Type | Required | Mutability | Description |
| :--- | :--- | :--- | :--- | :--- |
| `properties` | Selectable[PropertyOption] | OPTIONAL | selectable | What the line item runs on. See 5.2.4. Absent: the seller promises no property |
| `programs` | Selectable[ProgramOption] | OPTIONAL | selectable | The content the line item serves within. See 5.2.9. Absent, or nothing in effect: no content is promised |
| `episodes` | Enum | REQUIRED when `placement.feed` is Podcast (3) or Catch-up radio (4) | seller-set | `new` \| `catalog` \| `all`. `new`: released within the flight. `catalog`: released before it. `all`: either |
| `environments` | Selectable[Environment] | OPTIONAL | selectable | The distribution channels and device types the line item runs on. See 5.2.1. Absent: the seller promises no environment |
| `placement` | Placement | REQUIRED when `channel` is `video` or `audio` | seller-set | What every impression of this line item is: rewarded, interstitial, video placement subtype, skippability, playback, API frameworks, refresh, server-side insertion and audio feed. See 5.2.2 |
| `break_position` | Selectable[BreakPositionOption] | OPTIONAL | selectable | Where in the content stream an ad plays, on `video`, `ctv`, and `audio` line items. See 5.2.3. Absent, or nothing in effect: the seller promises no position |

#### 5.2.1 environments

**`Environment`** is a value of this table. Each value is the set of (distribution
channel, device type) pairs formed from its row, in AdCOM 1.0 terms. An impression
matches the value when both its distribution channel and its device type are in the
row. Device types are as in 5.1.1.

| `environments` | Distribution channel | Device types |
| :--- | :--- | :--- |
| `web_desktop` | `Site` | Personal Computer (2) |
| `web_mobile` | `Site` | The mobile device types |
| `app_mobile` | `App` | The mobile device types |
| `ctv` | `Site` or `App` | The TV device types |
| `dooh` | `Dooh` | Any |

Each `environments.available[]` value MUST match at least one impression to
which 5.1.1 gives the line item's `channel`.

#### 5.2.2 placement

Keys follow [AdCOM 1.0 `Placement`](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#object_placement) and its
[`DisplayPlacement`](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#object_displayplacement),
[`VideoPlacement`](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#object_videoplacement) and
[`AudioPlacement`](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#object_audioplacement) subtypes, and the matching
[OpenRTB 2.6 `Imp`](https://github.com/InteractiveAdvertisingBureau/openrtb2.x/blob/1debba8001f40eb14597102dec3205afddf811d4/2.6.md#objectimp) attributes.

`plcmt`, `playmethod[]`, `api[]` and `feed` take any code in
[List: Plcmt Subtypes - Video](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#list_plcmtsubtypesvideo),
[List: Playback Methods](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#list_playbackmethods),
[List: API Frameworks](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#list_apiframeworks) and
[List: Feed Types](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#list_feedtypes) respectively. This
section names each code by its AdCOM name followed by the code, such as
Instream (1).

**`Placement`** keys:

| Key | Type | Required | Meaning | AdCOM 1.0, OpenRTB 2.6 |
| :--- | :--- | :--- | :--- | :--- |
| `reward` | IntegerFlag | OPTIONAL | The user receives a reward for viewing the ad | `Placement.reward`, `imp.rwdd` |
| `instl` | IntegerFlag | OPTIONAL | The ad is interstitial or full screen | `DisplayPlacement.instl`, `imp.instl` |
| `plcmt` | Integer | REQUIRED when `channel` is `video` | A value from List: Plcmt Subtypes - Video, such as Instream (1). Its presence states that the line item is video, so a `ctv` line item that sells video carries it | `VideoPlacement.ptype`, `video.plcmt` |
| `skip` | IntegerFlag | OPTIONAL | Video or audio. The placement lets the user skip the ad | `VideoPlacement.skip`, `AudioPlacement.skip`, `video.skip` |
| `skipafter` | Integer | OPTIONAL | When `skip` is `1`: seconds the ad plays before the placement enables skipping | `VideoPlacement.skipafter`, `AudioPlacement.skipafter`, `video.skipafter` |
| `playmethod[]` | Array[Integer] | OPTIONAL | Video or audio. Values from List: Playback Methods in use, such as Initiates without any specific user interaction with Sound On (1), Initiates without any specific user interaction Sound Off by Default (2), Initiates on Click with Sound On (3) and Continuous Playback (7) | `VideoPlacement.playmethod`, `AudioPlacement.playmethod`, `video.playbackmethod` |
| `api[]` | Array[Integer] | OPTIONAL | Values from List: API Frameworks that every impression supports, such as MRAID 3.0 (6), OMID 1.0 (7) and SIMID 1.1 (9) | `DisplayPlacement.api`, `VideoPlacement.api`, `AudioPlacement.api`, `banner.api`, `video.api`, `audio.api` |
| `refresh` | Refresh | OPTIONAL | How often the slot refreshes | OpenRTB 2.6 only: `imp.refresh.refsettings[].minint` |
| `feed` | Integer | REQUIRED when `channel` is `audio` | A value from List: Feed Types, such as Podcast (3) | `AudioPlacement.feed`, `audio.feed` |
| `ssai` | Integer | OPTIONAL | Whether server-side ad insertion is in use and what it does to asset and tracker retrieval, in the values of AdCOM 1.0 `Placement.ssai`, such as all server-side (3) | `Placement.ssai`, `imp.ssai` |

**`Refresh`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `min_interval_s` | Integer | REQUIRED | Minimum seconds a creative renders before the slot refreshes |

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
  `app_mobile` or `ctv` SHOULD NOT offer a `measurement_source` option whose
  `measured_by` is not `seller`.

#### 5.2.3 break_position

Each option in `available[]`:

**`BreakPositionOption`** keys:

| Key | Type | Required | Meaning | AdCOM 1.0, OpenRTB 2.6 |
| :--- | :--- | :--- | :--- | :--- |
| `id` | String | REQUIRED | Option id (§ 3.1) | none |
| `delay` | Integer | OPTIONAL | A value from [List: Start Delay Modes](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#list_startdelaymodes), such as Pre-Roll (0) | `delay`, `video.startdelay` / `audio.startdelay` |
| `podseq` | Integer | OPTIONAL | A value from [List: Pod Sequence](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#list_podsequence) | `podseq`, `podseq` |
| `slotinpod` | Integer | OPTIONAL | A value from [List: Slot Position in Pod](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#list_slotpositioninpod) | `slotinpod`, `slotinpod` |
| `maxseq` | Integer | OPTIONAL | Ceiling: the most ads a served pod holds | `maxseq`, `maxseq` |
| `poddur` | Integer | OPTIONAL | Ceiling: the most seconds of dynamic ad time a served pod holds | `poddur`, `poddur` |

AdCOM keys are on [`VideoPlacement`](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#object_videoplacement), or on
[`AudioPlacement`](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#object_audioplacement) for an `audio` line item. An
absent key promises nothing.

An impression matches an option when every declared key matches. In `podseq`
and `slotinpod`, 0 (any) matches every value. In `delay`, -1 matches -1 and any
value above 0. In `slotinpod`, 2 (first or last) matches 1, -1, and 2. `maxseq`
and `poddur` match a pod at or below them. Every other value matches only
itself.

A declared option is a delivery term: with an option in effect, the seller MUST serve
the line item only into impressions that match one, and when the line item executes
over OpenRTB 2.6, a bid request that offers its deal MUST carry `imp.video` or
`imp.audio` values that match one. A seller MUST NOT declare `slotinpod` 1, 2, or -1
unless it can guarantee that slot.

#### 5.2.4 properties

Each option in `available[]`:

**`PropertyOption`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `id` | String | REQUIRED | Option id (§ 3.1) |
| `name` | String | OPTIONAL | The property's name, for people |
| `domains[]` | Array[Domain] | REQUIRED when `apps[]` is absent | The property's domains. On a `dooh` line item, the inventory owner's domain, as OpenRTB 2.6 `dooh.domain` |
| `apps[]` | Array[App] | REQUIRED when `domains[]` is absent | The apps behind a property sold in `app_mobile` or `ctv` (§ 5.2.5) |
| `seller_relationship` | Enum | REQUIRED | `owner` \| `manager` \| `inventory_partner` \| `reseller`, checked as § 5.2.6 states |
| `inventory_partner_domain` | Domain | OPTIONAL | As OpenRTB 2.6 `site.inventorypartnerdomain` and `app.inventorypartnerdomain` |
| `seller_accounts[]` | Array[SellerAccount] | REQUIRED when `seller_relationship` is `reseller`, or the line item offers a deal mechanism (§ 5.9) | The accounts that sell the property |
| `child_audience` | Enum | REQUIRED | `directed` \| `mixed` \| `general`. `directed`: children are its primary audience under the law the seller applies, or its app store lists it for children only. `mixed`: directed to children but not as its primary audience, or listed for children and older users. `general`: neither. § 5.2.7 states what follows |
| `child_treatment` | Enum | REQUIRED when `child_audience` is `mixed` | `excluded` \| `contextual`. `excluded`: users identified as children don't receive the line item. `contextual`: they receive it without personal data |
| `venue_type` | TaxonomyCodes | REQUIRED when `channel` is `dooh` | `taxonomy` is a value of AdCOM 1.0 List: DOOH Venue Taxonomies. `ids[]` holds exactly one id. It covers only itself, not its descendants. The values OpenRTB 2.6 `dooh.venuetypetax` and `dooh.venuetype` carry |
| `allocation` | Enum | OPTIONAL | `all` \| `seller_allocated`. Absent means `all`. With `all`, the line item runs on every listed screen. With `seller_allocated`, the seller picks the screens: `screens[]`, when present, is the pool it picks from and is seller-set, and the proof-of-play log names the screens used |
| `min_screens` | Integer | OPTIONAL | With `seller_allocated`, the fewest screens the seller allocates to the line item |
| `screens[]` | Array[Screen] | REQUIRED when `channel` is `dooh` and `allocation` is `all` | The property's screens (§ 5.2.8) |
| `slots_per_loop` | Integer | OPTIONAL | The slots per loop the line item buys on each screen of the property that has a `loop` |
| `sync_groups[]` | Array[SyncGroup] | OPTIONAL | Screens that show the same ad at the same moment, sold as one (§ 5.2.8) |

#### 5.2.5 App identity

**`AppId`** names an app within its store. A block list (§ 5.5) holds `AppId` entries.

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `store` | VocabularyTerm | REQUIRED | The app store that issued `bundle`. Core terms: `apple_app_store` \| `google_play` \| `roku_channel_store` \| `amazon_appstore` \| `samsung_apps_tv`. A `bundle` is unique only within its store. No OpenRTB equivalent |
| `bundle` | String | REQUIRED | Store ID. As OpenRTB 2.6 `app.bundle` |

**`App`** holds the keys of `AppId` and these:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `store_url` | Url | OPTIONAL | Store listing URL. As OpenRTB 2.6 `app.storeurl` |
| `developer_domain` | Domain | RECOMMENDED | Developer domain, informative; the governing developer domain comes from the store listing. No OpenRTB equivalent: not `app.domain`, which is the domain of the app |

#### 5.2.6 Seller relationship

Each property states by what right `seller.domain` sells it.

**`SellerAccount`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `asi` | Domain | REQUIRED | As ads.txt field 1, Domain name of the advertising system |
| `sid` | String | REQUIRED | As ads.txt field 2, Publisher's Account ID |

The governing file is the ads.txt of each `domains[]` entry, or the app-ads.txt
of the developer domain in the app's store listing (found by `store_url`, or by
`store` and `bundle`), not `apps[].developer_domain`. For
`seller_accounts[]`, it is the ads.txt of `inventory_partner_domain` when present,
or of `seller.domain` when `seller_relationship` is `inventory_partner`.

| `seller_relationship` | The governing file declares |
| :--- | :--- |
| `owner` | `OWNERDOMAIN` equal to `seller.domain`. With no `OWNERDOMAIN`: the domain serving the file equal to `seller.domain`, or a `DIRECT` record for a `seller_accounts[]` entry that sellers.json types `PUBLISHER` or `BOTH` |
| `manager` | `MANAGERDOMAIN` equal to `seller.domain`, global or for every country the line item's `geo` or `markets` allows |
| `inventory_partner` | `INVENTORYPARTNERDOMAIN` equal to `seller.domain` |
| `reseller` | A `RESELLER` record for a `seller_accounts[]` entry |

Each `seller_accounts[]` entry MUST be a record in the governing file.
A seller MUST NOT state a relationship its governing file, where one exists,
does not support. A consumer that checks MUST use this table, and confirms that
sellers.json at `asi` lists `sid` as a `seller_id`, with `domain` equal to
`seller.domain` where the entry carries `domain`. With no governing file, or a
confidential entry, the claim is unverifiable, not failed. Whether to check, and
what follows, is buyer policy.

#### 5.2.7 Child-directed status

A line item with a `directed` entry in `properties.available[]` SHOULD NOT carry
`audiences`, and its `buyer_supplied.segments_allowed` and `suppression_allowed`
SHOULD be false. Where that property's app store bars behavioral advertising
(Apple's Kids Category, Google Play's Families policies), the line item MUST NOT
carry `audiences`, and both flags MUST be false.

Beyond these rules, this specification does not decide where an option or a
property may lawfully be used.

#### 5.2.8 DOOH screens

When `channel` is `dooh`, a property is a set of screens of one venue type.

**`Screen`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `screen_id` | String | REQUIRED | The seller's id for the screen, as its proof-of-play log carries it. When the bid request's `device.ifa_type` is `ppid`, as the [OpenRTB 2.6 implementation guide](https://github.com/InteractiveAdvertisingBureau/openrtb2.x/blob/1debba8001f40eb14597102dec3205afddf811d4/implementation.md#7925-key-object-attributes-to-use-for-dooh-device-reference-in-openrtb) (§ 7.9.2.5) uses it, `device.ifa` carries the same id |
| `lat` | Number | OPTIONAL | Latitude, as OpenRTB 2.6 `geo.lat`. Absent when `movable` is true |
| `lon` | Number | OPTIONAL | Longitude, as OpenRTB 2.6 `geo.lon`. Absent when `movable` is true |
| `movable` | Boolean | OPTIONAL | True when the screen has no fixed location, as AdCOM 1.0 `Dooh.fixed` value 2 (movable) |
| `time_zone` | IanaZone | OPTIONAL | The screen's time zone |
| `operating_hours[]` | Array[ClockWindow] | OPTIONAL | `ClockWindow` entries (§ 5.5), in the screen's `time_zone` |
| `loop` | Loop | OPTIONAL | Absent when the screen schedules ads without a loop |

**`Loop`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `length_s` | Integer | REQUIRED | Loop length, in seconds |
| `slot_s` | Integer | REQUIRED | Slot length, in seconds |

**`SyncGroup`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `sync_group_id` | String | REQUIRED | The group's id |
| `screen_ids[]` | Array[String] | REQUIRED | The `screen_id` of each screen in the group |
| `min_screens_per_play` | Integer | REQUIRED | The fewest of the group's screens that must show a display for it to count as one play (§ 5.6.4) |

With `seller_allocated`, a buyer value MUST NOT name or exclude individual
screens.

With a `loop`, a screen delivers `slots_per_loop` × 3,600 ÷ `length_s` plays per
operating hour.

#### 5.2.9 programs

**`ProgramOption`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `id` | String | REQUIRED | Option id (§ 3.1). It is not compared with delivered content |
| `content` | Object | OPTIONAL | An [AdCOM 1.0 `Content`](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#object_content) object, in AdCOM's keys and meanings, `series`, `title`, `network`, `channel`, `genres`, `rating`, `live`, and `realtime` included. Its `channel` is the [AdCOM `Channel`](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#object_channel) object, the TV channel or station the content is on |
| `schedule` | EventSchedule | OPTIONAL | When the event airs. An option for a scheduled event carries it |

**`EventSchedule`** keys come from the
[LEAP Forecast API `UpcomingEvent`](https://github.com/IABTechLab/Live-Event-Ad-Protocols/blob/a9278d71c138cfa3a31d4953e82795ac48dc7fbe/ForecastAPI.md#upcomingevent), in LEAP's spelling and with its
meanings, except that the two times are `Instant` values:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `scheduledstart` | Instant | REQUIRED | When the event is scheduled to start |
| `scheduledend` | Instant | REQUIRED | When the event is scheduled to end |
| `flexibleend` | IntegerFlag | OPTIONAL | Whether `scheduledend` can move, which LEAP calls flexible. Absent: `0` |
| `eventstatus` | Integer | RECOMMENDED | `1` (scheduled) \| `2` (tentative) \| `3` (cancelled). Absent: `1` |

An impression matches an option when its content has the option's value for every
key `content` declares, with `network` and `channel` compared by `id`. With
`schedule`, the impression also falls between `scheduledstart` and `scheduledend`,
or the event's actual end when `flexibleend` is `1`.

With an option in effect, the seller MUST serve the line item only into impressions
that match one. When the line item executes over OpenRTB 2.6, the seller MUST send the
matched option's `content` values in `site.content` or `app.content`, under OpenRTB 2.6's
key names, such as `livestream` for `live` and `contentrating` for `rating`.

An option whose `schedule.eventstatus` is tentative (`2`) MUST NOT be in `included[]`,
and its entry in `deltas`, if any, MUST be `delta_flat`.

An event in effect that is cancelled or does not air in its window delivers nothing,
and its `delta_flat` is not owed. `commitment` still applies across the other options
in effect inside the flight, and a shortfall against it settles under
`shortfall_remedy` (§ 5.7) as for any other delivery.

### 5.3 Audience reach

| Field | Type | Required | Mutability | Description |
| :--- | :--- | :--- | :--- | :--- |
| `audiences` | AudienceSelectable | OPTIONAL | selectable | See below |
| `addressable_scale` | AddressableScale | OPTIONAL | asserted | What the line item can reach, recomputed against the buyer's selection. Not segment size. See below |
| `activation_route` | Selectable[VocabularyTerm] | OPTIONAL | selectable | Where the audience is matched. Core terms: `seller_side` (the seller's systems) \| `clean_room` (a clean room) \| `id_partner` (a third-party identity provider) |
| `buyer_supplied` | BuyerSupplied | OPTIONAL | mixed | See below |

**`AudienceOption`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `id` | String | REQUIRED | Option id (§ 3.1) |
| `name` | String | OPTIONAL | The audience's name, for people |
| `taxonomy` | Integer | REQUIRED | The integer from the OpenRTB segment taxonomies list for the IDs that name this option: `4` (IAB Tech Lab Audience Taxonomy 1.1) for the label's `taxonomy_id_list`, or the seller's registered vendor value (500 and up) for the label's `audience_id`. When the seller signals the segment in an OpenRTB 2.6 request, these are the `data.ext.segtax` and `segment.id` values |
| `data_label` | Object | REQUIRED | The option's IAB Tech Lab Data Transparency Standard 1.1 label: every field in its "Minimum Segment Disclosures: Required Fields" table, keyed by its API flat file key, with values exactly as the standard publishes them, such as `Observed/Known` or `TCF (Europe)`. A multi-select field the standard gives no separator for is an array of those values. The standard's conditional rules apply: offline data sources require the Onboarder Details fields, which otherwise take the standard's `N/A` option; `Modeled` requires `audience_expansion: Yes`; and `Single domain / App` scope requires a domain or app store URL in `originating_domain` |
| `sensitive_categories[]` | Array[VocabularyTerm] | REQUIRED | The categories the option's membership is derived from or reveals. Core terms: `racial_or_ethnic_origin` \| `political_opinions` \| `religious_or_philosophical_beliefs` \| `trade_union_membership` \| `genetic` \| `biometric` \| `health` \| `sex_life_or_sexual_orientation` \| `precise_geolocation` \| `minors` (under 18). An empty array declares none |
| `excludable` | Boolean | OPTIONAL | Whether the buyer may name this option in `excluded[]`. Absent means `false` |

**`AudienceSelectable`** holds the keys of `Selectable[AudienceOption]` and these:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `combine` | Selectable[CombineOperator] | REQUIRED when more than one seller audience can be in effect | The operators the seller supports. `max_select: 1`. `included[]` MUST name exactly one option. It carries no `deltas` |
| `excluded[]` | Array[String] | OPTIONAL | The buyer's write: option ids of options whose `excludable` is `true`, disjoint from the seller audiences in effect. `max_select` does not count them |

**`CombineOperator`** is `any` \| `all`.

The line item targets users who match all of the following conditions:

1. The seller audiences in effect (§ 3.1), under the `combine` option in effect. `any`
   matches a user in at least one of them. `all` matches a user in every one. An empty
   set adds no condition.
2. At least one of `buyer_supplied.segments[]`, when that list is not empty.
3. None of the options in `excluded[]`.
4. Not in `buyer_supplied.suppression_list`.

An option in `excluded[]` adds its delta to `agreed_rate` (§ 5.6), under either
operator.

`addressable_scale` and `availability` (§ 3.3) MUST be recomputed against
conditions 1 and 3. Conditions 2 and 4 need the buyer's data matched first;
until then, the figures for them are estimates.

**`BuyerSupplied`** keys:

| Key | Type | Required | Meaning | Mutability |
| :--- | :--- | :--- | :--- | :--- |
| `segments_allowed` | Boolean | OPTIONAL | Whether the buyer may supply `segments[]` | seller-set |
| `suppression_allowed` | Boolean | OPTIONAL | Whether the buyer may supply `suppression_list` | seller-set |
| `expected_match_rate` | Fraction | OPTIONAL | The seller's stated expectation of the share of a buyer's list that matches | asserted |
| `segments[]` | Array[BuyerList] | OPTIONAL | The buyer's segments | supplied |
| `suppression_list` | BuyerList | OPTIONAL | The users the line item doesn't target | supplied |

**`BuyerList`** describes a list the buyer supplies. Its members travel outside this
object.

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `list_id` | String | REQUIRED | Identity of the list within the line item. The buyer uses it wherever the list's members travel |
| `source` | String | OPTIONAL | Where the list comes from, such as `advertiser_crm` |
| `size` | Integer | OPTIONAL | How many members it holds |
| `match_method` | VocabularyTerm | OPTIONAL | How its members match users. Core terms: `hashed_email` \| `device_id`. A receiver that doesn't know a term reads the method as unstated |

**`AddressableScale`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `quantity` | Integer | REQUIRED | How many |
| `unit` | VocabularyTerm | REQUIRED | What `quantity` counts. Core terms: the `frequency_cap.per` terms (§ 5.5), and `person`. A receiver that doesn't know a term reads the figure as unstated |
| `window` | Interval | REQUIRED | The dates `quantity` covers |

### 5.4 Creative requirements

| Field | Type | Required | Mutability | Description |
| :--- | :--- | :--- | :--- | :--- |
| `formats` | Selectable[FormatId] | OPTIONAL | selectable | Format ids, such as `display/300x250` and `audio/host-read-30s`. Absent: this line item states no format |
| `format_specs` | Map[FormatId, FormatSpec] | REQUIRED when the proposal has left `draft` and `formats` is present | seller-set | Map from format id to `FormatSpec` |
| `creative_delivery` | CreativeDelivery | OPTIONAL | seller-set | How creative travels. See the creative path below. Absent: this line item states no path, and a `materials_due` still applies |
| `assets[]` | Array[Asset] | OPTIONAL | mixed | A record of the creative that reaches the seller or that the seller builds |
| `materials_due` | MaterialsDue | OPTIONAL | requestable | Deadline for creative to reach the seller. A buyer MAY request a later date |
| `approval` | String | OPTIONAL | seller-set | Review SLA and revision policy, in prose |
| `creative_policy` | String | OPTIONAL | seller-set | Content and category restrictions on creative, in prose |
| `production` | Selectable[ProductionOption] | OPTIONAL | selectable | Custom units. See `ProductionOption` below. Nothing in effect: no custom unit |

**`FormatId`** is a String: `<channel>/<name>`, where `<channel>` is the line item's
`channel`, with no `/` or `@` inside a part.

**`FormatSpec`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `spec_ref` | EntryRef | OPTIONAL | The format registry entry the spec comes from. Absent when the seller defines it |
| `spec` | Object | REQUIRED | The full specification. OpenProposal does not hardcode a shape per channel |

Once the proposal leaves `draft`, every id in `formats.available[]` MUST have a
`format_specs` entry. When `spec_ref` is present, `spec` MUST equal the content
of the version it names, and the format id SHOULD equal the `<collection>/<entry_id>`
part of `spec_ref`. A later registry version does not change an agreed record's
`format_specs`.

A `spec` MAY hold `asset`, a `VocabularyTerm` (§ 2.2) that says what the buyer
supplies for the format. Core terms: `audio_file` \| `video_file` \| `image_file` \|
`markup` \| `script`. A receiver that doesn't know a term treats that format as
unavailable.

A `spec` MAY also hold `voice`, a `VocabularyTerm` that says whether a synthesized
voice may read the ad. Core terms: `human_only` \| `synthetic_permitted`. A receiver
that doesn't know a term treats that format as unavailable. An asset whose
`provenance.synthetic` is true doesn't conform to a spec whose `voice` is
`human_only`.

**`MaterialsDue`** holds exactly one key:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `at` | Instant | REQUIRED when `before_start` is absent | The deadline |
| `before_start` | Duration | REQUIRED when `at` is absent | The deadline, as a length of time before `commitment.flight.start` |

**`Asset`** keys:

| Key | Type | Required | Meaning | Mutability |
| :--- | :--- | :--- | :--- | :--- |
| `asset_id` | String | REQUIRED | Identity of the asset within the line item | supplied |
| `format_id` | FormatId | REQUIRED | The `formats.available[]` id the asset is for | supplied |
| `url` | String | REQUIRED when `markup` is absent | Where the asset is, such as a tag URL with its macros unexpanded | supplied |
| `markup` | String | REQUIRED when `url` is absent | The tag or creative markup | supplied |
| `submitted_at` | Instant | OPTIONAL | When it was delivered | supplied |
| `built_by` | Side | OPTIONAL | Which side built it. Absent: the buyer | supplied |
| `provenance` | AssetProvenance | OPTIONAL | How the asset was made | supplied |
| `approval_status` | ApprovalStatus | OPTIONAL | The seller's review outcome. The seller moves it | lifecycle |

On an entry with `built_by: seller`, the seller writes the keys marked `supplied`. A
live read has no file to record, so it has no entry.

**`AssetProvenance`** records what the party that delivers an asset states about how
it was made. It isn't itself a marking or a disclosure under any law.

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `synthetic` | Boolean | REQUIRED | True when the content is artificially generated or manipulated, in whole or in part |
| `generator` | String | OPTIONAL | The system that generated it |
| `model_version` | String | OPTIONAL | The version of the model that generated it |
| `voice_consent_ref` | DocumentRef | OPTIONAL | The consent of the person whose voice is synthesized |
| `disclosure_methods[]` | Array[VocabularyTerm] | OPTIONAL | How the content is marked or disclosed. Core terms: `c2pa_manifest` \| `watermark` \| `audible_notice` \| `visible_label`. A receiver that doesn't know a term reads that method as unstated |
| `content_digest` | Digest | OPTIONAL | Over the exact bytes served at `url` |

**`CreativeDelivery`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `method` | VocabularyTerm | REQUIRED | Core terms: `buyer_hosted` \| `seller_hosted` \| `api` \| `platform_managed`, defined in the creative path below |
| `protocols[]` | Array[Integer] | OPTIONAL | Values from AdCOM 1.0 [List: Creative Subtypes - Audio/Video](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#list_creativesubtypesaudiovideo) the seller accepts, wrappers included, such as VAST 4.2 (13). The values OpenRTB 2.6 `video.protocols` and `audio.protocols` carry |
| `other_protocols[]` | Array[VocabularyTerm] | OPTIONAL | How a creative that list has no code for is delivered. Core term: `javascript_tag`, a tag whose script renders the ad. A receiver that doesn't know a term treats only that term as unavailable |
| `secure_required` | Boolean | OPTIONAL | Whether the creative must load over a secure connection. Absent: this line item states no such requirement |
| `endpoint` | Url | OPTIONAL | Where the buyer sends creative |

**Creative path.** `creative_delivery.method` routes the creative under any
`transaction_mechanism`:

| `method` | Who hosts the creative | What reaches the seller |
| :--- | :--- | :--- |
| `buyer_hosted` | The buyer's ad server | A URL or tag, in `assets[]`. When the bid carries the tag, nothing |
| `seller_hosted` | The seller | The creative, in `assets[]` |
| `api` | The seller | The creative, through the seller's API, at `endpoint` when the seller names one. `assets[]` records it |
| `platform_managed` | The platform that runs the buy, such as the DSP | Nothing. The platform holds the creative and its review |

`materials_due` doesn't apply when nothing reaches the seller. Under OpenDirect 2.1,
an `assets[]` entry is a `Creative` assigned to the `Line`, and `approval_status` reads
as the seller's status in its `creativeapprovals`.

**`ProductionOption`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `id` | String | REQUIRED | Option id (§ 3.1) |
| `custom_unit` | String | OPTIONAL | The custom unit built |
| `built_by` | Side | OPTIONAL | Which side builds it |
| `lead_time` | Duration | OPTIONAL | Time the build needs |

#### 5.4.1 Creative inspection and previews

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

`geo`, `device`, `daypart`, and `frequency_cap` declare bounds, not a value (§ 3.2), and
one that is absent declares none.
`markets` declares options (§ 3.1). For `accepted_exclusions` and `exclusions`, the
seller declares what it can enforce, and the buyer supplies its lists.

| Field | Type | Required | Mutability | Description |
| :--- | :--- | :--- | :--- | :--- |
| `geo` | Settable[GeoCode] | OPTIONAL | settable | Where the line item runs. `allowed[]` of `GeoCode` (below). A line item MUST NOT declare both `geo` and `markets` |
| `markets` | Selectable[GeoCode] | OPTIONAL | selectable | For a line item priced by market. See `GeoCode` below |
| `device` | Settable[Integer] | OPTIONAL | settable | `allowed[]` of [AdCOM 1.0 List: Device Types](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#list_devicetypes) codes, the values of OpenRTB 2.6 `device.devicetype`. It narrows `environments` (§ 5.2.1). Mobile/Tablet - General (1) covers Phone (4) and Tablet (5) |
| `daypart` | Settable[ClockWindow] | OPTIONAL | settable | `allowed[]` of `ClockWindow` (below). A window covers any window inside it |
| `time_zone` | ZoneName | REQUIRED when `daypart` or `frequency_cap` is present | seller-set | The clock for `daypart` and a calendar `frequency_cap.period` |
| `frequency_cap` | FrequencyCap | OPTIONAL | settable | See below |
| `accepted_exclusions` | AcceptedExclusions | OPTIONAL | seller-set | What the seller can enforce. See below |
| `exclusions` | Map[ExclusionType, ExclusionList] | OPTIONAL | supplied | The buyer's block lists, keyed by exclusion type. See below |

**Block lists.** The seller declares which exclusion types it accepts and how it
enforces each; the buyer supplies its lists within that declaration.

```yaml
accepted_exclusions:
  types:
    domains:    { enforcement: pre_serve, max_entries: 5000 }
    apps:       { enforcement: pre_serve }
    categories: { enforcement: pre_serve }
    keywords:   { enforcement: best_effort, max_entries: 500 }
  verification: ["integralads.com", "doubleverify.com"]

exclusions:
  domains:    ["example-gambling.example"]
  apps:       [{ store: roku_channel_store, bundle: "123456" }]
  categories: [{ taxonomy: 7, ids: ["181"] }]         # IAB Content Taxonomy 3.0: Casinos & Gambling
  keywords:   { url: "https://agency-a.example/lists/keywords-2026-10.json",   # a long list, by reference
                digest: "sha256:ca833e169e39bcaae9fc5b74f8dd3cfddf5b1c4158b6bc19bb3ae9112a347b06" }
```

**`ExclusionType`** is a `VocabularyTerm` (§ 2.2). Core terms: `domains` \| `apps` \| `categories` \|
`keywords`.

| `exclusions` | Entry | Meaning |
| :--- | :--- | :--- |
| `domains` | `Domain` | A domain. It covers only itself, not its subdomains |
| `apps` | `AppId` | An app (§ 5.2.5). A seller MUST reject an entry whose `store` it doesn't know, rather than apply it across stores, with `validation` |
| `categories` | `TaxonomyCodes` | `taxonomy` per AdCOM 1.0 List: Category Taxonomies. An id covers only itself, not its descendants |
| `keywords` | `String` | A keyword |

**`ExclusionList`** is an array of entries, or a `DocumentRef` (§ 2.2) to a JSON array
of them. The Entry cell of an exclusion type's row gives an entry's form, and an
extension term's definition gives its own. Each entry in that document counts as
that type.

**`AcceptedExclusions`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `types` | Map[ExclusionType, ExclusionTerms] | REQUIRED | The exclusion types the seller accepts (core terms above), and its terms for each |
| `verification[]` | Array[RegistrableDomain] | OPTIONAL | The third parties that can attest the seller enforced these lists |

**`ExclusionTerms`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `enforcement` | Enum | REQUIRED | `pre_serve` \| `best_effort` |
| `max_entries` | Integer | OPTIONAL | The most entries of this type the seller accepts |

- A buyer MUST NOT supply an exclusion type absent from
  `accepted_exclusions.types`. A seller MUST reject it deterministically
  rather than ignore it, with `not_offered`.
- A seller MUST NOT present `best_effort` enforcement as a guarantee.
- An exclusion the buyer adds after `agreed` is a delivery under
  `accepted_exclusions` (§ 4.1.1). It travels outside this object, as the members of a
  `BuyerList` (§ 5.3) do, and `exclusions` stays as it stood at `agreed`.

A buyer's exclusions reveal its strategy. A seller MUST NOT disclose them to anyone
but that buyer and the systems and vendors that enforce or verify them for this line
item.

**`GeoCode`** is a String: an ISO 3166-1 alpha-2 country code, an ISO 3166-2
subdivision code, or an extension `VocabularyTerm` for any other area, such as a
metro list. The country of an ISO 3166-2 code is the part before the hyphen, and a
country covers every subdivision code it prefixes. An extension term covers only
itself. § 1.1 states the conversion to OpenRTB 2.6 and the Deals API.

```yaml
geo:
  allowed: ["US"]
  default: { include: ["US"] }
  value:   { include: ["US"], exclude: ["US-TX"] }   # the buyer's write
```

**Market-priced line items.** A seller whose rate differs by market declares `markets`:

```yaml
markets:
  available:  ["SG", "TH", "ID", "MY"]
  included:   ["SG", "TH"]
  deltas:     { "ID": { delta_cpm: 18.00 }, "MY": { delta_cpm: 21.00 } }
  max_select: 4
  selected:   ["SG", "ID"]   # the buyer's write: runs in these two, and pays the ID delta
```

**`ClockWindow`** is a repeating window of civil time, deliberately not an `Interval`.
A window that crosses midnight is two windows.

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `days[]` | Array[DayOfWeek] | REQUIRED | The days the window repeats on |
| `start` | ClockTime | REQUIRED | The first minute. Not `24:00` |
| `before` | ClockTime | REQUIRED | The first minute after the window, later than `start` |

**`ClockTime`** is a String: `HH:MM` on a 24-hour clock, two digits each, from `00:00`
to `23:59`, or `24:00`, the end of the day.

**`DayOfWeek`** is `monday` \| `tuesday` \| `wednesday` \| `thursday` \| `friday` \|
`saturday` \| `sunday`.

```yaml
# Late fringe, 23:00 to 01:00, Monday night into Tuesday
daypart:
  allowed:
    - { days: [monday],  start: "23:00", before: "24:00" }
    - { days: [tuesday], start: "00:00", before: "01:00" }
  default:
    include:
      - { days: [monday],  start: "23:00", before: "24:00" }
      - { days: [tuesday], start: "00:00", before: "01:00" }
time_zone: "America/New_York"
```

**Clock.** Windows follow daylight-saving rules: a skipped
hour matches no instant; a repeated hour matches both. Like the calendar Day of
[OpenDirect 2.1 `Line.frequencyinterval`](https://github.com/InteractiveAdvertisingBureau/OpenDirect/blob/82bc294314aba017fc639ba634aecc53adfd675f/OpenDirect.v2.1.final.md#object_line),
a `frequency_cap.period` other than `flight` is a calendar period in `time_zone`; weeks start on
Monday.

**`FrequencyCap`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `count` | SettableRange[Integer] | REQUIRED | The cap. The buyer's `value` is the count, and `period` and `per` stay the seller's |
| `period` | TimeUnit | REQUIRED | The bucket the count runs over |
| `per` | VocabularyTerm | REQUIRED | Who is capped. It matters: CTV typically caps at household, audio at listener. Core terms: `device` \| `household` \| `listener` \| `screen` |

`screen` caps plays per DOOH screen, counted by `screen_id`, or by `sync_group_id` for
a sync group's screens; in the bid stream, the screen is the OpenRTB 2.6 `device`
with `devicetype` 8.

### 5.6 Commercial terms

| Field | Type | Required | Mutability | Description |
| :--- | :--- | :--- | :--- | :--- |
| `pricing[]` | Array[PricingEntry] | REQUIRED | mixed | See below |
| `pricing[].pricing_id` | String | REQUIRED | immutable | Names the entry within the line item. A revision MUST NOT reuse it for a different `cost_method`, `cost_parameters`, `currency`, or `transaction_mechanisms[]` |
| `pricing[].cost_method` | VocabularyTerm | REQUIRED | seller-set | The billable unit. Core terms in § 5.6.5 |
| `pricing[].rate_per` | Integer | REQUIRED when `cost_method` is an extension term | seller-set | `1` \| `1000`. Units per rate. For a core term, the vocabulary sets it, and a present value MUST match |
| `pricing[].unit_label` | String | REQUIRED when `cost_method` is an extension term | seller-set | A short label for one unit, such as `engagement` |
| `pricing[].cost_definition` | DocumentRef | REQUIRED when `cost_method` is an extension term | seller-set | Public definition of one unit and the `cost_parameters` keys (§ 5.6.5) |
| `pricing[].cost_parameters` | CostParameters | REQUIRED when the term requires keys | seller-set | The keys the term requires (§ 5.6.5). Absent when it requires none |
| `pricing[].transaction_mechanisms[]` | Array[TransactionMechanism] | OPTIONAL | seller-set | The `transaction_mechanism` options this entry prices. Absent: every offered option |
| `pricing[].list_rate` | Amount | REQUIRED | requestable | The rate before options. A buyer MAY request another value, and a granted value is the `list_rate` of the next `version` |
| `pricing[].agreed_rate` | Amount | REQUIRED when this is the committed entry | derived | The transacted rate (below). Absent on every other entry |
| `pricing[].price_valid_until` | Instant | OPTIONAL | seller-set | How long the entry holds (§ 4.3.2). Distinct from the proposal's `offer_window.end` |
| `pricing[].currency` | CurrencyCode | REQUIRED | seller-set | The currency of the entry's rates (below) |
| `pricing[].price_type` | Integer | REQUIRED when the entry prices a deal mechanism | seller-set | How `agreed_rate` clears, as Deals API 1.0 `terms.pricetype`: Dynamic (0), the auction type of each bid request; First Price (1); Second Price Plus (2); Fixed Price (3); or an exchange-specific value, 500 and up |
| `pricing[].min_rate` | Amount | OPTIONAL | seller-set | A hint: the lowest `list_rate` the seller says it will consider. It grants nothing. Not a term, not the downstream auction floor, and never sent downstream |
| `pricing[].unit_bounds` | Range[Integer] | OPTIONAL | requestable | Bounds on the units committed under this entry, counted in its unit (§ 5.6.5): `commitment.amount` when `basis` is `units`, otherwise `derived_units`. A buyer MAY request another. Absent on a `FLAT` entry |
| `availability` | Availability | OPTIONAL | asserted | What the seller says it can deliver, recomputed against the buyer's selection (§ 3.3). See below |
| `delivery_counting` | DeliveryCounting | REQUIRED when `channel` is `dooh` | seller-set | How the line item counts plays and, when it counts impressions, turns them into impressions. See 5.6.4 |
| `commitment_bounds` | CommitmentBounds | OPTIONAL | requestable | The envelope inside which a buyer may commit, and a buyer MAY request another. See 5.6.1 |
| `commitment` | Commitment | OPTIONAL | mixed | **The buyer's actual commitment.** See 5.6.1 |
| `hold_terms` | HoldTerms | OPTIONAL | seller-set | Offers a hold. Absent means `available` is `false`. See 5.6.2 |
| `hold` | Hold | OPTIONAL | lifecycle | The buyer's hold. Absent until the buyer first asks. See 5.6.2 |
| `renewal_right` | VocabularyTerm | OPTIONAL | seller-set | The current advertiser's right to the next cycle. Core term: `first_refusal`, the right to buy the next cycle before it opens up. Absent: no such right. It is not a place in a hold queue (`hold.position`) |
| `cancellation_policy` | Selectable[CancellationOption] | OPTIONAL | selectable | See § 5.6.6. Absent: this field states no right to cancel, and `terms_refs[]` (§ 5.8) may state one |
| `exclusivity` | Selectable[ExclusivityOption] | OPTIONAL | selectable | See § 5.6.7. Nothing in effect: no exclusivity |
| `preemption` | Preemption | OPTIONAL | seller-set | See § 5.6.7. Absent: no later sale preempts this line item |

`pricing[]` entries are alternatives. The buyer commits under exactly one, the
*committed entry*, named by `commitment.pricing_id`, or the only entry when that key is absent; it MUST cover the mechanism in effect. Only that
entry enters `agreed_rate` and `derived_units`. Two entries MUST NOT share
`cost_method`, `cost_parameters`, `currency`, and a mechanism.

**`CurrencyCode`** is a String: an ISO 4217 alphabetic code, such as `USD`.

A rate reads in its own entry's `currency`. A commitment reads in the committed
entry's `currency`, and so does every other `Amount` on the line item:
`commitment_bounds.spend`, § 3.1 `delta_cpm` and `delta_flat`, and a cancellation
fee. OpenProposal never converts, so a figure is the same number in whichever
currency is committed. A seller that wants another figure in another currency
publishes separate line items.

Every `Amount` on a line item is on one basis, so that rates, charges, and totals add
and compare. § 8 asks what that basis is.

**`agreed_rate`** is computed on the committed entry from the options in effect
(§ 3.1), in exact decimal, and rounded once, half up, to 6 decimal places:

```text
agreed_rate = (list_rate + sum of delta_cpm) × product of (1 + delta_fraction)
```

A delta counts when its option is in effect and not in `included[]`, on any field of the
line item marked `selectable`; § 5.3 adds excluded audience options. A `delta_cpm` enters
only a `CPM` or `CPMV` entry (§ 3.1), and the option's other deltas still count. So
`list_rate` 24.00 with one `delta_cpm` of 3.00 and one `delta_fraction` of 0.02 is
27.54. `delta_flat` stays outside it.

**Deal price.** For a deal on a `CPM` entry (§ 1.1), the committed entry's `agreed_rate`
is the deal's price per thousand impressions, in that entry's `currency`. Under Fixed Price
(3), it is the price the buyer pays. Under an auction `price_type`, it is the
deal's minimum bid. The Deals API treats it as guidance: per-impression floors
can be higher, so a bid at `agreed_rate` is not guaranteed to clear.

**`Availability`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `unit` | VocabularyTerm | REQUIRED | What `quantity` counts. Core terms: the `unit` terms of § 5.6.5, and `slots_per_loop` (as the § 5.2.4 key) \| `unit_periods` (one unit for one period, such as a board for a 4-week cycle). A receiver that doesn't know a term can't compare the figure, and still reads the line item |
| `quantity` | Number | REQUIRED | How many. It can be fractional where the unit is, such as `rating_points` per `day` |
| `computed_at` | Instant | REQUIRED | When the seller computed it |
| `window` | Interval | REQUIRED | The dates `quantity` covers. On a read (§ 3.3) or a decline (§ 5.6.1), the flight the buyer sent |
| `granularity` | CalendarUnit | OPTIONAL | The bucket `quantity` counts per, within `window`. Absent: `quantity` is the total over `window` |
| `certainty` | Enum | REQUIRED | `forecast` \| `reservable`. `forecast`: the seller's estimate of the quantity. `reservable`: the quantity the seller says it can reserve for `window`. MUST be `forecast` when the line item's `delivery_type` (§ 5.9) is `non_guaranteed` |

An `Availability` compares with a commitment only when it has no `granularity`, its
`unit` equals the term in the § 5.6.5 `unit` column for the committed entry's
`cost_method`, and its `window` equals `commitment.flight`. § 5.6.4 states the committed
quantity on a `dooh` line item.

#### 5.6.1 commitment

Absent on a shared proposal (§ 4.3). The buyer writes it on its composed record
(§ 4.1.1), and a `commit` carries it to the seller. The buyer writes
its `settable` keys itself, and they have no `default` (§ 3.2). A
`commitment` resolves under § 3 when the buyer is eligible (§ 5.8), every `selected[]`,
`excluded[]`, and `value` on the line item is within what the seller declared (§ 3.1,
§ 3.2, § 5.3), and the commitment fits `commitment_bounds.spend` and the committed entry's `unit_bounds`, is not
stale (§ 4.1.3), and meets the package rules (§ 4.1.4). A resolved `commitment` is an offer to buy. It
binds only when the seller accepts it;
`assent[]` (§ 4.1.2) records that acceptance for the binding `version`. A seller
MAY decline a resolved `commitment` with a `decline` entry; the buyer MAY recompose.
A decline for lack of availability MUST state the `availability` of each line item it covers,
recomputed against the buyer's composition; the seller's determination is authoritative.
The figures travel in a `CommitResult` with the `decline` entry, in whatever delivers it: the
response to the `commit`, a replay, or a later delivery by the message binding (§ 1.2). A
full fetch returns the entry without them, and a buyer that learns of the decline
that way gets figures from an availability read (§ 3.3).
While a buyer's hold (§ 5.6.2) runs, the seller MUST NOT decline that buyer's `commitment` for lack of
availability. This does not cover inventory that a hold granted ahead of it
(`hold.position`, § 5.6.2) reserves or took on converting. A firm entry limits a
decline to the grounds in § 4.3.2. Acceptance ends the availability check; booking
is downstream (§ 1.1). Frozen when the line item's `status` becomes `agreed`.

**`CommitmentAmount`** is the committed figure. `basis` means only this.

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `basis` | Enum | REQUIRED | `spend` \| `units` |
| `amount` | Number | REQUIRED | The figure committed: an `Amount` when `basis` is `spend`, otherwise a whole number of the entry's units (§ 5.6.5) |

**`Commitment`** holds the keys of `CommitmentAmount`, each `settable`, and these:

| Key | Type | Required | Meaning | Mutability |
| :--- | :--- | :--- | :--- | :--- |
| `pricing_id` | String | REQUIRED when `pricing[]` has more than one entry | The entry the buyer commits under | settable |
| `flight` | Interval | REQUIRED | The buyer's campaign. **Distinct from `offer_window`** | settable |
| `advertisers[]` | Array[Party] | REQUIRED | Whom the spend is for. It holds at least one entry | settable |
| `derived_units` | Integer | OPTIONAL | The committed units, as § 5.6.5 derives them, whether or not this key is written. A written value is a copy, outside the record (§ 4.1.1); where it differs, the § 5.6.5 result applies | derived |

The buyer's `assent[]` entry (§ 4.1.2) pins the `version` of a `commit` and carries its
`idempotency_key`, so `commitment` repeats neither.

**`CommitmentBounds`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `spend` | Range[Amount] | OPTIONAL | Bounds on the seller total (§ 5.6.5) |
| `earliest_start` | Instant | OPTIONAL | Informative: the earliest `commitment.flight.start` the seller expects |
| `latest_end` | Instant | OPTIONAL | Informative: the latest `commitment.flight.end` the seller expects |

**`Commit`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `entry` | AssentEntry | REQUIRED | The buyer's entry (§ 4.1.2), with `role: commitment` |
| `writes` | Map[String, LineItemWrites] | REQUIRED | The buyer's writes (§ 3.4), keyed by each `line_item_id` that `entry.line_item_ids[]` names |

**`CommitResult`** is the result of a `commit` that wrote an entry, as it stands. Its keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `entries[]` | Array[AssentEntry] | REQUIRED | The buyer's `commitment` entry, then each matching `acceptance`, `decline`, or `withdrawal` entry written after it in `assent[]` |
| `availability` | Map[String, Availability] | REQUIRED when `entries[]` holds a `decline` for lack of availability | The figures that `decline` states, keyed by `line_item_id`. They are not part of the entry |

The seller recomputes `record_digest` over the line items the entry names as they
stand, plus the `writes` of the `Commit` (§ 4.1.1). A value equal to the entry's means
the line items have not changed and the buyer read the same terms, so the seller MAY accept,
at the `version` the entry names.

The seller MUST reject a new `commit` whose `record_digest` differs from the recomputed
value, that is stale (§ 4.1.3), whose proposal is past `offer_window.end`, or where the
committed entry is past its `price_valid_until`. The rejection MUST carry `expired` when
`offer_window.end` or `price_valid_until` has passed, `stale_version` when the `commit`
is stale, `not_committable` when a ground of that code applies (§ 2.4), and otherwise
`record_mismatch`, so the buyer can fetch it again. A rejected `commit` writes no entry.
These checks MUST be deterministic: they depend only on the stored proposal, the
`commit`, and the time the seller receives it. A seller that rejects a `commit` before
`offer_window.start`, or because a live `commitment` entry already names one of its line
items (§ 4.1.2), returns `not_committable` with `retry: same`.

A `commit` on an issued proposal that this specification gives the seller no ground to
reject writes the buyer's `commitment` entry. The seller's answer comes in the same
response or later. Either way it is an `assent[]` entry, which a full fetch returns
(§ 2.1). How a buyer learns of a later answer belongs to the message binding (§ 1.2).

For a replay from the same buyer of a `commit` the seller has already processed, with
the same `idempotency_key` and an otherwise equal `Commit`, the seller MUST return the
result as it now stands: the rejection, or the `CommitResult`. It MUST NOT write a second
`commitment` entry. The checks above apply to a new `commit`, not to returning a stored
result. An error whose `retry` is `same` is not a stored result, so the retry runs the
checks again. Reusing an `idempotency_key` with a different `Commit` MUST return
`idempotency_conflict` and MUST NOT write an entry or change a `commitment`. A retry
against a new `version` is a new `commit`, with a new `idempotency_key`.

A buyer's `commitment` entry carries its `idempotency_key`, and `assent[]` keeps every
entry (§ 4.1.2). So a seller finds a `commit` that wrote an entry by its key for as long
as it keeps the proposal. A rejection writes no entry. The seller MUST keep a rejection
whose `retry` is not `same` at least until `offer_window.end`, or, on a proposal with no
`offer_window.end`, for as long as it keeps the proposal. Once the seller no longer keeps
a rejection, it runs the checks above on a replay as on a first `commit`, and a replay
that passes writes the entry with its `idempotency_key`.

#### 5.6.2 Holds

`hold_terms` offers a hold. It is `seller-set`, and it is inside the binding record.
`hold` is live state, outside the record (§ 4.1.1), and is absent on a shared
proposal (§ 4.3).
`held` means the seller has reserved inventory. A seller that only honors terms sets
`hold_terms.available` to `false` and uses `price_valid_until`.

**`HoldTerms`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `available` | Boolean | REQUIRED | Whether this line item may be held |
| `duration` | Duration | OPTIONAL | How long a hold runs from its grant |

**`Hold`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `status` | HoldStatus | REQUIRED | Moved by the transitions below |
| `version` | Integer | REQUIRED | The `version` the hold is on (§ 4.1.3) |
| `requested_terms` | LineItemWrites | OPTIONAL | The composition the buyer asks to hold, which is not a `commit`. A field it doesn't name reads as § 3.1 and § 3.2 put in effect |
| `held_availability` | Availability | OPTIONAL | What the hold reserves, as the seller states it on a grant or a re-offer. It can be less than `requested_terms` asks |
| `position` | Integer | OPTIONAL | Seller-set, 1 for first in line, in the order granted. A later hold moves up only when the one ahead expires, is released or converts. Holds on the same inventory reserve it in that order, so a later hold reserves only what the holds granted ahead of it leave (§ 5.6.1) |
| `reference` | String | OPTIONAL | Seller-set. The seller's id for the reservation, so a buyer can reconcile a hold against the seller's systems |
| `valid_until` | Instant | REQUIRED when `status` is `held` | The grant time plus `hold_terms.duration`, or the § 4.3.4 cap if that comes first. With no `duration`, the seller sets it within the cap. It MAY remain on `expired` and `released` |

**`HoldStatus`** is `requested` \| `held` \| `declined` \| `expired` \| `released` \|
`converted`.

These transitions are exhaustive:

- No `hold`, or `declined` | `expired` | `released` → `requested`: the buyer asks,
  writing `version` and any `requested_terms`. `hold_terms.available` MUST be `true`.
  The ask replaces any earlier `hold`.
- `requested` → `held`: the seller grants, writing `valid_until` and any
  `held_availability`.
- `requested` → `declined`: the seller declines, `hold_terms.available` becomes
  `false`, or the line item leaves `published` or `under_review` other than to
  `agreed`.
- `held` → `held`: the seller re-offers a hold its revision makes stale, moving
  `version` to the new one, writing any `held_availability`, and lowering `valid_until`
  to the new version's cap (§ 4.3.4) where that comes first (§ 4.3.2, rule 2).
- `held` → `expired`: `valid_until` passes and no `commit` the buyer made while the hold
  ran is open (§ 4.3). The hold stays `held` while that `commit` is open. Otherwise a seller
  could leave it unanswered until the hold lapses, then decline it for lack of availability.
- `held` → `released`: the buyer releases, or the seller releases a hold its
  revision makes stale (§ 4.3.2, rule 2).
- `requested` | `held` → `converted`: the line item reaches `agreed`.
  `converted` is terminal.

While `status` is `held`, the held terms are the offered terms of `hold.version`,
which § 4.1.3 freezes; a seller change is a new `version` under § 4.3.2, rule 2.

A seller's answer MUST set `status` to `held` or `declined`. A repeated request
while `requested` or `held` MUST NOT start a second hold. The holds on the line items
in one package's `line_items[]` (§ 4.1.4) move as a unit: each
transition applies to all of them, and `valid_until` is the earliest any of them
allows.

Hold transitions do not change the line item's `status` (§ 5.1) and do not
append to `negotiation_history[]` (§ 4.1).

#### 5.6.3 Add-ons

An add-on is a line item a package holds in `add_ons[]` (§ 4.1.4). It has its own
pricing, such as a discounted `list_rate` or `cost_method: FLAT` at 0. A conditional
discount is an add-on, not a price that changes with the other line items selected,
so every price stays self-contained. A bonus that more than one package unlocks is an
add-on in each, under its own `line_item_id`.

#### 5.6.4 Plays and impressions

On a `dooh` line item, a **play** is one display of an ad on one screen,
inside the screen's operating hours, that ends no more than
`play_tolerance_ms` short of the ad's full duration and that the
proof-of-play log records. On a sync group (§ 5.2.8), a display that
meets those conditions on at least `min_screens_per_play` of its screens is
one play, not one per screen. An **impression** is a play times the
multiplier for that screen or sync group at that time. Every impression
count on the line item (`pricing[]`, `commitment`, `availability`,
`committed_metrics[]`) counts these. A line item counts impressions when any of those
counts is in impressions.

The committed quantity is in the committed entry's unit (§ 5.6.5), so
`PLAY` commits plays and `CPM` commits impressions. Where the committed quantity is
impressions, plays are informative. Where it is plays, impressions are informative. With
`properties.available[].allocation: seller_allocated`, or on a screen that schedules
without a loop, plays are also reported. A `committed_metrics[]` tuple commits its own level either way
(§ 5.7.1).

**`DeliveryCounting`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `play_tolerance_ms` | Integer | REQUIRED | How far short of its full duration a play may end and still count |
| `proof_of_performance` | ProofOfPerformance | REQUIRED | Who logs the plays and what the buyer receives |
| `partial_play_credit` | VocabularyTerm | REQUIRED when a property has `sync_groups[]` | What a display on fewer than `min_screens_per_play` screens counts. Core terms: `none` (no play) \| `pro_rata` (screens played ÷ `min_screens_per_play`) |
| `impression_multiplier` | ImpressionMultiplier | REQUIRED when the line item counts impressions | What turns a play into impressions. A line item that counts only plays needs none |

**`ProofOfPerformance`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `logged_by` | Measurer | REQUIRED | Who keeps the proof-of-play log |
| `evidence[]` | Array[VocabularyTerm] | REQUIRED | What the buyer receives. Core terms: `play_log` \| `photo` \| `audit_report` |

**`ImpressionMultiplier`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `impression_type` | Enum | REQUIRED | `gross` \| `viewable` \| `lts` \| `audience`: Gross, Viewable (OTS), Likelihood-to-See, or Audience impressions, as the MRC Out-of-Home Measurement Standards (Phase 1 & 2 Combined, December 2025) define them |
| `source_type` | Integer | REQUIRED | Who supplies the multiplier. A value from AdCOM 1.0 [List: DOOH Multiplier Measurement Source Types](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#list_doohmultipliermeasurementmourcetypes) other than Unknown (`0`), such as Publisher Provided (`2`). The value OpenRTB 2.6 `imp.qty.sourcetype` carries |
| `vendor` | RegistrableDomain | REQUIRED when `source_type` is not Publisher Provided (`2`) | The domain of the vendor or exchange that supplies the multipliers, as OpenRTB 2.6 `imp.qty.vendor` names a vendor |
| `dataset` | String | REQUIRED | The source's named data release the multipliers come from. A new release is a new `dataset` |
| `settles_on` | Enum | REQUIRED | `declared` \| `restated`. `declared`: the value `dataset` gives that screen, or sync group, and hour when the play runs. Under a deal mechanism (§ 5.9), the bid request carries it as OpenRTB 2.6 `imp.qty.multiplier`. `restated`: that value after any reissue of `dataset` by its source before the count is final (§ 5.7.1) |

The multiplier's source controls the count of impressions: `seller` when `source_type`
is Publisher Provided (`2`) or `vendor` is the proposal's `seller.domain`, and `vendor`
otherwise. Every impression count that settles or invoices the line item MUST use its
multipliers, and a committed `impressions` level (§ 5.7.1) settles on that source's
count.

Impressions MUST be summed unrounded over each invoice period and rounded
once.

#### 5.6.5 Cost methods

`cost_method` is a `VocabularyTerm` (§ 2.2). Its core terms are `CPM` \| `CPMV` \| `CPC` \|
`CPCV` \| `CPV` \| `CPP` \| `CPA` \| `PLAY` \| `TIME` \| `FLAT`. Terms are upper case, like
[OpenDirect 2.1 `Line.ratetype`](https://github.com/InteractiveAdvertisingBureau/OpenDirect/blob/82bc294314aba017fc639ba634aecc53adfd675f/OpenDirect.v2.1.final.md#object_line).
§ 1.1 maps them to that list.

| `cost_method` | `unit` | One unit | Rate per | `cost_parameters` |
| :--- | :--- | :--- | :--- | :--- |
| `CPM` | `impressions` | Impression | 1,000 | |
| `CPMV` | `viewable_impressions` | Viewable impression | 1,000 | `viewability_standard` |
| `CPC` | `clicks` | Click | 1 | |
| `CPCV` | `completed_views` | Completed view: 100% of the creative played | 1 | |
| `CPV` | `views` | View | 1 | `view_s` or `view_fraction` |
| `CPP` | `rating_points` | Rating point | 1 | `demographic`, `rating_source` |
| `CPA` | `actions` | Action | 1 | `action_type`, `attribution_window`, `action_source` |
| `PLAY` | `plays` | DOOH play on one screen or one sync group | 1,000 | |
| `TIME` | `hours` \| `days` \| `weeks`, by `rate_unit` | One `rate_unit` | 1 | `rate_unit` |
| `FLAT` | | The line item | | |

An entry's unit is the term in the `unit` column for its `cost_method`. `unit` is a
column here, not a key on the entry. The `unit` terms are `impressions` \|
`viewable_impressions` \| `clicks` \| `completed_views` \| `views` \| `rating_points` \|
`actions` \| `plays` \| `hours` \| `days` \| `weeks`.
An extension term has no row: its `unit_label`, a free label, names its unit.

**`CostParameters`** lists the `cost_parameters` keys a core term uses. The object is
open: the term sets its keys.

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `viewability_standard` | VocabularyTerm | REQUIRED when `cost_method` is `CPMV` | The viewability standard that counts a unit. Core term: `mrc`, the MRC guidelines that `viewable_rate` cites (§ 5.7.1) |
| `view_s` | Integer | REQUIRED when `cost_method` is `CPV` and `view_fraction` is absent | Seconds played that make a view. Absent when `view_fraction` is present |
| `view_fraction` | Fraction | REQUIRED when `cost_method` is `CPV` and `view_s` is absent | The fraction of the creative played that makes a view. Absent when `view_s` is present |
| `demographic` | VocabularyTerm | REQUIRED when `cost_method` is `CPP` | The rated demographic, such as `ratings.example:adults_25_54`. Its definition states whether co-viewers and impressions of unknown age count, or says `unknown`. This version lists no core terms |
| `rating_source` | Measurer | REQUIRED when `cost_method` is `CPP` | Who supplies the ratings |
| `action_type` | VocabularyTerm | REQUIRED when `cost_method` is `CPA` | The kind of action counted, such as `shop.example:purchase`. This version lists no core terms |
| `attribution_window` | Duration | REQUIRED when `cost_method` is `CPA` | How long after exposure an action counts |
| `action_source` | Measurer | REQUIRED when `cost_method` is `CPA` | Who reports the action |
| `rate_unit` | Enum | REQUIRED when `cost_method` is `TIME` | `hour` \| `day` \| `week`. The unit the rate buys, counted in elapsed units |

A seller's own extension terms MUST use its `seller.domain` as the `<domain>`. The host
of `cost_definition.url` MUST be the term's `<domain>` or a subdomain of it.

`agreed_rate` MUST NOT be negative. When `commitment.basis` is `spend`, on an entry
other than `FLAT` or `TIME`, `agreed_rate` MUST be greater than 0.

When `commitment.basis` is `spend`, `amount` is the seller total, on the same
terms as `agreed_rate`, including `delta_flat` charges in effect (§ 3.1), which
MUST NOT exceed it. `derived_units` = (`amount` − those charges) ÷ `agreed_rate` × rate
per, rounded down to a whole unit, where rate per comes from the table for a core term
and from `rate_per` for an extension term.

When `commitment.basis` is `units`, `derived_units` is `amount`, and the seller
total is `amount` ÷ rate per × `agreed_rate` plus those charges.

`FLAT` and `TIME` set these figures from the rate and the flight instead, and a rule
that reads `commitment.amount` on such an entry reads them: the seller total when
`commitment.basis` is `spend`, `derived_units` when it is `units`.

**`FLAT`.** `agreed_rate` is the price of the line item, so the seller total is
`agreed_rate` plus those charges. `commitment.basis` MUST be `spend`, and
`derived_units` is absent.

**`TIME`.** `derived_units` is the whole `rate_unit`s elapsed from
`commitment.flight.start` through `commitment.flight.end`, inclusive, and the seller
total is `derived_units` × `agreed_rate` plus those charges.

**Delivery** is counted in the entry's unit, and each unit is worth `agreed_rate` ÷ rate
per, with rate per as above. A `FLAT` entry has no unit, so its
delivery is the days of `commitment.flight` delivered, counted in elapsed days from
`commitment.flight.start`. Each day is worth `agreed_rate` ÷ the flight's length in
days, and a last part day is worth its fraction of that.

A seller fee is never a `pricing[]` entry. A receiver MUST treat an extension entry
that breaks these rules as unavailable, not the line item as invalid.

#### 5.6.6 Cancellation option

**`CancellationOption`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `id` | String | REQUIRED | Option id (§ 3.1) |
| `notice_duration` | Duration | REQUIRED | Time from notice received to the earliest effective date: `P14D` is 14 days, `P0D` immediate |
| `max_share` | Fraction | REQUIRED | Cancellable share of the remaining commitment. `0`: non-cancellable |
| `fees[]` | Array[Fee] | REQUIRED | The fee, by how long before the reference date notice arrives. MUST be non-empty |
| `notice_reference` | VocabularyTerm | OPTIONAL | The date `before_reference` counts to. Core terms: `flight` (default) \| `install_date`. `flight`: `commitment.flight.start`. `install_date`: the posting or install date. No key in the record holds that date, so a fee that counts to it can't be computed from the record |
| `dated_shares[]` | Array[DatedShare] | OPTIONAL | Dates with their own `max_share`. Outside every entry's `window`, the top-level `max_share` applies |

**`Fee`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `before_reference` | Duration | OPTIONAL | Default `P0D`. Measured from notice received to the `notice_reference` date, or to the `window.start` of the `dated_shares[]` entry that applies. The entry with the longest `before_reference` the notice meets applies; notice that meets none takes the shortest |
| `calculation` | Enum | REQUIRED | `none` \| `cancelled` \| `commitment` \| `fixed`. `none`: no fee. `cancelled`: `share` of the cancelled amount. `commitment`: `share` of `commitment.amount` without `delta_flat` charges, whatever has been delivered. `fixed`: `amount` |
| `share` | Fraction | REQUIRED when `calculation` is `cancelled` or `commitment` | The fee as a share |
| `amount` | Amount | REQUIRED when `calculation` is `fixed` | The fee as money |

**`DatedShare`** keys. An entry applies when the effective date falls in its `window`.
Notice then counts to `window.start`.

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `window` | Interval | REQUIRED | The dates it covers. An option's windows don't overlap |
| `max_share` | Fraction | REQUIRED | Cancellable share of the remaining commitment when this entry applies |

The effective date is the later of the date the buyer asks for and notice received
plus `notice_duration`. The remaining commitment is `commitment.amount`, without
`delta_flat` charges, less delivery (§ 5.6.5) through the effective date; the
cancelled amount is the part of it the buyer cancels, up to the `max_share` that
applies. These, and the base of a `commitment` fee, are money (§ 5.6): units and days
are valued as § 5.6.5 values delivery. The buyer owes that
delivery, `production` (§ 5.4) work completed by then, and the fee.

Exercise happens downstream (§ 1.1), against the option in effect. An entry's
`cancellation` (§ 4.4) records the notice. It changes no term, and the line item's
`status` stays `agreed`.

**`CancellationNotice`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `option_id` | String | REQUIRED | The `id` of the option in effect that the notice exercises |
| `notice_received_at` | Instant | REQUIRED | When the seller received notice |
| `requested_effective_at` | Instant | REQUIRED | The effective date the buyer asks for |
| `cancelled_share` | Fraction | REQUIRED | The share of the remaining commitment cancelled, up to the `max_share` that applies |

#### 5.6.7 Exclusivity option

**`ExclusivityOption`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `id` | String | REQUIRED | Option id (§ 3.1) |
| `scope` | Enum | REQUIRED | `category` \| `sole`. `category`: no other advertiser in `categories`. `sole`: no other advertiser |
| `categories` | TaxonomyCodes | REQUIRED when `scope` is `category` | `taxonomy` per AdCOM 1.0 List: Category Taxonomies. An id covers its descendants |
| `competitors[]` | Array[RegistrableDomain] | OPTIONAL | Advertiser domains also excluded |
| `separation` | VocabularyTerm | REQUIRED | Where the term holds. Core terms: `inventory` (all of this line item) \| `page` (each page) \| `pod` (each ad pod) \| `stream` (each content stream an ad server fills) \| `episode` (each podcast episode) \| `loop` (each DOOH screen's loop) \| `location` (each venue or site of this line item's properties, static or digital) \| `paid_zone` (the part of each venue or site of this line item's properties past its paid entry, such as inside a station's fare gates) |
| `window` | Interval | OPTIONAL | The dates the term holds, only where they fall inside `commitment.flight`. Default: the whole flight. With no overlap, the term holds on no date and the option's deltas still count (§ 5.6) |

A seller MUST decline a `commitment` whose term in effect conflicts with an
accepted term on the same inventory and dates. A line item whose `preemption` names
`exclusivity` doesn't count against a later exclusivity term on dates at least its
`notice_duration` after the seller's notice, or on every date when it has no
`notice_duration`: the seller preempts it on those dates instead.

A line item states `preemption` when a later sale can preempt its delivery, such as
the faces in a station that another buyer can dominate. Its buyer reads that before
committing.

**`Preemption`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `reason` | VocabularyTerm | REQUIRED | What can preempt this line item. Core term: `exclusivity`, an exclusivity term the seller accepts later that holds, under its `separation` and `window`, where and when this line item delivers |
| `notice_duration` | Duration | OPTIONAL | The least time from the seller's notice to the first preempted delivery. Absent: no notice is owed |
| `remedy` | VocabularyTerm | OPTIONAL | What the buyer gets for the delivery a preemption takes, on any `delivery_type`. Core terms: `makegood` \| `credit` \| `none`, where `none` gives nothing for that delivery only. Absent: `shortfall_remedy` (§ 5.7) settles any shortfall the preemption causes |

A seller MUST NOT preempt a line item that has no `preemption`, or for a reason that
its `preemption` doesn't name. Preemption doesn't excuse a shortfall, which
`shortfall_remedy` (§ 5.7) settles. A `remedy` on `preemption` settles the delivery a
preemption takes instead, on any `delivery_type`.

### 5.7 Guarantees

| Field | Type | Required | Mutability | Description |
| :--- | :--- | :--- | :--- | :--- |
| `committed_metrics[]` | Array[CommittedMetric] | OPTIONAL | requestable | `CommittedMetric` tuples (§ 5.7.1). Seller declares its offered `level`. A buyer MAY request a stricter `level`, one further in `direction`. A request MUST NOT change a tuple's `direction` |
| `measurement_source` | Selectable[MeasurementOption] | OPTIONAL | selectable | Lets a buyer choose the measurement provider it transacts on. See § 5.7.1. Nothing in effect: no provider |
| `controlling_measurement` | Selectable[ControllingMeasurementOption] | REQUIRED when `serving_mode` is `embedded` or the line item has `committed_metrics[]`, `commitment_bounds.spend`, or a `pricing[].unit_bounds` | selectable | Whose count of billable units is invoiced. See § 5.7.1. `max_select: 1`. `included[]` MUST name exactly one option |
| `shortfall_remedy` | ShortfallRemedy | OPTIONAL | selectable | Core terms: `makegood` \| `credit` \| `none`. See `remedy_terms` in § 5.7.1. Nothing in effect: this line item states no remedy. Its committed levels stay guaranteed, because only `none` makes them targets |
| `reporting` | Selectable[ReportingOption] | OPTIONAL | selectable | See § 5.7.1. Nothing in effect: no report is promised |

#### 5.7.1 Settlement

`measurement_source` measures committed metrics; its `attribution_window` isn't
a settlement window. `controlling_measurement` counts the units the invoice
uses. Counted delivery, including delivery that still counts after
`commitment.flight.end`, falls in an invoice period. The seller sets the
period in `billing.invoice_period` (§ 5.10). A `month` is a calendar month in
`billing.time_zone`. `cycle` periods run back to back from `commitment.flight.start`,
each `billing.cycle_length` long.

**`CommittedMetric`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `metric` | VocabularyTerm | REQUIRED | What is measured. Core terms below. A receiver that doesn't know the term skips the line item (§ 2.2): a tuple binds outside any option |
| `level` | Number | REQUIRED | The offered level: a `Fraction` under a rate term, a count under a count term |
| `direction` | Enum | REQUIRED | `at_least` \| `at_most` |

A term defines whether its `level` is a rate or a count, and its definition names
its standard. Core terms: `viewable_rate` \| `completion_rate` \| `ivt_rate` \|
`impressions`.

| `metric` | Kind | Usual `direction` | Definition |
| :--- | :--- | :--- | :--- |
| `viewable_rate` | Rate | `at_least` | Viewable impressions per measured impression, as the MRC Viewable Ad Impression Measurement Guidelines (Desktop, Version 2.0) and the MRC Mobile Viewable Ad Impression Measurement Guidelines (June 2016) define them. Usual on display |
| `completion_rate` | Rate | `at_least` | Completed views per started ad, as the VAST `complete` and `start` tracking events report them. Usual on video, audio, and CTV |
| `ivt_rate` | Rate | `at_most` | Impressions identified as invalid traffic per measured impression, with invalid traffic as the MRC Invalid Traffic Detection and Filtration Standards Addendum (IVT 2.0) defines it |
| `impressions` | Count | `at_least` | Impressions on a `dooh` line item, counted under `delivery_counting` (§ 5.6.4) |

**`MeasurementOption`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `id` | String | REQUIRED | Option id (§ 3.1) |
| `measured_by` | Measurer | REQUIRED | The measurement provider |
| `attribution_window` | Duration | OPTIONAL | How long after exposure the provider attributes an event |
| `qualifier` | String | OPTIONAL | A product or method of `measured_by` |

**`ControllingMeasurementOption`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `id` | String | REQUIRED | Option id (§ 3.1) |
| `counted_by` | Measurer | REQUIRED | Who counts. When `channel` is `dooh` and the line item counts impressions, `counted_by` MUST be the source of the line item's `delivery_counting.impression_multiplier`. When the `pricing[]` entry the buyer commits under has `cost_method` `CPP`, `counted_by` MUST be its `cost_parameters.rating_source` |
| `qualifier` | String | OPTIONAL | A product or method of `counted_by`, such as a named ad server |
| `discrepancy_threshold` | Fraction | OPTIONAL | A fraction of the controlling count. When the other measurement, a party's own count of the same units, exceeds the controlling count by more than this over an invoice period, reconciliation opens |
| `final_after` | Duration | OPTIONAL | Such as `P30D` (30 days). A count is final that long after its invoice period ends. Committed values, whichever source measures them, are final that long after `commitment.flight.end` |

**`ReportingOption`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `id` | String | REQUIRED | Option id (§ 3.1) |
| `report_type` | VocabularyTerm | REQUIRED | The report's grain. Core terms: `log_level` (one record per event) \| `aggregate` (totals over a period or a dimension) |
| `cadence` | TimeUnit | OPTIONAL | How often a report arrives |
| `delivery_method` | VocabularyTerm | OPTIONAL | How a report arrives. Core terms: `api` \| `s3` |
| `provided_metrics[]` | Array[VocabularyTerm] | OPTIONAL | The metrics a report holds. Core terms: the `unit` terms of § 5.6.5, and the Rate terms of the `metric` table (§ 5.7.1) |
| `latency` | Duration | OPTIONAL | How long after the period a report arrives |

**`ShortfallRemedy`** holds the keys of `Selectable[VocabularyTerm]` and this one:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `remedy_terms` | RemedyTerms | OPTIONAL | The seller's terms for a remedy |

**`RemedyTerms`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `makegood_window` | Duration | OPTIONAL | How long past `commitment.flight.end` a makegood may run |
| `makegood_type` | VocabularyTerm | OPTIONAL | What a makegood delivers. Core terms: `same_unit` (more delivery on the inventory bought) \| `comparable_unit` (delivery on other inventory) \| `added_time` (more running time) |

Settlement reads the terms in force: the agreed record (§ 4.1.2) plus any change
the applying system has applied (§ 1.2).

A shortfall is a final value that misses a committed `level` in its
`direction`, under any `delivery_type`: a committed `level` is guaranteed in
its own right. Final delivery below `commitment.amount` is a
shortfall only where the line item's `delivery_type` (§ 5.9) is `guaranteed`:
counted in units when `commitment.basis` is `units`, and, when it is `spend`, valued as
§ 5.6.5 values delivery, against `commitment.amount` without `delta_flat` charges. Every
shortfall follows the `shortfall_remedy` rules below. When `preemption` states a `remedy`
(§ 5.6.7), the delivery a preemption takes, less any delivery the seller adds within
`commitment.flight` to replace it, is a shortfall on any `delivery_type`. That part
follows those rules as though its `remedy` were the only option in effect at commit,
under the `remedy_terms` of `shortfall_remedy`, and there `none` leaves committed levels
guaranteed. `shortfall_remedy` settles the rest of a shortfall.

`shortfall_remedy`: the options in effect are ordered, first choice first. When `none`
is in effect, it MUST be the only option. It means no remedy for any shortfall, and
committed levels become targets, which an agent MUST NOT present as
guaranteed. At a shortfall, the seller offers the first remedy. The buyer MAY
refuse a `makegood`, and the seller then offers the next. If none remains, the
shortfall settles under `remedy_terms`. A makegood MUST NOT run past
`commitment.flight.end` without the buyer's consent. A seller MAY offer that
consent upfront in `remedy_terms`. A buyer that commits with `makegood` in effect
consents to a makegood within `makegood_window`.

Under `sov_basis: impressions` (§ 5.9), the promised share is the offered
`sov_share`. The delivered share is measured against the same denominator and
pool, so the two are comparable.

Reports, restated counts, reconciliation, and the remedy workflow run downstream.
[OpenDirect 2.1 `Stats`](https://github.com/InteractiveAdvertisingBureau/OpenDirect/blob/82bc294314aba017fc639ba634aecc53adfd675f/OpenDirect.v2.1.final.md#object_stats)
reports delivery to date on a Line, with a spot's `shareoftime`. No standard in § 1.1
states a final count, a delivered share of impressions, a reconciliation, or a remedy.
A line item with no `controlling_measurement` option in effect, or no `final_after` on
the option in effect, states no final count either. An `embedded` line item with no
`final_after` also states no end to the counting in § 5.9, and `terms_refs[]` (§ 5.8)
may state one.

### 5.8 Transaction eligibility

`visibility` says who may read a line item. `required_credentials[]`,
`eligible_buyers[]`, `eligible_seats[]`, and `buyer_requirements` (§ 5.9) say who
may commit to it. `terms_refs[]` names the binding documents a `commitment` entry
accepts (§ 4.1.2).

| Field | Type | Required | Mutability | Description |
| :--- | :--- | :--- | :--- | :--- |
| `visibility` | Enum | REQUIRED | seller-set | `public` \| `registry_gated` \| `named`. See below |
| `required_credentials[]` | Array[RequiredCredential] | OPTIONAL | seller-set | What a buyer holds to be eligible |
| `eligible_buyers[]` | Array[RegistrableDomain] | OPTIONAL | seller-set | The buyers that may commit, by `buyer.domain` |
| `eligible_seats[]` | Array[SeatRef] | OPTIONAL | seller-set | The seats that may commit. An entry with an absent or empty `ids[]` names no seat and admits no one, unlike an absent OpenRTB 2.6 `Deal.wseat`, which sets no restriction |
| `terms_refs[]` | Array[DocumentRef] | OPTIONAL | seller-set | The binding documents of this line item, such as a main agreement and its addenda, or an IO template. Every entry applies, with no AND or OR. A `commitment` entry accepts them all (§ 4.1.2). Absent: a `commitment` entry accepts no document |

**Who may read.** Each `visibility` value names who may read the line item:

- `public`: any requester, with no authentication.
- `registry_gated`: an authenticated requester (§ 1.2) acting for a party the
  IAB Tech Lab Agent Registry attests.
- `named`: an authenticated requester acting for a party that `eligible_buyers[]`
  names, or that holds a seat `eligible_seats[]` names.

How a seller learns which party a requester acts for, or that it holds a seat, is
authorization (§ 1.2), and the object doesn't carry it.

An authenticated requester acting for the party a proposal's `buyer` names may read all
of it, whatever `visibility` says. Any other requester may read a proposal's own fields
only when it may read one of its line items. A response carries only the line items the
requester may read, and a package only when the requester may read every line item
in its `line_items[]`. A request for any other line item, or for a proposal the
requester may not read, returns `not_found` (§ 2.4). A full fetch leaves out only line
items (§ 2.1), so a value it returns can name a line item the requester may not read,
such as a `negotiation_history[]` path.

**Who may commit.** A buyer is eligible when each of these that is present holds:

- `eligible_buyers[]`, `eligible_seats[]`: `buyer.domain` MUST be in
  `eligible_buyers[]`, or `buyer_requirements.seats` MUST name at least one seat, each
  in an `eligible_seats[]` entry for its `dsp`.
- `buyer_requirements.allowed_dsps[]` (§ 5.9): when `buyer_requirements.seats` is
  present, its `dsp` MUST be in the list.
- `required_credentials[]`: the buyer meets it.

A buyer that fails these rules, or an authority check the seller applies (whether the
sender may make this request for `buyer`, or `buyer` for an advertiser it names, § 1.2),
gets `not_eligible` (§ 2.4), or `not_found` when the requester may not read what the request
names. That is a rejection, not a decline, so the limits on a
decline (§ 4.3.2, § 5.6.1) do not apply. A mandate is not a field of this object.

**`RequiredCredential`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `credential_type` | VocabularyTerm | REQUIRED | What the buyer holds. Core term: `iab_registry`, an entry in the IAB Tech Lab Agent Registry |
| `issuer` | Domain | REQUIRED | Who issues it |

A consumer that does not know a `credential_type` MUST NOT treat the proposal or
line item as invalid for that reason. It MUST treat that entry as unsatisfiable.

Message authentication follows the Web Bot Auth profile (§ 2.8). Agent identity is
defined by the AAMP agent identity and signing profile (provisional name). Neither is
expressed through `required_credentials[]`.

### 5.9 Execution

| Field | Type | Required | Mutability | Description |
| :--- | :--- | :--- | :--- | :--- |
| `transaction_mechanism` | Selectable[MechanismOption] | REQUIRED | selectable | The mechanisms the seller offers. A seller MAY offer the same inventory through more than one. `max_select: 1` |
| `sov_basis` | Enum | REQUIRED when an option's `delivery_type` is `share_of_voice` | seller-set | `impressions` \| `loop_time`. `impressions`: a share of the line item's eligible impressions (digital placements, pooled DOOH products). `loop_time`: a share of each named screen's loop time (fixed-loop DOOH spots) |
| `sov_share` | Fraction | REQUIRED when `sov_basis` is `impressions` | seller-set | Absent under `loop_time`. The promised share, greater than 0 |
| `serving_mode` | VocabularyTerm | OPTIONAL | seller-set | How the ad reaches the content or the player. Core terms: `dai` \| `scheduled` \| `embedded`, defined below. `placement.ssai` states server-side insertion |
| `retention` | Range[Duration] | REQUIRED when `serving_mode` is `embedded` | seller-set | From release or air. The ad stays in every copy of the content the seller distributes for at least `min` and is removed by `max`. No `max`: indefinitely. When `placement.feed` is present, only copies in that feed count toward delivery |
| `deal_origin` | RegistrableDomain | REQUIRED when the line item offers a deal mechanism | seller-set | Absent otherwise. The advertising system domain whose namespace holds the deal ID and that pushes the deal, as the Deals API 1.0 `origin`: typically an SSP, or the ad server for a deal it books itself |
| `buyer_requirements` | BuyerRequirements | OPTIONAL | mixed | See below |
| `serving_platform` | Domain | OPTIONAL | seller-set | The ad platform that serves the line item, such as the seller's ad server, by its domain. For a deal sold through a separate SSP it differs from `deal_origin` |

**`MechanismOption`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `id` | TransactionMechanism | REQUIRED | The mechanism, which is the option id (§ 3.1) |
| `delivery_type` | DeliveryType | REQUIRED | What the seller promises under this mechanism. The value on the mechanism in effect (§ 3.1) applies to the line item |

**`TransactionMechanism`** is `direct_io` \| `programmatic_guaranteed` \| `preferred_deal` \|
`private_auction`. A **deal mechanism** is one that
lands in a Deals API `Deal` (§ 1.1). An option's `delivery_type` MUST be one its row
allows.

| `transaction_mechanism` | Deal mechanism | `delivery_type` |
| :--- | :--- | :--- |
| `direct_io` | No | Any |
| `programmatic_guaranteed` | Yes | `guaranteed`, `share_of_voice` |
| `preferred_deal` | Yes | `non_guaranteed` |
| `private_auction` | Yes | `non_guaranteed` |

**`BuyerRequirements`** keys:

| Key | Type | Required | Meaning | Mutability |
| :--- | :--- | :--- | :--- | :--- |
| `seats_expected` | Boolean | OPTIONAL | The seller asks the buyer to supply `seats` | seller-set |
| `allowed_dsps[]` | Array[RegistrableDomain] | OPTIONAL | The DSPs that may receive the deal (§ 5.8), each by its primary domain, as `SeatRef.dsp` (§ 2.2) | seller-set |
| `seats` | SeatRef | OPTIONAL | The buyer's seats on the deal, as the Deals API 1.0 `wseat` | supplied |
| `seat_owner` | Party | OPTIONAL | The legal entity that owns the seats. Absent: the `buyer` | supplied |

**`DeliveryType`** is `guaranteed` \| `share_of_voice` \| `non_guaranteed`: what the
seller promises to deliver, independent of how the line item transacts and how it is
priced.

- `guaranteed`: the seller reserves the committed units for the flight, or, on a
  `FLAT` entry, which has none, the days of `commitment.flight` (§ 5.6.5).
- `share_of_voice`: the seller reserves a fixed share of the inventory, up to
  all of it, for the flight. With a `daypart` (§ 5.5), the share is of the
  daypart's hours only, read in the line item's `time_zone`. Sponsorships,
  roadblocks, takeovers, and DOOH loop and rotary buys.
- `non_guaranteed`: the seller reserves nothing.

A domination, every screen and static face in a location or in its paid zone, is
`guaranteed` with an included `exclusivity` term of `scope: sole` and the matching
`separation`, `location` or `paid_zone` (§ 5.6.7), not `share_of_voice` at 100%.

`sov_basis: loop_time` requires `properties.available[].allocation: all` on every DOOH
property.

Under `loop_time`, the share derives from `properties.available[].slots_per_loop` and
each screen's `loop`: `slots_per_loop` × `slot_s` ÷ `length_s`. Under `impressions`, `sov_share` states it. Its denominator
is impressions; a share counted in plays is a different product and doesn't
use this basis. On DOOH, its eligible screens are the line item's screen
set, the pool the seller allocates from under
`properties.available[].allocation: seller_allocated`.
Its scope is the line item's flight and `daypart`.

The `serving_mode` core terms mean the same on every channel:

- `dai`: an ad server picks the ad for each impression when the content or the ad
  break is requested, including ad replacement in a station's stream.
- `scheduled`: the media owner's scheduler pushes plays to the player.
- `embedded`: the ad is recorded into the content or aired in a live program, so
  everyone who receives that content receives that ad. A baked-in podcast read, a
  live read, and a broadcast spot carried in a simulcast are `embedded`.

On an `embedded` line item:

- `commitment.flight` bounds release or air dates. Delivery to that content after
  `commitment.flight.end` counts toward `commitment` until the `final_after` of the
  `controlling_measurement` option in effect elapses after that end (§ 5.7.1).
- `episodes`, when present, MUST be `new`.
- `geo`, `markets`, `device`, and `frequency_cap` MUST be absent. `daypart` bounds air
  time, not listening or viewing time, so `time_zone` MUST NOT be `viewer_local`.
- `transaction_mechanism.available[]` MUST hold only the `direct_io` option.

### 5.10 External references, agreement, and billing

| Field | Type | Required | Mutability | Description |
| :--- | :--- | :--- | :--- | :--- |
| `external_references[]` | Array[ExternalReference] | OPTIONAL | recorded | The ids other systems hold for this line item. The party that learns an id writes the entry. Once the deal exists in `deal_origin`, the seller MUST record its ID as one `deal` entry on the line item. An entry is not a term and MAY be added after `agreed` |
| `agreement` | Agreement | OPTIONAL | seller-set | The master or annual agreement the line item is priced under. An informative pointer; the agreement itself is outside this specification. A buyer-held agreement id travels as an `external_references[]` entry with `reference_type: agreement` |
| `billing` | Billing | OPTIONAL | seller-set | Who delivers is not always who invoices |

**`ExternalReference`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `system` | String | REQUIRED | The system that holds the id |
| `namespace` | String | OPTIONAL | The namespace of the id in that system |
| `id` | String | REQUIRED | The id |
| `reference_type` | VocabularyTerm | REQUIRED | What the id names. Core terms: `order` \| `line` \| `agreement` \| `deal`. `order`: the order that books the line item, such as an OpenDirect Order or an IO. `line`: the line in that order, such as an OpenDirect Line. `agreement`: a buyer-held agreement id. `deal`: the deal ID that bid requests carry, with `system` set to `deal_origin`. It is the Deals API `id` and the OpenRTB 2.6 `Deal.id`, whether `deal_origin` assigned it or accepted it from the seller. An ID that bid requests don't carry, such as the origin's internal record ID, is not a `deal` entry. A receiver that doesn't know the term ignores the entry |

**`Agreement`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `agreement_id` | String | REQUIRED | The agreement's id |
| `parties[]` | Array[Party] | OPTIONAL | The agreement's parties |
| `agreement_type` | VocabularyTerm | OPTIONAL | Core terms: `upfront` \| `annual` \| `master_services`. A receiver that doesn't know the term still reads the `agreement` |
| `term` | Interval | OPTIONAL | When the agreement runs |
| `document` | DocumentRef | OPTIONAL | The agreement, where the parties pin it |

**`Billing`** keys:

| Key | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `delivering_party` | Party | OPTIONAL | Who delivers. Absent: the `seller` |
| `invoicing_party` | Party | OPTIONAL | Who invoices. Absent: the `seller` |
| `payment_terms` | String | OPTIONAL | The payment terms, such as `net 30` |
| `invoice_period` | VocabularyTerm | OPTIONAL | The invoice period (§ 5.7.1). Core terms: `month` (default) \| `cycle` |
| `cycle_length` | Duration | REQUIRED when `invoice_period` is `cycle` | How long each `cycle` period runs, such as `P28D` (4 weeks) |
| `time_zone` | IanaZone | OPTIONAL | The clock for a `month` invoice period. Absent: `UTC` |

A buyer's own code for a supplier goes in `external_references[]`, under an
extension `reference_type`.

This specification does not define IO generation. IO creation is a connector
concern. OpenProposal supplies the agreed record and `terms_refs[]` a connector
needs.

---

## 6. Examples

Runnable copies of every example below live in [`examples/`](../examples/).

### 6.1 Proposal

Shows version 2 after one seller revision (§ 4.1.3). See
[`examples/proposal.yaml`](../examples/proposal.yaml).

Its `line_items[]` holds the line items of §§ 6.2 to 6.4, 6.7, and 6.11, which are
extracts of it. §§ 6.9 and 6.10 show a buyer's composed record (§ 4.1.1) of a line item
issued to it (§ 4.3), before its `commit`.

### 6.2 Display line item — fully worked

Shows `selectable` audiences with per-option pricing, `pricing[]` alternatives in
two currencies, cancellation options, `settable` bounds, and a `delivery_type` per
mechanism. See
[`examples/line-item-display.yaml`](../examples/line-item-display.yaml).

### 6.3 CTV line item

Shows priced cancellation options at three `notice_duration` values,
`break_position` with priced pre-roll and first-in-pod options (§ 5.2.3),
server-side insertion in `placement.ssai` (§ 5.2.2),
`format_specs` entries, two pinned to a format registry version and one defined by
the seller (§ 5.4), and `keywords` accepted only as `best_effort` (§ 5.5). See
[`examples/line-item-ctv.yaml`](../examples/line-item-ctv.yaml).

Inspecting this line item's VAST creative is subject to § 5.4.1.

### 6.4 Audio line item

Shows `placement.feed` on a music stream, a line item priced by market, a
cancellation fee that steps with notice before the start, and priced exclusivity
terms. See
[`examples/line-item-audio.yaml`](../examples/line-item-audio.yaml).

### 6.5 Package with an add-on

The CTV and audio line items of § 6.1, sold only together, with a CTV bonus line item
as an add-on (§ 5.6.3). The bonus is priced on its own and unlocked by 50,000 of
spend on the CTV line item. See
[`examples/proposal-package.yaml`](../examples/proposal-package.yaml), and the bonus
alone in [`examples/line-item-ctv-bonus.yaml`](../examples/line-item-ctv-bonus.yaml).

### 6.6 Publication manifest

A manifest (§ 2.3) listing the public line items of the example proposal. The display
line item is `registry_gated`, so it is not listed. See
[`examples/manifest.json`](../examples/manifest.json).

### 6.7 Rewarded video line item

Shows `placement` on in-app rewarded video, with OMID support that lets a
buyer select a third-party `measurement_source`. See
[`examples/line-item-rewarded-video.yaml`](../examples/line-item-rewarded-video.yaml).

### 6.8 Agreed proposal

Shows a custom proposal after the seller counters a request and accepts a
commitment: matching `assent[]` entries over one `record_digest` (§ 4.1.1,
§ 4.1.2), which covers the `digest` of each document in `terms_refs[]` (§ 5.8), the
history that led there (§ 4.3), and `change_requests[]` entries outside the digest,
one for each line item, the second a deal with no Order (§ 4.4). See
[`examples/proposal-agreed.yaml`](../examples/proposal-agreed.yaml).

### 6.9 DOOH line item

Shows a buyer's composed record (§ 4.1.1) of a line item issued to it (§ 4.3), before
its `commit`, with its `commitment`: a CPM
priced on impressions, with the multiplier's source, data release, and settlement
rule in `delivery_counting.impression_multiplier` (§ 5.6.4). See
[`examples/line-item-dooh.yaml`](../examples/line-item-dooh.yaml).

### 6.10 Embedded podcast line item

A host read recorded into new episodes of a podcast: a buyer's composed record
(§ 4.1.1) of a line item issued to it (§ 4.3), before its `commit`, with `retention` and
no per-listener targeting. See
[`examples/line-item-podcast-embedded.yaml`](../examples/line-item-podcast-embedded.yaml).

### 6.11 Live event series line item

A seven-game series sold as `programs`, with the games that may not be played
outside the base rate. See
[`examples/line-item-ctv-live-series.yaml`](../examples/line-item-ctv-live-series.yaml).

### 6.12 Issued proposal, partly agreed

A proposal issued to one buyer from the shared proposal of § 6.1 (§ 4.3). One line
item is agreed at version 1, with a commitment under one of two `pricing[]`
entries. Its buyer writes `selected[]` and `value`, and `agreed_rate` follows from
the options in effect (§ 5.6). The other stays `published` at version 2, with a hold,
so the proposal stays `published` (§ 4.3.3). The `assent[]` entries name version 1, and
the digest is over that line item alone (§ 4.1.2). A `change_requests[]` entry records a notice to
cancel part of the agreed line item (§ 5.6.6). See
[`examples/proposal-issued.yaml`](../examples/proposal-issued.yaml).

---

## 7. Why this split

- **No inheritance mechanism to specify or debug.** Fields live at exactly one
  level, so there is no "overridable unless restated" rule to maintain.
- **The proposal reads as a pitch, not a schema dump.** `description`,
  `media_kit_detail`, `best_for[]` and `seasonality_notes` are what a model needs to
  decide whether to look further.
- **Every line item states its own terms, in exactly one channel.** A
  buying agent can hand a line item, with the proposal's identity, to a downstream
  system, with no proposal-level defaults or cross-channel ambiguity to resolve.
- **Channels share one object, not a schema fork per channel.** `channel` is the
  discriminator. Fields such as `placement`, `programs`, `break_position`, and the
  DOOH property keys apply only where a channel needs them, and `format_specs`
  carries what is channel-specific about creative shape.
- **Composition resolves without a round trip.** Because the seller declares the
  option set and its pricing up front, a buyer agent performs constraint
  satisfaction rather than negotiation. Only genuinely out-of-envelope asks
  require the counterparty to respond.

**Templates and issued proposals (non-normative).**

- **Template:** seller-side only. It lives in the seller's own systems (its
  proposal store), is not part of the public object, and is never transacted
  directly.
- **Issued proposal:** what a buyer commits against (§ 4.3). Each has its own
  `proposal_id` per counterparty or destination, and may carry
  `proposal_template_id` (§ 4.1) to trace it back to its template and `issued_from`
  to trace it back to a shared proposal.
- Buyer-specific terms, such as annual rates and named visibility, live on the
  issued proposal's line items: `visibility: named`, `eligible_buyers[]` and
  their own `pricing[]`.

**Relationships, agreements and IOs (non-normative).** Buyer–seller
relationships are expressed as issued proposals (`visibility: named`,
`eligible_buyers[]` set to that buyer, with the negotiated `pricing[]`) plus
the buyer agent's business rules. "Preferred partner" weighting is a buyer-side
ranking rule, not part of this specification. `agreement` and `terms_refs[]`
(§ 5.10, § 5.8) point at the agreement and terms a line item is executed under;
IO generation happens through connectors.

---

## 8. Open questions

Comment is specifically invited on the following. Each has a tracking issue —
see [docs/open-questions.md](../docs/open-questions.md).

1. **Does per-field mutability belong in 3.0?** Sections 3 and 5 make
   composition part of the object. The alternative is a catalog format where a
   buyer selects whole line items and everything else is a round trip.
2. **Is a fetchable reference to a seller catalog needed?** The object is fully
   inline: a seller reuses catalog entries in its own systems, and a summary lists
   what § 2.1 names. A `Line.productid` would be one use: an agreed record doesn't say
   which OpenDirect `Product` it books.
3. **Cross-channel guarantee comparability is unsolved.** Once one line item
   guarantees `viewable_rate` and another `completion_rate`, there is no
   normalised way for a buying agent to compare or optimise across them. 3.0
   doesn't cover it.
4. **The format registry has no entries for `audio/*`, `ctv/*` or `dooh/*`.** A
   `format_specs` entry can copy a registry version or be defined by the seller
   (§ 5.4), so half the declared channels have only seller-defined specs today. A
   `spec_ref` names a registry by domain alone: this draft doesn't say which
   registry that is or how to fetch an entry.
5. **Do packages cover every bundle sellers sell?** A package (§ 4.1.4) covers bundle
   purchases without a `min_line_items` count. No filing names a bundle that a package
   and its add-ons can't express.
6. **Should `billing.payment_terms` and `billing.invoicing_party` be repeated on
   every line item,** given they are usually identical across a seller's shelf?
7. **`environments.available[]` needs validation against real inventory.** The
   list is proposed, not derived from implementation experience.
8. **How does a receiver read a document from a later release?** `spec_version`
   names the release a document follows, and § 2.5 makes a key the receiver's
   release does not list invalid. Nothing says whether a receiver rejects a release
   it does not know, or keeps and ignores keys it does not list.
9. **What basis is a money value on?** Every `Amount` on a line item is on one basis
   (§ 5.6). This draft doesn't say whether that basis is gross or net of agency
   commission, or whether it includes tax. A `commitment.amount` of 80,000.00 at an
   `agreed_rate` of 24.00 `CPM` buys 3,333,333 impressions if 24.00 is what the seller
   invoices. If 24.00 is gross of a 15% commission, the seller invoices 20.40, and
   80,000.00 stated net buys 3,921,568.
10. **What settles a shortfall once no remedy remains?** A buyer MAY refuse a sole or
    last `makegood`, and § 5.7.1 then points at `remedy_terms`, whose keys describe only
    a makegood. This draft also doesn't state what a `credit` is worth. Such a shortfall
    could settle under terms the seller states or fall back to a credit, or a sole
    makegood within the flight could bind the buyer. Nor does this draft say how much
    delivery a preemption takes (§ 5.6.7).
11. **Must a manifest response carry both `ETag` and `Last-Modified`, or is either
    enough?** § 2.3 requires at least one, so a buyer's client handles whichever the
    seller sends.
12. **How does a `change_requests[]` entry state a change other than a cancellation?**
    `cancellation` states a notice to cancel. The OpenDirect 2.1 ChangeRequest has no
    structured statement of any other change, only free-text `comments` (§ 4.4).

---

## Appendix A — Field index

Every field in the specification, in document order, with its type, presence,
and mutability marker. Generated from the body of this document; **if the two disagree, the
body is normative.**

| Field | Section | Type | Required | Marker |
| :--- | :--- | :--- | :--- | :--- |
| `proposal_id` | 4.1 Identity and lifecycle | String | REQUIRED | immutable |
| `version` | 4.1 Identity and lifecycle | Integer | REQUIRED | derived |
| `spec_version` | 4.1 Identity and lifecycle | String | REQUIRED | seller-set |
| `seller` | 4.1 Identity and lifecycle | Party | REQUIRED | immutable |
| `buyer` | 4.1 Identity and lifecycle | Party | REQUIRED when `type` is `custom` or `assent[]` is present | immutable |
| `type` | 4.1 Identity and lifecycle | Enum | REQUIRED | immutable |
| `proposal_template_id` | 4.1 Identity and lifecycle | String | OPTIONAL | immutable |
| `issued_from` | 4.1 Identity and lifecycle | VersionRef | OPTIONAL | immutable |
| `status` | 4.1 Identity and lifecycle | ProposalStatus | REQUIRED | derived |
| `assent[]` | 4.1 Identity and lifecycle | Array[AssentEntry] | OPTIONAL | recorded |
| `offer_window` | 4.1 Identity and lifecycle | Interval | OPTIONAL | seller-set |
| `brief_id` | 4.1 Identity and lifecycle | String | REQUIRED when `type` is `custom` | immutable |
| `negotiation_history[]` | 4.1 Identity and lifecycle | Array[HistoryEntry] | REQUIRED when the current `version` is frozen (§ 4.1.3) | recorded |
| `line_items[]` | 4.1 Identity and lifecycle | Array[LineItem] | REQUIRED when `packages[]` is absent | seller-set |
| `packages[]` | 4.1 Identity and lifecycle | Array[Package] | REQUIRED when `line_items[]` is absent | seller-set |
| `ext` | 4.1 Identity and lifecycle | Ext | OPTIONAL | seller-set |
| `description` | 4.2 Agent comprehension | String | REQUIRED | seller-set |
| `media_kit_detail` | 4.2 Agent comprehension | String | OPTIONAL | seller-set |
| `best_for[]` | 4.2 Agent comprehension | Array[String] | OPTIONAL | seller-set |
| `not_suitable_for[]` | 4.2 Agent comprehension | Array[String] | OPTIONAL | seller-set |
| `seasonality_notes` | 4.2 Agent comprehension | String | OPTIONAL | seller-set |
| `change_requests[]` | 4.4 Change requests | Array[ChangeRequest] | OPTIONAL | recorded |
| `line_item_id` | 5.1 Identity | String | REQUIRED | immutable |
| `status` | 5.1 Identity | LineItemStatus | REQUIRED | lifecycle |
| `channel` | 5.1 Identity | MediaChannel | REQUIRED | immutable |
| `ext` | 5.1 Identity | Ext | OPTIONAL | seller-set |
| `properties` | 5.2 Inventory composition | Selectable[PropertyOption] | OPTIONAL | selectable |
| `programs` | 5.2 Inventory composition | Selectable[ProgramOption] | OPTIONAL | selectable |
| `episodes` | 5.2 Inventory composition | Enum | REQUIRED when `placement.feed` is Podcast (3) or Catch-up radio (4) | seller-set |
| `environments` | 5.2 Inventory composition | Selectable[Environment] | OPTIONAL | selectable |
| `placement` | 5.2 Inventory composition | Placement | REQUIRED when `channel` is `video` or `audio` | seller-set |
| `break_position` | 5.2 Inventory composition | Selectable[BreakPositionOption] | OPTIONAL | selectable |
| `audiences` | 5.3 Audience reach | AudienceSelectable | OPTIONAL | selectable |
| `addressable_scale` | 5.3 Audience reach | AddressableScale | OPTIONAL | asserted |
| `activation_route` | 5.3 Audience reach | Selectable[VocabularyTerm] | OPTIONAL | selectable |
| `buyer_supplied` | 5.3 Audience reach | BuyerSupplied | OPTIONAL | mixed |
| `formats` | 5.4 Creative requirements | Selectable[FormatId] | OPTIONAL | selectable |
| `format_specs` | 5.4 Creative requirements | Map[FormatId, FormatSpec] | REQUIRED when the proposal has left `draft` and `formats` is present | seller-set |
| `creative_delivery` | 5.4 Creative requirements | CreativeDelivery | OPTIONAL | seller-set |
| `assets[]` | 5.4 Creative requirements | Array[Asset] | OPTIONAL | mixed |
| `materials_due` | 5.4 Creative requirements | MaterialsDue | OPTIONAL | requestable |
| `approval` | 5.4 Creative requirements | String | OPTIONAL | seller-set |
| `creative_policy` | 5.4 Creative requirements | String | OPTIONAL | seller-set |
| `production` | 5.4 Creative requirements | Selectable[ProductionOption] | OPTIONAL | selectable |
| `geo` | 5.5 Targeting envelope | Settable[GeoCode] | OPTIONAL | settable |
| `markets` | 5.5 Targeting envelope | Selectable[GeoCode] | OPTIONAL | selectable |
| `device` | 5.5 Targeting envelope | Settable[Integer] | OPTIONAL | settable |
| `daypart` | 5.5 Targeting envelope | Settable[ClockWindow] | OPTIONAL | settable |
| `time_zone` | 5.5 Targeting envelope | ZoneName | REQUIRED when `daypart` or `frequency_cap` is present | seller-set |
| `frequency_cap` | 5.5 Targeting envelope | FrequencyCap | OPTIONAL | settable |
| `accepted_exclusions` | 5.5 Targeting envelope | AcceptedExclusions | OPTIONAL | seller-set |
| `exclusions` | 5.5 Targeting envelope | Map[ExclusionType, ExclusionList] | OPTIONAL | supplied |
| `pricing[]` | 5.6 Commercial terms | Array[PricingEntry] | REQUIRED | mixed |
| `pricing[].pricing_id` | 5.6 Commercial terms | String | REQUIRED | immutable |
| `pricing[].cost_method` | 5.6 Commercial terms | VocabularyTerm | REQUIRED | seller-set |
| `pricing[].rate_per` | 5.6 Commercial terms | Integer | REQUIRED when `cost_method` is an extension term | seller-set |
| `pricing[].unit_label` | 5.6 Commercial terms | String | REQUIRED when `cost_method` is an extension term | seller-set |
| `pricing[].cost_definition` | 5.6 Commercial terms | DocumentRef | REQUIRED when `cost_method` is an extension term | seller-set |
| `pricing[].cost_parameters` | 5.6 Commercial terms | CostParameters | REQUIRED when the term requires keys | seller-set |
| `pricing[].transaction_mechanisms[]` | 5.6 Commercial terms | Array[TransactionMechanism] | OPTIONAL | seller-set |
| `pricing[].list_rate` | 5.6 Commercial terms | Amount | REQUIRED | requestable |
| `pricing[].agreed_rate` | 5.6 Commercial terms | Amount | REQUIRED when this is the committed entry | derived |
| `pricing[].price_valid_until` | 5.6 Commercial terms | Instant | OPTIONAL | seller-set |
| `pricing[].currency` | 5.6 Commercial terms | CurrencyCode | REQUIRED | seller-set |
| `pricing[].price_type` | 5.6 Commercial terms | Integer | REQUIRED when the entry prices a deal mechanism | seller-set |
| `pricing[].min_rate` | 5.6 Commercial terms | Amount | OPTIONAL | seller-set |
| `pricing[].unit_bounds` | 5.6 Commercial terms | Range[Integer] | OPTIONAL | requestable |
| `availability` | 5.6 Commercial terms | Availability | OPTIONAL | asserted |
| `delivery_counting` | 5.6 Commercial terms | DeliveryCounting | REQUIRED when `channel` is `dooh` | seller-set |
| `commitment_bounds` | 5.6 Commercial terms | CommitmentBounds | OPTIONAL | requestable |
| `commitment` | 5.6 Commercial terms | Commitment | OPTIONAL | mixed |
| `hold_terms` | 5.6 Commercial terms | HoldTerms | OPTIONAL | seller-set |
| `hold` | 5.6 Commercial terms | Hold | OPTIONAL | lifecycle |
| `renewal_right` | 5.6 Commercial terms | VocabularyTerm | OPTIONAL | seller-set |
| `cancellation_policy` | 5.6 Commercial terms | Selectable[CancellationOption] | OPTIONAL | selectable |
| `exclusivity` | 5.6 Commercial terms | Selectable[ExclusivityOption] | OPTIONAL | selectable |
| `preemption` | 5.6 Commercial terms | Preemption | OPTIONAL | seller-set |
| `committed_metrics[]` | 5.7 Guarantees | Array[CommittedMetric] | OPTIONAL | requestable |
| `measurement_source` | 5.7 Guarantees | Selectable[MeasurementOption] | OPTIONAL | selectable |
| `controlling_measurement` | 5.7 Guarantees | Selectable[ControllingMeasurementOption] | REQUIRED when `serving_mode` is `embedded` or the line item has `committed_metrics[]`, `commitment_bounds.spend`, or a `pricing[].unit_bounds` | selectable |
| `shortfall_remedy` | 5.7 Guarantees | ShortfallRemedy | OPTIONAL | selectable |
| `reporting` | 5.7 Guarantees | Selectable[ReportingOption] | OPTIONAL | selectable |
| `visibility` | 5.8 Transaction eligibility | Enum | REQUIRED | seller-set |
| `required_credentials[]` | 5.8 Transaction eligibility | Array[RequiredCredential] | OPTIONAL | seller-set |
| `eligible_buyers[]` | 5.8 Transaction eligibility | Array[RegistrableDomain] | OPTIONAL | seller-set |
| `eligible_seats[]` | 5.8 Transaction eligibility | Array[SeatRef] | OPTIONAL | seller-set |
| `terms_refs[]` | 5.8 Transaction eligibility | Array[DocumentRef] | OPTIONAL | seller-set |
| `transaction_mechanism` | 5.9 Execution | Selectable[MechanismOption] | REQUIRED | selectable |
| `sov_basis` | 5.9 Execution | Enum | REQUIRED when an option's `delivery_type` is `share_of_voice` | seller-set |
| `sov_share` | 5.9 Execution | Fraction | REQUIRED when `sov_basis` is `impressions` | seller-set |
| `serving_mode` | 5.9 Execution | VocabularyTerm | OPTIONAL | seller-set |
| `retention` | 5.9 Execution | Range[Duration] | REQUIRED when `serving_mode` is `embedded` | seller-set |
| `deal_origin` | 5.9 Execution | RegistrableDomain | REQUIRED when the line item offers a deal mechanism | seller-set |
| `buyer_requirements` | 5.9 Execution | BuyerRequirements | OPTIONAL | mixed |
| `serving_platform` | 5.9 Execution | Domain | OPTIONAL | seller-set |
| `external_references[]` | 5.10 External references, agreement, and billing | Array[ExternalReference] | OPTIONAL | recorded |
| `agreement` | 5.10 External references, agreement, and billing | Agreement | OPTIONAL | seller-set |
| `billing` | 5.10 External references, agreement, and billing | Billing | OPTIONAL | seller-set |

---

## Appendix B — Fields by marker

| Marker | Count | Meaning | Fields |
| :--- | :--- | :--- | :--- |
| immutable | 10 | Set once at creation. Neither party may change it. | `proposal_id`, `seller`, `buyer`, `type`, `proposal_template_id`, `issued_from`, `brief_id`, `line_item_id`, `channel`, `pricing[].pricing_id` |
| seller-set | 46 | The seller sets it and MAY revise it while the `status` of the object that carries it is `draft`, `published` or `under_review`. § 4.3.2 states what a revision does to a line item `under_review`. The buyer cannot change it directly. | `spec_version`, `offer_window`, `line_items[]`, `packages[]`, `ext` (proposal), `description`, `media_kit_detail`, `best_for[]`, `not_suitable_for[]`, `seasonality_notes`, `ext` (line item), `episodes`, `placement`, `format_specs`, `creative_delivery`, `approval`, `creative_policy`, `time_zone`, `accepted_exclusions`, `pricing[].cost_method`, `pricing[].rate_per`, `pricing[].unit_label`, `pricing[].cost_definition`, `pricing[].cost_parameters`, `pricing[].transaction_mechanisms[]`, `pricing[].price_valid_until`, `pricing[].currency`, `pricing[].price_type`, `pricing[].min_rate`, `delivery_counting`, `hold_terms`, `renewal_right`, `preemption`, `visibility`, `required_credentials[]`, `eligible_buyers[]`, `eligible_seats[]`, `terms_refs[]`, `sov_basis`, `sov_share`, `serving_mode`, `retention`, `deal_origin`, `serving_platform`, `agreement`, `billing` |
| selectable | 16 | The buyer chooses from a seller-declared set. Each option MAY carry a price delta. Resolves without a round trip. | `properties`, `programs`, `environments`, `break_position`, `audiences`, `activation_route`, `formats`, `production`, `markets`, `cancellation_policy`, `exclusivity`, `measurement_source`, `controlling_measurement`, `shortfall_remedy`, `reporting`, `transaction_mechanism` |
| settable | 4 | The buyer supplies a value within seller-declared bounds. Resolves without a round trip. | `geo`, `device`, `daypart`, `frequency_cap` |
| supplied | 1 | The buyer provides data or an artifact. The seller does not pre-populate it. | `exclusions` |
| requestable | 5 | The buyer MAY ask for a value outside the declared space. An ask changes the value only through a seller `grant` or `counter` (§ 4.3.1). A change on the seller's own initiative follows § 4.1.3. | `materials_due`, `pricing[].list_rate`, `pricing[].unit_bounds`, `commitment_bounds`, `committed_metrics[]` |
| derived | 3 | Computed by a rule this specification states. Neither party sets it directly. | `version`, `status` (proposal), `pricing[].agreed_rate` |
| lifecycle | 2 | Live state of the object. The party its section names moves it between the stated values. Not a term. | `status` (line item), `hold` |
| recorded | 4 | Written by the party that acted. Append-only: an entry is never edited or removed. Not a term. | `assent[]`, `negotiation_history[]`, `change_requests[]`, `external_references[]` |
| asserted | 2 | The seller states it from data the buyer can't recompute. Not a term, and it changes without a new version. | `addressable_scale`, `availability` |
| mixed | 5 | The keys of the object carry different markers: in the Mutability column of its key table, in its lead-in for composed keys, or on its rows for `pricing[]`. | `buyer_supplied`, `assets[]`, `pricing[]`, `commitment`, `buyer_requirements` |

### What the distribution says

Of 98 fields, **26 are touched by the buyer** — 16 `selectable`, 4 `settable`, 1
`supplied` and 5 `requestable`. The remaining 72 are `seller-set`, `immutable`,
`derived`, `lifecycle`, `recorded`, `asserted` or `mixed`. The buyer also writes some of
those: its own entries in `assent[]` and `change_requests[]`, its `hold`, and its keys of
`commitment`, `assets[]`, `buyer_supplied`, and `buyer_requirements`.

Only the 5 `requestable` fields require a round trip to resolve (§ 5.6.1).
Everything else the buyer touches — 21 fields — resolves against bounds the seller
declared up front. That ratio is the design claim: composition is constraint
satisfaction, and negotiation is the exception.
