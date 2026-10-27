/**
 * What the generated SDKs give a consumer beyond the types: the provenance
 * constants each SDK states, the Python SDK's wire helpers and receive
 * mode, each vocabulary's terms as constants, and the error a bare Python
 * template raises.
 *
 * `fixtures/seller-agent-payloads.json` holds the 11 payloads that
 * IABTechLab/seller-agent's own mapper writes from its router examples, on
 * the unmerged branch `feat/openproposal-mapping` at `e77022e` (Apache
 * License 2.0), each with the type it is a value of.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { treeDigest } from "../src/release.ts";
import { constantName, plural } from "../src/sdk.ts";
import { goTermName } from "../src/sdk-go.ts";
import { ROOT } from "./helpers.ts";

/** The four SDK trees: each one's directory, lock, variant, and schema directory. */
const TREES = [
  { dir: "sdk", lock: "main", variant: "as-written", schemas: "schemas/as-written" },
  { dir: "sdk/with-open-prs", lock: "with-open-prs", variant: "as-written", schemas: "schemas/as-written/with-open-prs" },
  { dir: "sdk/proposed", lock: "main", variant: "proposed", schemas: "schemas" },
  { dir: "sdk/proposed/with-open-prs", lock: "with-open-prs", variant: "proposed", schemas: "schemas/with-open-prs" },
] as const;

/** Runs a Python script with a tree's `openproposal` package on the path, under the venv's interpreter, and returns its stdout. */
function python(tree: string, script: string): string {
  const r = spawnSync(join(ROOT, ".venv", "bin", "python"), ["-I", "-B", "-c", `import sys\nsys.path.insert(0, ${JSON.stringify(join(ROOT, tree, "python"))})\n${script}`], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/** The digest of a committed schema tree, as a release manifest records it. */
function committedDigest(dir: string): string {
  const files: { path: string; schema: unknown }[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(ROOT, dir, rel), { withFileTypes: true })) {
      const p = rel === "" ? e.name : posix.join(rel, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".json")) files.push({ path: p, schema: JSON.parse(readFileSync(join(ROOT, dir, p), "utf8")) });
    }
  };
  for (const top of ["kernel", "modules", "documents"]) walk(top);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return treeDigest(files);
}

test("each SDK states the commit, lock, variant, and schema release it was generated from, alike in Python, TypeScript, and Go", async () => {
  for (const t of TREES) {
    const lock = readFileSync(join(ROOT, "spec-input", t.lock === "main" ? "spec-lock.yaml" : `${t.lock}.lock.yaml`), "utf8");
    const commit = /^\s*commit:\s*"?([0-9a-f]{40})"?/m.exec(lock)?.[1];
    assert.ok(commit, `${t.lock}: the lock names a commit`);
    const want = { SPEC_COMMIT: commit, LOCK: t.lock, VARIANT: t.variant, SCHEMA_RELEASE: committedDigest(t.schemas) };
    const py = JSON.parse(python(t.dir, "import json, openproposal as op\nprint(json.dumps({k: getattr(op, k) for k in ['SPEC_COMMIT', 'SPEC_BLOB', 'LOCK', 'VARIANT', 'SCHEMA_RELEASE']}))")) as Record<string, string>;
    const ts = (await import(join(ROOT, t.dir, "ts", "src", "index.ts"))) as Record<string, string>;
    const goText = readFileSync(join(ROOT, t.dir, "go", "openproposal", "provenance.go"), "utf8");
    const go = (name: string) => new RegExp(`^const ${name} = "([^"]*)"$`, "m").exec(goText)?.[1];
    for (const [k, v] of Object.entries(want)) assert.equal(py[k], v, `${t.dir}: Python ${k}`);
    for (const [k, v] of Object.entries(want)) assert.equal(ts[k], v, `${t.dir}: TypeScript ${k}`);
    assert.deepEqual([go("SpecCommit"), go("Lock"), go("Variant"), go("SchemaRelease")], [want.SPEC_COMMIT, want.LOCK, want.VARIANT, want.SCHEMA_RELEASE], `${t.dir}: Go`);
    assert.equal(ts.SPEC_BLOB, py.SPEC_BLOB);
    assert.equal(go("SpecBlob"), py.SPEC_BLOB);
  }
});

