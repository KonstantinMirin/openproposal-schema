# Synthetic specification

A fixture for the mapping and decision-record formats. It is not the OpenProposal specification.

## 5. Line items

### 5.6 Pricing

| Field | Type | Mutability | Description |
| :--- | :--- | :--- | :--- |
| `pricing[]` | Array[Object] | seller-set | The prices the seller offers. |
| `pricing[].cost_method` | Enum | seller-set | `cpm` \| `flat` |
| `pricing[].gross_rate` | Number | seller-set | The rate before discounts. |
| `hold_available` | Boolean | seller-set | Whether the buyer may place a hold. |

Each `pricing[].gross_rate` MUST NOT be negative.
