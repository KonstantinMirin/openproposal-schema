#!/usr/bin/env python3
"""Check every example against the tables of the specification.

Every rule here reads the spec, so a table change reaches the examples without a
change to this script. It checks:

  - Each file parses strictly: no duplicate keys, no implicit dates, YAML 1.2 core
    schema scalars, and Numbers that RFC 8785 reproduces (section 4.1.1).
  - Each REQUIRED field and key is present. A `REQUIRED when <condition>` cell is
    tested by its entry in CONDITIONS, and a wording with no entry is an error.
  - Each key at a typed position is a key its table lists, and each value has its
    Type. A Type cell the script can't test is an error. An Enum value is on its list,
    and a bare VocabularyTerm is a core term where its row lists them.
  - Option ids are unique, and included[], selected[], and deltas name options.
  - excluded[] names excludable options outside the set in effect, and combine holds
    the operators section 5.3 lists, with no deltas.
  - An exclusions entry is an array of its type's entries or a DocumentRef, and its
    type is one accepted_exclusions accepts.
  - Each format id starts with the channel and has a format_specs entry, and every
    copy of one spec_ref version holds one spec (section 5.4).
  - selected[] or included[] fits max_select, and an empty set has a stated meaning.
  - A settable field holds its form, and each buyer value is within its bounds.
  - agreed_rate recomputes under section 5.6, on the committed entry only.
  - A commitment's arithmetic holds under section 5.6.5, on FLAT and TIME as well,
    and it fits commitment_bounds.spend and the committed entry's unit_bounds. An amount
    under basis units is whole.
  - Each mechanism option fits its row in section 5.9.
  - An array whose row says MUST be non-empty holds an entry, and an audience option's
    taxonomy is a value its row allows.
  - The committed entry covers the mechanism in effect (section 5.6).
  - Each section 2.1 summary path resolves to a table row with the same spelling.
  - The manifest fits its key table, is a strict path subset of the full objects
    (section 2.1), and lists each public, published line item (section 2.3).
  - Each section 4.1.1 removal path resolves to a table row, and each lifecycle,
    recorded, or asserted field is on the removal list (section 3).
  - seller and buyer on a proposal hold legal_name.
  - proposal.yaml is a shared proposal: it carries no buyer, assent, ask, hold,
    commitment, or buyer write (section 4.3).
  - Each line-item-*.yaml with no commitment equals the entry of that line_item_id in
    proposal.yaml, and proposal.yaml holds no other entry (section 6.1).
  - A value table's first column equals the list it restates (section 2.6).
  - A proposal's status follows its line items (section 4.3.3), and its history has
    one seller entry for each version and pointers that resolve (section 4.1.3).
  - record_digest in examples/proposal-agreed.yaml and examples/proposal-issued.yaml
    recomputes under section 4.1.1, over the line items each entry names.
  - In those examples a withdrawal or decline matches a commitment entry before it,
    an acceptance matches a commitment entry, a line item is agreed only with a
    matching pair (section 4.1.2), and the buyer is eligible (section 5.8).
  - A change_requests[] baseline names an agreed line item at the version of its
    acceptance entry (section 4.4). A cancellation's cancelled_share is within the max_share of
    the range holding its effective date, or the top-level one, and an option's
    dated_shares[] windows don't overlap (section 5.6.6).
  - An Interval's end is later than its start (section 2.2), and an Integer row that
    opens with a list holds a value on it (section 2.6).
  - A core metric's level has the kind its row states, and counted_by equals the
    party sections 5.6.4 and 5.7.1 name, under the Measurer comparison.
  - pricing_id is unique, and two entries don't share a cost method, cost parameters,
    a currency, and a mechanism (section 5.6).
  - A tentative event is outside included[] and priced only by delta_flat (section
    5.2.9), an embedded line item follows section 5.9, deal_origin is on a deal line
    item only, and a deal reference names deal_origin.
  - A proposal holds line_items[] or packages[], ids are unique across it, and a
    package's min_commitments[] name its own line_items[] (section 4.1.4).
  - An availability figure is forecast under non_guaranteed, a hold ends within the
    section 4.3.4 cap, and a venue_type holds one id.
  - Each yaml block in the body of the specification holds keys and types its tables
    list.

Run with --regen-manifest to rewrite examples/manifest.json from the full examples.

Run: python3 scripts/check_examples.py
"""
import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from zoneinfo import ZoneInfo, available_timezones

import yaml

ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / "spec" / "openproposal-3.0.md"
EXAMPLES = ROOT / "examples"

# What the specification states, read by Spec.
# Object types whose extra keys are allowed (section 2.5).
OPEN_TYPES = set()
# A named type that holds the keys of another.
COMPOSES = {}
# Named types that hold the keys of a Selectable[T], with their T (section 2.6).
SELECTABLE_HOLDERS = {}
# Types whose lead-in says they hold exactly one key.
ONE_KEY_TYPES = set()
# Selectable fields that give an empty set a meaning (section 3.1).
EMPTY_ALLOWED = set()
# Selectable fields with exactly one option in effect.
EXACTLY_ONE = set()
# The closed lists of section 2.2, and of each type a lead-in or section 5.2.1 names.
CLOSED = {}
# Fields absent when embedded.
EMBEDDED_ABSENT = []
# The mechanism table of section 5.9.
MECHANISMS = {}
# The cost table of section 5.6.5, as cost_method -> rate per, and -> unit terms.
RATE_PER = {}
COST_UNIT = {}
# The core metric table of section 5.7.1, as term -> Rate or Count.
METRIC_KIND = {}
# The exclusion type table of section 5.5, as term -> entry type.
EXCLUSION_ENTRY = {}
# The methods delta_cpm applies to (section 3.1), and the units they count.
IMPRESSION_METHODS = set()
IMPRESSION_UNITS = set()
RATE_UNIT_SECONDS = {"hour": 3600, "day": 86400, "week": 604800}


def _options(item):
    options = (item.get("transaction_mechanism") or {}).get("available", [])
    return [o for o in options if isinstance(o, dict)]


def _mechanisms(item):
    return {o.get("id") for o in _options(item)}


def _is_deal(mechanisms):
    return any(MECHANISMS.get(m, {}).get("deal") for m in mechanisms)


def _counts_impressions(item):
    # Section 5.6.4: any count on the line item is in impressions.
    if any(p.get("cost_method") in IMPRESSION_METHODS for p in item.get("pricing", [])):
        return True
    if any(m.get("metric") == "impressions" for m in item.get("committed_metrics", [])):
        return True
    if (item.get("availability") or {}).get("unit") in IMPRESSION_UNITS:
        return True
    return False


def _audiences_can_combine(audiences):
    """Whether more than one seller audience can be in effect (section 5.3)."""
    options = audiences.get("available", [])
    return len(options) > 1 and audiences.get("max_select", len(options)) > 1


def _cost_method(parameters, item):
    """The cost_method of the pricing[] entry that holds these cost_parameters."""
    for entry in item.get("pricing", []):
        if entry.get("cost_parameters") is parameters:
            return entry.get("cost_method")
    return None


def _has_sync_groups(item):
    options = (item.get("properties") or {}).get("available", [])
    return any("sync_groups" in o for o in options)


def line_items_of(doc):
    """Every line item of a proposal: its line_items[], or each package's line_items[] and add_ons[]."""
    if "packages" in (doc or {}):
        return [i for p in doc["packages"] for i in p.get("line_items", []) + p.get("add_ons", [])]
    return (doc or {}).get("line_items", [])


def instant(value):
    """An Instant as a datetime, or None when it isn't one (the type check reports that)."""
    if isinstance(value, str) and INSTANT.match(value):
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    return None


def _has_order_reference(entry, proposal):
    """Whether the line item a change_requests[] entry names has an order id."""
    named = (entry.get("baseline") or {}).get("line_item_id")
    for item in line_items_of(proposal):
        if item.get("line_item_id") == named:
            refs = item.get("external_references", [])
            return any(r.get("reference_type") == "order" for r in refs)
    return False


# Each `REQUIRED when <condition>` wording, as (object, line item, proposal) -> bool.


def _committed_entry(item):
    """The pricing[] entry the line item's commitment is under, if any."""
    commitment, entries = item.get("commitment"), item.get("pricing") or []
    if not commitment:
        return None
    named = commitment.get("pricing_id")
    if named is None:
        return entries[0] if len(entries) == 1 else None
    return next((e for e in entries if e.get("pricing_id") == named), None)


CONDITIONS = {
    # No example holds an ErrorObject, so this one is never asked.
    "the request names a proposal the requester may read": lambda o, i, p: False,
    # Every VersionRef in the examples sits inside its proposal.
    "the `VersionRef` is outside its proposal": lambda o, i, p: False,
    "`role` is `decline`": lambda o, i, p: o.get("role") == "decline",
    "`packages[]` is absent": lambda o, i, p: "packages" not in o,
    "`line_items[]` is absent": lambda o, i, p: "line_items" not in o,
    "the full form holds `line_items[]`": lambda o, i, p: "packages" not in o,
    "the full form holds `packages[]`": lambda o, i, p: "line_items" not in o,
    # No example holds a CommitResult. A ground of availability is the one sign of it.
    "`entries[]` holds a `decline` for lack of availability":
        lambda o, i, p: any(e.get("role") == "decline" and e.get("ground") == "availability"
                            for e in o.get("entries", [])),
    "`type` is `custom`": lambda o, i, p: o.get("type") == "custom",
    "`type` is `custom` or `assent[]` is present":
        lambda o, i, p: o.get("type") == "custom" or "assent" in o,
    "`invoice_period` is `cycle`": lambda o, i, p: o.get("invoice_period") == "cycle",
    "the current `version` is frozen (§ 4.1.3)": lambda o, i, p: o.get("status") != "draft",
    "`channel` is `dooh`": lambda o, i, p: i.get("channel") == "dooh",
    "`channel` is `audio`": lambda o, i, p: i.get("channel") == "audio",
    "`channel` is `video`": lambda o, i, p: i.get("channel") == "video",
    "`placement.feed` is Podcast (3) or Catch-up radio (4)":
        lambda o, i, p: (i.get("placement") or {}).get("feed") in (3, 4),
    "the proposal has left `draft` and `formats` is present":
        lambda o, i, p: "formats" in i and (p or i).get("status") != "draft",
    "`daypart` or `frequency_cap` is present":
        lambda o, i, p: "daypart" in i or "frequency_cap" in i,
    "`channel` is `video` or `audio`": lambda o, i, p: i.get("channel") in ("video", "audio"),
    "`serving_mode` is `embedded` or the line item has `committed_metrics[]`, `commitment_bounds.spend`, or a `pricing[].unit_bounds`":
        lambda o, i, p: i.get("serving_mode") == "embedded"
        or "committed_metrics" in i or "spend" in (i.get("commitment_bounds") or {})
        or any("unit_bounds" in e for e in i.get("pricing", [])),
    "`serving_mode` is `embedded`": lambda o, i, p: i.get("serving_mode") == "embedded",
    "an option's `delivery_type` is `share_of_voice`":
        lambda o, i, p: any(x.get("delivery_type") == "share_of_voice" for x in _options(i)),
    "this is the committed entry": lambda o, i, p: _committed_entry(i) is o,
    "`sov_basis` is `impressions`": lambda o, i, p: i.get("sov_basis") == "impressions",
    "the line item offers a deal mechanism": lambda o, i, p: _is_deal(_mechanisms(i)),
    "the entry prices a deal mechanism":
        lambda o, i, p: _is_deal(o.get("transaction_mechanisms") or _mechanisms(i)),
    "`role` is `commitment`": lambda o, i, p: o.get("role") == "commitment",
    "`status` is `held`": lambda o, i, p: o.get("status") == "held",
    "the line item has an `order` reference (§ 5.10)":
        lambda o, i, p: _has_order_reference(o, p),
    "`cost_method` is an extension term": lambda o, i, p: ":" in str(o.get("cost_method")),
    "the term requires keys":
        lambda o, i, p: o.get("cost_method") in ("CPMV", "CPV", "CPP", "CPA", "TIME"),
    "`pricing[]` has more than one entry": lambda o, i, p: len(i.get("pricing", [])) > 1,
    "`calculation` is `cancelled` or `commitment`":
        lambda o, i, p: o.get("calculation") in ("cancelled", "commitment"),
    "`calculation` is `fixed`": lambda o, i, p: o.get("calculation") == "fixed",
    "`at` is absent": lambda o, i, p: "at" not in o,
    "`requested_value` is present": lambda o, i, p: "requested_value" in o,
    "the entry's `action` is `requested`":
        lambda o, i, p: any(e.get("action") == "requested" and any(x is o for x in e.get("paths", []))
                            for e in (p or {}).get("negotiation_history", [])),
    "`before_start` is absent": lambda o, i, p: "before_start" not in o,
    "`url` is absent": lambda o, i, p: "url" not in o,
    "`markup` is absent": lambda o, i, p: "markup" not in o,
    "`scope` is `category`": lambda o, i, p: o.get("scope") == "category",
    "the line item counts impressions": lambda o, i, p: _counts_impressions(i),
    "`source_type` is not Publisher Provided (`2`)": lambda o, i, p: o.get("source_type") != 2,
    "a property has `sync_groups[]`": lambda o, i, p: _has_sync_groups(i),
    "`apps[]` is absent": lambda o, i, p: "apps" not in o,
    "`domains[]` is absent": lambda o, i, p: "domains" not in o,
    "`seller_relationship` is `reseller`, or the line item offers a deal mechanism (§ 5.9)":
        lambda o, i, p: o.get("seller_relationship") == "reseller" or _is_deal(_mechanisms(i)),
    "`child_audience` is `mixed`": lambda o, i, p: o.get("child_audience") == "mixed",
    "more than one seller audience can be in effect": lambda o, i, p: _audiences_can_combine(o),
    "`channel` is `dooh` and `allocation` is `all`":
        lambda o, i, p: i.get("channel") == "dooh" and o.get("allocation", "all") == "all",
    "`cost_method` is `CPMV`": lambda o, i, p: _cost_method(o, i) == "CPMV",
    "`cost_method` is `CPV` and `view_fraction` is absent":
        lambda o, i, p: _cost_method(o, i) == "CPV" and "view_fraction" not in o,
    "`cost_method` is `CPV` and `view_s` is absent":
        lambda o, i, p: _cost_method(o, i) == "CPV" and "view_s" not in o,
    "`cost_method` is `CPP`": lambda o, i, p: _cost_method(o, i) == "CPP",
    "`cost_method` is `CPA`": lambda o, i, p: _cost_method(o, i) == "CPA",
    "`cost_method` is `TIME`": lambda o, i, p: _cost_method(o, i) == "TIME",
}

