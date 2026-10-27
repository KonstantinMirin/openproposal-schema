"""Report the verdicts of the classes a plain generator wrote from the schema.

The plain-generator gate (scripts/ci.ts) runs datamodel-code-generator, as
tools/plaingen/requirements.txt pins it, on each published schema file of a
lock, into one module per file of the package `opplain`. It then runs this
with the directory that holds `opplain`, sends {"cases": [{"target",
"json"}]} on stdin, and reads {"engine", "verdicts": [<bool>], "dumps":
[<value>], "errors": [<str or null>]} from stdout.

A case's target is the type its value is an instance of: a named type
(`{"k": "ref", "name", "module"}`), the class of that name in the module
generated from the type's schema file; or a list or map of such types, the
shapes a generator writes for an array and for `propertyNames` with
`additionalProperties`. A plain generator has no generics, so a template
application never reaches this. Each case's JSON text is validated as it is,
as a receiver gets it, and an accepted value is dumped back to JSON.

Run it with the interpreter of the venv that tools/plaingen/requirements.txt
pins.
"""

import importlib
import json
import sys
from importlib.metadata import version
from typing import Any


def main() -> None:
    sys.path.insert(0, sys.argv[1])
    from pydantic import TypeAdapter, ValidationError

    def type_of(e: dict[str, Any]) -> Any:
        k = e["k"]
        if k == "ref":
            module = importlib.import_module(f"opplain.{e['module']}")
            if not hasattr(module, e["name"]):
                raise LookupError(f"the generator wrote no class {e['name']} in {e['module']}.py")
            return getattr(module, e["name"])
        if k == "boolean":
            return bool
        if k == "list":
            return list[type_of(e["item"])]
        if k == "map":
            return dict[type_of(e["key"]), type_of(e["value"])]
        raise ValueError(f"a plain generator has no type for {e!r}")

    doc = json.load(sys.stdin)
    adapters: dict[str, TypeAdapter[Any]] = {}
    engine = f"datamodel-code-generator {version('datamodel-code-generator')} with Pydantic {version('pydantic')}"
    out: dict[str, Any] = {"engine": engine, "verdicts": [], "dumps": [], "errors": []}

    def fail(error: str | None) -> None:
        out["verdicts"].append(False)
        out["dumps"].append(None)
        out["errors"].append(error)

    for case in doc["cases"]:
        key = json.dumps(case["target"], sort_keys=True)
        try:
            if key not in adapters:
                adapters[key] = TypeAdapter(type_of(case["target"]))
            adapter = adapters[key]
        except Exception as e:  # noqa: BLE001 - a type that doesn't build is reported, not raised
            fail(f"the type doesn't build: {e}")
            continue
        try:
            value = adapter.validate_json(case["json"])
        except ValidationError:
            fail(None)
            continue
        except Exception as e:  # noqa: BLE001 - a crash while validating is reported, not raised
            fail(f"validation raised {type(e).__name__}: {e}")
            continue
        out["verdicts"].append(True)
        try:
            out["dumps"].append(adapter.dump_python(value, mode="json", exclude_unset=True, by_alias=True))
            out["errors"].append(None)
        except Exception as e:  # noqa: BLE001
            out["dumps"].append(None)
            out["errors"].append(f"accepted, but doesn't dump: {e}")
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