test("the schema release of the SDKs with our proposals is the digest each lock's release manifest records", () => {
  for (const t of TREES.filter((x) => x.variant === "proposed")) {
    const manifest = JSON.parse(readFileSync(join(ROOT, t.schemas, "release.json"), "utf8")) as { digest: string };
    assert.equal(JSON.parse(python(t.dir, "import json, openproposal as op\nprint(json.dumps(op.SCHEMA_RELEASE))")), manifest.digest, t.dir);
  }
});

/** The type examples of a tree's build. */
const examplesOf = (t: (typeof TREES)[number]) => join(ROOT, "type-examples", ...t.schemas.split("/").slice(1), "examples.json");

test("the receive mode ignores the members a closed object doesn't name, at any depth, and checks everything else as the strict mode does", () => {
  for (const t of TREES) {
    const out = python(
      t.dir,
      `import json, typing
import openproposal as op
from openproposal import _runtime as rt
from pydantic import ValidationError
full = json.load(open(${JSON.stringify(examplesOf(t))}))["types"]["LineItem"]["full"]
def verdict(value, mode):
    try:
        return op.dump(op.parse("LineItem", value, mode=mode))
    except ValidationError:
        return None
out = {"baseline": [verdict(full, m) == full for m in ("strict", "receive")]}
top = dict(full, ext={"gam": {"order_id": "1"}})
out["top"] = [verdict(top, "strict"), verdict(top, "receive") == full]
nested = dict(full, hold_status=dict(full["hold_status"], ext=1))
out["nested"] = [verdict(nested, "strict"), verdict(nested, "receive") == full]
listed = dict(full, pricing=[dict(full["pricing"][0], ext=1)] + full["pricing"][1:])
out["listed"] = [verdict(listed, "strict"), verdict(listed, "receive") == full]
wrong = dict(top, hold_status=dict(full["hold_status"], hold_available="yes"))
out["wrong"] = [verdict(wrong, "strict"), verdict(wrong, "receive")]
opens = [n for n, f in op.LineItem.model_fields.items() if n in full and isinstance(full[n], dict) and any(isinstance(a, type) and issubclass(a, rt.Open) for a in typing.get_args(f.annotation))]
out["open"] = []
for n in opens:
    kept = dict(full, **{n: dict(full[n], examplepub_note="kept")})
    out["open"] += [verdict(kept, m) == kept for m in ("strict", "receive")]
try:
    op.parse("LineItem", full, mode="lenient")
    out["mode"] = "accepted"
except ValueError as e:
    out["mode"] = str(e)
print(json.dumps(out))`,
    );
    const r = JSON.parse(out) as Record<string, unknown>;
    assert.deepEqual(r.baseline, [true, true], `${t.dir}: the full example passes both modes`);
    for (const k of ["top", "nested", "listed"]) assert.deepEqual(r[k], [null, true], `${t.dir}: ${k}: the strict mode rejects the unknown member and the receive mode drops it`);
    assert.deepEqual(r.wrong, [null, null], `${t.dir}: a known member of the wrong type fails both modes`);
    assert.ok((r.open as boolean[]).length > 0 && (r.open as boolean[]).every(Boolean), `${t.dir}: an open object keeps a member it doesn't name in both modes`);
    assert.match(String(r.mode), /'lenient' is no mode/);
  }
});

/** How many of the seller agent's 11 payloads each tree accepts, in the strict mode and the receive mode. */
const SELLER_AGENT: Record<string, [number, number]> = {
  sdk: [1, 3],
  "sdk/with-open-prs": [1, 3],
  "sdk/proposed": [0, 1],
  "sdk/proposed/with-open-prs": [0, 1],
};