BASE = {"String", "Integer", "Number", "Boolean", "Enum", "Object"}
# T is a parameter. ExclusionList has its definition in prose.
GENERIC = {"Array", "Map", "Range", "Selectable", "Settable", "SettableRange", "T",
           "ExclusionList"}
# Types that a path list defines, read from section 2.1 and section 3.4. A key table
# beside the list adds keys, so it doesn't close the type.
PATH_LISTS = set()
INSTANT = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\Z")
# The RFC 3339 Appendix A grammar without its week form: section 2.2 writes P14D, never P2W.
_DUR_TIME = r"T(?:\d+H(?:\d+M(?:\d+S)?)?|\d+M(?:\d+S)?|\d+S)"
_DUR_DATE = r"(?:\d+Y(?:\d+M(?:\d+D)?)?|\d+M(?:\d+D)?|\d+D)"
DURATION = re.compile(rf"P(?:{_DUR_DATE}(?:{_DUR_TIME})?|{_DUR_TIME})\Z")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
DOMAIN = re.compile(r"[a-z0-9-]+(\.[a-z0-9-]+)+\Z")
# The VocabularyTerm form of section 2.2: a bare term, or a domain and a term.
TERM_PART = r"[A-Za-z0-9_-]+"
TERM_DOMAIN = r"[a-z0-9-]+(?:\.[a-z0-9-]+)+:"
TERM = re.compile(rf"(?:{TERM_DOMAIN})?{TERM_PART}\Z")
# ISO 3166-1 alpha-2, ISO 3166-2, or an extension term.
GEO_CODE = re.compile(rf"(?:[A-Z]{{2}}(?:-[A-Z0-9]{{1,3}})?|{TERM_DOMAIN}{TERM_PART})\Z")


def _is_zone(value):
    """Whether a value names a zone in the IANA time zone database."""
    try:
        ZoneInfo(value)
    except (KeyError, ValueError, OSError, TypeError):
        return False
    return True


SCALARS = {
    "Instant": (lambda v: isinstance(v, str) and INSTANT.match(v)),
    "Duration": (lambda v: isinstance(v, str) and DURATION.match(v)),
    "Digest": (lambda v: isinstance(v, str) and DIGEST.match(v)),
    "Domain": (lambda v: isinstance(v, str) and DOMAIN.match(v)),
    "RegistrableDomain": (lambda v: isinstance(v, str) and DOMAIN.match(v)),
    "Measurer": (lambda v: v in CLOSED["Side"] or (isinstance(v, str) and DOMAIN.match(v))),
    "VocabularyTerm": (lambda v: isinstance(v, str) and TERM.match(v)),
    "MediaChannel": (lambda v: isinstance(v, str) and TERM.match(v)),
    "ExclusionType": (lambda v: isinstance(v, str) and TERM.match(v)),
    "String": (lambda v: isinstance(v, str)),
    "Url": (lambda v: isinstance(v, str) and v.startswith(("http://", "https://"))),
    "HttpsUrl": (lambda v: isinstance(v, str) and v.startswith("https://")),
    "CurrencyCode": (lambda v: isinstance(v, str) and re.fullmatch(r"[A-Z]{3}", v)),
    "ClockTime": (lambda v: isinstance(v, str) and re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00", v)),
    "FormatId": (lambda v: isinstance(v, str) and re.fullmatch(r"[^/@]+/[^/@]+", v)),
    "Integer": (lambda v: (isinstance(v, int) and not isinstance(v, bool))
                or (isinstance(v, float) and v.is_integer())),  # JSON's integer: JCS writes 3.0 as 3
    "Number": (lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)),
    "Amount": (lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)),
    "Boolean": (lambda v: isinstance(v, bool)),
    "Fraction": (lambda v: isinstance(v, (int, float)) and 0 <= v <= 1),
    "FractionDelta": (lambda v: isinstance(v, (int, float)) and v > -1),
    "GeoCode": (lambda v: isinstance(v, str) and GEO_CODE.match(v)),
    "CalendarUnit": (lambda v: v in CLOSED["CalendarUnit"]),
    "TimeUnit": (lambda v: v in CLOSED["TimeUnit"]),
    "ZoneName": (lambda v: v in CLOSED["ZoneName"] or _is_zone(v)),
    "IanaZone": _is_zone,
    "Side": (lambda v: v in CLOSED["Side"]),
    "ProposalStatus": (lambda v: v in CLOSED["ProposalStatus"]),
    "LineItemStatus": (lambda v: v in CLOSED["LineItemStatus"]),
    "ApprovalStatus": (lambda v: v in CLOSED["ApprovalStatus"]),
    "TransactionMechanism": (lambda v: v in MECHANISMS),
    "EntryRef": (lambda v: isinstance(v, str) and re.fullmatch(r"[^/@]+/[^/@]+/[^/@]+@[^/@]+", v)
                 and DOMAIN.match(v.split("/")[0])),
    "FieldPointer": (lambda v: isinstance(v, str) and (v == "" or v.startswith("/"))),
    "Ext": (lambda v: isinstance(v, dict) and all(
        isinstance(k, str) and DOMAIN.match(k) and isinstance(item, dict)
        for k, item in v.items()
    )),
}


class StrictLoader(yaml.SafeLoader):
    """Read the YAML 1.2 core schema (section 4.1.1), and reject duplicate keys.

    PyYAML reads YAML 1.1, where `no` is false and `1:30` is a number. Section 4.1.1
    names the core schema, so those stay strings here, and a date stays a string for
    its Type to reject. Hexadecimal, octal, and .inf also stay strings: JSON has no
    number for them, so no Type accepts them.
    """


def _strict_map(loader, node):
    out = {}
    for k_node, v_node in node.value:
        key = loader.construct_object(k_node, deep=True)
        if key in out:
            raise yaml.YAMLError(f"duplicate key {key!r} at line {k_node.start_mark.line + 1}")
        out[key] = loader.construct_object(v_node, deep=True)
    return out


StrictLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _strict_map)
CORE_SCHEMA = [
    ("tag:yaml.org,2002:null", re.compile(r"(?:null|Null|NULL|~|)\Z")),
    ("tag:yaml.org,2002:bool", re.compile(r"(?:true|True|TRUE|false|False|FALSE)\Z")),
    ("tag:yaml.org,2002:int", re.compile(r"[-+]?[0-9]+\Z")),
    ("tag:yaml.org,2002:float", re.compile(
        r"[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?\Z")),
]
StrictLoader.yaml_implicit_resolvers = {
    k: [(tag, rx) for tag, rx in v if not tag.endswith((":bool", ":float", ":int", ":null", ":timestamp"))]
    for k, v in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
for _tag, _rx in CORE_SCHEMA:
    for _first in "-+0123456789.nNtTfF~":
        StrictLoader.yaml_implicit_resolvers.setdefault(_first, []).append((_tag, _rx))
StrictLoader.yaml_implicit_resolvers.setdefault("", []).append(CORE_SCHEMA[0])


def _core_number(loader, node):
    """A Number whose serialization reproduces the value written (section 4.1.1)."""
    value = float(node.value)
    if node.tag.endswith(":int") and abs(value) < 2 ** 53:
        value = int(node.value)
    if Decimal(node.value) != Decimal(repr(value)):
        raise yaml.YAMLError(f"{node.value} at line {node.start_mark.line + 1} does not survive RFC 8785")
    return value


StrictLoader.add_constructor("tag:yaml.org,2002:int", _core_number)
StrictLoader.add_constructor("tag:yaml.org,2002:float", _core_number)


def load_yaml(path):
    return yaml.load(path.read_text(), Loader=StrictLoader)


def load_json(path):
    def pairs(items):
        keys = [k for k, _ in items]
        if len(keys) != len(set(keys)):
            raise ValueError(f"duplicate key in {path.name}")
        return dict(items)

    return json.loads(path.read_text(), object_pairs_hook=pairs)


# Spec reading --------------------------------------------------------------


def cells(line):
    body = line.strip()
    if not (body.startswith("|") and body.endswith("|")):
        return None
    return [p.strip() for p in re.split(r"(?<!\\)\|", body[1:-1])]


def clean_key(cell):
    return cell.strip("`")


def enum_values(typ, meaning):
    """The closed values a row states, written first in its Meaning cell (section 2.6).

    An Integer row is a closed list only when it opens with two values or more, so a
    Meaning cell that starts with one backticked name stays a plain integer.
    """
    if typ not in ("Enum", "Integer"):
        return None
    m = re.match(r"`[^`]+`(?: \([^)]*\))?(?: \\\| `[^`]+`(?: \([^)]*\))?)*", meaning)
    if not m:
        return None
    values = re.findall(r"`([^`]+)`", re.sub(r"\([^)]*\)", "", m.group(0)))
    if typ == "Enum":
        return values
    return [int(v) for v in values] if len(values) > 1 else None


def core_terms(meaning):
    """The core terms a VocabularyTerm row lists, or None where it lists none here.

    A row can run prose after its list, so this also holds other backticked names. It
    only ever passes a term it should have refused, and never refuses a core term.
    """
    m = re.search(r"[Cc]ore terms?\b:?\s*(.*)$", meaning)
    if not m or m.group(1).startswith(("in §", "in [")):
        return None
    return set(re.findall(r"`([^`]+)`", m.group(1)))


class Spec:
    def __init__(self):
        self.lines = SPEC.read_text().splitlines()
        self.proposal, self.line_item = {}, {}
        self.tables = {}
        self.composed_markers = {}
        self.summary_paths, self.proposal_paths = [], []
        self.removal = []
        self.write_paths = []
        self.yaml_blocks = []
        self._read_fields()
        self._read_key_tables()
        self._read_lists()
        self._read_shared_types()
        self._read_mechanisms()
        self._read_cost_methods()
        self._read_metrics()
        self._read_exclusion_types()
        self._read_channels()
        self._read_rules()
        self._follow_term_references()

    def _follow_term_references(self):
        """A row that is "the same kind of term as `a.b`" takes the core terms of that row."""
        for table in list(self.tables.values()):
            for row in table.values():
                m = re.search(r"[Tt]he same kind of term as `([^`]+)`", row["description"])
                if not m or row["core"] is not None:
                    continue
                head, *rest = m.group(1).split(".")
                found = [r for t in self.tables.values() for k, r in t.items() if k == head]
                target = found[0] if found else None
                for key in rest:
                    target = self.tables.get(target["type"], {}).get(key) if target else None
                if target is None:
                    raise SystemExit(f"spec: `{m.group(1)}` names no row")
                row["core"] = target["core"]

    def _read_fields(self):
        target, in_table = None, False
        for line in self.lines:
            if line.startswith("## Appendix"):
                break
            m = re.match(r"^#{2,4} (\d+)\.", line)
            if m:
                target = {"4": self.proposal, "5": self.line_item}.get(m.group(1))
                in_table = False
                continue
            c = cells(line)
            if not c:
                in_table = False
            elif c[0] == "Field":
                in_table = True
            elif in_table and target is not None and len(c) == 5 and c[0].startswith("`"):
                target[clean_key(c[0])] = {
                    "type": c[1], "required": c[2], "marker": c[3], "description": c[4],
                    "values": enum_values(c[1], c[4]), "core": core_terms(c[4]),
                }
        # A pricing[] entry's keys are field rows, and a line item has its own table.
        self.tables["PricingEntry"] = {
            k[len("pricing[]."):]: r for k, r in self.line_item.items() if k.startswith("pricing[].")
        }
        self.tables["LineItem"] = {k: r for k, r in self.line_item.items() if "[]." not in k}

    def selectable_of(self, typ):
        """The (T, added key rows) of a Selectable[T] or a type that holds its keys, or None."""
        base, args = split_generic(typ)
        if base == "Selectable":
            return args[0], {}
        if base in SELECTABLE_HOLDERS:
            return SELECTABLE_HOLDERS[base], self.tables[base]
        return None

    def mixed_keys(self, typ):
        """The key rows of a mixed field, each with the marker its table or lead-in states."""
        base, args = split_generic(typ)
        name = args[0] if base == "Array" else typ
        rows = {k: r for k, r in self.tables.get(name, {}).items() if "marker" in r}
        other, marker = self.composed_markers.get(name, (None, None))
        rows.update({k: {**r, "marker": marker} for k, r in self.tables.get(other, {}).items()})
        return rows

    def write_paths_of(self, field):
        """The BuyerWrites paths under one field, without the field's name."""
        named = [p for p in self.write_paths if p == field or p.startswith(f"{field}.")]
        row = self.line_item.get(field) or {}
        if row.get("marker") == "selectable":
            named.append("<selectable>.selected[]")
        elif row.get("marker") == "settable" and not named:
            named.append("<settable>.value")
        return {p.partition(".")[2].removesuffix("[]") for p in named}

    def _read_shared_types(self):
        """The closed lists of the section 2.2 table, and of each type named outside it."""
        start = self.lines.index("| Type | Form | Rules |")
        for line in self.lines[start + 2:]:
            c = cells(line)
            if not c:
                break
            name, form = clean_key(c[0]), c[1]
            adds = re.match(r"An? `([^`]+)`, or (.*)", form)
            if adds:
                # A Form that adds to a type: A `T`, or `b` (section 2.6). Only literals count.
                added = re.findall(r"`([^`]+)`", adds.group(2))
                CLOSED[name] = CLOSED.get(adds.group(1), []) + [v for v in added if not v[0].isupper()]
            elif "\\|" in form:
                # A list of integers holds integers, such as IntegerFlag.
                CLOSED[name] = [int(v) if v.isdigit() else v for v in re.findall(r"`([^`]+)`", form)]
        text = "\n".join(self.lines)
        for name, form in re.findall(r"^\*\*`(\w+)`\*\* is ((?:`[^`]+`\s*\\\|\s*)+`[^`]+`)", text, re.M):
            CLOSED[name] = re.findall(r"`([^`]+)`", form)
        start = self.lines.index("| `environments` | Distribution channel | Device types |")
        CLOSED["Environment"] = []
        for line in self.lines[start + 2:]:
            c = cells(line)
            if not c:
                break
            CLOSED["Environment"].append(clean_key(c[0]))
        for name, values in CLOSED.items():
            SCALARS.setdefault(name, lambda v, values=values: v in values and not isinstance(v, bool))

    def _read_rules(self):
        """What the prose states about types and fields, read rather than repeated."""
        text = "\n".join(self.lines)
        m = re.search(r"open objects (.*?)\)\.", text, re.S)
        OPEN_TYPES.update(re.findall(r"`([^`]+)`", m.group(1)))
        for name, other in re.findall(r"^\*\*`(\w+)`\*\* holds the keys of `([^`]+)`", text, re.M):
            base, args = split_generic(other)
            if base == "Selectable":
                SELECTABLE_HOLDERS[name] = args[0]
            elif base not in GENERIC:
                COMPOSES[name] = [other]
        for name, other, marker in re.findall(r"^\*\*`(\w+)`\*\* holds the keys of `([^`]+)`, each `([^`]+)`", text, re.M):
            self.composed_markers[name] = (other, marker)
        ONE_KEY_TYPES.update(re.findall(r"^\*\*`(\w+)`\*\* holds exactly one key", text, re.M))
        m = re.search(r"^- ((?:`\w+`,? (?:and )?)+)MUST be absent", text, re.M)
        EMBEDDED_ABSENT.extend(re.findall(r"`(\w+)`", m.group(1)))
        IMPRESSION_METHODS.update(re.findall(r"`([A-Z]+)`", self.tables["Delta"]["delta_cpm"]["description"]))
        IMPRESSION_UNITS.update(t for method in IMPRESSION_METHODS for t in COST_UNIT[method])
        rows = list(self.line_item.items()) + [
            (k, r) for table in self.tables.values() for k, r in table.items()
        ]
        for key, row in rows:
            name = key.removesuffix("[]")
            if row.get("description") and "MUST name exactly one option" in row["description"]:
                EXACTLY_ONE.add(name)
            if self.selectable_of(row["type"]) and re.search(r"[Nn]othing in effect", row.get("description", "")):
                EMPTY_ALLOWED.add(name)
        # Section 5.3 states this one in its numbered conditions, not in the row.
        EMPTY_ALLOWED.add("audiences")
        body = text.split("\n## 6. Examples")[0]
        self.yaml_blocks = re.findall(r"^```yaml\n(.*?)^```", body, re.S | re.M)

    def _read_channels(self):
        """The section 5.1.1 table: the core terms of MediaChannel."""
        start = self.lines.index("| `channel` | Condition |")
        terms = set()
        for line in self.lines[start + 2:]:
            c = cells(line)
            if not c:
                break
            terms.add(clean_key(c[0]))
        self.line_item["channel"]["core"] = terms

    def _read_mechanisms(self):
        """The section 5.9 table: deal or not, and the allowed delivery types."""
        start = self.lines.index(
            "| `transaction_mechanism` | Deal mechanism | `delivery_type` |")
        for line in self.lines[start + 2:]:
            c = cells(line)
            if not c:
                break
            MECHANISMS[clean_key(c[0])] = {
                "deal": c[1] == "Yes",
                "delivery": None if c[2] == "Any" else re.findall(r"`([^`]+)`", c[2]),
            }

    def _read_cost_methods(self):
        """The section 5.6.5 table: the rate per of each core cost_method."""
        start = self.lines.index("| `cost_method` | `unit` | One unit | Rate per | `cost_parameters` |")
        for line in self.lines[start + 2:]:
            c = cells(line)
            if not c:
                break
            RATE_PER[clean_key(c[0])] = int(c[3].replace(",", "")) if c[3] else None
            COST_UNIT[clean_key(c[0])] = re.findall(r"`([^`]+)`", c[1].split(", by")[0])
        units = {t for terms in COST_UNIT.values() for t in terms}
        self.tables["PricingEntry"]["cost_method"]["core"] = set(RATE_PER)
        self.tables["Availability"]["unit"]["core"] |= units
        self.tables["AddressableScale"]["unit"]["core"] |= self.tables["FrequencyCap"]["per"]["core"]

    def _read_metrics(self):
        """The section 5.7.1 table: whether each core metric is a rate or a count."""
        start = self.lines.index("| `metric` | Kind | Usual `direction` | Definition |")
        for line in self.lines[start + 2:]:
            c = cells(line)
            if not c:
                break
            METRIC_KIND[clean_key(c[0])] = c[1]
        self.tables["CommittedMetric"]["metric"]["core"] = set(METRIC_KIND)
        units = {t for terms in COST_UNIT.values() for t in terms}
        rates = {m for m, kind in METRIC_KIND.items() if kind == "Rate"}
        self.tables["ReportingOption"]["provided_metrics[]"]["core"] = units | rates

    def _read_exclusion_types(self):
        """The section 5.5 table: the entry type of each core exclusion type."""
        start = self.lines.index("| `exclusions` | Entry | Meaning |")
        for line in self.lines[start + 2:]:
            c = cells(line)
            if not c:
                break
            EXCLUSION_ENTRY[clean_key(c[0])] = clean_key(c[1])

    def _read_key_tables(self):
        current = None
        for i, line in enumerate(self.lines):
            if line.startswith("## Appendix"):
                break
            m = re.match(r"^\*\*`([A-Z][A-Za-z]+)`", line)
            if m:
                current = m.group(1)
                continue
            c = cells(line)
            if c and c[:2] == ["Key", "Type"]:
                if current:
                    self.tables.setdefault(current, {})
                    rows = self.tables[current]
                    j = i + 2
                    while j < len(self.lines) and self.lines[j].startswith("|"):
                        r = cells(self.lines[j])
                        rows[clean_key(r[0])] = {
                            "type": r[1], "required": r[2], "description": r[3],
                            "values": enum_values(r[1], r[3]), "core": core_terms(r[3]),
                        }
                        if c[-1] == "Mutability":
                            rows[clean_key(r[0])]["marker"] = r[4]
                        j += 1
                current = None

    def _read_lists(self):
        text = "\n".join(self.lines)
        m = re.search(r"(?:\*\*)?`LineItemSummary`(?:\*\*)? lists these paths[^\n]*\n\n```text\n(.*?)```", text, re.S)
        self.summary_paths = m.group(1).split()
        m = re.search(r"`ProposalSummary` lists these paths.*?```text\n(.*?)```", text, re.S)
        self.proposal_paths = m.group(1).split()
        PATH_LISTS.update(re.findall(r"^(?:\*\*)?`(\w+)`(?:\*\*)? lists these paths", text, re.M))
        m = re.search(r"`BuyerWrites` lists these paths.*?```text\n(.*?)```", text, re.S)
        self.write_paths = m.group(1).split()
        m = re.search(r"#### 4\.1\.1.*?```\n(.*?)```", text, re.S)
        self.removal = [l for l in m.group(1).splitlines() if l.startswith("$")]


# Type walking --------------------------------------------------------------


def split_generic(typ):
    m = re.fullmatch(r"([A-Za-z]+)\[(.*)\]", typ)
    if not m:
        return typ, []
    args, depth, cur = [], 0, ""
    for ch in m.group(2):
        if ch == "," and depth == 0:
            args.append(cur.strip())
            cur = ""
            continue
        depth += ch == "["
        depth -= ch == "]"
        cur += ch
    args.append(cur.strip())
    return m.group(1), args


class Checker:
    def __init__(self, spec):
        self.spec = spec
        self.errors = []
        self.item, self.proposal = {}, None
        self.entry_specs = {}

    def err(self, file, path, msg):
        self.errors.append(f"{file}: {path}: {msg}")

    def required(self, file, path, cell, obj):
        """Return whether a Required cell makes its key required on obj."""
        if cell == "REQUIRED":
            return True
        if not cell.startswith("REQUIRED when "):
            return False
        condition = cell[len("REQUIRED when "):]
        if condition not in CONDITIONS:
            self.errors.append(f"{file}: {path}: no CONDITIONS entry for: {condition}")
            return False
        return CONDITIONS[condition](obj, self.item, self.proposal)

    def check_type(self, file, path, value, typ):
        base, args = split_generic(typ)
        if base == "Array":
            if not isinstance(value, list):
                self.err(file, path, f"expected an array, found {type(value).__name__}")
                return
            for i, item in enumerate(value):
                self.check_type(file, f"{path}[{i}]", item, args[0])
            return
        if base == "Map":
            if not isinstance(value, dict):
                self.err(file, path, f"expected a map, found {type(value).__name__}")
                return
            for k, item in value.items():
                if args[0] in SCALARS and not SCALARS[args[0]](k):
                    self.err(file, f"{path}.{k}", f"key {k!r} is not a {args[0]}")
                self.check_type(file, f"{path}.{k}", item, args[1])
            return
        if base == "ExclusionList":
            self.check_exclusion_list(file, path, value)
            return
        selectable = self.spec.selectable_of(typ)
        if selectable:
            self.check_selectable(file, path, value, *selectable)
            return
        if base == "Settable":
            self.check_settable(file, path, value, args[0])
            return
        if base == "SettableRange":
            self.check_settable_range(file, path, value, args[0])
            return
        if base == "Range":
            if not isinstance(value, dict) or not value.keys() <= {"min", "max"} or not value:
                self.err(file, path, "a Range holds min, max, or both")
                return
            for k, item in value.items():
                self.check_type(file, f"{path}.{k}", item, args[0])
            low, high = value.get("min"), value.get("max")
            if isinstance(low, (int, float)) and isinstance(high, (int, float)) and low > high:
                self.err(file, path, "min is greater than max")
            return
        if base in SCALARS:
            if not SCALARS[base](value):
                self.err(file, path, f"{value!r} is not a {base}")
            return
        if base == "Interval" and isinstance(value, dict):
            starts, ends = value.get("start"), value.get("end")
            if isinstance(starts, str) and isinstance(ends, str) and ends <= starts:
                self.err(file, path, "an Interval's end is not later than its start")
        if base in self.spec.tables:
            self.check_object(file, path, value, base)

    def check_table_cells(self):
        """Each Type cell names what section 2.6 allows, and each condition has a test."""
        def names(typ):
            base, args = split_generic(typ)
            return [base] + [n for arg in args for n in names(arg)]

        known = BASE | GENERIC | set(SCALARS) | set(self.spec.tables) | PATH_LISTS
        rows = [("proposal", self.spec.proposal), ("line item", self.spec.line_item), *self.spec.tables.items()]
        for owner, table in rows:
            for key, row in table.items():
                for name in names(row["type"]):
                    if name not in known:
                        self.err("spec", owner, f"the Type cell of {key} names {name}, which nothing defines")
                wording = row["required"].removeprefix("REQUIRED when ")
                if wording != row["required"] and wording not in CONDITIONS:
                    self.err("spec", owner, f"{key}: no CONDITIONS entry for: {wording}")

    def check_value_tables(self):
        """Section 2.6: a value table's first column equals the list it restates."""
        text = "\n".join(self.spec.lines)
        written = {
            "code": re.search(r"Core codes: (.*?)\.\n", text, re.S).group(1),
            "exclusions": re.search(r"\*\*`ExclusionType`\*\* is a `VocabularyTerm` \(§ 2\.2\)\. Core terms: (.*?)\.\n", text, re.S).group(1),
            "cost_method": re.search(r"Its core terms are (.*?)\. Terms are", text, re.S).group(1),
            "metric": re.search(r"its standard\. Core terms: (.*?)\.\n", text, re.S).group(1),
            "transaction_mechanism": re.search(r"\*\*`TransactionMechanism`\*\* is (.*?)\. A", text, re.S).group(1),
            "seller_relationship": self.spec.tables["PropertyOption"]["seller_relationship"]["description"].split(",")[0],
            "method": self.spec.tables["CreativeDelivery"]["method"]["description"].split(",")[0],
        }
        # These two tables are the list: their lead-ins say so.
        own = {"channel", "environments"}
        for n, line in enumerate(self.spec.lines):
            c = cells(line)
            if not c or not c[0].startswith("`") or n + 1 == len(self.spec.lines):
                continue
            if not re.match(r"^\|\s*:?-{3}", self.spec.lines[n + 1]):
                continue
            name = clean_key(c[0])
            rows = []
            for row in self.spec.lines[n + 2:]:
                r = cells(row)
                if not r:
                    break
                rows.append(clean_key(r[0]))
            if name in own:
                continue
            if name not in written:
                self.err("spec", f"line {n + 1}", f"value table {name} restates no list this check knows")
            elif set(rows) != set(re.findall(r"`([^`]+)`", written[name])):
                self.err("spec", f"line {n + 1}", f"value table {name} differs from the list it restates")
        unit_terms = re.search(r"The `unit` terms are (.*?)\.\n", text, re.S).group(1)
        if set(re.findall(r"`([^`]+)`", unit_terms)) != {t for terms in COST_UNIT.values() for t in terms}:
            self.err("spec", "section 5.6.5", "the unit column differs from the unit terms")

    def check_values(self, file, path, value, row):
        """A value on its row's closed list, or a bare term on its core list."""
        base, args = split_generic(row["type"])
        inner = args[0] if args else base
        selectable = self.spec.selectable_of(row["type"])
        if selectable:
            inner = selectable[0]
            items = value.get("available", []) if isinstance(value, dict) else []
        elif base == "Array":
            items = value if isinstance(value, list) else []
        else:
            items = [value]
        if "MUST be non-empty" in row.get("description", "") and items == []:
            self.err(file, path, "an array this row says MUST be non-empty is empty")
        for item in items:
            if row.get("values") and item not in row["values"]:
                self.err(file, path, f"{item!r} is not one of {row['values']}")
            if inner in ("VocabularyTerm", "MediaChannel", "ExclusionType") and row.get("core") is not None:
                if isinstance(item, str) and ":" not in item and item not in row["core"]:
                    self.err(file, path, f"{item!r} is neither a core term nor an extension term")

    def rows_of(self, name):
        rows = dict(self.spec.tables.get(name, {}))
        for extra in COMPOSES.get(name, []):
            rows.update(self.spec.tables.get(extra, {}))
        return rows

    def check_object(self, file, path, value, name):
        if not isinstance(value, dict):
            self.err(file, path, f"expected a {name}, found {type(value).__name__}")
            return
        rows = self.rows_of(name)
        known = {k.rstrip("[]") if k.endswith("[]") else k: r for k, r in rows.items()}
        holds_writes = "BuyerWrites" in COMPOSES.get(name, [])
        if name not in OPEN_TYPES and not PATH_LISTS & ({name} | set(COMPOSES.get(name, []))):
            for key in value:
                if key not in known:
                    self.err(file, path, f"key {key!r} is not in the {name} table")
        if holds_writes:
            self.check_buyer_writes(file, path, value, known)
        if "CommitmentAmount" in COMPOSES.get(name, []) and value.get("basis") == "units":
            if not SCALARS["Number"](value.get("amount")) or value["amount"] % 1:
                self.err(file, path, "an amount under basis units is a whole number")
        if name in ONE_KEY_TYPES and len(value) != 1:
            self.err(file, path, f"a {name} holds exactly one key")
        for key, row in known.items():
            if key not in value and self.required(file, path, row["required"], value):
                self.err(file, path, f"REQUIRED key {key!r} of {name} is missing")
            if key in value:
                self.check_type(file, f"{path}.{key}", value[key], row["type"])
                self.check_values(file, f"{path}.{key}", value[key], row)

    def check_buyer_writes(self, file, path, value, known):
        """Section 3.4: the keys of a BuyerWrites, and the options its choices name."""
        for key, write in value.items():
            if key in known:
                continue
            allowed = self.spec.write_paths_of(key)
            if not allowed:
                self.err(file, path, f"key {key!r} is not a BuyerWrites path")
            elif allowed != {""}:
                self.check_write_keys(file, f"{path}.{key}", write, allowed)
            declared = self.item.get(key) or {}
            self.check_write_names(file, f"{path}.{key}", write, declared)

    def check_write_keys(self, file, path, write, allowed):
        """Each key of a write is a listed path, or leads to one."""
        if not isinstance(write, dict):
            self.err(file, path, "expected the keys of a BuyerWrites path")
            return
        for key, value in write.items():
            if key in allowed:
                continue
            deeper = {a.partition(".")[2] for a in allowed if a.startswith(f"{key}.")}
            if deeper:
                self.check_write_keys(file, f"{path}.{key}", value, deeper)
            else:
                self.err(file, path, f"key {key!r} is not a BuyerWrites path")

    def check_write_names(self, file, path, write, declared):
        """A selected[] or excluded[] names options the field declares."""
        if not isinstance(write, dict) or not isinstance(declared, dict):
            return
        names = [o.get("id") if isinstance(o, dict) else o for o in declared.get("available", [])]
        for name in write.get("selected", []) + write.get("excluded", []):
            if name not in names:
                self.err(file, path, f"{name!r} names no option")
        if "combine" in write:
            self.check_write_names(file, f"{path}.combine", write["combine"], declared.get("combine"))

    def check_exclusion_list(self, file, path, value):
        """An array of the type's entries, or a DocumentRef (section 5.5)."""
        if isinstance(value, dict):
            self.check_object(file, path, value, "DocumentRef")
        elif not isinstance(value, list):
            self.err(file, path, "an ExclusionList is an array or a DocumentRef")
        else:
            entry = EXCLUSION_ENTRY.get(path.rsplit(".", 1)[-1])
            for i, item in enumerate(value):
                if entry:
                    self.check_type(file, f"{path}[{i}]", item, entry)

    def check_exclusions(self, file, path, item):
        """A buyer supplies only the types the seller accepts (section 5.5)."""
        accepted = (item.get("accepted_exclusions") or {}).get("types", {})
        for term in accepted:
            if ":" not in term and term not in EXCLUSION_ENTRY:
                self.err(file, f"{path}.accepted_exclusions", f"{term!r} is not a core exclusion type")
        for term, entries in (item.get("exclusions") or {}).items():
            if term not in accepted:
                self.err(file, f"{path}.exclusions", f"{term!r} is not an accepted exclusion type")
            elif isinstance(entries, list) and len(entries) > accepted[term].get("max_entries", len(entries)):
                self.err(file, f"{path}.exclusions", f"{term!r} holds more than max_entries")

    def check_formats(self, file, path, item):
        """Format ids, their format_specs entries, and spec_ref (section 5.4)."""
        specs = item.get("format_specs") or {}
        draft = (self.proposal or item).get("status") == "draft"
        for fid in (item.get("formats") or {}).get("available", []):
            if not fid.startswith(f"{item.get('channel')}/"):
                self.err(file, path, f"format id {fid!r} is not namespaced by channel")
            if fid not in specs and not draft:
                self.err(file, path, f"format id {fid!r} has no format_specs entry")
        core = re.search(r"what the buyer\s+supplies for the format\. Core terms: (.*?)\. A receiver",
                         "\n".join(self.spec.lines), re.S).group(1)
        core = set(re.findall(r"`([^`]+)`", core))
        voices = re.search(r"whether a synthesized\s+voice may read the ad\. Core terms: (.*?)\. A receiver",
                           "\n".join(self.spec.lines), re.S).group(1)
        voices = set(re.findall(r"`([^`]+)`", voices))
        for i, a in enumerate(item.get("assets") or []):
            spec = (specs.get(a.get("format_id")) or {}).get("spec") or {} if isinstance(a, dict) else {}
            if ((a.get("provenance") or {}).get("synthetic") is True) and spec.get("voice") == "human_only":
                self.err(file, f"{path}.assets[{i}]", "a synthetic asset doesn't conform to a spec whose voice is human_only")
        for fid, entry in specs.items():
            asset = (entry.get("spec") or {}).get("asset") if isinstance(entry, dict) else None
            if asset is not None and asset not in core and not re.fullmatch(rf"{TERM_DOMAIN}{TERM_PART}", str(asset)):
                self.err(file, path, f"{fid}: spec.asset {asset!r} is neither a core term nor an extension term")
            voice = (entry.get("spec") or {}).get("voice") if isinstance(entry, dict) else None
            if voice is not None and voice not in voices and not re.fullmatch(rf"{TERM_DOMAIN}{TERM_PART}", str(voice)):
                self.err(file, path, f"{fid}: spec.voice {voice!r} is neither a core term nor an extension term")
            ref = entry.get("spec_ref") if isinstance(entry, dict) else None
            if not ref:
                continue
            if self.entry_specs.setdefault(ref, entry.get("spec")) != entry.get("spec"):
                self.err(file, path, f"spec differs from another copy of {ref!r}")

    def check_audiences(self, file, path, value):
        """The keys AudienceSelectable adds to its Selectable (section 5.3)."""
        combine = value.get("combine") or {}
        if combine.get("deltas"):
            self.err(file, f"{path}.combine", "combine carries no deltas")
        options = {o.get("id"): o for o in value.get("available", []) if isinstance(o, dict)}
        in_effect = value.get("selected", value.get("included", []))
        meaning = self.spec.tables["AudienceOption"]["taxonomy"]["description"]
        codes = {int(n) for n in re.findall(r"`(\d+)`", meaning)}
        vendor_from = int(re.search(r"\((\d+) and up\)", meaning).group(1))
        for name, option in options.items():
            taxonomy = option.get("taxonomy")
            if isinstance(taxonomy, int) and taxonomy not in codes and taxonomy < vendor_from:
                self.err(file, f"{path}.available", f"{name!r} has taxonomy {taxonomy}, which section 5.3 does not allow")
        for name in value.get("excluded", []):
            if not options.get(name, {}).get("excludable"):
                self.err(file, f"{path}.excluded", f"{name!r} is not an excludable option")
            if name in in_effect:
                self.err(file, f"{path}.excluded", f"{name!r} is also in effect")

    def check_selectable(self, file, path, value, option_type, rows):
        if not isinstance(value, dict):
            self.err(file, path, "expected a Selectable")
            return
        if "available" not in value:
            self.err(file, path, "a Selectable holds available[]")
            return
        table = set(self.spec.tables["Selectable"])
        field = path.rsplit(".", 1)[-1]
        extra = {k.rstrip("[]"): row["type"] for k, row in rows.items()}
        known = {k.rstrip("[]") for k in table} | set(extra)
        for key, row in rows.items():
            if key.rstrip("[]") not in value and self.required(file, path, row["required"], value):
                self.err(file, path, f"REQUIRED key {key!r} is missing")
        for key in value:
            if key not in known:
                self.err(file, path, f"key {key!r} is not a Selectable key")
        for key, typ in extra.items():
            if key in value:
                self.check_type(file, f"{path}.{key}", value[key], typ)
        names = []
        for i, option in enumerate(value["available"]):
            if isinstance(option, dict):
                if "id" not in option:
                    self.err(file, f"{path}.available[{i}]", "an object option has an id")
                names.append(option.get("id"))
                if option_type in self.spec.tables:
                    self.check_object(file, f"{path}.available[{i}]", option, option_type)
            else:
                self.check_type(file, f"{path}.available[{i}]", option, option_type)
                names.append(str(option))
        if len(names) != len(set(names)):
            self.err(file, path, "option ids are not unique in the field")
        if "included" not in value:
            self.err(file, path, "REQUIRED key 'included' is missing")
        for name in value.get("included", []):
            if name not in names:
                self.err(file, f"{path}.included", f"{name!r} names no option")
        for name in value.get("selected", []):
            if name not in names:
                self.err(file, f"{path}.selected", f"{name!r} names no option")
        for name, delta in (value.get("deltas") or {}).items():
            if name not in names:
                self.err(file, f"{path}.deltas", f"{name!r} names no option")
            self.check_object(file, f"{path}.deltas.{name}", delta, "Delta")
            if not delta:
                self.err(file, f"{path}.deltas.{name}", "a Delta holds at least one key")
        in_effect = value.get("selected", value.get("included", []))
        if "max_select" in value and len(in_effect) > value["max_select"]:
            self.err(file, path, "more options in effect than max_select")
        if not in_effect and field not in EMPTY_ALLOWED:
            self.err(file, path, f"{field} gives an empty set no meaning")
        if field in EXACTLY_ONE:
            if value.get("max_select") != 1 or len(value.get("included", [])) != 1:
                self.err(file, path, f"{field} needs max_select 1 and one included option")

    def covers(self, field, outer, inner):
        """Whether an entry of a settable field covers another (sections 3.2, 5.5)."""
        if outer == inner:
            return True
        if field == "geo":
            return str(inner).startswith(f"{outer}-")
        if field == "device":
            return outer == 1 and inner in (4, 5)
        if field == "daypart":
            return (set(inner.get("days", [])) <= set(outer.get("days", []))
                    and outer.get("start", "") <= inner.get("start", "")
                    and inner.get("before", "") <= outer.get("before", ""))
        return False

    def check_narrowing(self, file, path, value, item_type, allowed):
        if not isinstance(value, dict) or not value.keys() <= {"include", "exclude"}:
            self.err(file, path, "a Narrowing holds include[] and exclude[]")
            return
        if "include" not in value:
            self.err(file, path, "REQUIRED key 'include' is missing")
        field = path.split(".")[-2]
        include, exclude = value.get("include", []), value.get("exclude", [])
        for key, within, entries in (("allowed", allowed, include), ("include", include, exclude)):
            for entry in entries:
                self.check_type(file, path, entry, item_type)
                if not any(self.covers(field, outer, entry) for outer in within):
                    self.err(file, path, f"{entry!r} is not covered by {key}")

    def check_settable(self, file, path, value, item_type):
        if not isinstance(value, dict) or not value.keys() <= {"allowed", "default", "value"}:
            self.err(file, path, "a Settable holds allowed[], default, and value")
            return
        for key in ("allowed", "default"):
            if key not in value:
                self.err(file, path, f"REQUIRED key {key!r} is missing")
        allowed = value.get("allowed", [])
        for i, entry in enumerate(allowed):
            self.check_type(file, f"{path}.allowed[{i}]", entry, item_type)
        for key in ("default", "value"):
            if key in value:
                self.check_narrowing(file, f"{path}.{key}", value[key], item_type, allowed)

    def check_settable_range(self, file, path, value, item_type):
        if not isinstance(value, dict) or not value.keys() <= {"min", "max", "default", "value"}:
            self.err(file, path, "a SettableRange holds min, max, default, and value")
            return
        if "min" not in value and "max" not in value:
            self.err(file, path, "a SettableRange holds at least one bound")
        if "default" not in value:
            self.err(file, path, "REQUIRED key 'default' is missing")
        for key in ("min", "max", "default", "value"):
            if key in value:
                self.check_type(file, f"{path}.{key}", value[key], item_type)
        if "min" in value and "max" in value and value["min"] > value["max"]:
            self.err(file, path, "min is greater than max")
        for key in ("default", "value"):
            if key in value and ((("min" in value) and value[key] < value["min"])
                                 or (("max" in value) and value[key] > value["max"])):
                self.err(file, f"{path}.{key}", f"{key} is outside the bounds")

    def check_agreed_rate(self, file, path, item):
        """Recompute agreed_rate on the committed entry (section 5.6)."""
        committed = _committed_entry(item)
        for entry in item.get("pricing") or []:
            if entry is not committed and "agreed_rate" in entry:
                self.err(file, path, "agreed_rate on an uncommitted entry")
        if committed is None or "agreed_rate" not in committed:
            return
        decimal = lambda n: Decimal(str(n))
        cpm, factor = Decimal(0), Decimal(1)
        for value in item.values():
            if not isinstance(value, dict) or "available" not in value:
                continue
            included = value.get("included", [])
            names = [n for n in value.get("selected", included) if n not in included]
            names += value.get("excluded", [])
            for name in names:
                delta = (value.get("deltas") or {}).get(name, {})
                if committed.get("cost_method") in IMPRESSION_METHODS:
                    cpm += decimal(delta.get("delta_cpm", 0))
                elif set(delta) == {"delta_cpm"}:
                    self.err(file, path, "an option priced only by delta_cpm on this entry")
                factor *= 1 + decimal(delta.get("delta_fraction", 0))
        rate = (decimal(committed["list_rate"]) + cpm) * factor
        rate = rate.quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)
        if rate != decimal(committed["agreed_rate"]):
            self.err(file, path, f"agreed_rate recomputes to {rate}")

    def check_cost_presence(self, file, path, item):
        """Section 5.6.5: cost_parameters keys that apply under one rate unit or cost method."""
        base = "" if path in ("", "(root)") else f"{path}."
        for i, entry in enumerate(item.get("pricing") or []):
            params = entry.get("cost_parameters") if isinstance(entry, dict) else None
            if not isinstance(params, dict):
                continue
            where = f"{base}pricing[{i}].cost_parameters"
            if "calendar_zone" in params:
                if params.get("rate_unit") != "day":  # at the object when rate_unit is missing
                    at = f"{where}.rate_unit" if "rate_unit" in params else where
                    self.err(file, at, "calendar_zone without rate_unit day")
            method = entry.get("cost_method")
            if "action_definition" in params and method != "CPA" and ":" not in str(method):
                self.err(file, f"{where}.action_definition", "action_definition on a core term other than CPA")

    def check_screen_location(self, file, path, item):
        """Section 5.2: a movable screen has no fixed coordinates."""
        base = "" if path in ("", "(root)") else f"{path}."
        for i, prop in enumerate((item.get("properties") or {}).get("available") or []):
            for j, screen in enumerate((prop.get("screens") or []) if isinstance(prop, dict) else []):
                if isinstance(screen, dict) and screen.get("movable") is True and ("lat" in screen or "lon" in screen):
                    self.err(file, f"{base}properties.available[{i}].screens[{j}].movable", "lat or lon on a movable screen")

    def check_commitment(self, file, path, item):
        """A commitment's arithmetic and its bounds (sections 5.6.1 and 5.6.5)."""
        for entry in item.get("pricing") or []:
            if entry.get("cost_method") == "FLAT" and "unit_bounds" in entry:
                self.err(file, path, "unit_bounds on a FLAT entry")
        commitment, committed = item.get("commitment"), _committed_entry(item)
        if not commitment or not committed or "agreed_rate" not in committed:
            return
        decimal = lambda n: Decimal(str(n))
        method, rate = committed.get("cost_method"), decimal(committed["agreed_rate"])
        basis, amount = commitment.get("basis"), decimal(commitment.get("amount", 0))
        charges = Decimal(0)
        for value in item.values():
            if isinstance(value, dict) and "available" in value:
                included = value.get("included", [])
                names = [n for n in value.get("selected", included) if n not in included]
                for name in names + value.get("excluded", []):
                    charges += decimal((value.get("deltas") or {}).get(name, {}).get("delta_flat", 0))
        flight = commitment.get("flight") or {}
        starts, ends = flight.get("start"), flight.get("end")
        total, units, elapsed = amount, None, None
        if rate < 0:
            self.err(file, path, "agreed_rate is negative")
        rate_per = decimal(committed.get("rate_per", RATE_PER.get(method) or 1))
        params = committed.get("cost_parameters")
        params = params if isinstance(params, dict) else {}  # the type check reports a non-object
        size = RATE_UNIT_SECONDS.get(params.get("rate_unit"))
        if method == "TIME" and instant(starts) and instant(ends) and size:
            if "calendar_zone" in params and params.get("rate_unit") == "day":
                name = params["calendar_zone"]
                if not _is_zone(name):
                    return  # the IanaZone type check reports the zone; no unit count to check
                zone, utc = ZoneInfo(name), ZoneInfo("UTC")  # section 5.6.5: calendar days in the zone
                first, last = (instant(v).replace(tzinfo=utc).astimezone(zone).date() for v in (starts, ends))
                elapsed = (last - first).days + 1
            else:
                seconds = (instant(ends) - instant(starts)).total_seconds() + 1
                elapsed = int((seconds + size / 2) // size)  # section 5.6.5: the nearest whole unit
        if method == "FLAT":
            if basis != "spend":
                self.err(file, path, "a FLAT commitment has basis spend")
            if amount != rate + charges:
                self.err(file, path, f"a FLAT amount is {rate + charges}")
            if "derived_units" in commitment:
                self.err(file, path, "derived_units on a FLAT commitment")
        elif elapsed is not None:
            units, total = elapsed, elapsed * rate + charges
            if amount != (elapsed if basis == "units" else total):
                self.err(file, path, f"a TIME commitment is for {elapsed} units, {total} in all")
        elif basis == "spend":
            if charges > amount:
                self.err(file, path, "delta_flat charges exceed the amount")
            if rate > 0:
                units = int((amount - charges) / rate * rate_per)
            else:
                self.err(file, path, "a spend commitment on this entry needs an agreed_rate above 0")
        else:
            total, units = amount / rate_per * rate + charges, amount
        if units is not None and "derived_units" in commitment and commitment["derived_units"] != units:
            self.err(file, path, f"derived_units recomputes to {units}")
        limits = item.get("commitment_bounds") or {}
        spend = limits.get("spend") or {}
        if ("min" in spend and total < decimal(spend["min"])) or ("max" in spend and total > decimal(spend["max"])):
            self.err(file, path, f"seller total {total} is outside spend")
        unit_limits = committed.get("unit_bounds") or {}
        if units is not None and (units < unit_limits.get("min", units) or units > unit_limits.get("max", units)):
            self.err(file, path, f"{units} units are outside unit_bounds")

    def check_mechanisms(self, file, path, item):
        """Each option fits its row in section 5.9, and the committed entry prices it."""
        for option in _options(item):
            row = MECHANISMS.get(option.get("id"))
            if not row:
                continue
            if row["delivery"] is not None and option.get("delivery_type") not in row["delivery"]:
                self.err(file, path, f"{option['id']} does not allow delivery_type {option.get('delivery_type')!r}")
        committed = _committed_entry(item)
        if committed and committed.get("transaction_mechanisms"):
            mechanism = item.get("transaction_mechanism") or {}
            for name in mechanism.get("selected", mechanism.get("included", [])):
                if name not in committed["transaction_mechanisms"]:
                    self.err(file, path, f"the committed entry does not price {name}")

    def check_measurement(self, file, path, item):
        """Metric kinds, and the counted_by values sections 5.6.4 and 5.7.1 fix (section 2.2)."""
        for i, tuple_ in enumerate(item.get("committed_metrics") or []):
            kind, value = METRIC_KIND.get(tuple_.get("metric")), tuple_.get("level")
            if kind == "Rate" and not SCALARS["Fraction"](value):
                self.err(file, f"{path}.committed_metrics[{i}]", f"{value!r} is not a rate")
            if kind == "Count" and not SCALARS["Integer"](value):
                self.err(file, f"{path}.committed_metrics[{i}]", f"{value!r} is not a count")
        counting = item.get("delivery_counting") or {}
        multiplier = counting.get("impression_multiplier") or {}
        logged_by = (counting.get("proof_of_performance") or {}).get("logged_by")
        parties = [] if logged_by is None else [("logged_by", logged_by)]
        for entry in item.get("pricing") or []:
            parameters = entry.get("cost_parameters") or {}
            for key, method in (("rating_source", "CPP"), ("action_source", "CPA")):
                if entry.get("cost_method") == method and key in parameters:
                    parties.append((key, parameters[key]))
        for key, party in parties:
            if not SCALARS["Measurer"](party):
                self.err(file, path, f"{key} {party!r} is not a Measurer")
        selection = item.get("controlling_measurement") or {}
        counters = selection.get("available", [])
        expected = {}
        if item.get("channel") == "dooh" and _counts_impressions(item):
            seller_domain = ((self.proposal or {}).get("seller") or {}).get("domain")
            vendor = multiplier.get("vendor")
            own = multiplier.get("source_type") == 2 or (seller_domain is not None and vendor == seller_domain)
            source = "seller" if own else vendor
            expected = {c.get("id"): source for c in counters}
        committed = _committed_entry(item)
        source_key = {"CPP": "rating_source", "CPA": "action_source"}.get((committed or {}).get("cost_method"))
        if source_key:  # section 5.7.1: the rated or reported source counts
            expected = {}
            source = (committed.get("cost_parameters") or {}).get(source_key)
            for name in selection.get("selected", selection.get("included", [])):
                expected[name] = source
        for counter in counters:
            name = counter.get("id")
            if name in expected and counter.get("counted_by") != expected[name]:
                self.err(file, path, f"counted_by of {name} is not {expected[name]!r}")

    def check_fields(self, file, path, doc, fields):
        known = {k[:-2] if k.endswith("[]") else k: r for k, r in fields.items() if "[]." not in k}
        if "line_item_id" in doc:
            self.item = doc
        else:
            self.proposal = doc
            self.item = {}
            for key in ("seller", "buyer"):
                if key in doc and "legal_name" not in doc[key]:
                    self.err(file, key, "legal_name is REQUIRED here")
        for key in doc:
            if key not in known:
                self.err(file, path or "(root)", f"key {key!r} is not in a field table")
        for key, row in known.items():
            if key not in doc and self.required(file, path, row["required"], doc):
                self.err(file, path or "(root)", f"REQUIRED field {key!r} is missing")
            if key in doc and key not in ("line_items", "packages"):
                sub = f"{path}.{key}" if path else key
                self.check_type(file, sub, doc[key], row["type"])
                self.check_values(file, sub, doc[key], row)
        if "line_item_id" in doc:
            self.check_line_item(file, path or "(root)", doc)
            self.check_agreed_rate(file, path or "(root)", doc)
            self.check_screen_location(file, path, doc)
            self.check_cost_presence(file, path, doc)
            self.check_commitment(file, path or "(root)", doc)
            self.check_mechanisms(file, path or "(root)", doc)
            self.check_measurement(file, path or "(root)", doc)
            self.check_exclusions(file, path or "(root)", doc)
            self.check_formats(file, path or "(root)", doc)
            if "audiences" in doc:
                self.check_audiences(file, f"{path}.audiences" if path else "audiences", doc["audiences"])
            if "geo" in doc and "markets" in doc:
                self.err(file, path or "(root)", "a line item declares geo or markets")
        # A Placement key can be required though the OPTIONAL placement is absent.
        if "line_item_id" in doc and "placement" not in doc:
            self.check_object(file, f"{path}.placement" if path else "placement", {}, "Placement")

    def check_dated_shares(self, file, path, item):
        """Section 5.6.6: an option's dated_shares[] windows don't overlap."""
        for option in (item.get("cancellation_policy") or {}).get("available", []):
            windows = sorted((r["window"]["start"], r["window"]["end"]) for r in option.get("dated_shares", []))
            for earlier, later in zip(windows, windows[1:]):
                if later[0] <= earlier[1]:
                    self.err(file, path, f"{option.get('id')}: dated_shares[] windows overlap")

    def check_line_item(self, file, path, item):
        """Rules between a line item's fields that no single table row states."""
        self.check_dated_shares(file, path, item)
        entries = item.get("pricing") or []
        ids = [e.get("pricing_id") for e in entries]
        if len(ids) != len(set(ids)):
            self.err(file, path, "two pricing[] entries share a pricing_id")
        seen = set()
        for entry in entries:
            for name in entry.get("transaction_mechanisms") or _mechanisms(item):
                key = (entry.get("cost_method"), json.dumps(entry.get("cost_parameters"), sort_keys=True),
                       entry.get("currency"), name)
                if key in seen:
                    self.err(file, path, f"two pricing[] entries are the same on {name}")
                seen.add(key)
        if "deal_origin" in item and not _is_deal(_mechanisms(item)):
            self.err(file, path, "deal_origin on a line item with no deal mechanism")
        for ref in item.get("external_references") or []:
            if ref.get("reference_type") == "deal" and ref.get("system") != item.get("deal_origin"):
                self.err(file, path, "a deal reference has system other than deal_origin")
        programs = item.get("programs") or {}
        for option in programs.get("available", []):
            if (option.get("schedule") or {}).get("eventstatus") == 2:
                name = option.get("id")
                if name in programs.get("included", []):
                    self.err(file, path, f"tentative {name} is in included[]")
                if set((programs.get("deltas") or {}).get(name, {})) - {"delta_flat"}:
                    self.err(file, path, f"tentative {name} has a delta other than delta_flat")
        mechanism = item.get("transaction_mechanism") or {}
        in_effect = mechanism.get("selected", mechanism.get("included", []))
        delivery = {o.get("delivery_type") for o in _options(item) if o.get("id") in in_effect}
        hold = item.get("hold") or {}
        for key, figures in (("availability", item.get("availability")),
                             ("hold.held_availability", hold.get("held_availability"))):
            if figures and delivery == {"non_guaranteed"} and figures.get("certainty") != "forecast":
                self.err(file, path, f"{key}.certainty is forecast when delivery_type is non_guaranteed")
        limits = [e["price_valid_until"] for e in entries if "price_valid_until" in e]
        limits += [(self.proposal or {}).get("offer_window", {}).get("end")] if self.proposal else []
        if "valid_until" in hold and any(limit and hold["valid_until"] > limit for limit in limits):
            self.err(file, path, "hold.valid_until exceeds offer_window.end or a price_valid_until")
        for option in (item.get("properties") or {}).get("available", []):
            if len((option.get("venue_type") or {"ids": [0]}).get("ids", [])) != 1:
                self.err(file, path, "venue_type.ids holds exactly one id")
        if item.get("serving_mode") == "embedded":
            if item.get("episodes", "new") != "new":
                self.err(file, path, "episodes on an embedded line item is new")
            for key in EMBEDDED_ABSENT:
                if key in item:
                    self.err(file, path, f"{key} on an embedded line item")
            if item.get("time_zone") == "viewer_local":
                self.err(file, path, "time_zone on an embedded line item is viewer_local")
            if _mechanisms(item) != {"direct_io"}:
                self.err(file, path, "an embedded line item offers only direct_io")

    def check_removal_paths(self):
        parsed = []
        for path in self.spec.removal:
            parts = [p.replace("[*]", "[]") for p in path.removeprefix("$.").split(".")]
            parsed.append(parts)
            if not self.resolves(self.spec.proposal, parts):
                self.err("spec", "removal path", f"{path} resolves to no row")
        # Section 3: these markers mean "not a term", so the value is outside the record.
        for rows, prefix in ((self.spec.proposal, []), (self.spec.tables["LineItem"], ["line_items"])):
            for key, row in rows.items():
                if row["marker"] in ("lifecycle", "recorded", "asserted"):
                    if prefix + [key.removesuffix("[]")] not in [
                        [p.removesuffix("[]") for p in parts] for parts in parsed
                    ]:
                        self.err("spec", "removal list", f"{key} is {row['marker']}, and the removal list leaves it in the record")
        # The same for each key of a mixed field, which its Mutability column marks.
        flat = [[p.removesuffix("[]") for p in parts] for parts in parsed]
        for field, row in self.spec.tables["LineItem"].items():
            if row["marker"] != "mixed":
                continue
            name = field.removesuffix("[]")
            for key, inner in self.spec.mixed_keys(row["type"]).items():
                path = ["line_items", name, key.removesuffix("[]")]
                if inner["marker"] in ("lifecycle", "recorded", "asserted") and path not in flat and path[:2] not in flat:
                    self.err("spec", "removal list", f"{name}.{key} is {inner['marker']}, and the removal list leaves it in the record")

    def check_summary_paths(self):
        """Each section 2.1 path resolves, spelled as its table row spells it."""
        for rows, paths in ((self.spec.line_item, self.spec.summary_paths),
                            (self.spec.proposal, self.spec.proposal_paths)):
            for path in paths:
                if not self.resolves(rows, path.split("."), strict=True):
                    self.err("spec", "summary path", f"{path} resolves to no row")

    def resolves(self, rows, parts, strict=False):
        """Whether a path names table rows. What an Object holds is not listed."""
        head, rest = parts[0], parts[1:]
        row = rows.get(head)
        if row is None and not strict:
            row = rows.get(f"{head}[]") or rows.get(head.removesuffix("[]"))
        if row is None:
            return False
        return self.resolves_type(row["type"], rest, strict)

    def resolves_type(self, typ, parts, strict):
        if not parts:
            return True
        base, args = split_generic(typ)
        if base == "Array":
            return self.resolves_type(args[0], parts, strict)
        selectable = self.spec.selectable_of(typ)
        if selectable:
            if parts[0] == "available[]":
                return self.resolves_type(selectable[0], parts[1:], strict)
            if parts[0] in selectable[1]:
                return self.resolves(selectable[1], parts, strict)
            return parts[0] in self.spec.tables["Selectable"] and not parts[1:]
        if base == "Object":
            return True
        rows = self.rows_of(base)
        return bool(rows) and self.resolves(rows, parts, strict)

    def check_spec_blocks(self):
        """Each yaml block in the body is a fragment of a line item (or of its ext)."""
        for n, block in enumerate(self.spec.yaml_blocks):
            fragment = yaml.load(block, Loader=StrictLoader)
            self.item, self.proposal = fragment, None
            where = f"yaml block {n + 1}"
            for key, value in fragment.items():
                row = self.spec.line_item.get(key) or self.spec.line_item.get(f"{key}[]")
                if not row:
                    self.err("spec", where, f"key {key!r} is not in a field table")
                    continue
                self.check_type("spec", f"{where}.{key}", value, row["type"])
                self.check_values("spec", f"{where}.{key}", value, row)
            self.check_exclusions("spec", where, fragment)


# Digest --------------------------------------------------------------------


def jcs_number(n):
    """RFC 8785 section 3.2.2.3: the ECMAScript form of the shortest round trip."""
    if isinstance(n, bool):
        return "true" if n else "false"
    if n == 0:
        return "0"
    sign, digits, exponent = Decimal(repr(float(n))).normalize().as_tuple()
    text, point = "".join(map(str, digits)), len(digits) + exponent
    if 0 < point <= 21:
        body = text.ljust(point, "0")[:point] + ("." + text[point:] if len(text) > point else "")
    elif -6 < point <= 0:
        body = "0." + "0" * -point + text
    else:
        power = point - 1
        body = text[0] + ("." + text[1:] if len(text) > 1 else "") + f"e{'+' if power > 0 else '-'}{abs(power)}"
    return ("-" if sign else "") + body


def jcs(value):
    """RFC 8785 serialization, for the values examples use."""
    if value is None:
        return "null"
    if isinstance(value, (bool, int, float)):
        return jcs_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(jcs(v) for v in value) + "]"
    keys = sorted(value, key=lambda k: k.encode("utf-16-be"))
    return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + jcs(value[k]) for k in keys) + "}"


