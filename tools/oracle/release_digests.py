"""Recomputes release manifest digests with rfc8785, independently of the TypeScript pipeline.

Reads {"checks": [{"release": <path>, "schemas": <dir or null>, "model": <path or null>, "rules": <path or null>}]}
on stdin; paths are relative to the working directory. For each check:

- with "schemas": every file the manifest lists exists under the directory, its
  JCS SHA-256 is the listed digest, every file under kernel/, modules/, and
  documents/ is listed, and the digest of {path: schema} over the files is the
  manifest's "digest";
- with "model": the JCS SHA-256 of the model is the manifest's "model";
- with "rules": the JCS SHA-256 of the rules is the manifest's "rules".

Writes {"rfc8785": <version>, "problems": [...]} to stdout.
"""

import hashlib
import importlib.metadata
import json
import os
import sys

import rfc8785

ROOTS = ("kernel", "modules", "documents")


def digest(value):
    return hashlib.sha256(rfc8785.dumps(value)).hexdigest()


def load(path):
    with open(path, "rb") as f:
        return json.loads(f.read().decode("utf-8"))


def tree(directory):
    out = []
    for root in ROOTS:
        base = os.path.join(directory, root)
        for current, _dirs, files in os.walk(base):
            for name in files:
                full = os.path.join(current, name)
                out.append(os.path.relpath(full, directory).replace(os.sep, "/"))
    return sorted(out)


def check(entry, problems):
    release_path = entry["release"]
    manifest = load(release_path)
    listed = manifest["files"]
    if entry.get("schemas") is not None:
        directory = entry["schemas"]
        present = tree(directory)
        schemas = {}
        for path in present:
            if path not in listed:
                problems.append(f"{release_path}: {path} isn't listed")
            schemas[path] = load(os.path.join(directory, path))
            got = digest(schemas[path])
            if path in listed and listed[path]["digest"] != got:
                problems.append(f"{release_path}: {path}: rfc8785 gives {got}, the manifest lists {listed[path]['digest']}")
        for path in listed:
            if path not in schemas:
                problems.append(f"{release_path}: lists {path}, which {directory} lacks")
        got = digest(schemas)
        if got != manifest["digest"]:
            problems.append(f"{release_path}: the tree digest under rfc8785 is {got}, the manifest lists {manifest['digest']}")
    for key in ("model", "rules"):
        if entry.get(key) is not None:
            got = digest(load(entry[key]))
            if got != manifest[key]:
                problems.append(f"{release_path}: the {key} digest under rfc8785 is {got}, the manifest lists {manifest[key]}")


def main():
    request = json.load(sys.stdin)
    problems = []
    for entry in request["checks"]:
        check(entry, problems)
    json.dump({"rfc8785": importlib.metadata.version("rfc8785"), "problems": problems}, sys.stdout)


if __name__ == "__main__":
    main()
