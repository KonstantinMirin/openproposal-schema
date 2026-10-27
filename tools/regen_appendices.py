#!/usr/bin/env python3
"""Regenerate Appendix A and Appendix B of the OpenProposal spec from its body.

The body field tables in sections 4.x and 5.x are normative. Appendix A and
Appendix B are derived from them. This script rebuilds both deterministically,
so a merge never has to hand-merge them.

Body tables are  | `field` | Type | Marker | Description |
Appendix A is    | `field` | Section | Type | Marker |
Appendix B is    | Marker | Count | Meaning | Fields |

What it rewrites:
  - Appendix A table rows, in document order.
  - Appendix B table rows: per-marker count and field list, in document order.
    A field name that appears more than once is suffixed with the object it
    belongs to, as in "`status` (proposal)".
  - The figures in "What the distribution says". Only the numbers change; the
    prose and its line breaks are kept.

Everything else in the file is left byte for byte.

The parsing rules mirror scripts/check_appendix.py: a body row counts when it
sits under a `###`/`####` heading numbered 4.x or 5.x[.y], has four cells, its
first cell starts with a backtick, and its third cell is a known marker.

Usage:
  regen_appendices.py [SPEC]          rewrite SPEC in place
  regen_appendices.py --check [SPEC]  exit 1 if SPEC is not already regenerated
SPEC defaults to spec/openproposal-3.0.md under the current directory.
"""
import re
import sys
from pathlib import Path

MARKER_ORDER = [
    "immutable", "seller-set", "selectable", "settable",
    "supplied", "requestable", "derived", "mixed",
]
MARKERS = set(MARKER_ORDER)
BUYER_MARKERS = ["selectable", "settable", "supplied", "requestable"]

BODY_SECTION = re.compile(r"^#{3,4} (4\.\d|5\.\d+(?:\.\d+)?)\s")
APPENDIX_A = re.compile(r"^## Appendix A")
APPENDIX_B = re.compile(r"^## Appendix B")
DISTRIBUTION = re.compile(r"^### What the distribution says")
# Owner label used to disambiguate a field name declared in more than one place.
OWNER = {"4": "proposal", "5": "line item"}

DIST_1 = re.compile(
    r"Of (\d+) fields, \*\*(\d+) are touched by the buyer\*\* — "
    r"(\d+) `selectable`,(\s+)(\d+) `settable`,(\s+)(\d+)(\s+)`supplied` and"
    r"(\s+)(\d+) `requestable`\.(\s+)The remaining(\s+)(\d+) are"
)
DIST_2 = re.compile(
    r"Only the (\d+) `requestable` fields require a round trip\.(\s+)"
    r"Everything else the buyer(\s+)touches — (\d+) fields —"
)


def cells(line):
    """Split a Markdown table row into stripped cells, honouring `\\|`."""
    body = line.strip()
    if not (body.startswith("|") and body.endswith("|")):
        return None
    parts = re.split(r"(?<!\\)\|", body[1:-1])
    return [p.strip() for p in parts]


def is_table_row(line):
    return line.lstrip().startswith("|")


def body_fields(lines):
    """Return [(field_cell, section_title, type, marker, top_section)]."""
    rows, active, section = [], False, None
    for line in lines:
        if line.startswith("#"):
            m = BODY_SECTION.match(line)
            active = bool(m)
            section = line.lstrip("#").strip() if m else None
            continue
        if not active:
            continue
        c = cells(line)
        if not c or len(c) != 4:
            continue
        field, typ, marker = c[0], c[1], c[2]
        if field.startswith("`") and marker in MARKERS:
            rows.append((field, section, typ, marker, section.split(".")[0]))
    return rows


def table_span(lines, start, stop):
    """Locate the first table between start and stop: (header, first_row, end)."""
    i = start
    while i < stop and not is_table_row(lines[i]):
        i += 1
    if i + 1 >= stop or not is_table_row(lines[i + 1]):
        raise SystemExit(f"no table found after line {start + 1}")
    first = i + 2  # header row, separator row, then data rows
    end = first
    while end < stop and is_table_row(lines[end]):
        end += 1
    return i, first, end


