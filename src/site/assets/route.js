// The type map's routes, which map.js and examples.js read, and the site's check and tests load in Node.
// The canonical address of a view is
//   #!/type/<Name>?lock=<lock>&variant=<as-written|proposals>&view=<schema|example>&open=<paths>
// with the parameters in that order and `open` left out when empty. parse() also takes the other names
// below, such as the switches' labels in lowercase with hyphens, and lists every change it makes, so
// the map can rewrite the address in place and say why. Nothing here navigates: a caller writes the
// hash it returns, which keeps the reader on the page they opened. The build fills in the spec's locks, the
// other names its profile gives them, and its variants: both where the spec proposes changes, and else
// the text as written alone.
(function (root) {
  "use strict";
  var LOCKS = __SPEC_LOCKS__;
  var VARIANTS = __SPEC_VARIANTS__;
  var VIEWS = ["schema", "example"];
  var DEFAULT = { type: "__SPEC_DEFAULT_TYPE__", lock: LOCKS[0], variant: "as-written", view: "schema", open: [] };
  // Each parameter's other names, and each value's: the switches' labels, as slugs, and short forms.
  var PARAMS = { lock: "lock", input: "lock", variant: "variant", view: "view", show: "view", open: "open", type: "type" };
  var VARIANT_NAMES = { "as-written": "as-written", written: "as-written", proposals: "proposals", "with-proposals": "proposals", "with-our-proposals": "proposals", proposed: "proposals" };
  var only = function (names, values) {
    var out = {};
    Object.keys(names).forEach(function (k) { if (values.indexOf(names[k]) >= 0) out[k] = names[k]; });
    return out;
  };
  var VALUES = {
    lock: __SPEC_LOCK_NAMES__,
    variant: only(VARIANT_NAMES, VARIANTS),
    view: { schema: "schema", "json-schema": "schema", json: "schema", example: "example", examples: "example", "example-payload": "example", payload: "example" },
  };
  var slug = function (v) { return String(v).trim().toLowerCase().replace(/[\s_]+/g, "-"); };
  var copy = function (s) { return { type: s.type, lock: s.lock, variant: s.variant, view: s.view, open: s.open.slice() }; };
  var decode = function (v) {
    try { return decodeURIComponent(v); } catch (e) { return v; }
  };

  function hashOf(s) {
    return "#!/type/" + encodeURIComponent(s.type) + "?lock=" + s.lock + "&variant=" + s.variant + "&view=" + s.view +
      (s.open.length ? "&open=" + s.open.map(encodeURIComponent).join(",") : "");
  }

  // Reads an address's hash. A hash that isn't a route, such as #main, which names an element of the
  // page, gives { route: false }. Otherwise { route: true, state, changes }, where each change says, in a
  // sentence fragment, what the address wrote and what the map reads instead.
  function parse(hash) {
    var h = String(hash || "").replace(/^#/, "");
    var s = copy(DEFAULT);
    var changes = [];
    if (h === "" || h === "!" || h === "!/") return { route: true, state: s, changes: changes };
    var bang = h.charAt(0) === "!";
    if (bang) h = h.slice(1);
    if (h.charAt(0) === "/") h = h.slice(1);
    else if (!bang) return { route: false };
    if (!bang) changes.push("#/ reads as #!/");
    var at = h.indexOf("?");
    var path = (at < 0 ? h : h.slice(0, at)).split("/").filter(Boolean).map(decode);
    var query = at < 0 ? "" : h.slice(at + 1);

    var typed = false;
    if (path.length === 2 && slug(path[0]) === "type") {
      s.type = path[1];
      typed = true;
      if (path[0] !== "type") changes.push(path[0] + "/ reads as type/");
    } else if (path.length === 1 && slug(path[0]) !== "type") {
      s.type = path[0];
      typed = true;
      changes.push("/" + path[0] + " reads as /type/" + path[0]);
    } else if (path.length > 0) {
      changes.push("/" + path.join("/") + " names no view, so the map opens at " + DEFAULT.type);
    }

    var seen = {};
    new URLSearchParams(query).forEach(function (value, name) {
      var key = PARAMS[slug(name)];
      if (!key) {
        changes.push(name + "=" + value + " is no setting of the map, so it is left out");
        return;
      }
      if (seen[key]) {
        changes.push(name + "=" + value + " repeats " + key + ", so the first one stands");
        return;
      }
      seen[key] = true;
      if (name !== key) changes.push(name + "= reads as " + key + "=");
      if (key === "type") {
        if (typed) changes.push("type=" + value + " is left out, since the path names " + s.type);
        else if (value !== "") s.type = value;
        return;
      }
      if (key === "open") {
        s.open = value.split(",").filter(Boolean);
        return;
      }
      var canonical = VALUES[key][slug(value)];
      if (!canonical) {
        changes.push(key + "=" + value + " names no " + (key === "lock" ? "input" : key) + ", so the map shows " + DEFAULT[key]);
        return;
      }
      if (canonical !== value) changes.push(key + "=" + value + " reads as " + key + "=" + canonical);
      s[key] = canonical;
    });
    return { route: true, state: s, changes: changes };
  }

  // Where a reference across hosts opens: the registry's page of the vocabulary it names, from the build's
  // registry targets, by the registry's own name; null for another absolute reference, so it opens nothing.
  // A reference within the page's own schemas gives undefined, for the caller to resolve.
  function registryHref(registry, ref) {
    var t = registry && Object.prototype.hasOwnProperty.call(registry, ref) ? registry[ref] : null;
    if (t) return t.href;
    return /^https?:/.test(ref) ? null : undefined;
  }
  // Where a reference inside a registry's schema opens: a `#/$defs/<Name>` names a vocabulary of the same
  // registry file, which the registry's type map opens at the lock the spec imports; any other opens nothing.
  function registryInnerHref(target, ref) {
    var m = /^#\/\$defs\/([A-Za-z0-9]+)$/.exec(ref);
    return m ? target.map + hashOf({ type: m[1], lock: target.lock, variant: "as-written", view: "schema", open: [] }) : null;
  }

  root.MapRoute = { LOCKS: LOCKS, VARIANTS: VARIANTS, VIEWS: VIEWS, DEFAULT: DEFAULT, PARAMS: PARAMS, VALUES: VALUES, parse: parse, hashOf: hashOf, registryHref: registryHref, registryInnerHref: registryInnerHref };
})(window);
