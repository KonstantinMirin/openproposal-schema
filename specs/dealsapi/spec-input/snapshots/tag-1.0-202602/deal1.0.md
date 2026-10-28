# Deal Sync API Specification

## Table of Contents

- [Introduction](#introduction)
  - [Goals](#goals)
  - [What it is](#what-it-is)
  - [What it isn't](#what-it-isnt)
  - [Considerations](#considerations)
- [Deal API Specification](#deal-api-specification)
  - [Object: Deal](#object-deal)
  - [Object: Terms](#object-terms)
  - [Object: Inventory](#object-inventory)
  - [Object: Curation](#object-curation)
- [Receiving System Endpoint](#receiver-endpoint)
  - [Object: BuyerSeat](#object-buyerseat)
  - [Object: BuyerStatus](#object-buyerstatus)
- [Implementation Guidance](#implementation-guidance)
  - [Matching Bid Requests to Deals](#matching-bid-requests-to-deals)
  - [Authorization](#authorization)
  - [Sending and Receiving Information](#sending-and-receiving-information)
  - [Deal Object Guidance](#deal-object-guidance)
    - [Auxiliary Data](#auxiliary-data)
    - [Publisher Count](#publisher-count)
    - [Dynamic Inventory](#dynamic-inventory)
  - [Terms Object](#terms-object-1)
  - [Inventory Object](#inventory-object-1)
  - [Included Inventory](#included-inventory)
  - [Price and Floor Guidance](#price-and-floor-guidance)
  - [Origin, Curator, and Seller](#origin-curator-and-seller)
    - [Example 1](#example-1)
    - [Example 2](#example-2)
  - [Curation Object](#curation-object-1)
    - [Curation Fee](#curation-fee)
  - [Example Scenarios](#example-scenarios)

---

<a name="introduction"></a>
# Introduction

This API has multiple implications including lowering manual entry by making the high-level terms of the deal clear so automated setups can be more easily executed. It also adds transparency into Curated deals that is not currently available in the bid stream.

<a name="goals"></a>
## Goals

- Decrease manual entry of deal information across systems by providing a way for the terms of a deal to be input and sent to the system that will deliver the deal to review and accept.
- Describe what the selling system deal includes at a high level
- Know which parties were involved in curating and selling the package

<a name="what-it-is"></a>
## What it is

- API that provides subscribers with static information about a given Deal that outlines the tenents of the Deal.
- This MVP is a one-party design for the origin system to PUSH information about the deal into the receiving system(s) from the system where it was created (e.g. SSP → DSP). It also allows the same system to query the receiving system for the Deal status after initial deal send. Future versions will likely add support for bi-directional communications.
- Version 1.0 of this API does not support differential overrides, but 1.1 will. For the 1.0 version, periodic polling by the deal receiver can be used as a fallback. To ensure data integrity, deal receivers are encouraged to implement periodic polling as a fallback mechanism to handle any missed notifications.

<a name="what-it-isnt"></a>
## What it isn't

- This is a separate API that is **NOT** included in OpenRTB Request/Response
- Does not include real-time information contained in the bid request or determine whether or not a deal applies. Implementers are strongly encouraged to validate the conditions laid out in this deal with OpenRTB requests to ensure their expectations are being met.
- The MVP of this API does NOT support proposals, revisions, or negotiations. It is assumed those are known to implementers *a priori.* Future versions will likely contemplate this functionality.
- The MVP is not meant to support discoverability in deal marketplaces. Future versions may include that functionality.

<a name="considerations"></a>
## Considerations

- The values of these fields are meant to be an outline of business terms agreed to between buyers and sellers *a priori*. The information contained in this API should be used as a guide of what the terms that were agreed to, but they should never be used to bid without validating that information coming from the OpenRTB Bid Request is in line with the terms laid out in this API.
- Deal criteria provided via this channel are not guaranteed to be accurately reflected in bid requests containing the associated deal ID. It is the responsibility of the buyer to validate bid requests that contain the deal ID conform to the deal criteria. In other words, buyers should ALWAYS apply targeting matching the terms outlined in any deal on their side. For example, if a deal is struck for US only inventory, buyers should include that targeting in their DSP when trafficking the campaign.
- If bid requests continually do not match the expectations laid out in the API, a conversation should be had between the buyer and seller to continue negotiations offline.
- It is not possible to validate that the party selling the inventory has been authorized without including app bundle or site id that matches the publishers (app)ads.txt file. Deal IDs receiving requests without that information should be used rarely and closely monitored.

---

<a name="deal-api-specification"></a>
# Deal API Specification
An HTTP POST endpoint implemented by the receiving system to accept data pushed from the origin system. Configuration of push calls is out of scope for this specification and is the responsibility of the Origin system.

<a name="object-deal"></a>
## Object: Deal

| Attribute | Type | Description |
|-----------|------|-------------|
| `id` | string; **required** | A unique identifier for the direct deal in origin's namespace. |
| `name` | string, recommended | Name of the deal as created in the origin system. Note: This name may be displayed to the buyer. The person inputting the deal into the `origin` system should consider that when setting up the deal. |
| `created` | string | UTC timestamp in seconds in ISO-8601 of when the deal was created in the Origin system |
| `sellerstatus` | int, default 0, recommended | Status of the deal in the sellers system where:<br> `0` = deal is active<br> `1` = deal is paused<br> `2` = deal is pending<br>  `4` = deal is complete (ie. selling scomplete (ie. selling system shows deal has completed)<br>  `4` = deal is archived (cannot be active again) |
| `origin` | string, **required** | The advertising system domain of the business entity that will receive bid responses for the deal, typically the SSP hosting the API. |
| `seller` | string, recommended | Canonical domain of the business entity who sold the deal. This may be the same as the origin or curator, but it also could be any intermediate seller. <br><br> [See Implementation Guidance for additional detail](#origin-curator-and-seller) |
| `desc` | string | Short description for the deal to help the receiver locate the deal once it has been sent. It is strongly recommended to keep this field to 250 characters or less. |
| `wseat` | string array, recommended | Allowed list of buyer seats (e.g., advertisers, agencies) allowed to bid on this impression. <br><br>IDs of seats and knowledge of the buyer's customers to which they refer must be coordinated between bidders and the exchange <i>a priori</i>. <br><br>At most, only one of `wseat` and `bseat` should be used in the same request. Omission of both implies no seat restrictions. |
| `bseat` | string array | Block list of buyer seats (e.g., advertisers, agencies) restricted from bidding on this impression. IDs of seats and knowledge of the buyer's customers to which they refer must be coordinated between bidders and the exchange <i>a priori</i>. <br><br>At most, only one of `wseat` and `bseat` should be used in the same request. Omission of both implies no seat restrictions.|
| `adtypes` | int array | The format of the ad creative(s) supported by the inventory in the deal:<br> `1` = Banner<br> `2` = Video<br> `3` = Audio<br> `4` = Native<br><br>If this is empty or missing, the deal is assumed to apply to all types of ad creative. |
| `auxdata` | int | Indicates if there is non-publisher data (i.e. a non-publisher data layer) applied in this package with an associated fee where:<br> `0` = undisclosed<br> `1` = yes, at start of deal and will not be modified<br> `2` = yes and subject to change after start of deal<br> `3` = no and will not be modified<br> `4` = no and subject to change after start of deal<br><br>[See implementation guidance for additional detail](#auxiliary-data) |
| `pubcount` | int | Indicates if there is more than one publishing company:<br> `0` = undisclosed<br> `1` = single publisher<br> `2` = multi-publisher<br>[See implementation guidance for additional detail](#publisher-count) |
| `dinventory` | int | Indicates if the inventory for the deal is dynamic, meaning sites or applications included in the deal may update after the deal is live where:<br> `0` = undisclosed<br> `1` = inventory will NOT update once the deal goes live<br> `2` = inventory where this deal may run is updated dynamically. <br><br>[See implementation guidance for additional detail](#dynamic-inventory) |
| `terms` | object, **required** | Terms of the deal. See [Object: Terms](#object-terms) for additional detail |
| `inventory` | object | Information about the inventory included in the deal. This object should only be included when the deal is for a static set of sites or applications (`dinventory=1`). <br><br>See [Object: Inventory](#object-inventory) for additional detail |
| `curation` | object | Information about the curation package if applicable. <br><br>See [Object: Curation](#object-curation) for additional detail. |
| `ext` | object | Placeholder for deal-specific extensions |

<a name="object-terms"></a>
## Object: Terms

| Attribute | Type | Description |
|-----------|------|-------------|
| `startdate` | string | UTC timestamp in seconds in ISO-8601 of when the deal starts |
| `enddate` | string | UTC timestamp in seconds in ISO-8601 of when the deal ends. Evergreen or always on deals should leave this field blank. |
| `countries` | string array | An array of country codes in which the deal is available, where country code is a string using ISO-3166-3. If this is empty or missing, the deal is assumed to apply to all countries. |
| `dealfloor` | float | Minimum bid for impressions for this deal expressed in CPM. Unless `pricetype` is Fixed, this should be used as guidance to buyers. <br><br> [See Implementation Guidance for additional detail](#price-and-floor-guidance) |
| `cur` | string; default "USD" | Bid currency using ISO-4217 alpha codes. |
| `guar` | int | Indicates that the deal is of type guaranteed and the bidder must bid on the deal, where 0 = not a guaranteed deal, 1 = guaranteed deal. |
| `pricetype` | int, default 2 | Deal Price Type where:<br> `0` = Dynamic (ie. auction type will be provided by `request.at` attribute in OpenRTB Bid Request)<br> `1` = First Price<br> `2` = Second Price Plus<br> `3` = Fixed Price<br>Exchange-specific auction types can be defined using values 500 and greater. |
| `units` | int | Number of units (impressions) over the specified start and end date of the deal. If the deal is guaranteed, this number should be provided. If the deal is not guaranteed this may be omitted. |
| `totalcost` | float | The total cost over the specified start and end date of the deal. If the deal is guaranteed, this value should be provided. If the deal is not guaranteed this may be omitted. <br><br> [See Implementation Guidance for additional detail](#price-and-floor-guidance) |
| `ext` | object | Placeholder for deal-specific extensions |

<a name="object-inventory"></a>
## Object: Inventory

Attributes in Inventory objects are meant to be an overview of the kinds of ads and inventory where the deal might appear.

| Attribute | Type | Description |
|-----------|------|-------------|
| `inclinventory` | integer array | High-level information about the kind of inventory included in the deal:<br> `1` = site<br> `2` = app<br> `3` = dooh<br> `4` = audio<br> `5` = endemic<br> `6` = other<br> <br><br>If this is empty or missing, the deal is assumed to apply to all types of inventory |
| `devicetype` | integer array | The general type of device. Refer to List: [Device Type](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/main/AdCOM%20v1.0%20FINAL.md#list--device-types-) in AdCOM 1.0 |
| `sellerids` | string array | The identifier associated with the seller or reseller account within the advertising system. If used, the values in this attribute must contain the same value used in transactions (i.e. OpenRTB bid requests) in the field specified by the SSP/exchange. <br><br>An empty list implies the deal may runs across all sellers. <br><br>Typically, in OpenRTB, this is `publisher.id`. <br><br>For OpenDirect it is typically the publisher's organization ID. Should be limited to 64 characters in length. |
| `sitedomains` | string array | An array containing one or more site domain(s). <br><br>An empty list implies the deal may run across many unspecified site domain(s).|
| `appbundles` | string array | An array containing one or more bundle/package name(s) of the app. <br><br>An empty list implies the deal may run across many unspecified bundles/package(s) |
| `cat` | string array | Array of IAB Tech Lab content categories included in the deal. The taxonomy to be used is defined by the cattax field. |
| `cattax` | integer | The taxonomy in use for the cat attribute. Refer to [List: Category Taxonomies](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/main/AdCOM%20v1.0%20FINAL.md#list_categorytaxonomies). |
| `ext` | object | Placeholder for deal-specific extensions |


<a name="object-curation"></a>
## Object: Curation

Information about the selection and organization of inventory using technology and data, with the goal of creating effective packages for advertisers through prepackaged or real-time operations.

| Attribute | Type | Description |
|-----------|------|-------------|
| `curator` | string | Canonical domain of the business entity that did the packaging of inventory, technology and/or data. Most often, this will be the seller of the deal. |
| `cdealid` | string | Unique identifier for the deal in the Curators namespace. |
| `curfeetype` | int | Fee type being applied for curation of the deal:<br> `0` = undisclosed<br> `1` = percentage of spend<br> `2` = flat fee<br> `3` = CPM<br> `4` = no fee is paid for curation services<br><br>[See Implementation Guidance for additional detail](#curation-fee) |
| `ext` | object | Placeholder for deal-specific extensions |

---

<a name="receiver-endpoint"></a>
# Receiving System Endpoint
An HTTP POST endpoint implemented by the receiving system that allows the Origin system to request current information for a specific deal.

<a name="object-buyerseat"></a>
## Object: BuyerSeat

Information about the status of the deal in the buying system at a seat level.

| Attribute | Type | Description |
|-----------|------|-------------|
| `version` | string, **required** | Version of the Deal API in use |
| `id` | string, **required** | A unique identifier for the deal as passed in the initial push that this response is referring to. This should always be the same id as `deal.id` |
| `buyerstatus` | object array | Information about the buying seat where the Deal will be trafficked |
| `ext` | object | Placeholder for deal-specific extensions |

<a name="object-buyerstatus"></a>
## Object: BuyerStatus

Information about the status of the deal at a seat level in the buying system. 

| Attribute | Type | Description |
|-----------|------|-------------|
| `buyerseatid` | string | Seat ID in the buying system that the response refers to |
| `status` | int | Status of the deal in the buying system:<br> `0` = pending approval<br> `1` = buyer has approved (ie. non PG deal is ready for bid requests)<br> `2` = buyer has rejected<br> `3` = ready to serve (ie. deal is in a campaign - ready to receive bid requests, relevant especially for PG deals)<br> `4` = active (i.e. deal is actively serving impressions)<br> `5` = paused<br> `6` = complete (ie. buying system shows deal has completed)|
| `ext` | object | Placeholder for deal-specific extensions |

---

<a name="implementation-guidance"></a>
# Implementation Guidance

<a name="matching-bid-requests-to-deals"></a>
## Matching Bid Requests to Deals

Some level of trust is required when buying any Deal ID. It is incumbent on the buyer of the deal to compare information from the Deal API with information contained in OpenRTB Bid Requests to ensure that it meets their expectations.

Version 1.0 of this API does not support deal revisions. However, some attributes may be subject to change over the flight of the deal. Conversations between implementers should be had around what attributes, if any, may be subject to change after the deal has gone live.

The `deal.id` from both the sender and receiver should match the `deal.id` in the OpenRTB request when bidding. Implementers should use the Deal ID from the Origin system that did the PUSH.

Implementers are strongly encouraged to discuss where targeting criteria will be set. In instances where additional targeting will be applied in the receiving system, implementers should discuss potential implicaitons to delivery if sources of targeting may differ.

<a name="authorization"></a>
## Authorization

Supply Chain validation should always be done using Object: Supply Chain from OpenRTB. If this information is unavailable, implementers should proceed with extreme caution with the understanding that there is no mechanism to know if a given path is authorized to sell the inventory.

<a name="sending-and-receiving-information"></a>
## Sending and Receiving Information

To send information about a new deal, the origin system will send a PUSH request to the receiving system partner's API endpoint.

Once a deal has been sent by the origin system to the receiving system, it may query the endpoint setup by the receiving system for information about the status of the Deal.  

Implementers may choose to accept incoming webhooks to their API endpoints for events. Please discuss this feature and support with your chosen integration partners.

<a name="deal-object-guidance"></a>
## Deal Object Guidance

<a name="auxiliary-data"></a>
### Auxiliary Data

`auxdata` should be used whenever any non-publisher data is expected to be part of a given deal. This will most often be traditional data providers, but can include optimization services that do NOT belong to the publisher. While the non-publisher data entities are not named, if any company is being paid for their data and/or optimization, this value should indicate the presence of non-publisher data.

This attribute also communicates information about whether or not additional data layers may be applied after the deal has gone live. For example, a deal starts with some additional data and expects the list of data and/or optimization services to be added or updated as the deal is in flight should use a value of 2.

<a name="publisher-count"></a>
### Publisher Count

`pubcount` is meant to communicate if the deal is for a single publishing company, or if it spans multiple publishing companies. Deals covering a single company with multiple web and app properties are considered to be a single publisher. Inventory aggregation services representing multiple publishing sites may also be considered a single publisher deal.

Note that the `pubcount` attribute does **not** contemplate non-publisher parties, including ad tech stacks involved in the transaction. Intermediaries should be identified using Supply Chain Validation from OpenRTB requests.

<a name="dynamic-inventory"></a>
### Dynamic Inventory

`dinventory` communicates information about whether or not the sites and apps included in the initial offering are expected to be updated after the deal goes live. In other words, this attribute communicates the expectation that inventory will (or will not) change by adding or removing sites and/or apps after the deal has gone live. Implementers are strongly encouraged to communicate and discuss the specifics of any and all inventory updates to ensure expectations are met.

<a name="terms-object-1"></a>
## Terms Object

Price attribute must be provided if the deal is a fixed price deal, especially if it's a programmatic guaranteed deal, but otherwise can be used as pricing guidance or not provided at all if there is no pricing guidance (for example, for a Run-of-Exchange deal where there is no pricing guidance)

Where multiple DSP seats are included, per seat acceptance/rejection is on the DSP to surface in their internal systems and User Interfaces.

Examples of Deal name and description so there's a reference point for a standard way of what the fields should contain

<a name="inventory-object-1"></a>
## Inventory Object

This object should only be included when the deal is for a static set of sites or applications (`dinventory=1`).

<a name="included-inventory"></a>
## Included Inventory

This attribute conveys the type of inventory where the deal will run, not the specifics of the inventory itself. Therefore, there is no specific object in OpenRTB that directly relates to this attribute.

For example, `inclinventory.adtype=1,2` means the deal is inclusive of both banner and video ads. Implementers should expect to see ORTB bid requests using either `imp.banner` or `imp.video` once the deal is in flight.

<a name="price-and-floor-guidance"></a>
## Price and Floor Guidance

Historically deals have been negotiated at agreed upon rates to guarantee delivery at a certain price. In the new world many SSPs and curators aggregate media around data points that are not directly related to the inventory itself. Impressions for deals thus curated could have varying price points on a request by request basis. In lieu of a floor provided in these cases, suppliers offer bid guidance that will provide an effective win rate across inventory but do not describe the individual floors of the bid requests included in the deal.

<a name="origin-curator-and-seller"></a>
## Origin, Curator, and Seller

The `origin` attribute refers to the system with the UI where the deal is first input. This will typically be an SSP.

The `curator` attribute names the business entity that did the packaging of inventory, technology and/or data. Most often, although not always, this will be the party that sold the deal to the buyer.

The `seller` attribute represents the business entity who has sourced the demand (aka contracted with the buyer of the deal). When this is NOT either of the entities named in the `origin` or `curator` attributes, this field can be especially valuable.

<a name="example-1"></a>
### Example 1

- SALESHOUSE has the sales team and sources the demand
- The curated deal incorporates data provided by DATA PROVIDER A, DATA PROVIDER B, and potentially DATA PROVIDER C and/or DATA PROVIDER D
- The deal is entered into the SSP
- CURATOR does all the ops to help SALESHOUSE launch the deal

In this case the `seller`=saleshousedomain.com, the `curator`=curatordomain.com, and the `origin`=sspdomain.com

<a name="example-2"></a>
### Example 2

- PUBLISHER has an agreement with DATA PROVIDER A to decorate bid requests and packages the publisher's inventory
- PUBLISHER sources demand for the deal
- PUBLISHER inputs the deal into SSP User interface

In this case the `seller`=publishercompany.com, the `curator`=datacompany.com, and the `origin`=sspdomain.com

<a name="curation-object-1"></a>
## Curation Object

<a name="curation-fee"></a>
### Curation Fee

`curationfee` provides information about the type of fee being applied in the bidstream, but not what that fee is. For example, if a curator is charging a CPM of $5, the `curationfee` will equal 3 because it is a CPM. If a curator is charging a flat fee of $100, the value sent in the `curationfee` attribute will be 2, because it is a flat fee. If the curator is packaging their data alongside the inventory and not taking a specific fee for the Curation service itself, the value will be 4 for no fee.

<a name="example-scenarios"></a>
## Example Scenarios

| Scenario | curationfee | auxdata | pubcount | dinventory |
|----------|:-----------:|:-------:|:--------:|:----------:|
| Publisher packages their O&O inventory and data, and sells a deal to a buyer. No other party is or will be involved in the deal and the inventory will remain static throughout the term of the deal. | 4 | 3 | 1 | 1 |
| Data company packages their data across multiple publishers, but does not charge a fee for the specific curation service. Data providers will not be changed, but inventory may be updated after the start of the deal. | 4 | 1 | 2 | 2 |
| Curation company charges a CPM fee to aggregate inventory across multiple publishers that they will add and remove as the deal is in flight to optimize deal performance. They have an optimization service, and work with additional data providers to increase addressability, and expect to add additional data partners throughout the flight. | 3 | 2 | 2 | 2 |
| Curation company works with inventory aggregation company that regularly adds new websites and charges a % of spend to optimize deals. They do not currently work with other data providers, but may layer them in based on deal performance. | 1 | 4 | 1 | 2 |
| SSP pays a Curator a CPM to decorate inventory across the SSP universe that they do not pass on to the publishers. All inventory and data is subject to change. | 3 | 2 | 2 | 2 |

---
