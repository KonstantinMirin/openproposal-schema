/**
 * The registry agreement gate (src/agreement.ts): a spec cites only lists a
 * registry it imports titles with codes, restates only their codes and
 * labels, copies no list's codes and no list into the kernel, references the
 * registry's vocabularies, pins each registry once, and links only anchors
 * the registry's text has at the pinned commit. It runs on each lock and
 * variant of every spec that isn't a registry itself.
 */
import { checkAgreement, type AgreementInput } from "../src/agreement.ts";
import { defineGate } from "./harness.ts";

const OP = "openproposal";
const PRS = "with-open-prs";

/** The input with one string of the IR changed, wherever it occurs. */
const withText = (i: AgreementInput, from: string, to: string): AgreementInput => {
  const json = JSON.stringify(i.ir);
  if (!json.includes(from)) throw new Error(`the IR doesn't write "${from}"`);
  return { ...i, ir: JSON.parse(json.split(from).join(to)) };
};
/** The input with one string of the text changed, wherever it occurs. */
const withLine = (i: AgreementInput, from: string, to: string): AgreementInput => {
  if (!i.text.some((l) => l.includes(from))) throw new Error(`the text doesn't write "${from}"`);
  return { ...i, text: i.text.map((l) => l.split(from).join(to)) };
};
const inventory = (i: AgreementInput, def: string, schema: Record<string, unknown>): AgreementInput => ({ ...i, files: i.files.map((f) => (f.path !== "modules/inventory/1/inventory.json" ? f : { ...f, schema: { ...f.schema, $defs: { ...(f.schema.$defs as object), [def]: schema } } })) });

