/**
 * The gates on a registry's enum drift report (src/enum-drift.ts): its
 * sources' pins and pairs, and the report's determinism and committed bytes. Each runs on
 * a spec that has `enum-drift/sources.yaml`, AdCOM's.
 */
import { checkEnumDriftSnapshots, compareEnumDrift, type EnumDriftSources } from "../src/enum-drift.ts";
import type { SpecIR } from "../src/ir-types.ts";
import type { ModelDoc } from "../src/model.ts";
import { committedTreeCurrent, flipFirst, onlyGenerated, sameTreeRuns, type CommittedTreeInput, type TrackedInput, type TreeRunsInput } from "./common.ts";
import { defineGate } from "./harness.ts";

const ADCOM = "adcom";

/** A source's snapshot with one file's bytes changed. */
const withFile = (files: Map<string, Map<string, Buffer>>, source: string, path: string, f: (text: string) => string) =>
  new Map([...files].map(([id, m]) => [id, id !== source ? m : new Map([...m].map(([p, b]) => [p, p === path ? Buffer.from(f(b.toString("utf8"))) : b]))]));
/** The sources file with one list's enum for one source changed. */
const withEnum = (s: EnumDriftSources, list: string, source: string, name: string | null): EnumDriftSources => ({ ...s, lists: s.lists.map((l) => (l.list === list ? { ...l, enums: { ...l.enums, [source]: name } } : l)) });

export const enumDriftSources = defineGate<{ sources: EnumDriftSources; files: Map<string, Map<string, Buffer>>; ir: SpecIR; model: ModelDoc }>({
  id: "enum-drift-sources",
  title: "enum drift sources: every artifact's snapshot holds its whole folder at the pinned tree and its license at the pinned blob, a reachable clone agrees, every list of the registry is paired once with each artifact's enum or none, and every enum is paired with a list",
  code: ["src/enum-drift.ts#checkEnumDriftSnapshots", "src/enum-drift.ts#compareEnumDrift", "src/enum-drift.ts#loadEnumDriftSources"],
  files: ["enum-drift/sources.schema.json"],
  check: (i) => {
    const snap = checkEnumDriftSnapshots(i.sources, i.files);
    const { doc, problems } = compareEnumDrift(i);
    return { problems: [...snap.problems, ...problems], note: `${doc.lists.length} lists against ${doc.sources.map((s) => s.title).join(" and ")}; ${snap.notes.join("; ")}` };
  },
  fixtures: [
    { name: "a snapshot file changed", spec: ADCOM, mutate: (i) => ({ ...i, files: withFile(i.files, "adcom-proto", "proto/com/iabtechlab/adcom/v1/enums/enums.proto", (t) => t.replace("SIMID_1_1  = 9;", "SIMID_1_1  = 9;\n  SIMID_1_2  = 10;")) }), expect: "the snapshot's proto/com/iabtechlab/adcom/v1/enums/ is tree" },
    { name: "a snapshot that left out a file of the folder", spec: ADCOM, mutate: (i) => ({ ...i, files: new Map([...i.files].map(([id, m]) => [id, id === "prebid-openrtb" ? new Map([...m].filter(([p]) => p !== "adcom1/feed_type.go")) : m])) }), expect: "the snapshot's adcom1/ is tree" },
    { name: "a snapshot that holds a file outside its folder", spec: ADCOM, mutate: (i) => ({ ...i, files: new Map([...i.files].map(([id, m]) => [id, id === "prebid-openrtb" ? new Map([...m, ["openrtb2/bid.go", Buffer.from("package openrtb2\n")]]) : m])) }), expect: "holds openrtb2/bid.go, which is neither in adcom1/ nor the license" },
    { name: "a changed license", spec: ADCOM, mutate: (i) => ({ ...i, files: withFile(i.files, "prebid-openrtb", "LICENSE", (t) => `${t}\n`) }), expect: "the snapshot's LICENSE is blob" },
    { name: "a list left out", spec: ADCOM, mutate: (i) => ({ ...i, sources: { ...i.sources, lists: i.sources.lists.filter((l) => l.list !== "list_devicetypes") } }), expect: "leaves out the list list_devicetypes" },
    { name: "an enum the artifact doesn't define", spec: ADCOM, mutate: (i) => ({ ...i, sources: withEnum(i.sources, "list_devicetypes", "adcom-proto", "DeviceTypes") }), expect: "names adcom-proto's enum DeviceTypes, which its files don't define" },
    { name: "an enum paired with no list", spec: ADCOM, mutate: (i) => ({ ...i, sources: withEnum(i.sources, "list_feedtypes", "prebid-openrtb", null) }), expect: "prebid-openrtb's enum FeedType is named for no list" },
    { name: "an enum paired with two lists", spec: ADCOM, mutate: (i) => ({ ...i, sources: withEnum(i.sources, "list_podsequence", "prebid-openrtb", "SlotPositionInPod") }), expect: "is named for list_podsequence and list_slotpositioninpod" },
    { name: "an enum value the reader can't read", spec: ADCOM, mutate: (i) => ({ ...i, files: withFile(i.files, "prebid-openrtb", "adcom1/device_type.go", (t) => t.replace(/DeviceType = 1 /, "DeviceType = iota ")) }), expect: "a constant the reader can't read" },
  ],
});

export const enumDriftDeterministic = defineGate<TreeRunsInput>({
  id: "enum-drift-deterministic",
  title: "deterministic enum drift report",
  code: ["gates/common.ts#sameTreeRuns"],
  check: sameTreeRuns,
  fixtures: [{ name: "a run writes the report differently", spec: ADCOM, mutate: (i) => ({ ...i, runs: [i.runs[0]!, flipFirst(i.runs[1]!)] }), expect: "run 2: " }],
});

export const enumDriftCommitted = defineGate<CommittedTreeInput>({
  id: "enum-drift-committed",
  title: (i) => `committed ${i.dir}/ report current`,
  code: ["gates/common.ts#committedTreeCurrent"],
  check: committedTreeCurrent,
  fixtures: [{ name: "a committed report edited by hand", spec: ADCOM, mutate: (i) => ({ ...i, committed: flipFirst(i.committed) }), expect: "differs" }],
});

export const enumDriftTracked = defineGate<TrackedInput>({
  id: "enum-drift-tracked",
  title: "every tracked file under enum-drift/ is the sources file, a pinned snapshot file, or one the report writes",
  code: ["gates/common.ts#onlyGenerated"],
  check: onlyGenerated,
  fixtures: [{ name: "a snapshot file outside its source's folder", spec: ADCOM, mutate: (i) => ({ ...i, tracked: [...i.tracked, "enum-drift/snapshots/prebid-openrtb/openrtb2/bid.go"] }), expect: "enum-drift/snapshots/prebid-openrtb/openrtb2/bid.go" }],
});