def remove_path(node, parts):
    if not parts:
        return
    head, rest = parts[0], parts[1:]
    if head.endswith("[*]"):
        key = head[:-3]
        for item in (node.get(key) or []):
            remove_path(item, rest)
        return
    if not rest:
        node.pop(head, None)
    elif isinstance(node.get(head), dict):
        remove_path(node[head], rest)


def record_digest(doc, removal, line_item_ids=None):
    copy = json.loads(json.dumps(doc))
    if line_item_ids is not None and "packages" in copy:
        for package in copy["packages"]:
            for key in ("line_items", "add_ons"):
                if key in package:
                    package[key] = [i for i in package[key] if i["line_item_id"] in line_item_ids]
        copy["packages"] = [p for p in copy["packages"] if p.get("line_items") or p.get("add_ons")]
    elif line_item_ids is not None:
        copy["line_items"] = [i for i in copy["line_items"] if i["line_item_id"] in line_item_ids]
    for path in removal:
        parts = path[2:].split(".")
        remove_path(copy, parts)
        # Section 4.1.1: each $.line_items[*] path also selects the same path in a package.
        if parts[0] == "line_items[*]":
            for package in copy.get("packages", []):
                for key in ("line_items", "add_ons"):
                    remove_path(package, [f"{key}[*]"] + parts[1:])
    # Section 4.1.1: the one object the removals don't leave in place when it is empty.
    for item in line_items_of(copy):
        if item.get("buyer_supplied") == {}:
            del item["buyer_supplied"]
    return "sha256:" + hashlib.sha256(jcs(copy).encode("utf-8")).hexdigest()


