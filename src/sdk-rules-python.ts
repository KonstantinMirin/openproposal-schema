/**
 * The Python SDK's rule programs: the evaluator of src/rule-program.ts,
 * ported to Python with the same semantics, which `_rules.py` holds beside
 * the programs and the time zone table every rule check of the tree reads.
 */

/** The evaluator, as Python source; `PROGRAMS` and `ZONES` follow it in the file. */
export const PYTHON_EVALUATOR = `import json
from fractions import Fraction
from typing import Any


def _num(x: Any) -> Any:
    return x if isinstance(x, Fraction) else None


def _from_json(v: Any) -> Any:
    """A JSON value as a program reads it: each number exact, as the decimal it writes."""
    if isinstance(v, bool) or v is None or isinstance(v, str):
        return v
    if isinstance(v, (int, float)):
        return Fraction(str(v)) if isinstance(v, float) else Fraction(v)
    if isinstance(v, list):
        return [_from_json(x) for x in v]
    if isinstance(v, dict):
        return {k: _from_json(x) for k, x in v.items()}
    return None


def _same(a: Any, b: Any) -> bool:
    if isinstance(a, Fraction) or isinstance(b, Fraction):
        return isinstance(a, Fraction) and isinstance(b, Fraction) and a == b
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, list):
        return isinstance(b, list) and len(a) == len(b) and all(_same(x, y) for x, y in zip(a, b))
    if isinstance(a, dict):
        return isinstance(b, dict) and a.keys() == b.keys() and all(_same(a[k], b[k]) for k in a)
    return a == b


def _rat_text(x: Fraction) -> str:
    d, twos, fives = x.denominator, 0, 0
    while d % 2 == 0:
        d, twos = d // 2, twos + 1
    while d % 5 == 0:
        d, fives = d // 5, fives + 1
    if d != 1:
        return f"{x.numerator}/{x.denominator}"
    k = max(twos, fives)
    scaled = abs(x.numerator) * 10**k // x.denominator
    digits = str(scaled).rjust(k + 1, "0")
    text = digits if k == 0 else f"{digits[:-k]}.{digits[-k:]}"
    return f"-{text}" if x.numerator < 0 else text


def _days_from_civil(y: int, m: int, d: int) -> int:
    y -= 1 if m <= 2 else 0
    era = y // 400
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


_decoded: dict[str, tuple[list[int], list[int]]] = {}


def _local_day(seconds: int, zone: str) -> Any:
    """The day number, since 1970-01-01, of the civil date in a zone at an instant, or None for a zone or an instant the table doesn't hold."""
    if seconds < ZONES["from"] or seconds >= ZONES["until"]:
        return None
    key = ZONES["names"].get(zone)
    if key is None:
        return None
    if key not in _decoded:
        offsets, changes = ZONES["zones"][key].split("|")
        values = [int(o, 36) for o in offsets.split(",")]
        t, at, off = ZONES["from"], [], []
        for c in changes.split(" "):
            delta, index = c.split(".")
            t += int(delta, 36)
            at.append(t)
            off.append(values[int(index, 36)])
        _decoded[key] = (at, off)
    at, off = _decoded[key]
    lo, hi = 0, len(at) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if at[mid] <= seconds:
            lo = mid
        else:
            hi = mid - 1
    return (seconds + off[lo]) // 86400


def _instant(x: Any) -> Any:
    import re

    m = re.fullmatch(r"(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})Z", x) if isinstance(x, str) else None
    if m is None:
        return None
    y, mo, d, h, mi, s = (int(g) for g in m.groups())
    return Fraction(_days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s)


def _arith(args: list[Any], f: Any) -> Any:
    acc = _num(args[0]) if args else None
    for x in args[1:]:
        b = _num(x)
        acc = None if acc is None or b is None else f(acc, b)
    return acc


def _eval(e: Any, env: dict[str, Any], vars: dict[str, Any]) -> Any:
    if e is None or isinstance(e, (bool, str)):
        return e
    if isinstance(e, (int, float)):
        return _from_json(e)
    if isinstance(e, dict):
        return _from_json(e)
    op, args = e[0], e[1:]

    def ev(x: Any, more: dict[str, Any] | None = None) -> Any:
        return _eval(x, env, {**vars, **(more or {})})

    if op == "$":
        return env["root"]
    if op == "up":
        return env["up"]
    if op == "given":
        return env["whole"] or (isinstance(env["up"], dict) and args[0] in env["up"])
    if op == "def":
        name = args[0]
        memo = env["memo"]
        if name not in memo:
            memo[name] = _eval(PROGRAMS["defs"][name], env, {})
        return memo[name]
    if op == "var":
        return vars.get(args[0])
    if op == "get":
        x = ev(args[0])
        return x.get(args[1]) if isinstance(x, dict) else None
    if op == "at":
        x, i = ev(args[0]), _num(ev(args[1]))
        return x[int(i)] if isinstance(x, list) and i is not None and i.denominator == 1 and 0 <= i < len(x) else None
    if op == "list":
        return [ev(x) for x in args]
    if op == "table":
        k = ev(args[0])
        return _from_json(args[1][k]) if isinstance(k, str) and k in args[1] else None
    if op == "has":
        x = ev(args[0])
        return isinstance(x, dict) and args[1] in x
    if op == "ismap":
        return isinstance(ev(args[0]), dict)
    if op == "islist":
        return isinstance(ev(args[0]), list)
    if op == "isnum":
        return isinstance(ev(args[0]), Fraction)
    if op == "isstr":
        return isinstance(ev(args[0]), str)
    if op == "eq":
        return _same(ev(args[0]), ev(args[1]))
    if op == "ne":
        return not _same(ev(args[0]), ev(args[1]))
    if op in ("lt", "le", "gt", "ge"):
        a, b = ev(args[0]), ev(args[1])
        if not isinstance(a, Fraction) or not isinstance(b, Fraction):
            return False
        return {"lt": a < b, "le": a <= b, "gt": a > b, "ge": a >= b}[op]
    if op == "and":
        return all(ev(x) is True for x in args)
    if op == "or":
        return any(ev(x) is True for x in args)
    if op == "not":
        return ev(args[0]) is not True
    if op == "if":
        return ev(args[1]) if ev(args[0]) is True else ev(args[2])
    if op == "coalesce":
        for x in args:
            v = ev(x)
            if v is not None:
                return v
        return None
    if op == "add":
        return _arith([ev(x) for x in args], lambda a, b: a + b)
    if op == "sub":
        return _arith([ev(x) for x in args], lambda a, b: a - b)
    if op == "mul":
        return _arith([ev(x) for x in args], lambda a, b: a * b)
    if op == "div":
        return _arith([ev(x) for x in args], lambda a, b: None if b == 0 else a / b)
    if op == "floor":
        x = _num(ev(args[0]))
        return None if x is None else Fraction(x.numerator // x.denominator)
    if op == "len":
        x = ev(args[0])
        return Fraction(len(x)) if isinstance(x, list) else None
    if op == "contains":
        x, y = ev(args[0]), ev(args[1])
        if isinstance(x, str):
            return isinstance(y, str) and y in x
        return isinstance(x, list) and any(_same(z, y) for z in x)
    if op == "concat":
        parts = [ev(x) for x in args]
        return [z for p in parts for z in p] if all(isinstance(p, list) for p in parts) else None
    if op == "values":
        x = ev(args[0])
        return [x[k] for k in sorted(x)] if isinstance(x, dict) else None
    if op == "keys":
        x = ev(args[0])
        return sorted(x) if isinstance(x, dict) else None
    if op in ("filter", "sum", "find"):
        x = ev(args[0])
        if not isinstance(x, list):
            return Fraction(0) if op == "sum" else None
        name = args[1]
        if op == "filter":
            return [y for y in x if ev(args[2], {name: y}) is True]
        if op == "find":
            return next((y for y in x if ev(args[2], {name: y}) is True), None)
        return _arith([Fraction(0)] + [ev(args[2], {name: y}) for y in x], lambda a, b: a + b)
    if op == "instant":
        return _instant(ev(args[0]))
    if op == "local_day":
        t, z = _num(ev(args[0])), ev(args[1])
        if t is None or t.denominator != 1 or not isinstance(z, str):
            return None
        day = _local_day(int(t), z)
        return None if day is None else Fraction(day)
    if op == "str":
        out = []
        for x in args:
            v = ev(x)
            out.append(_rat_text(v) if isinstance(v, Fraction) else "null" if v is None else v if isinstance(v, str) else json.dumps(v))
        return "".join(out)
    raise ValueError(f"no operation {op!r}")


def _check(rule: str, value: Any, holder: Any) -> list[tuple[str, str]]:
    """The violations of one rule on a value of its owner, below it, with its holder's whole value; none where the rule can't decide."""
    p = PROGRAMS["rules"][rule]
    root = _from_json(value)
    env = {"root": root, "up": root if holder is None else _from_json(holder), "whole": True, "memo": {}}
    if "undecided" in p and _eval(p["undecided"], env, {}) is True:
        return []
    out = []
    for v in p["violations"]:
        if _eval(v["when"], env, {}) is not True:
            continue
        m = _eval(v["message"], env, {})
        out.append((v["path"], m if isinstance(m, str) else "violates the rule"))
    return out


def _token(k: str) -> str:
    return k.replace("~", "~0").replace("/", "~1")


def violations(rule: str, value: Any) -> list[tuple[str, str]]:
    """The violations of one rule on a value of the type that runs it, its owner or the owner's holder, each as a JSON pointer below the value and a message."""
    p = PROGRAMS["rules"][rule]
    if p.get("on", p["owner"]) == p["owner"]:
        return _check(rule, value, None)
    out = []
    for place in p.get("at", []):
        here = [("", value)]
        for seg in place:
            nxt = []
            for at, v in here:
                if seg == "*":
                    if isinstance(v, list):
                        nxt.extend((f"{at}/{i}", x) for i, x in enumerate(v))
                    elif isinstance(v, dict):
                        nxt.extend((f"{at}/{_token(k)}", v[k]) for k in sorted(v))
                elif isinstance(v, dict) and seg in v:
                    nxt.append((f"{at}/{_token(seg)}", v[seg]))
            here = nxt
        for at, v in here:
            out.extend((at + path, m) for path, m in _check(rule, v, value))
    return out
`;