test("the seller agent's mapped payloads: how many each tree accepts in each mode, and each accepted one parses, dumps, and parses again to the same value", () => {
  for (const t of TREES) {
    const out = python(
      t.dir,
      `import json
import openproposal as op
from pydantic import ValidationError
payloads = json.load(open(${JSON.stringify(join(ROOT, "test", "fixtures", "seller-agent-payloads.json"))}))
out = {"strict": [], "receive": [], "round_trip": []}
for name, p in payloads.items():
    for mode in ("strict", "receive"):
        try:
            value = op.parse(p["type"], p["json"], mode=mode)
        except ValidationError:
            continue
        out[mode].append(name)
        again = op.parse(p["type"], op.dump(value))
        out["round_trip"].append(op.dump(again) == op.dump(value) and json.loads(op.dump_json(value)) == op.dump(value))
print(json.dumps(out))`,
    );
    const r = JSON.parse(out) as { strict: string[]; receive: string[]; round_trip: boolean[] };
    assert.deepEqual([r.strict.length, r.receive.length], SELLER_AGENT[t.dir], `${t.dir}: ${JSON.stringify(r)}`);
    assert.ok(r.strict.every((n) => r.receive.includes(n)), `${t.dir}: every payload the strict mode accepts, the receive mode accepts`);
    assert.ok(r.round_trip.every(Boolean), `${t.dir}: every accepted payload round-trips`);
  }
});

test("dump and dump_json write every absent member as absent, so each type example parses, dumps, and parses again unchanged", () => {
  for (const t of TREES) {
    const out = python(
      t.dir,
      `import json
import openproposal as op
types = json.load(open(${JSON.stringify(examplesOf(t))}))["types"]
bad = []
for name, ex in sorted(types.items()):
    for which in ("minimal", "full"):
        if which not in ex or name not in op.TYPES:
            continue
        value = op.parse(name, ex[which])
        d = op.dump(value)
        if d != ex[which] or op.dump(op.parse(name, d)) != d or json.loads(op.dump_json(value)) != d or op.dump(op.parse_json(name, op.dump_json(value))) != d:
            bad.append(f"{name} {which}")
li = op.LineItem(status="draft")
plain = li.model_dump()
li.channel = None
out = {"bad": bad, "count": len(types), "dump": op.dump(li), "json": op.dump_json(li), "plain_has_null": any(v is None for v in plain.values())}
print(json.dumps(out))`,
    );
    const r = JSON.parse(out) as { bad: string[]; count: number; dump: unknown; json: string; plain_has_null: boolean };
    assert.deepEqual(r.bad, [], t.dir);
    assert.ok(r.count > 100, `${t.dir}: ${r.count} type examples`);
    assert.deepEqual(r.dump, { status: "draft" }, `${t.dir}: a member never set, or set to None, stays absent`);
    assert.equal(r.json, '{"status":"draft"}');
    assert.equal(r.plain_has_null, true, `${t.dir}: a plain model_dump() writes nulls, which is why dump exists`);
  }
});

test("a vocabulary's constants are named in the plural, with each term in upper snake case, and Go's term constants keep initialisms in one case", () => {
  assert.deepEqual(["Channel", "HoldState", "CommitmentBasis", "ProposalStatus", "Party", "Metric"].map(plural), ["Channels", "HoldStates", "CommitmentBases", "ProposalStatuses", "Parties", "Metrics"]);
  assert.deepEqual(["display", "PREFERRED_DEAL", "oauth2_client_credentials", "CPM", 3, -1].map(constantName), ["DISPLAY", "PREFERRED_DEAL", "OAUTH2_CLIENT_CREDENTIALS", "CPM", "CODE_3", "CODE_MINUS_1"]);
  assert.deepEqual(["viewable_rate", "PREFERRED_DEAL", "ctv", "DIRECT_IO", "api_key", "oauth2_client_credentials", "id_partner", "fire_tv"].map(goTermName), ["ViewableRate", "PreferredDeal", "CTV", "DirectIO", "APIKey", "OAuth2ClientCredentials", "IDPartner", "FireTV"]);
});