export const registryAgreement = defineGate<AgreementInput>({
  id: "registry-agreement",
  title: (i) => `registry agreement: every list ${i.spec} cites on ${i.lock} is a list with codes of a registry it imports${i.registries.some((r) => r.imported) ? `, ${i.registries.filter((r) => r.imported).map((r) => `${r.spec} at ${r.lock}`).join(" and ")}` : ""}, every code it restates is the registry's with its label, no schema or kernel list copies a list's codes, each vocabulary of a list references the registry's, each registry is pinned once, and every link into a registry's text is at the pinned commit and names an anchor it has`,
  code: ["src/agreement.ts#checkAgreement"],
  check: (i) => ({ problems: checkAgreement(i), note: `${i.registries.filter((r) => r.imported).map((r) => `${r.spec} at ${r.lock}, ${r.lists.length} lists`).join("; ") || "imports no registry"}; ${i.model.types.filter((t) => t.kind === "vocabulary" && t.list?.registry).length} vocabularies reference one` }),
  fixtures: [
    { name: "a restated code that disagrees with the registry", spec: OP, lock: PRS, mutate: (i) => withText(i, "MRAID 3.0 (6)", "MRAID 3.0 (5)"), expect: `restates List: API Frameworks's "mraid 3.0" as code 5, where the registry gives it 6` },
    { name: "a restated code the registry doesn't hold", spec: OP, lock: PRS, mutate: (i) => withText(i, "In-scene (9)", "In-scene (10)"), expect: `restates List: Plcmt Subtypes - Video's "in-scene" as code 10, where the registry gives it 9, and holds no code 10` },
    { name: "a restated label the registry doesn't write", spec: OP, lock: PRS, mutate: (i) => withText(i, "OMID 1.0 (7)", "OMID 1.1 (7)"), expect: `restates List: API Frameworks's code 7 as "omid 1.1", where the registry labels it "OMID 1.0"` },
    { name: "a device table's code that disagrees with the list it cites", spec: OP, lock: PRS, mutate: (i) => withLine(i, "Connected TV (3)", "Connected TV (4)"), expect: `restates List: Device Types's "connected tv" as code 4, where the registry gives it 3` },
    { name: "a list name the registry doesn't title", spec: OP, lock: PRS, mutate: (i) => withText(i, "List: Playback Methods", "List: Playback Modes"), expect: 'cites "List: Playback Modes", which no registry on this site titles' },
    { name: "a list the registry titles with no codes", spec: OP, lock: PRS, mutate: (i) => withLine(i, "List: Device Types", "List: Placement Subtypes - Video"), expect: "cites List: Placement Subtypes - Video, which adcom at main titles with no codes" },
    { name: "a copied enum in place of the registry's vocabulary", spec: OP, lock: PRS, mutate: (i) => inventory(i, "PlcmtSubtype", { type: "integer", enum: [1, 2, 3, 4, 5, 6, 7, 8, 9] }), expect: "modules/inventory/1/inventory.json at /$defs/PlcmtSubtype copies the codes of AdCOM 1.0 List: API Frameworks or AdCOM 1.0 List: Category Taxonomies or AdCOM 1.0 List: Plcmt Subtypes - Video" },
    { name: "copied const branches with a vendor range", spec: OP, lock: PRS, mutate: (i) => inventory(i, "ApiFramework", { type: "integer", oneOf: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => ({ const: c, title: `x${c}` })).concat([{ type: "integer", minimum: 500, title: "Vendor-specific" } as never]) }), expect: "at /$defs/ApiFramework copies the codes of" },
    { name: "a registry vocabulary that references something else", spec: OP, lock: PRS, mutate: (i) => inventory(i, "PlaybackMethod", { $ref: "https://adtechspec.noetis.dev/adcom/schemas/modules/lists/1/lists.json#/$defs/DeviceType" }), expect: "PlaybackMethod's schema isn't a $ref to https://adtechspec.noetis.dev/adcom/schemas/modules/lists/1/lists.json#/$defs/PlaybackMethod" },
    { name: "a vocabulary that takes a list's codes from a copy", spec: OP, lock: PRS, mutate: (i) => ({ ...i, model: { ...i.model, types: i.model.types.map((t) => (t.name === "PlaybackMethod" && t.kind === "vocabulary" ? { ...t, list: { ...t.list!, registry: undefined } } : t)) } }), expect: "PlaybackMethod takes the codes of AdCOM 1.0 List: Playback Methods from a copy" },
    { name: "a vocabulary whose codes aren't the registry's", spec: OP, lock: PRS, mutate: (i) => ({ ...i, model: { ...i.model, types: i.model.types.map((t) => (t.name === "PlaybackMethod" && t.kind === "vocabulary" ? { ...t, terms: t.terms.filter((x) => x.value !== 11) } : t)) } }), expect: 'PlaybackMethod lacks "11 Initiated by idling (e.g. screensaver), Sound off"' },
    { name: "a vocabulary closed where its list is open", spec: OP, lock: PRS, mutate: (i) => ({ ...i, model: { ...i.model, types: i.model.types.map((t) => (t.name === "ApiFramework" && t.kind === "vocabulary" ? { ...t, open: false } : t)) } }), expect: "ApiFramework is closed, where List: API Frameworks at main is open" },
    { name: "a kernel list that copies a registry's list", spec: OP, lock: PRS, mutate: (i) => ({ ...i, kernelLists: [...i.kernelLists, { name: "Device kinds", standard: "AdCOM", url: "https://example.com/devices", codes: i.registries[0]!.lists.find((l) => l.name === "List: Device Types")!.codes }] }), expect: 'kernel/lists.yaml: the list "Device kinds" copies adcom\'s List: Device Types' },
    { name: "a second pin of the registry", spec: OP, lock: PRS, mutate: (i) => ({ ...i, pins: [...i.pins, { spec: OP, registry: "adcom", lock: "tag-202607" }] }), expect: "pins adcom 2 times (main, tag-202607); a spec pins each registry once" },
    { name: "a pin at a lock the registry doesn't have", spec: OP, lock: PRS, mutate: (i) => ({ ...i, registries: i.registries.map((r) => (r.imported ? { ...r, lock: "nope" } : r)) }), expect: 'pins adcom at "nope", which adcom has no lock named' },
    { name: "another spec pinning the registry at another lock", spec: OP, lock: PRS, mutate: (i) => ({ ...i, pins: [...i.pins, { spec: "dealsapi", registry: "adcom", lock: "tag-202607" }] }), expect: 'openproposal pins adcom at "main", and dealsapi at "tag-202607"' },
    { name: "a citation of a registry the spec doesn't import", spec: OP, lock: PRS, mutate: (i) => ({ ...i, registries: i.registries.map((r) => ({ ...r, imported: false })) }), expect: "cites List: API Frameworks of adcom, a registry its profile doesn't import" },
    { name: "a link to an anchor the registry's text doesn't have", spec: OP, lock: PRS, mutate: (i) => withLine(i, "#list_apiframeworks", "#list_apiframework"), expect: "links adcom's text at #list_apiframework, which names no section of it" },
    { name: "a link by a slug GitHub doesn't give the heading", spec: OP, lock: PRS, mutate: (i) => withLine(i, "#list_apiframeworks", "#list-api-frameworks"), expect: "links adcom's text at #list-api-frameworks, which names no section of it" },
    { name: "a link at another commit than the pinned lock's", spec: OP, lock: PRS, mutate: (i) => withLine(i, "26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#list_apiframeworks", "master/AdCOM%20v1.0%20FINAL.md#list_apiframeworks"), expect: "links adcom's text at master, not at 26c59ba, the commit of the lock \"main\" the spec pins" },
  ],
});