def check_digest_ignores_empty_buyer_supplied(checker, doc, removal):
    """Section 4.1.1: a removed buyer_supplied value moves no digest, and a kept one does."""
    item = doc["line_items"][0]
    forms = [
        None,
        {},
        {"expected_match_rate": 0.65},
        {"segments": [], "suppression_list": {}, "expected_match_rate": 0.65},
    ]
    digests = set()
    for form in forms:
        copy = json.loads(json.dumps(doc))
        copy["line_items"][0].pop("buyer_supplied", None)
        if form is not None:
            copy["line_items"][0]["buyer_supplied"] = form
        digests.add(record_digest(copy, removal, [item["line_item_id"]]))
    if len(digests) != 1:
        checker.errors.append("record_digest: an absent and an empty buyer_supplied give different digests")
    copy = json.loads(json.dumps(doc))
    copy["line_items"][0]["buyer_supplied"] = {"suppression_allowed": True}
    if record_digest(copy, removal, [item["line_item_id"]]) in digests:
        checker.errors.append("record_digest: a buyer_supplied that keeps a term moved no digest")


# Summary -------------------------------------------------------------------


def project(doc, paths):
    """Return the strict path subset of doc for the listed paths."""
    tree = {}
    for path in paths:
        node = tree
        for part in path.split("."):
            node = node.setdefault(part, {})

    def walk(value, spec):
        if not spec:
            return value
        if isinstance(value, list):
            return [walk(v, spec) for v in value]
        if not isinstance(value, dict):
            return value
        res = {}
        for key, sub in spec.items():
            bare = key[:-2] if key.endswith("[]") else key
            if bare in value:
                res[bare] = walk(value[bare], sub)
        return res

    return walk(doc, tree)


