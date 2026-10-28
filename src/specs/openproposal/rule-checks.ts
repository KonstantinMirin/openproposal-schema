/**
 * The deterministic checks of OpenProposal's own rules (src/rule-checks.ts),
 * by rule ID: the rules of its sections that one payload decides.
 */
import { escape, isMap, list, omits, type Check, type Violation } from "../../rule-checks.ts";

/**
 * The environments that hold an impression § 5.1.1 gives each channel, from
 * the § 5.2.1 rows: a channel is the first § 5.1.1 row an impression matches,
 * so a `Dooh` impression is `dooh` whatever its ad, an audio ad is `audio` on
 * any device, a Connected TV, Connected Device, or Set Top Box impression is
 * `ctv`, and native, video, and display ads are what is left, the site and app
 * impressions on a computer, a phone, or a tablet.
 */
const CHANNEL_ENVIRONMENTS: Record<string, string[]> = {
  dooh: ["dooh"],
  audio: ["web_desktop", "web_mobile", "app_mobile", "ctv"],
  ctv: ["ctv"],
  native: ["web_desktop", "web_mobile", "app_mobile"],
  video: ["web_desktop", "web_mobile", "app_mobile"],
  display: ["web_desktop", "web_mobile", "app_mobile"],
};
const ENVIRONMENTS = new Set(Object.values(CHANNEL_ENVIRONMENTS).flat());

/** Every `catalog_ref` in a value, by its JSON pointer. */
function catalogRefs(v: unknown, path: string): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => catalogRefs(x, `${path}/${i}`));
  if (!isMap(v)) return [];
  return Object.entries(v).flatMap(([k, x]) => (k === "catalog_ref" ? [`${path}/${escape(k)}`] : catalogRefs(x, `${path}/${escape(k)}`)));
}

/** The members the § 5.2.2 measurement rule reads, each of which a code block may leave out. */
const MEASUREMENT_READS = ["placement", "committed_metrics", "environments", "measurement_source"];


