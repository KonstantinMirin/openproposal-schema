"""Report where the Python SDK rejects each payload.

The desk-tests and SDK-locations gates (src/desk-tests.ts,
src/sdk-parity.ts) run this with the path of a lock's generated `python/`
directory and the name of the package it holds, send {"payloads": [{"type",
"json"}]} on stdin, and read {"engine", "findings": [[{"path", "message"}]]}
from stdout, one list per payload, empty where the SDK accepts it. Each
payload is checked as an implementer checks a JSON text, with the package's
`parse_json(type, text)` in its default, strict mode, and each Pydantic
error is reported with its `loc` as the path, which the gates read as a
JSON pointer.

Run it with the interpreter of the venv that tools/sdk/requirements.txt pins.
"""

import importlib
import json
import sys
from importlib.metadata import version
from typing import Any


def main() -> None:
    sys.path.insert(0, sys.argv[1])
    op = importlib.import_module(sys.argv[2])
    from pydantic import ValidationError

    doc = json.load(sys.stdin)
    out: dict[str, Any] = {"engine": f"Python with Pydantic {version('pydantic')}", "findings": []}
    for payload in doc["payloads"]:
        try:
            op.parse_json(payload["type"], payload["json"])
            out["findings"].append([])
        except ValidationError as e:
            out["findings"].append([{"path": list(x["loc"]), "message": x["msg"]} for x in e.errors(include_url=False)])
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
