"""Write the UTC offsets of the IANA time zone database's zones, as one release compiles them, for the rule checks.

The rule checks that count the calendar days a flight touches in a zone
(src/rule-program.ts, and each SDK's runtime) read a zone's UTC offset at an
instant from this table, so every engine counts with the same release. The
names come on stdin, one per line, as kernel/lists.yaml pins them; the
offsets come from the `tzdata` package that tools/oracle/requirements.txt
hash-locks, whose `IANA_VERSION` must be the release the list names, given
as the first argument. The table covers 1970-01-01T00:00:00Z up to
2100-01-01T00:00:00Z: each zone is its offset at the start and every change
after it, as seconds since the epoch; names whose zones have one history
share one entry, encoded as `encode` writes it. It writes canonical JSON to
stdout.

Run it with the interpreter of the venv: .venv/bin/python -I -B tools/tzdata/build.py 2026e < names
"""

import json
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

START = 0  # 1970-01-01T00:00:00Z
END = 4102444800  # 2100-01-01T00:00:00Z
DAY = 86400


def offset(zone: ZoneInfo, t: int) -> int:
    return int(datetime.fromtimestamp(t, timezone.utc).astimezone(zone).utcoffset().total_seconds())


def changes(zone: ZoneInfo) -> list[list[int]]:
    """The zone's offset at START, then each [instant, offset] where it changes before END."""
    out = [[START, offset(zone, START)]]
    t = START
    # Step by 12 hours, which no zone's offset changes back within, and find each change to the second.
    step = DAY // 2
    while t < END:
        n = min(t + step, END)
        if offset(zone, n) != out[-1][1]:
            lo, hi = t, n
            while hi - lo > 1:
                mid = (lo + hi) // 2
                if offset(zone, mid) == out[-1][1]:
                    lo = mid
                else:
                    hi = mid
            out.append([hi, offset(zone, hi)])
        t = n
    return out


def b36(n: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    sign, n, out = ("-" if n < 0 else ""), abs(n), ""
    while True:
        n, r = divmod(n, 36)
        out = digits[r] + out
        if n == 0:
            return sign + out


def encode(history: list[list[int]]) -> str:
    """`<offsets>|<delta>.<index> …`: the zone's distinct offsets, sorted, then each change as the seconds since the one before, from START, and its offset's index, all base 36."""
    offsets = sorted({o for _, o in history})
    parts, prev = [], START
    for t, o in history:
        parts.append(f"{b36(t - prev)}.{b36(offsets.index(o))}")
        prev = t
    return ",".join(b36(o) for o in offsets) + "|" + " ".join(parts)


def main() -> None:
    import tzdata

    version = sys.argv[1]
    if tzdata.IANA_VERSION != version:
        sys.exit(f"the tzdata package holds release {tzdata.IANA_VERSION}, not {version}")
    names = [line.strip() for line in sys.stdin if line.strip()]
    zones: dict[str, list[list[int]]] = {}
    by_history: dict[str, str] = {}
    index: dict[str, str] = {}
    import importlib.resources

    by_file: dict[bytes, list[list[int]]] = {}
    for name in sorted(names):
        # Names whose compiled files are the same bytes, as a link and its zone, have one history.
        data = importlib.resources.files("tzdata.zoneinfo").joinpath(*name.split("/")).read_bytes()
        if data not in by_file:
            by_file[data] = changes(ZoneInfo(name))
        history = by_file[data]
        key = json.dumps(history, separators=(",", ":"))
        if key not in by_history:
            by_history[key] = name
            zones[name] = history
        index[name] = by_history[key]
    doc = {"format": 1, "release": version, "from": START, "until": END, "zones": {k: encode(v) for k, v in zones.items()}, "names": index}
    json.dump(doc, sys.stdout, separators=(",", ":"), sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