test("each vocabulary with terms has a constants class in Python and a const object in TypeScript, of its terms, and a field takes a constant, or a namespaced term as a plain string where the vocabulary is open", async () => {
  for (const t of TREES) {
    const out = python(
      t.dir,
      `import json, typing
import openproposal as op
from pydantic import ValidationError
out = {}
for name in op.__all__:
    c = getattr(op, name)
    if isinstance(c, type) and not hasattr(c, "model_fields") and name[0].isupper() and name not in op.TYPES and name not in op.TEMPLATES and name not in ("ExtensionRegistry",):
        out[name] = {k: v for k, v in vars(c).items() if k.isupper()}
li = op.parse("LineItem", {"channel": op.Channels.CTV, "status": op.LineItemStatuses.DRAFT})
try:
    op.parse("LineItem", {"channel": "examplepub.example:podcast"})
    namespaced = True
except ValidationError:
    namespaced = False
try:
    op.parse("LineItem", {"status": "examplepub.example:paused"})
    closed = "accepted"
except ValidationError:
    closed = "rejected"
print(json.dumps({"constants": out, "dump": op.dump(li), "namespaced": namespaced, "closed": closed}))`,
    );
    const r = JSON.parse(out) as { constants: Record<string, Record<string, string | number>>; dump: unknown; namespaced: boolean; closed: string };
    assert.deepEqual(r.dump, { channel: "ctv", status: "draft" }, t.dir);
    assert.equal(r.namespaced, true, `${t.dir}: an open vocabulary takes a namespaced term as a plain string`);
    assert.equal(r.closed, "rejected", `${t.dir}: a closed vocabulary takes no other term`);
    const ts = (await import(join(ROOT, t.dir, "ts", "src", "index.ts"))) as Record<string, unknown>;
    const types = ts.TYPES as Record<string, { safeParse(v: unknown): { success: boolean } }>;
    assert.ok(Object.keys(r.constants).length >= 20, `${t.dir}: ${Object.keys(r.constants).length} constants classes`);
    for (const [name, members] of Object.entries(r.constants)) {
      assert.deepEqual(ts[name], members, `${t.dir}: ${name} is the same in TypeScript as in Python`);
      const of = Object.keys(types).find((n) => plural(n) === name);
      assert.ok(of, `${t.dir}: ${name} is the constants of a vocabulary`);
      for (const v of Object.values(members)) assert.ok(types[of]!.safeParse(v).success, `${t.dir}: ${name}'s ${JSON.stringify(v)} is a term of ${of}`);
    }
  }
});

test("a bare Python template raises a TypeError that names its copies and an application, where it used to blame a null member, and an applied one checks values", () => {
  for (const t of TREES) {
    const out = python(
      t.dir,
      `import json, typing
import openproposal as op
from openproposal import _runtime as rt
out = {}
for name, tpl in op.TEMPLATES.items():
    if not isinstance(tpl, type):
        continue
    errors = []
    for build in (lambda: tpl(), lambda: tpl.model_validate({}), lambda: tpl.model_validate_json("{}")):
        try:
            build()
            errors.append(None)
        except TypeError as e:
            errors.append(str(e))
    copy, application = tpl.__copies__[0] if tpl.__copies__ else (None, None)
    out[name] = {"errors": errors, "copy": copy, "application": application}
T = typing.TypeVar("T")
out["none"] = rt._template_error(type("Lone", (), {}), (T,))
formats = op.parse("LineItem", {"formats": {"available": ["display/300x250"], "included": ["display/300x250"]}}).formats
out["applied"] = [type(formats).__name__, op.dump(op.FormatsSelection(available=["display/300x250"], included=[]))]
print(json.dumps(out))`,
    );
    const r = JSON.parse(out) as Record<string, unknown>;
    for (const name of ["Selectable", "Settable", "Range"]) {
      const x = r[name] as { errors: (string | null)[]; copy: string; application: string };
      assert.ok(x, `${t.dir}: ${name} is a class template`);
      for (const raised of x.errors) {
        const e = raised ?? "nothing raised";
        assert.ok(e.startsWith(`${name} is a generic template, so it can't check a value until it is applied to its arguments: use one of its named copies, ${x.copy}`), `${t.dir}: ${e}`);
        assert.ok(e.includes(`or apply it, as ${x.application}`), e);
        assert.ok(!e.includes("is null"), e);
      }
    }
    assert.equal(r.none, "Lone is a generic template, so it can't check a value until it is applied to its arguments: apply it, as Lone[T]");
    assert.deepEqual(r.applied, ["Selectable[FormatId, FormatId]", { available: ["display/300x250"], included: [] }], t.dir);
  }
});