def full_examples():
    items = {}
    for path in sorted(EXAMPLES.glob("line-item-*.yaml")):
        doc = load_yaml(path)
        items[doc["line_item_id"]] = doc
    return items


def check_extracts(checker):
    """Section 6.1: the line item files with no commitment are extracts of proposal.yaml."""
    held = {}
    for name in ("proposal.yaml", "proposal-package.yaml"):
        for i in line_items_of(load_yaml(EXAMPLES / name)):
            if i["line_item_id"] in held and held[i["line_item_id"]] != i:
                checker.errors.append(f"{name}: line item {i['line_item_id']} differs from proposal.yaml's")
            held[i["line_item_id"]] = i
    # A line item example that carries a commitment is one issued to a buyer (section 4.3).
    extracts = {k: i for k, i in full_examples().items() if "commitment" not in i}
    for name in held.keys() ^ extracts.keys():
        checker.errors.append(f"proposal.yaml: line item {name} isn't in both proposal.yaml and a line item file")
    for name in held.keys() & extracts.keys():
        if held[name] != extracts[name]:
            checker.errors.append(f"proposal.yaml: line item {name} differs from its line item file")


def line_item_summary(item, spec):
    return project(item, spec.summary_paths)


def proposal_summary(proposal, spec):
    return project(proposal, spec.proposal_paths)