/** OpenProposal's rule checks, by rule ID. */
export const RULE_CHECKS: Record<string, Check> = {
  // § 2.2: at `agreed`, every `catalog_ref` is resolved into the stored record. A code block that leaves out `status` can't say.
  "rule:2.2:06ccee9f": (v, ctx) => {
    if (!isMap(v)) return [];
    const refs = catalogRefs(v, "");
    if (ctx.part && !("status" in v)) return refs.length > 0 ? null : [];
    return v.status === "agreed" ? refs.map((path) => ({ path, message: "a `catalog_ref` in an agreed line item" })) : [];
  },
  // § 5.2.1: each environment offered holds an impression of the line item's channel. A code block that shows the
  // environments and leaves out the channel can't say.
  "rule:5.2.1:cc42a1f8": (v, ctx) => {
    if (!isMap(v)) return [];
    if (omits(v, ctx, ["environments"], "channel")) return list(isMap(v.environments) ? v.environments.available : []).some((e) => typeof e === "string" && ENVIRONMENTS.has(e)) ? null : [];
    if (typeof v.channel !== "string" || !(v.channel in CHANNEL_ENVIRONMENTS) || !isMap(v.environments)) return [];
    const fits = CHANNEL_ENVIRONMENTS[v.channel]!;
    return list(v.environments.available).flatMap((e, i) => (typeof e === "string" && ENVIRONMENTS.has(e) && !fits.includes(e) ? [{ path: `/environments/available/${i}`, message: `\`${e}\` holds no \`${v.channel as string}\` impression` }] : []));
  },
  // § 5.2.2: without OMID 1.0 (7), viewability in app and CTV is measured by the seller only. Each of its conditions is
  // true, false, or, where a code block leaves its member out, unknown; one false condition decides it, and an unknown
  // one, a vendor a catalog reference stands for, or the proposal's seller, which a line item alone doesn't carry,
  // leaves it undecided.
  "rule:5.2.2:f9a1a6d5": (v, ctx) => {
    if (!isMap(v)) return [];
    const unknown = (k: string) => omits(v, ctx, MEASUREMENT_READS, k);
    const placement = isMap(v.placement) ? v.placement : {};
    const omid = unknown("placement") ? null : list(placement.api).includes(7);
    const viewable = unknown("committed_metrics") ? null : list(v.committed_metrics).some((m) => isMap(m) && m.metric === "viewable_rate");
    const environments = unknown("environments") ? null : (isMap(v.environments) ? list(v.environments.available) : []).some((e) => e === "app_mobile" || e === "ctv");
    const options = unknown("measurement_source") ? null : isMap(v.measurement_source) ? list(v.measurement_source.available) : [];
    if (omid === true || viewable === false || environments === false || (options !== null && options.length === 0)) return [];
    if (omid === null || viewable === null || environments === null || options === null) return null;
    const vendors = options.map((o, i) => [i, isMap(o) ? o.vendor : undefined] as const).filter(([, x]) => typeof x === "string");
    const referenced = options.some((o) => isMap(o) && "catalog_ref" in o);
    const seller = ctx.context["Proposal.seller_id"];
    if (typeof seller !== "string") return vendors.length > 0 || referenced ? null : [];
    const out = vendors.flatMap(([i, x]) => (x === seller ? [] : [{ path: `/measurement_source/available/${i}`, message: `offers the vendor ${JSON.stringify(x)}, not the seller, without OMID 1.0 (7)` }]));
    return out.length === 0 && referenced ? null : out;
  },
  // § 5.2, as the § 5.2.2 key row states it: "`plcmt` | REQUIRED for video ads (`channel` `video`, or video on
  // `channel` `ctv`); otherwise OPTIONAL". A `ctv` line item says in no field whether its ads are video: a format ID
  // is namespaced by channel, not by medium, and the registry has no `ctv/*` entries, and a delivery protocol is a
  // term the text doesn't list (D-035, D-041). So a `ctv` line item with no `plcmt` is undecided, and so is a code
  // block that leaves out the channel or the placement.
  "rule:5.2:f3d3f9e8": (v, ctx) => {
    if (!isMap(v)) return [];
    if (isMap(v.placement) && "plcmt" in v.placement) return [];
    if (omits(v, ctx, ["placement"], "channel") || v.channel === "ctv") return null;
    if (v.channel !== "video") return [];
    if (omits(v, ctx, ["channel"], "placement")) return null;
    return [{ path: isMap(v.placement) ? "/placement" : "", message: "a video line item's `placement` gives no `plcmt`" }];
  },
  // § 5.5: a `list_ref` is hash-pinned, and resolved into the stored record at `agreed`. A code block that leaves out
  // `status` decides the pin only.
  "rule:5.5:16494a1a": (v, ctx) => {
    if (!isMap(v) || !isMap(v.exclusions) || !isMap(v.exclusions.list_ref)) return [];
    const out: Violation[] = [];
    if (!("sha256" in v.exclusions.list_ref)) out.push({ path: "/exclusions/list_ref", message: "a `list_ref` with no `sha256`" });
    if (ctx.part && !("status" in v)) return out.length > 0 ? out : null;
    if (v.status === "agreed") out.push({ path: "/exclusions/list_ref", message: "a `list_ref` in an agreed line item" });
    return out;
  },
  // § 5.5: the buyer supplies only the exclusion types the seller accepts.
  "rule:5.5:2eab2842": (v, ctx) => {
    if (!isMap(v) || !isMap(v.exclusions)) return [];
    const types = Object.keys(v.exclusions).filter((k) => k !== "list_ref");
    if (types.length === 0) return [];
    if (!isMap(v.exclusions_accepted)) return ctx.part ? null : types.map((k) => ({ path: `/exclusions/${escape(k)}`, message: `the seller accepts no exclusion type, and the buyer supplies \`${k}\`` }));
    const accepted = new Set(list(v.exclusions_accepted.types));
    return types.flatMap((k) => (accepted.has(k) ? [] : [{ path: `/exclusions/${escape(k)}`, message: `\`exclusions_accepted.types\` doesn't list \`${k}\`` }]));
  },
};
