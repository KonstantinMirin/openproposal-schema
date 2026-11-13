/**
 * The checks of the stack's presence rules (the `with-our-stack` lock): each
 * row whose Required cell reads "REQUIRED when <condition>" and whose
 * condition the schema can't state is a rule, and its check reads the
 * condition on the value, or on the context its vectors give, and requires
 * the row's key where it holds (D-060). A condition a value can't settle,
 * such as the proposal's `status` for a line item alone, is undecided.
 */
import { isMap, list, type Check } from "../../rule-checks.ts";

type Cond = (v: Record<string, unknown>, ctx: Record<string, unknown>) => boolean | null;

/** A rule that requires `key` where `cond` holds. */
const requires = (key: string, cond: Cond): Check => (v, ctx) => {
  if (!isMap(v)) return [];
  const c = cond(v, ctx.context);
  if (c === null) return null;
  return c && !(key in v) ? [{ path: "", message: `\`${key}\` is REQUIRED here` }] : [];
};

const has = (v: Record<string, unknown>, k: string) => k in v;
const nonEmpty = (x: unknown) => Array.isArray(x) && x.length > 0;
/** A context value a vector gives, as `LineItem.channel`; undefined where it gives none. */
const ctxOf = (ctx: Record<string, unknown>, k: string) => ctx[k];
const known = <T>(x: T | undefined, f: (x: T) => boolean): boolean | null => (x === undefined ? null : f(x));

/** The § 5.9 mechanisms that are deal mechanisms. */
const DEAL = new Set(["programmatic_guaranteed", "preferred_deal", "private_auction"]);
/** The § 5.6.5 cost methods whose row names `cost_parameters` keys. */
const KEYED = new Set(["CPMV", "CPV", "CPP", "CPA", "TIME"]);
const offersDeal = (mechanism: unknown) => (isMap(mechanism) ? list(mechanism.available) : []).some((o) => isMap(o) && DEAL.has(String(o.id)));