def build_manifest(spec):
    """Section 2.3: the proposal's public, published line items, as summaries."""
    proposal = load_yaml(EXAMPLES / "proposal.yaml")
    entry = proposal_summary(proposal, spec)
    entry["full_url"] = f"https://{proposal['seller']['domain']}/openproposal/{proposal['proposal_id']}"
    listed = lambda item: item.get("visibility") == "public" and item.get("status") == "published"
    if "packages" not in proposal:
        entry["line_items"] = [line_item_summary(item, spec) for item in proposal["line_items"] if listed(item)]
    else:
        entry["packages"] = []
        for package in proposal["packages"]:
            if not all(listed(i) for i in package["line_items"]):
                continue
            summary = {"package_id": package["package_id"],
                       "line_items": [line_item_summary(i, spec) for i in package["line_items"]]}
            add_ons = [line_item_summary(i, spec) for i in package.get("add_ons", []) if listed(i)]
            if add_ons:
                summary["add_ons"] = add_ons
            if "min_commitments" in package:
                summary["min_commitments"] = package["min_commitments"]
            entry["packages"].append(summary)
    return {
        "generated_at": "2026-10-03T15:00:00Z",
        "spec_version": proposal["spec_version"],
        "proposals": [entry],
    }


def check_assent(checker, file, doc):
    """Section 4.1.2: only a matching pair makes agreed, and an acceptance matches a live entry."""
    def key(entry):
        return entry["version"], entry["record_digest"], frozenset(entry["line_item_ids"])

    items = {i["line_item_id"]: i for i in line_items_of(doc)}
    commitments, live, matched, agreed = [], set(), set(), set()
    for entry in doc.get("assent", []):
        role = entry["role"]
        if "ground" in entry and role != "decline":
            checker.errors.append(f"{file}: {role} entry carries ground")
        for named in entry["line_item_ids"]:
            if named not in items:
                checker.errors.append(f"{file}: {role} entry names {named}, which is not a line item")
            elif role == "commitment" and "commitment" not in items[named]:
                checker.errors.append(f"{file}: commitment entry names {named}, which has no commitment")
        if role == "commitment":
            commitments.append(key(entry))
            live.add(key(entry))
        elif role == "acceptance":
            # Section 4.1.2: an acceptance matches only a live commitment entry.
            if key(entry) not in live:
                checker.errors.append(f"{file}: acceptance entry matches no live commitment entry")
            else:
                matched.add(key(entry))
                agreed.update(entry["line_item_ids"])
        elif key(entry) not in commitments:
            checker.errors.append(f"{file}: {role} entry matches no commitment entry before it")
        elif key(entry) not in matched:
            live.discard(key(entry))
    for name, item in items.items():
        if (item.get("status") == "agreed") != (name in agreed):
            checker.errors.append(f"{file}: {name} has status {item.get('status')!r}, "
                                  f"and assent[] {'has' if name in agreed else 'has no'} matching pair")
        if name in agreed:
            check_eligible(checker, file, doc, item)


def check_eligible(checker, file, doc, item):
    """Section 5.8: the agreed buyer passes each eligibility field that is present."""
    name, domain = item["line_item_id"], doc["buyer"]["domain"]
    requirements = item.get("buyer_requirements") or {}
    seats = requirements.get("seats") or {}
    if "eligible_buyers" in item or "eligible_seats" in item:
        listed = {s for e in item.get("eligible_seats", []) if e["dsp"] == seats.get("dsp") for s in e.get("ids", [])}
        if domain not in item.get("eligible_buyers", []) and not (
                seats.get("ids") and set(seats["ids"]) <= listed):
            checker.errors.append(f"{file}: {name}: the buyer is in neither eligible_buyers nor eligible_seats")
    if "allowed_dsps" in requirements and seats and seats["dsp"] not in requirements["allowed_dsps"]:
        checker.errors.append(f"{file}: {name}: buyer_requirements.seats.dsp is not in allowed_dsps")


