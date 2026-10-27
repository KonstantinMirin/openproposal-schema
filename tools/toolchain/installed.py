"""Reports the venv's Python version and each pinned distribution's installed version.

Reads {"pins": [{"name": ..., "marker": ... or null}]} on stdin and writes
{"python": "3.12", "pins": [{"name": ..., "applies": bool, "installed": ... or null}]}.
A marker is evaluated with the packaging copy that pip vendors, so the check
needs nothing beyond the venv itself.
"""

import json
import sys
from importlib import metadata

from pip._vendor.packaging.markers import Marker


def main() -> None:
    request = json.load(sys.stdin)
    out = []
    for pin in request["pins"]:
        applies = pin["marker"] is None or Marker(pin["marker"]).evaluate()
        try:
            installed = metadata.version(pin["name"])
        except metadata.PackageNotFoundError:
            installed = None
        out.append({"name": pin["name"], "applies": applies, "installed": installed})
    json.dump({"python": "%d.%d" % sys.version_info[:2], "pins": out}, sys.stdout)


if __name__ == "__main__":
    main()