def regenerate(text):
    lines = text.split("\n")
    try:
        a = next(i for i, l in enumerate(lines) if APPENDIX_A.match(l))
        b = next(i for i, l in enumerate(lines) if APPENDIX_B.match(l))
        d = next(i for i, l in enumerate(lines) if DISTRIBUTION.match(l))
    except StopIteration:
        raise SystemExit("Appendix A, Appendix B or the distribution heading is missing")
    if not a < b < d:
        raise SystemExit("appendix headings are out of order")

    rows = body_fields(lines[:a])
    if not rows:
        raise SystemExit("parsed no body fields; the table format changed")

    # Appendix A
    _, a_first, a_end = table_span(lines, a, b)
    a_rows = [f"| {f} | {s} | {t} | {m} |" for f, s, t, m, _ in rows]

    # Appendix B
    _, b_first, b_end = table_span(lines, b, d)
    meanings = {}
    for line in lines[b_first:b_end]:
        c = cells(line)
        if c and len(c) == 4 and c[0] in MARKERS:
            meanings[c[0]] = c[2]
    name_count = {}
    for f, *_ in rows:
        name_count[f] = name_count.get(f, 0) + 1

    def label(f, top):
        if name_count[f] > 1:
            return f"{f} ({OWNER[top]})"
        return f

    by_marker = {m: [] for m in MARKER_ORDER}
    for f, _, _, m, top in rows:
        by_marker[m].append(label(f, top))
    b_rows = []
    for m in MARKER_ORDER:
        if not by_marker[m]:
            continue
        if m not in meanings:
            raise SystemExit(f"Appendix B has no Meaning text for marker {m}")
        b_rows.append(
            f"| {m} | {len(by_marker[m])} | {meanings[m]} | {', '.join(by_marker[m])} |"
        )

    # What the distribution says
    total = len(rows)
    n = {m: len(by_marker[m]) for m in MARKER_ORDER}
    buyer = sum(n[m] for m in BUYER_MARKERS)
    prose = "\n".join(lines[d:])

    def sub1(mo):
        g = mo.groups()
        return (
            f"Of {total} fields, **{buyer} are touched by the buyer** — "
            f"{n['selectable']} `selectable`,{g[3]}{n['settable']} `settable`,{g[5]}"
            f"{n['supplied']}{g[7]}`supplied` and{g[8]}{n['requestable']} `requestable`."
            f"{g[10]}The remaining{g[11]}{total - buyer} are"
        )

    def sub2(mo):
        g = mo.groups()
        return (
            f"Only the {n['requestable']} `requestable` fields require a round trip."
            f"{g[1]}Everything else the buyer{g[2]}touches — "
            f"{buyer - n['requestable']} fields —"
        )

    prose, k1 = DIST_1.subn(sub1, prose, count=1)
    prose, k2 = DIST_2.subn(sub2, prose, count=1)
    if k1 != 1 or k2 != 1:
        raise SystemExit("the distribution prose no longer matches the expected sentences")

    out = (
        lines[:a_first] + a_rows + lines[a_end:b_first] + b_rows
        + lines[b_end:d] + prose.split("\n")
    )
    return "\n".join(out)


def main(argv):
    check = "--check" in argv
    args = [x for x in argv if x != "--check"]
    spec = Path(args[0]) if args else Path("spec/openproposal-3.0.md")
    text = spec.read_text(encoding="utf-8")
    new = regenerate(text)
    if check:
        if new != text:
            print(f"{spec}: appendices are not regenerated")
            return 1
        print(f"{spec}: appendices match the body")
        return 0
    if new != text:
        spec.write_text(new, encoding="utf-8")
        print(f"{spec}: appendices regenerated")
    else:
        print(f"{spec}: already up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