def check_status(checker, file, doc):
    """Section 4.3.3: a proposal's status is the first rule that applies."""
    statuses = [i.get("status") for i in line_items_of(doc)]
    if all(s == "draft" for s in statuses):
        status = "draft"
    elif "under_review" in statuses:
        status = "under_review"
    elif {"draft", "published", "sold_out"} & set(statuses):
        status = "published"
    elif "agreed" in statuses:
        status = "agreed"
    else:
        status = "expired" if "expired" in statuses else "withdrawn"
    if doc.get("status") != status:
        checker.errors.append(f"{file}: status is {doc.get('status')!r}, and section 4.3.3 gives {status!r}")


def check_history(checker, file, doc):
    """Section 4.1.3: one seller entry per version, and pointers that resolve."""
    history = doc.get("negotiation_history", [])
    made = [e for e in history if e["actor"] == "seller" and e["action"] in ("published", "granted", "countered")]
    if sorted(e["version"] for e in made) != list(range(1, doc["version"] + 1)):
        checker.errors.append(f"{file}: negotiation_history has no single seller entry for each version")
    if made and made[0]["action"] != "published":
        checker.errors.append(f"{file}: negotiation_history starts with {made[0]['action']!r}, not published")
    items = {i["line_item_id"]: i for i in line_items_of(doc)}
    for n, entry in enumerate(history):
        for path in entry["paths"]:
            requested_value = path.get("requested_value")
            if requested_value and entry["action"] not in ("requested", "declined", "withdrawn"):
                checker.errors.append(f"{file}: negotiation_history[{n}]: a {entry['action']} path carries requested_value")
            if requested_value and not set(requested_value) <= set(path["pointer"].split("/")):
                checker.errors.append(f"{file}: negotiation_history[{n}]: requested_value names no field of {path['pointer']}")
            node = items.get(path.get("line_item_id")) if "line_item_id" in path else doc
            if node is None:
                checker.errors.append(f"{file}: negotiation_history[{n}] names {path['line_item_id']}, "
                                      "which is not a line item")
                continue
            for part in path["pointer"].split("/")[1:]:
                part = part.replace("~1", "/").replace("~0", "~")
                node = node[int(part)] if isinstance(node, list) else (node or {}).get(part)
            if node is None:
                checker.errors.append(f"{file}: negotiation_history[{n}]: {path['pointer']} resolves to nothing")


def check_packages(checker, spec, file, doc):
    """Section 4.1.4: one shape per proposal, unique ids, and thresholds on the package's own line items."""
    if "packages" in doc and "line_items" in doc:
        checker.errors.append(f"{file}: a proposal holds line_items[] or packages[], not both")
    ids = [i["line_item_id"] for i in line_items_of(doc)]
    for name in {n for n in ids if ids.count(n) > 1}:
        checker.errors.append(f"{file}: line_item_id {name} appears more than once")
    package_ids = [p.get("package_id") for p in doc.get("packages", [])]
    for name in {n for n in package_ids if package_ids.count(n) > 1}:
        checker.errors.append(f"{file}: package_id {name} appears more than once")
    rows = spec.tables["Package"]
    for n, package in enumerate(doc.get("packages", [])):
        where = f"packages[{n}]"
        for key in package:
            if f"{key}[]" not in rows and key not in rows:
                checker.err(file, where, f"key {key!r} is not in the Package table")
        if not package.get("line_items"):
            checker.err(file, where, "line_items[] holds at least one entry")
        if "min_commitments" in package:
            checker.check_type(file, f"{where}.min_commitments", package["min_commitments"], "Array[MinCommitment]")
        core = {i["line_item_id"] for i in package.get("line_items", [])}
        for m in package.get("min_commitments", []):
            if m.get("line_item_id") not in core:
                checker.err(file, f"{where}.min_commitments", f"{m.get('line_item_id')} is not in this package's line_items[]")
        for key in ("line_items", "add_ons"):
            for i, item in enumerate(package.get(key, [])):
                checker.check_fields(file, f"{where}.{key}[{i}]", item, spec.line_item)


def check_shared(checker, file, doc):
    """Section 4.3: a shared proposal carries no buyer state."""
    for key in ("buyer", "assent", "change_requests"):
        if key in doc:
            checker.errors.append(f"{file}: a shared proposal carries no {key}")
    for item in line_items_of(doc):
        name = item["line_item_id"]
        if item.get("status") in ("under_review", "agreed"):
            checker.errors.append(f"{file}: {name}: a shared proposal has no line item {item['status']}")
        for key in ("commitment", "hold"):
            if key in item:
                checker.errors.append(f"{file}: {name}: a shared proposal carries no {key}")
        for entry in item.get("pricing", []):
            if "agreed_rate" in entry:
                checker.errors.append(f"{file}: {name}: a shared proposal carries no agreed_rate")
        for key, value in item.items():
            row = checker.spec.line_item.get(key) or checker.spec.line_item.get(f"{key}[]") or {}
            if row.get("marker") == "supplied":
                checker.errors.append(f"{file}: {name}: {key} is what a buyer supplies")
            elif row.get("marker") == "mixed":
                supplied = {k.removesuffix("[]") for k, r in checker.spec.mixed_keys(row["type"]).items()
                            if r["marker"] == "supplied"}
                for entry in value if isinstance(value, list) else [value]:
                    if isinstance(entry, dict):
                        for inner in entry.keys() & supplied:
                            checker.errors.append(f"{file}: {name}: {key}.{inner} is what a buyer supplies")
            elif not isinstance(value, dict):
                continue
            elif row.get("marker") in ("selectable", "settable"):
                for inner in value.keys() & {"selected", "excluded", "value"}:
                    checker.errors.append(f"{file}: {name}: {key}.{inner} is a buyer's write")
            if key == "frequency_cap" and "value" in value.get("count", {}):
                checker.errors.append(f"{file}: {name}: frequency_cap.count.value is a buyer's write")


def applicable_max_share(terms, notice):
    """Section 5.6.6: the range holding the effective date, or the top-level max_share."""
    effective = instant(notice.get("requested_effective_at"))
    if effective is None:
        return terms.get("max_share", 1)
    length = re.fullmatch(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", terms.get("notice_duration", "P0D"))
    if length:  # a length in months or years has no fixed span; the requested date stands
        days, hours, minutes, seconds = (int(part or 0) for part in length.groups())
        received = instant(notice.get("notice_received_at"))
        if received is not None:
            effective = max(effective, received + timedelta(days=days, hours=hours, minutes=minutes, seconds=seconds))
    for span in terms.get("dated_shares", []):
        start, end = instant(span["window"].get("start")), instant(span["window"].get("end"))
        if start is not None and end is not None and start <= effective <= end:
            return span["max_share"]
    return terms.get("max_share", 1)


def check_change_requests(checker, file, doc):
    """Section 4.4: each entry names an agreed line item at its agreed version."""
    items = {i["line_item_id"]: i for i in line_items_of(doc)}
    for n, entry in enumerate(doc.get("change_requests", [])):
        where = f"{file}: change_requests[{n}].baseline"
        baseline = entry.get("baseline", {})
        named = baseline.get("line_item_id")
        if baseline.get("proposal_id") != doc.get("proposal_id"):
            checker.errors.append(f"{where}: names another proposal")
        if named is None:
            checker.errors.append(f"{where}: line_item_id is REQUIRED here")
        elif items.get(named, {}).get("status") != "agreed":
            checker.errors.append(f"{where}: {named} is not an agreed line item")
        versions = {e["version"] for e in doc.get("assent", [])
                    if e["role"] == "acceptance" and named in e["line_item_ids"]}
        if baseline.get("version") not in versions:
            checker.errors.append(f"{where}: no acceptance entry names {named} at that version")
        notice = entry.get("cancellation") or {}
        option = notice.get("option_id")
        if option is not None:
            policy = items.get(named, {}).get("cancellation_policy") or {}
            if option not in policy.get("selected", policy.get("included", [])):
                checker.errors.append(f"{file}: change_requests[{n}].cancellation: "
                                      f"{option} is not an option in effect")
            terms = next((o for o in policy.get("available", []) if o.get("id") == option), {})
            if notice.get("cancelled_share", 0) > applicable_max_share(terms, notice):
                checker.errors.append(f"{file}: change_requests[{n}].cancellation: "
                                      f"cancelled_share is above the max_share that applies")


def check_manifest(checker, spec):
    manifest = load_json(EXAMPLES / "manifest.json")
    rows = spec.tables["ProposalManifest"]
    keys = {k.removesuffix("[]") for k in rows}
    required = {k.removesuffix("[]") for k, row in rows.items() if row["required"] == "REQUIRED"}
    for key in sorted((required - manifest.keys()) | (manifest.keys() - keys)):
        checker.err("manifest.json", "(root)", f"key {key!r} differs from the ProposalManifest table")
    for key, row in rows.items():
        if key.removesuffix("[]") in manifest:
            checker.check_type("manifest.json", key, manifest[key.removesuffix("[]")], row["type"])
    expected = build_manifest(spec)
    if manifest != {**expected, "generated_at": manifest.get("generated_at")}:
        checker.err("manifest.json", "(root)", "the manifest is not the path subset of the full examples; "
                    "run --regen-manifest")


# Main ----------------------------------------------------------------------


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--regen-manifest", action="store_true")
    args = ap.parse_args()
    spec = Spec()
    if args.regen_manifest:
        manifest = build_manifest(spec)
        (EXAMPLES / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
        print("examples/manifest.json regenerated")
        return 0

    checker = Checker(spec)
    unparsed = []
    for path in sorted(EXAMPLES.glob("*.yaml")):
        try:
            load_yaml(path)
        except yaml.YAMLError as e:
            unparsed.append(f"{path.name}: does not parse strictly: {e}")
    if unparsed:
        print("\n".join(unparsed))
        return 1

    for path in sorted(EXAMPLES.glob("*.yaml")):
        doc = load_yaml(path)
        checker.proposal = None
        if "line_item_id" in doc:
            checker.check_fields(path.name, "", doc, spec.line_item)
            continue
        checker.check_fields(path.name, "", doc, spec.proposal)
        for i, item in enumerate(doc.get("line_items", [])):
            checker.check_fields(path.name, f"line_items[{i}]", item, spec.line_item)
        check_packages(checker, spec, path.name, doc)
        if path.name in ("proposal.yaml", "proposal-package.yaml"):
            check_shared(checker, path.name, doc)
        check_status(checker, path.name, doc)
        check_history(checker, path.name, doc)
    try:
        check_manifest(checker, spec)
    except (ValueError, KeyError) as e:
        checker.errors.append(f"manifest.json: {e}")
    check_extracts(checker)
    checker.check_value_tables()
    checker.check_table_cells()
    checker.check_summary_paths()
    checker.check_removal_paths()
    checker.check_spec_blocks()

    check_digest_ignores_empty_buyer_supplied(checker, load_yaml(EXAMPLES / "proposal-agreed.yaml"), spec.removal)

    digests = {}
    for name in ("proposal-agreed.yaml", "proposal-issued.yaml"):
        doc = load_yaml(EXAMPLES / name)
        check_assent(checker, name, doc)
        check_change_requests(checker, name, doc)
        for entry in doc.get("assent", []):
            digest = record_digest(doc, spec.removal, entry["line_item_ids"])
            digests[name] = digest
            if entry["record_digest"] != digest:
                checker.errors.append(f"{name}: record_digest recomputes to {digest}")

    if checker.errors:
        print("Examples disagree with the specification:\n")
        for e in checker.errors:
            print(f"  - {e}")
        return 1
    print("Examples match the tables. record_digest recomputes to:")
    for name, digest in digests.items():
        print(f"  {name}: {digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
