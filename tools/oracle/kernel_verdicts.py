"""Report the reference oracle's and Python `re`'s verdicts on the kernel vectors.

The kernel gate (scripts/ci.ts) sends {"cases": [{"schema", "pattern", "value"}]}
on stdin and reads {"jsonschema", "python", "verdicts": [...]} from stdout.
Each verdict holds:

- "oracle": python-jsonschema's Draft202012Validator with formats asserted;
- "re": `re.search(pattern, value)`, as python-jsonschema runs `pattern`;
- "re_anchored": the same with the final `$` written as `\\Z`, which matches
  only at the end of the string, as ECMA-262's `$` does.

"re" and "re_anchored" are null when the case has no pattern or the value
isn't a string. Run it with the interpreter of the venv that
tools/oracle/requirements.txt pins.
"""

import json
import platform
import re
import sys
from importlib.metadata import version

from jsonschema import Draft202012Validator


def anchored(pattern: str) -> str:
    """The pattern with its final end anchor written as `\\Z`."""
    body = pattern[:-1]
    backslashes = len(body) - len(body.rstrip("\\"))
    if not pattern.endswith("$") or backslashes % 2 == 1:
        raise ValueError(f"pattern doesn't end with an anchor: {pattern!r}")
    return body + r"\Z"


def main() -> None:
    cases = json.load(sys.stdin)["cases"]
    validators: dict[str, Draft202012Validator] = {}
    verdicts = []
    for case in cases:
        key = json.dumps(case["schema"], sort_keys=True)
        if key not in validators:
            Draft202012Validator.check_schema(case["schema"])
            validators[key] = Draft202012Validator(case["schema"], format_checker=Draft202012Validator.FORMAT_CHECKER)
        value, pattern = case["value"], case.get("pattern")
        regex = pattern is not None and isinstance(value, str)
        verdicts.append(
            {
                "oracle": validators[key].is_valid(value),
                "re": bool(re.search(pattern, value)) if regex else None,
                "re_anchored": bool(re.search(anchored(pattern), value)) if regex else None,
            }
        )
    json.dump({"jsonschema": version("jsonschema"), "python": platform.python_version(), "verdicts": verdicts}, sys.stdout)


if __name__ == "__main__":
    main()
