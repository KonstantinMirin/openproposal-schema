"""Report the Python SDK's verdicts on the conformance cases.

The SDK parity gate (scripts/ci.ts) runs this with the path of a lock's
generated `python/` directory, sends {"cases": [{"target", "json"}]} on
stdin, and reads {"engine", "verdicts": [<bool>], "dumps": [<value>],
"errors": [<str or null>]} from stdout. A case's target is the type its
value is an instance of: a named type (`{"k": "ref", "name"}`), or a
template applied to its arguments (`{"k": "apply", "template", "args"}`),
which this builds from the SDK's generics. Each case's JSON text is
validated as it is, as a receiver gets it, so `1.0` stays a float, and an
accepted value is dumped back to JSON with the SDK's `dump`, which must
write what Pydantic's `dump_python(mode="json", exclude_unset=True)` writes.

Run it with the interpreter of the venv that tools/sdk/requirements.txt pins.
"""

import json
import sys
from importlib.metadata import version
from typing import Annotated, Any


def main() -> None:
    sys.path.insert(0, sys.argv[1])
    import openproposal as op
    from pydantic import Strict, TypeAdapter, ValidationError

    def type_of(e: dict[str, Any]) -> Any:
        k = e["k"]
        if k == "ref":
            return op.TYPES[e["name"]]
        if k == "boolean":
            return Annotated[bool, Strict()]
        if k == "list":
            return list[type_of(e["item"])]
        if k == "map":
            return dict[type_of(e["key"]), type_of(e["value"])]
        if k == "apply":
            args = tuple(type_of(a) for a in e["args"])
            return op.TEMPLATES[e["template"]][args if len(args) > 1 else args[0]]
        raise ValueError(f"no type for {e!r}")

    doc = json.load(sys.stdin)
    adapters: dict[str, TypeAdapter[Any]] = {}
    out: dict[str, Any] = {"engine": f"Python with Pydantic {version('pydantic')}", "verdicts": [], "dumps": [], "errors": []}
    for case in doc["cases"]:
        key = json.dumps(case["target"], sort_keys=True)
        try:
            if key not in adapters:
                adapters[key] = TypeAdapter(type_of(case["target"]))
            adapter = adapters[key]
        except Exception as e:  # noqa: BLE001 - a type that doesn't build is reported, not raised
            out["verdicts"].append(False)
            out["dumps"].append(None)
            out["errors"].append(f"the type doesn't build: {e}")
            continue
        try:
            value = adapter.validate_json(case["json"])
        except ValidationError:
            out["verdicts"].append(False)
            out["dumps"].append(None)
            out["errors"].append(None)
            continue
        out["verdicts"].append(True)
        try:
            dumped = op.dump(value)
            plain = adapter.dump_python(value, mode="json", exclude_unset=True, by_alias=True)
            out["dumps"].append(dumped)
            out["errors"].append(None if dumped == plain else f"accepted, but op.dump writes {json.dumps(dumped)[:200]} where Pydantic writes {json.dumps(plain)[:200]}")
        except Exception as e:  # noqa: BLE001
            out["dumps"].append(None)
            out["errors"].append(f"accepted, but doesn't dump: {e}")
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
