"""Check emitted schema files as JSON Schema 2020-12 with the reference oracle.

The schema gate (scripts/ci.ts) sends {"schemas": [{"path", "schema"}]} on
stdin and reads {"jsonschema", "referencing", "problems": [...]} from stdout.
For each file it checks that:

- `validator_for` picks Draft 2020-12 from its `$schema`;
- it is a valid 2020-12 schema (`Draft202012Validator.check_schema`);
- every `$ref` in it resolves, with `referencing`, in a registry that holds
  every file under its `$id`.

Run it with the interpreter of the venv that tools/oracle/requirements.txt pins.
"""

import json
import sys
from importlib.metadata import version

from jsonschema import Draft202012Validator, validators
from jsonschema.exceptions import SchemaError
from referencing import Registry, Resource
from referencing.exceptions import Unresolvable
from referencing.jsonschema import DRAFT202012

# Keywords whose value is instance data or names, never a subschema.
DATA = {"const", "enum", "examples", "default", "required", "dependentRequired", "type", "$ref", "$schema", "$id", "description", "title", "pattern", "format"}
NAME_MAPS = {"properties", "patternProperties", "$defs", "dependentSchemas"}


def refs(schema, pointer=""):
    """Every `$ref` in a schema, with its JSON pointer."""
    if not isinstance(schema, dict):
        return
    if isinstance(schema.get("$ref"), str):
        yield pointer, schema["$ref"]
    for key, value in schema.items():
        if key in DATA:
            continue
        if key in NAME_MAPS and isinstance(value, dict):
            for name, sub in value.items():
                yield from refs(sub, f"{pointer}/{key}/{name}")
        elif isinstance(value, list):
            for i, sub in enumerate(value):
                yield from refs(sub, f"{pointer}/{key}/{i}")
        else:
            yield from refs(value, f"{pointer}/{key}")


def main() -> None:
    files = json.load(sys.stdin)["schemas"]
    problems = []
    registry = Registry().with_resources(
        (f["schema"]["$id"], Resource.from_contents(f["schema"], default_specification=DRAFT202012)) for f in files
    )
    for f in files:
        path, schema = f["path"], f["schema"]
        if validators.validator_for(schema, default=None) is not Draft202012Validator:
            problems.append(f"{path}: $schema doesn't select Draft 2020-12")
        try:
            Draft202012Validator.check_schema(schema)
        except SchemaError as e:
            problems.append(f"{path}: not a valid 2020-12 schema: {e.message} at {'/'.join(map(str, e.absolute_path))}")
        resolver = registry.resolver(base_uri=schema["$id"])
        for pointer, ref in refs(schema):
            try:
                resolver.lookup(ref)
            except Unresolvable as e:
                problems.append(f"{path} at {pointer or '/'}: $ref {ref} doesn't resolve: {e}")
    json.dump({"jsonschema": version("jsonschema"), "referencing": version("referencing"), "problems": problems}, sys.stdout)


if __name__ == "__main__":
    main()