export const STACK_CHECKS: Record<string, Check> = {
  // § 4.1
  "rule:4.1:1ef7cbec": requires("buyer", (v) => v.type === "custom" || nonEmpty(v.assent)),
  "rule:4.1:22f5a51a": requires("line_items", (v) => !has(v, "packages")),
  "rule:4.1:94b23ce1": requires("packages", (v) => !has(v, "line_items")),
  "rule:4.1:9c98396c": requires("negotiation_history", (v) => (v.status !== undefined && v.status !== "draft") || nonEmpty(v.assent)),
  "rule:4.1:71a584ca": requires("line_item_id", (v) => has(v, "requested_value")),
  "rule:4.1:d31e02ee": requires("requested_value", (_v, c) => known(ctxOf(c, "HistoryEntry.action"), (a) => a === "requested")),
  // § 4.4
  // A change request names its line item by its baseline: the proposal that holds the request holds the line item.
  "rule:4.4:9754e43c": requires("orderid", (v, c) => {
    const proposal = ctxOf(c, "Proposal");
    const id = isMap(v.baseline) ? v.baseline.line_item_id : undefined;
    const items = isMap(proposal) ? [...list(proposal.line_items), ...list(proposal.packages).flatMap((p) => (isMap(p) ? list(p.line_items) : []))] : [];
    const li = items.find((x) => isMap(x) && x.line_item_id === id);
    const refs = isMap(li) ? li.external_references : ctxOf(c, "LineItem.external_references");
    return known(isMap(li) && refs === undefined ? [] : refs, (r) => list(r).some((x) => isMap(x) && x.reference_type === "order"));
  }),
  // § 5.2 to § 5.2.4
  "rule:5.2:2f4f1aa3": requires("episodes", (v) => isMap(v.placement) && [3, 4].includes(v.placement.feed as number)),
  "rule:5.2:f8f39d84": requires("placement", (v) => v.channel === "video" || v.channel === "audio"),
  "rule:5.2.2:40e6089f": requires("plcmt", (_v, c) => known(ctxOf(c, "LineItem.channel"), (x) => x === "video")),
  "rule:5.2.2:87d20470": requires("feed", (_v, c) => known(ctxOf(c, "LineItem.channel"), (x) => x === "audio")),
  "rule:5.2.4:02c220b8": requires("venue_type", (_v, c) => known(ctxOf(c, "LineItem.channel"), (x) => x === "dooh")),
  "rule:5.2.4:ea387bb0": requires("screens", (v, c) => (v.allocation !== "all" ? false : known(ctxOf(c, "LineItem.channel"), (x) => x === "dooh"))),
  "rule:5.2.4:45d0b1fa": requires("seller_accounts", (v, c) => (v.seller_relationship === "reseller" ? true : known(ctxOf(c, "LineItem.transaction_mechanism"), offersDeal))),
  "rule:5.2.4:65ca47c9": requires("apps", (v) => !has(v, "domains")),
  "rule:5.2.4:c8e6720e": requires("domains", (v) => !has(v, "apps")),
  // § 5.3
  "rule:5.3:153027ca": requires("combine", (v) => list(v.available).length > 1 && (v.max_select === undefined || (v.max_select as number) > 1)),
  // § 5.4
  "rule:5.4:3a677601": requires("format_specs", (v, c) => (!has(v, "formats") ? false : known(ctxOf(c, "Proposal.status"), (s) => s !== "draft"))),
  "rule:5.4:45b02f49": requires("markup", (v) => !has(v, "url")),
  "rule:5.4:e2c0968b": requires("url", (v) => !has(v, "markup")),
  "rule:5.4:58ab1d09": requires("at", (v) => !has(v, "before_start")),
  "rule:5.4:7a6f2ac4": requires("before_start", (v) => !has(v, "at")),
  // § 5.5
  "rule:5.5:4a35bd89": requires("time_zone", (v) => has(v, "daypart") || has(v, "frequency_cap")),
  // § 5.6
  "rule:5.6:0f8d396f": requires("cost_parameters", (v) => KEYED.has(String(v.cost_method))),
  // The committed entry is the one the line item's `commitment` names, or its only entry; a line item with no `commitment` has none.
  "rule:5.6:62e21e38": requires("agreed_rate", (v, c) => {
    const li = ctxOf(c, "LineItem");
    if (!isMap(li)) return known(ctxOf(c, "Commitment.pricing_id"), (id) => id === v.pricing_id);
    if (!isMap(li.commitment)) return false;
    const entries = list(li.pricing);
    const id = li.commitment.pricing_id ?? (entries.length === 1 && isMap(entries[0]) ? entries[0].pricing_id : undefined);
    return id === undefined ? null : id === v.pricing_id;
  }),
  "rule:5.6:7235466d": requires("rate_per", (v) => typeof v.cost_method === "string" && v.cost_method.includes(":")),
  "rule:5.6:7235466d-2": requires("unit_label", (v) => typeof v.cost_method === "string" && v.cost_method.includes(":")),
  "rule:5.6:7235466d-3": requires("cost_definition", (v) => typeof v.cost_method === "string" && v.cost_method.includes(":")),
  "rule:5.6:8288302a": requires("price_type", (v) => list(v.transaction_mechanisms).some((m) => DEAL.has(String(m)))),
  "rule:5.6.1:7b200076": requires("pricing_id", (_v, c) => known(ctxOf(c, "LineItem.pricing"), (p) => list(p).length > 1)),
  "rule:5.6.1:94be9998": requires("availability", (v) => list(v.entries).some((e) => isMap(e) && e.role === "decline" && e.ground === "availability")),
  "rule:5.6.4:615bf228": requires("partial_play_credit", (_v, c) => known(ctxOf(c, "LineItem.properties"), (p) => (isMap(p) ? list(p.available) : []).some((o) => isMap(o) && nonEmpty(o.sync_groups)))),
  "rule:5.6.4:b6f5be4c": requires("vendor", (v) => v.source_type !== undefined && v.source_type !== 2),
  // § 5.6.5: the keys a cost method's row names, by the entry's `cost_method`.
  "rule:5.6.5:119b216f": requires("rate_unit", (_v, c) => known(ctxOf(c, "PricingEntry.cost_method"), (m) => m === "TIME")),
  "rule:5.6.5:1f435d20": requires("viewability_standard", (_v, c) => known(ctxOf(c, "PricingEntry.cost_method"), (m) => m === "CPMV")),
  "rule:5.6.5:26b080e2": requires("view_fraction", (v, c) => (has(v, "view_s") ? false : known(ctxOf(c, "PricingEntry.cost_method"), (m) => m === "CPV"))),
  "rule:5.6.5:f959ab87": requires("view_s", (v, c) => (has(v, "view_fraction") ? false : known(ctxOf(c, "PricingEntry.cost_method"), (m) => m === "CPV"))),
  "rule:5.6.5:449027fe": requires("action_type", (_v, c) => known(ctxOf(c, "PricingEntry.cost_method"), (m) => m === "CPA")),
  "rule:5.6.5:449027fe-2": requires("attribution_window", (_v, c) => known(ctxOf(c, "PricingEntry.cost_method"), (m) => m === "CPA")),
  "rule:5.6.5:449027fe-3": requires("action_source", (_v, c) => known(ctxOf(c, "PricingEntry.cost_method"), (m) => m === "CPA")),
  "rule:5.6.5:acca3c1c": requires("demographic", (_v, c) => known(ctxOf(c, "PricingEntry.cost_method"), (m) => m === "CPP")),
  "rule:5.6.5:acca3c1c-2": requires("rating_source", (_v, c) => known(ctxOf(c, "PricingEntry.cost_method"), (m) => m === "CPP")),
  // § 5.6.6
  "rule:5.6.6:11a40445": requires("share", (v) => v.calculation === "cancelled" || v.calculation === "commitment"),
  // § 5.7 and § 5.9
  "rule:5.7:76df804b": requires("controlling_measurement", (v) => v.serving_mode === "embedded" || nonEmpty(v.committed_metrics) || (isMap(v.commitment_bounds) && has(v.commitment_bounds, "spend")) || list(v.pricing).some((e) => isMap(e) && has(e, "unit_bounds"))),
  "rule:5.9:c0f7b8ce": requires("sov_basis", (v) => (isMap(v.transaction_mechanism) ? list(v.transaction_mechanism.available) : []).some((o) => isMap(o) && o.delivery_type === "share_of_voice")),
  "rule:5.9:cc571473": requires("deal_origin", (v) => offersDeal(v.transaction_mechanism)),
  "rule:5.9:ceef2a21": requires("sov_share", (v) => v.sov_basis === "impressions"),
  "rule:5.9:d8611936": requires("retention", (v) => v.serving_mode === "embedded"),
};
