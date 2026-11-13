"""Write the UTC offsets of the IANA time zone database's zones, as one release compiles them, for the rule checks.

The rule checks that count the calendar days a flight touches in a zone
(src/rule-program.ts, and each SDK's runtime) read a zone's UTC offset at an
instant from this table, so every engine counts with the same release. The
names come on stdin, one per line, as kernel/lists.yaml pins them; the
offsets come from the `tzdata` package that tools/oracle/requirements.txt
hash-locks, whose `IANA_VERSION` must be the release the list names, given
as the first argument. It reads that package's compiled files alone, never
the system's zoneinfo, which `zoneinfo.ZoneInfo(name)` reads first and
which differs from machine to machine; and it refuses to run unless the
package installed is the version the requirements pin, with each file it
reads the bytes the package's RECORD hashes. The table covers 1970-01-01T00:00:00Z up to
2100-01-01T00:00:00Z: each zone is its offset at the start and every change
after it, as seconds since the epoch; names whose zones have one history
share one entry, encoded as `encode` writes it. It writes canonical JSON to
stdout.

Run it with the interpreter of the venv: .venv/bin/python -I -B tools/tzdata/build.py 2026e < names
"""

import base64
import hashlib
import importlib.metadata
import importlib.resources
import io
import json
import re
import sys
import zoneinfo
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

REQUIREMENTS = Path(__file__).resolve().parents[1] / "oracle" / "requirements.txt"

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


def pinned_package(version: str) -> dict[str, str]:
    """The pinned tzdata package's compiled files, by zone name, as the SHA-256 its RECORD gives; exits unless the package is the pinned one at the release."""
    m = re.search(r"^tzdata==(\S+)", REQUIREMENTS.read_text(), re.M)
    if m is None:
        sys.exit(f"{REQUIREMENTS} pins no tzdata package")
    try:
        import tzdata
        installed = importlib.metadata.version("tzdata")
    except (ImportError, importlib.metadata.PackageNotFoundError):
        sys.exit(f"the tzdata package isn't installed; run: npm run setup:oracle, which installs tzdata=={m[1]} from {REQUIREMENTS.name} with its hashes")
    if installed != m[1]:
        sys.exit(f"the tzdata package installed is {installed}, and {REQUIREMENTS.name} pins {m[1]}; run: npm run setup:oracle")
    if tzdata.IANA_VERSION != version:
        sys.exit(f"the tzdata package holds release {tzdata.IANA_VERSION}, not {version}")
    record: dict[str, str] = {}
    for f in importlib.metadata.files("tzdata") or []:
        parts = Path(f).parts
        if parts[:2] == ("tzdata", "zoneinfo") and f.hash is not None and f.hash.mode == "sha256":
            record["/".join(parts[2:])] = f.hash.value
    return record


def compiled(record: dict[str, str], name: str) -> bytes:
    """A zone's compiled file in the pinned package, checked against the package's RECORD."""
    want = record.get(name)
    if want is None:
        sys.exit(f"the tzdata package's RECORD lists no zone {name}")
    data = importlib.resources.files("tzdata.zoneinfo").joinpath(*name.split("/")).read_bytes()
    got = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    if got != want:
        sys.exit(f"the tzdata package's file for {name} isn't the one its RECORD hashes")
    return data


def main() -> None:
    version = sys.argv[1]
    record = pinned_package(version)
    # No zone is ever read from the system's zoneinfo: each comes from the package's own file.
    zoneinfo.reset_tzpath([])
    names = [line.strip() for line in sys.stdin if line.strip()]
    zones: dict[str, list[list[int]]] = {}
    by_history: dict[str, str] = {}
    index: dict[str, str] = {}
    by_file: dict[bytes, list[list[int]]] = {}
    for name in sorted(names):
        # Names whose compiled files are the same bytes, as a link and its zone, have one history.
        data = compiled(record, name)
        if data not in by_file:
            by_file[data] = changes(ZoneInfo.from_file(io.BytesIO(data), key=name))
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
