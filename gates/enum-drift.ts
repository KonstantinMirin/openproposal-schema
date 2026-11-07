/**
 * The gates on a registry's enum drift report (src/enum-drift.ts): its
 * sources' pins and pairs, the spec's own proto target held to the
 * registry, and the report's determinism and committed bytes. Each runs on
 * a spec that has `enum-drift/sources.yaml`, AdCOM's.
 */
import { checkEnumDriftSnapshots, compareEnumDrift, compareTarget, targetProblems, type EnumDriftSources, type RegistryList } from "../src/enum-drift.ts";
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

/** The target's files with one file's text changed. */
const withTarget = (files: Map<string, Buffer>, f: (text: string) => string) => new Map([...files].map(([p, b]) => [p, Buffer.from(f(b.toString("utf8")))]));

export const enumDriftTarget = defineGate<{ lists: RegistryList[]; files: Map<string, Buffer> }>({
  id: "enum-drift-target",
  title: "enum drift target: the spec's own proto files hold an enum for every list with codes, named as its vocabulary, with every code at its own number and no other value but the unset one, none in a vendor range or a positive-number row",
  code: ["src/enum-drift.ts#compareTarget", "src/enum-drift.ts#targetProblems"],
  check: (i) => {
    if (i.files.size === 0) return { problems: ["the spec has no proto files to compare"] };
    const { target } = compareTarget(i.lists, i.files);
    return { problems: targetProblems(target, i.lists), note: `${target.totals.compared} lists, ${target.totals.values} values; ${target.totals.missing} missing, ${target.totals.extra} extra, ${target.totals.noEnum} with no enum` };
  },
  fixtures: [
    { name: "a code renumbered", spec: ADCOM, mutate: (i) => ({ ...i, files: withTarget(i.files, (t) => t.replace("API_FRAMEWORK_MRAID_3_0 = 6;", "API_FRAMEWORK_MRAID_3_0 = 60;")) }), expect: "the target's ApiFramework lacks the code 6" },
    { name: "an enum dropped", spec: ADCOM, mutate: (i) => ({ ...i, files: withTarget(i.files, (t) => t.replace("enum DeviceType {", "enum DeviceTypes {")) }), expect: "Device Types: the target has no enum for the list" },
    { name: "a value that is no code", spec: ADCOM, mutate: (i) => ({ ...i, files: withTarget(i.files, (t) => t.replace("  API_FRAMEWORK_SIMID_1_1 = 9;\n", "  API_FRAMEWORK_SIMID_1_1 = 9;\n  API_FRAMEWORK_SIMID_1_2 = 10;\n")) }), expect: "holds API_FRAMEWORK_SIMID_1_2 = 10, which is no code of the list" },
    { name: "a vendor's code as a value, which a range is not", spec: ADCOM, mutate: (i) => ({ ...i, files: withTarget(i.files, (t) => t.replace("  API_FRAMEWORK_SIMID_1_1 = 9;\n", "  API_FRAMEWORK_SIMID_1_1 = 9;\n  API_FRAMEWORK_MY_VENDOR = 500;\n")) }), expect: "holds API_FRAMEWORK_MY_VENDOR = 500, which is no code of the list" },
    { name: "a media offset as a value, which a positive-number row is not", spec: ADCOM, mutate: (i) => ({ ...i, files: withTarget(i.files, (t) => t.replace("  START_DELAY_MODE_GENERIC_POST_ROLL = -2;\n", "  START_DELAY_MODE_GENERIC_POST_ROLL = -2;\n  START_DELAY_MODE_SECOND_15 = 15;\n")) }), expect: "holds START_DELAY_MODE_SECOND_15 = 15, which is no code of the list" },
    { name: "an enum of no list", spec: ADCOM, mutate: (i) => ({ ...i, files: withTarget(i.files, (t) => `${t}\nenum Extra {\n  EXTRA_UNSPECIFIED = 0;\n}\n`) }), expect: "the target's enum Extra is no list's vocabulary" },
    { name: "a line the proto reader can't read", spec: ADCOM, mutate: (i) => ({ ...i, files: withTarget(i.files, (t) => t.replace("API_FRAMEWORK_ORMMA = 4;", "API_FRAMEWORK_ORMMA = 4 [deprecated = true];")) }), expect: "a line in enum ApiFramework the reader can't read" },
    { name: "no proto files", spec: ADCOM, mutate: (i) => ({ ...i, files: new Map() }), expect: "the spec has no proto files to compare" },
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
