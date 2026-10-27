"""Report the reference oracle's verdicts on instances of the emitted schemas.

The examples gate (scripts/ci.ts) sends {"schemas": [<schema>], "cases":
[{"ref", "value"}]} on stdin and reads {"jsonschema", "referencing",
"verdicts": [<bool>]} from stdout. Each verdict is whether python-jsonschema's
Draft202012Validator, with formats asserted, accepts the case's value against
the schema its `ref` names, resolved with `referencing` in a registry that
holds every schema under its `$id`.

Run it with the interpreter of the venv that tools/oracle/requirements.txt pins.
"""

import json
import sys
from importlib.metadata import version

from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012


def main() -> None:
    doc = json.load(sys.stdin)
    registry = Registry().with_resources(
        (s["$id"], Resource.from_contents(s, default_specification=DRAFT202012)) for s in doc["schemas"]
    )
    validators: dict[str, Draft202012Validator] = {}
    verdicts = []
    for case in doc["cases"]:
        ref = case["ref"]
        if ref not in validators:
            validators[ref] = Draft202012Validator(
                {"$ref": ref}, registry=registry, format_checker=Draft202012Validator.FORMAT_CHECKER
            )
        verdicts.append(validators[ref].is_valid(case["value"]))
    json.dump({"jsonschema": version("jsonschema"), "referencing": version("referencing"), "verdicts": verdicts}, sys.stdout)


if __name__ == "__main__":
    main()
