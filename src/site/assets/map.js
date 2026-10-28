// The type map: how the generated types compose, for one of four builds (an input and a variant).
// Every view is a route, #!/type/<Name>?lock=<lock>&variant=<variant>&view=<schema|example>&open=<paths>,
// so the back and forward buttons work and every view is a link to share. route.js reads and writes
// the routes; this file only ever writes the hash, so no address takes the reader off this page.
(function () {
  "use strict";
  var VARIANTS = { "as-written": "As written", proposals: "With our proposals" };
  // How the pages name each lock, from the spec's profile: its label, and the phrase that places a type on it.
  var LOCK_NAMES = __SPEC_LOCK_LABELS__;
  var DEFAULT = window.MapRoute.DEFAULT;
  var hashOf = window.MapRoute.hashOf;
  var KINDS = { primitive: "Primitive", constructor: "Constructor", part: "Part", vocabulary: "Vocabulary", copy: "Copy", object: "Object", union: "Union", document: "Document", profile: "Profile" };
  var COLS = [
    [1, "Primitives", "Grouped by value domain."],
    [2, "Constructors and parts", "Templates (italic) and the copies built from primitives only."],
    [3, "Vocabularies", "Value lists, and copies over a vocabulary."],
    [4, "Objects, unions, and copies", "Named structures built from the layers below."],
    [5, "Documents and profiles", "What a payload is."],
  ];

  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var code = function (s) { return esc(s).replace(/`([^`]+)`/g, "<code>$1</code>"); };
  var canon = function (v) {
    if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
    if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ":" + canon(v[k]); }).join(",") + "}";
    return JSON.stringify(v);
  };
  var pascal = function (s) { return String(s).replace(/\[\]/g, "").split(/[_\W]+/).filter(Boolean).map(function (w) { return w[0].toUpperCase() + w.slice(1); }).join(""); };

  var cache = {};
  var B = null; // the build shown
  var byName, copies, deps, users, changed, added, state = null, shownBuild = null;

  // ---- routes ----
  function go(next, replace) {
    var s = Object.assign({}, state || DEFAULT, next);
    var h = hashOf(s);
    if (replace) {
      history.replaceState(null, "", h);
      route();
    } else if (location.hash === h) route();
    else location.hash = h;
  }

  // ---- data ----
  function load(lock, variant) {
    var k = lock + "." + variant;
    if (!cache[k]) cache[k] = fetch("data/" + k + ".json").then(function (r) {
      if (!r.ok) throw new Error("data/" + k + ".json: " + r.status);
      return r.json();
    });
    return cache[k];
  }
  function index(b) {
    B = b;
    byName = new Map(b.types.map(function (t) { return [t.name, t]; }));
    copies = new Map();
    b.types.forEach(function (t) {
      if (t.kind === "copy") { var k = canon(t.of); copies.set(k, (copies.get(k) || []).concat([t.name])); }
    });
    deps = new Map(b.types.map(function (t) { return [t.name, typeDeps(t)]; }));
    users = new Map(b.types.map(function (t) { return [t.name, []]; }));
    deps.forEach(function (ds, n) { ds.forEach(function (d) { users.get(d).push(n); }); });
    changed = new Set(b.differences.map(function (d) { return d.type; }));
    added = new Set(b.added);
  }
  function copyFor(expr, hint) {
    var list = copies.get(canon(expr));
    if (!list) return null;
    if (list.length === 1 || !hint) return list[0];
    return list.find(function (n) { return n.indexOf(pascal(hint)) === 0; }) || list[0];
  }
  function exprDeps(e, hint) {
    if (!e) return [];
    if (e.kind === "named") return [e.name];
    if (e.kind === "apply") {
      var c = copyFor(e, hint);
      if (c) return [c];
      return [e.constructor].concat(Object.values(e.arguments || {}).flatMap(function (a) { return exprDeps(a); }));
    }
    return [];
  }
  function shellCtors(s, out) {
    out = out || [];
    if (Array.isArray(s)) s.forEach(function (x) { shellCtors(x, out); });
    else if (s && typeof s === "object") {
      if (s.kind === "apply" && s.constructor) out.push(s.constructor);
      Object.values(s).forEach(function (v) { shellCtors(v, out); });
    }
    return out;
  }
  function typeDeps(t) {
    var d = [];
    if (t.properties) Object.entries(t.properties).forEach(function (kv) { d.push.apply(d, exprDeps(kv[1].type, kv[0])); });
    if (t.includes) d.push(t.includes);
    if (t.kind === "profile") d.push(t.document);
    if (t.kind === "union") t.any_of.forEach(function (v) { d.push.apply(d, exprDeps(v, t.name)); });
    if (t.kind === "copy") d.push.apply(d, [t.of.constructor].concat(Object.values(t.of.arguments).flatMap(function (a) { return exprDeps(a); })));
    if (["primitive", "constructor", "part", "vocabulary"].indexOf(t.kind) >= 0) d.push.apply(d, t.references || []);
    if (t.kind === "constructor") d.push.apply(d, shellCtors(t.shell));
    return Array.from(new Set(d)).filter(function (n) { return n !== t.name && byName.has(n); });
  }
  function closure(start, graph) {
    var seen = new Set(), stack = (graph.get(start) || []).slice();
    while (stack.length) { var n = stack.pop(); if (seen.has(n)) continue; seen.add(n); stack.push.apply(stack, graph.get(n) || []); }
    return seen;
  }

  // ---- rendering ----
  function kindClass(k) { return "k-" + k; }
  function link(n) {
    var t = byName.get(n);
    return t ? '<a class="t ' + kindClass(t.kind) + '" href="' + esc(hashOf(Object.assign({}, state, { type: n, open: [] }))) + '">' + esc(n) + "</a>" : "<span>" + esc(n) + "</span>";
  }
  function chip(n) {
    var t = byName.get(n);
    var cls = "chip " + t.kind + " " + kindClass(t.kind) + (added.has(n) ? " added" : "") + (changed.has(n) ? " changed" : "");
    return '<a class="' + cls + '" data-n="' + esc(n) + '" href="' + esc(hashOf(Object.assign({}, state, { type: n, open: [] }))) + '" title="' + esc(KINDS[t.kind]) + (t.application ? ": " + esc(t.application) : "") + '">' + esc(n) + "</a>";
  }
  function renderLayers() {
    var host = $("#layers");
    host.querySelectorAll(".col").forEach(function (e) { e.remove(); });
    COLS.forEach(function (c) {
      var layer = c[0];
      var ts = B.types.filter(function (t) { return t.layer === layer; });
      var grp = function (t) { return layer <= 2 && t.kind !== "copy" && t.kind !== "constructor" && B.domains[t.name] ? B.domains[t.name].domain : t.module; };
      var mods = Array.from(new Set(ts.map(grp))).sort(function (a, b) { return a === "kernel" ? 1 : b === "kernel" ? -1 : a.localeCompare(b); });
      var col = document.createElement("div");
      col.className = "col";
      col.innerHTML = "<h3>" + layer + " · " + c[1] + ' <span class="note">(' + ts.length + ')</span></h3><p class="hint">' + c[2] + "</p>" +
        mods.map(function (m) {
          return '<div class="mod">' + esc(m) + '</div><div class="chips">' + ts.filter(function (t) { return grp(t) === m; })
            .sort(function (a, b) { return (a.kind === "copy") - (b.kind === "copy") || a.name.localeCompare(b.name); })
            .map(function (t) { return chip(t.name); }).join("") + "</div>";
        }).join("");
      host.appendChild(col);
    });
    var counts = Object.create(null);
    B.types.forEach(function (t) { counts[t.kind] = (counts[t.kind] || 0) + 1; });
    $("#legend").innerHTML = Object.keys(KINDS).map(function (k) { return '<span class="' + kindClass(k) + '">' + KINDS[k] + " (" + (counts[k] || 0) + ")</span>"; }).join("");
    var added = $("#addedkey");
    if (added) added.hidden = state.lock === DEFAULT.lock;
  }
  function highlight() {
    var sel = state.type, host = $("#layers"), down = closure(sel, deps), up = closure(sel, users), d1 = new Set(deps.get(sel)), u1 = new Set(users.get(sel));
    host.classList.add("focus");
    host.querySelectorAll(".chip").forEach(function (c) {
      var n = c.getAttribute("data-n");
      c.classList.toggle("sel", n === sel); c.classList.toggle("down", down.has(n)); c.classList.toggle("up", up.has(n));
      c.classList.toggle("d1", d1.has(n)); c.classList.toggle("u1", u1.has(n));
      c.setAttribute("href", hashOf(Object.assign({}, state, { type: n, open: [] })));
    });
    drawEdges();
  }
  function drawEdges() {
    var host = $("#layers"), svg = $("#edges"), base = host.getBoundingClientRect(), sel = state.type;
    var rect = function (n) {
      var e = host.querySelector('.chip[data-n="' + CSS.escape(n) + '"]');
      if (!e) return null;
      var r = e.getBoundingClientRect();
      return { l: r.left - base.left, r: r.right - base.left, y: r.top - base.top + r.height / 2, cx: r.left - base.left + r.width / 2 };
    };
    var s = rect(sel);
    if (!s) { svg.innerHTML = ""; return; }
    var path = function (a, b, cls) {
      var x1, x2, c1, c2;
      if (Math.abs(a.cx - b.cx) < 60) { x1 = a.r; x2 = b.r; c1 = c2 = Math.max(x1, x2) + 40; }
      else if (a.cx < b.cx) { x1 = a.r; x2 = b.l; c1 = c2 = x1 + (x2 - x1) / 2; }
      else { x1 = a.l; x2 = b.r; c1 = c2 = x1 - (x1 - x2) / 2; }
      return '<path class="' + cls + '" d="M' + x1 + "," + a.y + " C" + c1 + "," + a.y + " " + c2 + "," + b.y + " " + x2 + "," + b.y + '"/>';
    };
    var out = "";
    deps.get(sel).forEach(function (d) { var r = rect(d); if (r) out += path(r, s, "dep"); });
    users.get(sel).forEach(function (u) { var r = rect(u); if (r) out += path(s, r, "use"); });
    svg.innerHTML = out;
  }

  // ---- type expressions and the composition tree ----
  function label(e, hint, nested) {
    if (!e) return "";
    if (nested && e.kind === "apply") { var c0 = copyFor(e, hint); if (c0) return link(c0); }
    if (e.kind === "named") return link(e.name);
    if (e.kind === "boolean") return "<span>boolean</span>";
    if (e.kind === "apply") {
      var args = Object.entries(e.arguments || {}).map(function (kv) { return (kv[0] === "B" ? "B=" : "") + label(kv[1], null, true); }).join(", ");
      var c = copyFor(e, hint);
      return link(e.constructor) + "&lt;" + args + "&gt;" + (c ? ' <span class="note">=</span> ' + link(c) : "");
    }
    if (e.kind === "shell") return "full form of " + link(e.ctor);
    if (e.kind === "schema") return "<span>" + esc(JSON.stringify(e.schema)) + "</span>";
    return esc(JSON.stringify(e));
  }
  function subst(e, env) {
    if (!e) return e;
    if (e.kind === "parameter") return env[e.name];
    if (e.kind === "apply") return Object.assign({}, e, { arguments: Object.fromEntries(Object.entries(e.arguments).map(function (kv) { return [kv[0], subst(kv[1], env)]; })) });
    return e;
  }
  function shellExpr(s, env) {
    if (s && s.$model) return subst(s.$model, env);
    if (s && s.$ref) return { kind: "named", name: s.$ref.split("/").pop() };
    if (s && s.items) return { kind: "apply", constructor: "List", arguments: { T: shellExpr(s.items, env) } };
    return { kind: "schema", schema: s };
  }
  function shellRows(s, env) {
    var rows = [];
    if (s.anyOf) s.anyOf.forEach(function (v, i) { rows.push({ label: i ? "or" : "either", expr: shellExpr(v, env) }); });
    if (s.properties) Object.entries(s.properties).forEach(function (kv) { rows.push({ label: kv[0], expr: shellExpr(kv[1], env), hint: kv[0], presence: (s.required || []).indexOf(kv[0]) >= 0 ? "required" : "optional", desc: kv[1].description }); });
    if (s.minProperties) rows.push({ note: "at least " + s.minProperties + " member" + (s.minProperties > 1 ? "s" : "") });
    return rows;
  }
  function rowsOf(e, hint) {
    if (!e) return [];
    if (e.kind === "named") {
      var t = byName.get(e.name);
      if (!t) return [];
      if (["object", "document", "profile"].indexOf(t.kind) >= 0) {
        var rows = [];
        if (t.includes) rows.push({ label: "includes", expr: { kind: "named", name: t.includes }, note: "every field of it" });
        Object.entries(t.properties || {}).forEach(function (kv) { rows.push({ label: kv[0], expr: kv[1].type, hint: kv[0], marker: kv[1].marker, presence: kv[1].presence, desc: kv[1].description, owner: t.name }); });
        if (t.open && !Object.keys(t.properties || {}).length && !t.includes) rows.push({ note: "An open object: the specification names no members, so the schema accepts any." });
        return rows;
      }
      if (t.kind === "union") return t.any_of.map(function (v, i) { return { label: i ? "or" : "either", expr: v, hint: t.name }; });
      if (t.kind === "copy") return rowsOf(t.of, t.name);
      if (t.kind === "part") return shellRows(t.schema, {});
      return [];
    }
    if (e.kind === "apply") {
      var c = byName.get(e.constructor);
      if (!c) return [];
      var env = e.arguments || {};
      if (e.constructor === "List") return rowsOf(env.T, hint);
      if (e.constructor === "Map") return [{ label: "keys", expr: env.K }, { label: "values", expr: env.V }];
      if (env.B) return [{ label: "either", expr: env.B, note: "the bare value" }, { label: "or", expr: { kind: "shell", ctor: e.constructor, env: env } }];
      return shellRows(c.shell, env);
    }
    if (e.kind === "shell") return shellRows(byName.get(e.ctor).shell, e.env);
    return [];
  }
  function constraintText(s) {
    if (!s) return "";
    var p = [];
    if (s.type) p.push(s.type);
    if (s.format) p.push("format " + s.format);
    if (s.pattern) p.push("pattern " + s.pattern);
    if (s.minimum !== undefined) p.push("≥ " + s.minimum);
    if (s.maximum !== undefined) p.push("≤ " + s.maximum);
    if (s.maxLength !== undefined) p.push("max length " + s.maxLength);
    if (s.enum) p.push(s.enum.join(" | "));
    return p.join(", ");
  }
  function inlineInfo(e) {
    if (!e || e.kind !== "named") return "";
    var t = byName.get(e.name);
    if (!t) return "";
    if (t.kind === "vocabulary") {
      var terms = t.terms.map(function (x) { return x.value; });
      return '<span class="terms">' + esc(terms.slice(0, 8).join(" | ")) + (terms.length > 8 ? " | +" + (terms.length - 8) : "") + "</span>" + (t.open ? ' <span class="badge open">open</span>' : "");
    }
    if (t.kind === "primitive") return '<span class="terms">' + esc(constraintText(t.schema)) + "</span>";
    if (t.kind === "object" && t.open) return ' <span class="badge open">open</span>';
    return "";
  }
  var ROWS = new Map(), rowSeq = 0;
  function diffOf(owner, member) {
    return B.differences.find(function (d) { return d.type === owner && d.member === member; });
  }
  function rowHtml(r, path, at) {
    if (!r.expr) return '<li><div class="row"><span class="tog"></span><span class="note">' + esc(r.note) + "</span></div></li>";
    var named = r.expr.kind === "named" ? r.expr.name : null;
    var cyc = named && path.indexOf(named) >= 0;
    var has = !cyc && rowsOf(r.expr, r.hint).length > 0;
    var id = "r" + rowSeq++;
    ROWS.set(id, { r: r, path: named ? path.concat([named]) : path, at: at });
    var dif = r.owner ? diffOf(r.owner, r.label) : null;
    return '<li><div class="row"><button class="tog" type="button" data-id="' + id + '" ' + (has ? "" : "disabled") + ' aria-expanded="false" aria-label="Expand ' + esc(r.label || named || "") + '">' + (has ? "▸" : cyc ? "↻" : "·") + "</button>" +
      '<span class="key">' + esc(r.label) + '</span><span class="ty">' + label(r.expr, r.hint) + "</span>" + inlineInfo(r.expr) +
      (r.presence === "required" ? ' <span class="badge req">required</span>' : "") +
      (r.marker ? ' <span class="badge">' + esc(r.marker) + "</span>" : "") +
      (dif ? ' <a class="badge prop" href="decisions/' + dif.decision + '.html" title="This member differs between the variants">' + esc(dif.decision) + "</a>" : "") +
      (r.note ? ' <span class="note">' + esc(r.note) + "</span>" : "") +
      (r.desc ? '<div class="desc">' + code(r.desc) + "</div>" : "") + '</div><div class="kids"></div></li>';
  }
  function expand(btn, open, quiet) {
    var li = btn.closest("li"), kids = li.querySelector(":scope > .kids"), x = ROWS.get(btn.getAttribute("data-id"));
    var isOpen = btn.getAttribute("aria-expanded") === "true";
    if (open === undefined) open = !isOpen;
    if (open && !kids.innerHTML) kids.innerHTML = "<ul>" + rowsOf(x.r.expr, x.r.hint).map(function (y) { return rowHtml(y, x.path, x.at ? x.at + "/" + y.label : y.label); }).join("") + "</ul>";
    kids.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    btn.textContent = open ? "▾" : "▸";
    if (!quiet && x.at) {
      var set = new Set(state.open);
      if (open) set.add(x.at); else set.forEach(function (p) { if (p === x.at || p.indexOf(x.at + "/") === 0) set.delete(p); });
      go({ open: Array.from(set).sort() }, true);
    }
  }
  function renderTree() {
    ROWS.clear();
    $("#tree").innerHTML = "<ul>" + rowHtml({ label: "", expr: { kind: "named", name: state.type } }, [], "") + "</ul>";
    var top = $("#tree .tog");
    if (top && !top.disabled) expand(top, true, true);
    // Reopen the paths the route names, shortest first, so each parent exists before its child.
    state.open.slice().sort(function (a, b) { return a.split("/").length - b.split("/").length; }).forEach(function (p) {
      var hit = null;
      ROWS.forEach(function (x, id) { if (x.at === p) hit = id; });
      var btn = hit && document.querySelector('.tog[data-id="' + hit + '"]');
      if (btn && !btn.disabled) expand(btn, true, true);
    });
  }

  // ---- the detail panel ----
  function sourceHtml(id) {
    var s = B.sources[id];
    if (!s) return "<li><code>" + esc(id) + "</code></li>";
    var links = s.links.map(function (l) { return '<a href="' + esc(l.href) + '">' + esc(l.text) + "</a>"; }).join(", ");
    return '<li class="src"><details><summary title="' + esc(s.quote.text) + '"><span class="src-label">' + code(s.label) + "</span>" + (links ? ' <span class="src-links">' + links + "</span>" : ' <span class="note">no link</span>') + "</summary><blockquote>" + s.quote.html + "</blockquote>" + (s.note ? '<p class="note">' + esc(s.note) + "</p>" : "") + '<p class="note"><code>' + esc(id) + "</code></p></details></li>";
  }
  function decisionHtml(id) {
    var d = B.decisions[id];
    if (!d) return '<a href="decisions/' + id + '.html">' + esc(id) + "</a>";
    return '<li><a href="decisions/' + id + '.html">' + esc(id) + "</a> " + (d.kind === "gap" ? '<span class="tag gap">Gap</span>' : '<span class="tag prop">Proposal</span>') + " " + code(d.question) + (d.number ? ' <span class="note">decision ' + d.number + " on the supporting page of __SPEC_ISSUE__</span>" : "") + "</li>";
  }
  // What an open vocabulary takes beyond its terms: a vendor's code where its list reserves codes for vendors, and else a namespaced term.
  function openNote(t) {
    var vendor = t.vendor || (t.list && t.list.vendor);
    return vendor ? "Open: a vendor-specific code, " + vendor.from + " or more, is also accepted." : "Open: a namespaced term <code>&lt;domain&gt;:&lt;term&gt;</code> is also accepted.";
  }
  function refHref(ref) {
    var m = /#\/\$defs\/([A-Za-z0-9]+)$/.exec(ref);
    var name = m ? m[1] : null;
    if (!name) {
      var file = ref.split("#")[0].split("/").pop();
      Object.keys(B.emitted).forEach(function (n) { if (B.emitted[n].file.split("/").pop() === file && byName.has(n) && byName.get(n).layer === 5) name = n; });
    }
    return name && byName.has(name) ? hashOf(Object.assign({}, state, { type: name, open: [] })) : null;
  }
  function renderDetail() {
    var sel = state.type, t = byName.get(sel), em = B.emitted[sel];
    var desc = t.description || (em && em.schema.description) || "";
    var dm = B.domains[t.name];
    var h = "<h2>" + esc(t.name) + '<span class="kindtag ' + kindClass(t.kind) + '">' + KINDS[t.kind] + '</span></h2><div class="meta">layer ' + t.layer + " · module " + esc(t.module) + (dm ? " · domain " + esc(dm.domain) + " · concept " + esc(dm.concept) : "") + (t.open ? " · open" : "") + "</div>";
    if (dm && dm.meaning) h += "<p><b>Meaning:</b> " + code(dm.meaning) + "</p>";
    if (desc) h += "<p>" + code(desc) + "</p>";
    var diffs = B.differences.filter(function (d) { return d.type === sel; });
    if (diffs.length) {
      h += '<div class="diffs"><p><b>This type differs between the variants.</b> ' + (state.variant === "as-written" ? "With our proposals:" : "As written:") + "</p><ul>" + diffs.map(function (d) {
        var other = state.variant === "as-written" ? d.from : d.to;
        var what = d.change === "withheld" ? (state.variant === "as-written" ? "<code>" + esc(d.member) + "</code> is added, a <code>" + esc(d.from) + "</code>" : "<code>" + esc(d.member) + "</code> is left out") : (d.member ? "<code>" + esc(d.member) + "</code> is " : "this type is ") + "<code>" + esc(other) + "</code>";
        return "<li>" + what + ' (<a href="decisions/' + d.decision + '.html">' + d.decision + "</a>)</li>";
      }).join("") + "</ul></div>";
    }
    if (t.kind === "copy") h += '<h4>Application</h4><p class="ty">' + label(t.of, t.name) + '</p><p class="note">A concrete copy of the template. The schema holds no template, only this expanded object.</p>';
    if (t.kind === "constructor") {
      h += "<h4>Parameters</h4><ul>" + t.parameters.map(function (p) { return "<li><code>" + esc(p.name) + "</code>" + (p.optional ? " (optional)" : "") + ", accepts <i>" + esc(p.accepts) + "</i>: " + code(p.description) + "</li>"; }).join("") + "</ul>";
      var cs = B.types.filter(function (x) { return x.kind === "copy" && x.of.constructor === t.name; });
      if (cs.length) h += "<h4>Copies (" + cs.length + ')</h4><div class="chips">' + cs.map(function (x) { return chip(x.name); }).join("") + "</div>";
    }
    // An integer-coded vocabulary lists each code with its name, as its schema titles it.
    var named = B.codes && B.codes[t.name];
    if (t.kind === "vocabulary") h += "<h4>Terms (" + t.terms.length + ")" + (t.open ? ", open" : "") + "</h4>" + (named ? '<ul class="codes">' + named.map(function (c) { return "<li><code>" + esc(c.value) + "</code> " + esc(c.title) + "</li>"; }).join("") + "</ul>" : '<p class="terms">' + esc(t.terms.map(function (x) { return x.value; }).join(" | ")) + "</p>") + (t.open ? '<p class="note">' + openNote(t) + "</p>" : "") + (t.attribute === "marker" ? '<p class="note">A mutability marker: the rules use it, and the schema never carries it.</p>' : "");
    if (t.kind === "profile") h += '<h4>Projected from</h4><div class="chips">' + chip(t.document) + '</div><h4>Paths</h4><p class="terms">' + esc(t.paths.join(", ")) + "</p>";
    var d = deps.get(sel), u = users.get(sel);
    h += "<h4>Built from (" + d.length + ")</h4>" + (d.length ? '<div class="chips">' + d.map(chip).join("") + "</div>" : '<p class="note">Nothing: a base type.</p>');
    h += "<h4>Used by (" + u.length + ")</h4>" + (u.length ? '<div class="chips">' + u.map(chip).join("") + "</div>" : '<p class="note">Nothing in the model uses it directly.</p>');
    var rules = B.rules.filter(function (r) { return r.owner === sel; });
    if (rules.length) h += "<h4>Rules beyond the schema (" + rules.length + ")</h4><ul>" + rules.map(function (r) { return "<li>" + code(r.statement || r.id) + (r.severity === "warning" ? ' <span class="badge">SHOULD</span>' : "") + "</li>"; }).join("") + "</ul>";
    if (t.decisions && t.decisions.length) h += "<h4>Decision records (" + t.decisions.length + ")</h4><ul>" + t.decisions.map(decisionHtml).join("") + "</ul>";
    var own = t.sources || [];
    if (own.length) h += "<h4>Specification lines it rests on</h4><ul class=\"sources\">" + own.map(sourceHtml).join("") + "</ul>";
    if (t.properties) {
      var members = Object.entries(t.properties).filter(function (kv) { return kv[1].sources.some(function (s) { return own.indexOf(s) < 0; }); });
      if (members.length) h += "<details><summary><b>Its members' lines</b> (" + members.length + ')</summary><ul class="sources">' + members.map(function (kv) { return "<li><code>" + esc(kv[0]) + '</code><ul class="sources">' + kv[1].sources.filter(function (s) { return own.indexOf(s) < 0; }).map(sourceHtml).join("") + "</ul></li>"; }).join("") + "</ul></details>";
    }
    h += '<div class="panel-head"><h4>' + (state.view === "schema" ? "JSON Schema" : "Example payload") + '</h4><div class="seg" role="group" aria-label="Show"><button type="button" data-view="schema" aria-pressed="' + (state.view === "schema") + '">Schema</button><button type="button" data-view="example" aria-pressed="' + (state.view === "example") + '">Example</button></div></div><div id="panel"></div>';
    $("#detail").innerHTML = h;
    renderPanel(t, em);
  }
  function renderPanel(t, em) {
    var host = $("#panel");
    if (state.view === "schema") {
      if (!em) {
        host.innerHTML = '<p class="note">' + (t.kind === "constructor" ? "A template has no schema of its own; the schema holds its copies." : "The schema doesn't emit this type as its own definition" + (t.attribute === "marker" ? ": it lists a mutability marker, which a rule reads." : ".")) + "</p>";
        return;
      }
      var p = document.createElement("p");
      p.className = "note";
      p.innerHTML = 'In <a href="' + esc(em.file) + '"><code>' + esc(em.file) + "</code></a>, on this site. Each <code>$ref</code> opens the type it names.";
      host.appendChild(p);
      var box = document.createElement("div");
      host.appendChild(box);
      window.JsonTree.render(box, em.schema, { open: 2, refHref: refHref });
      return;
    }
    var x = B.examples[t.name];
    if (!x) {
      host.innerHTML = '<p class="note">' + (t.kind === "constructor" ? "A template has no payload of its own. Open one of its copies." : "No example: the schema doesn't emit this type on its own.") + "</p>";
      return;
    }
    var intro = document.createElement("p");
    intro.className = "note";
    intro.textContent = "Every member, one item per list, and one key per map. Values come from the specification's own examples where the schema accepts them, and else are illustrative. The payload is valid against the schema, and breaks no rule one payload decides.";
    host.appendChild(intro);
    var box2 = document.createElement("div");
    host.appendChild(box2);
    window.JsonTree.render(box2, x.full, { open: 2 });
    var more = "";
    if (x.notes && x.notes.length) more += '<p class="note">Where the example holds less than every member:</p><ul class="notes">' + x.notes.map(function (n) { return "<li><code>" + esc(n.path) + "</code> " + (n.holds === "omitted" ? "is left out" : "holds its minimal value") + ": " + code(n.reason) + "</li>"; }).join("") + "</ul>";
    if (x.illustrative && x.illustrative.length) more += '<p class="note">Illustrative values, ours and not the specification\'s:</p><ul class="notes">' + x.illustrative.map(function (n) { return "<li><code>" + esc(n.path) + "</code>: " + code(n.note) + "</li>"; }).join("") + "</ul>";
    if (x.undecided && x.undecided.length) more += '<p class="note">Rules that can\'t decide on this payload alone: ' + x.undecided.map(function (u) { return "<code>" + esc(u.rule) + "</code> at <code>" + esc(u.path || "/") + "</code>"; }).join(", ") + ".</p>";
    if (more) { var m = document.createElement("div"); m.innerHTML = more; host.appendChild(m); }
  }

  function setNotice(text) {
    var n = $("#notice");
    n.textContent = text;
    n.hidden = !text;
  }
  function info() {
    var b = B.input;
    // A lock that merges open PRs names its base by the default lock's label.
    $("#buildinfo").textContent = (b.prs.length === 0 ? LOCK_NAMES[state.lock].label + " at " + b.commit.slice(0, 7) : LOCK_NAMES[DEFAULT.lock].label + " at " + (b.base || "").slice(0, 7) + " with " + b.prs.length + " open PRs") + " · " + VARIANTS[state.variant] + " · " + B.types.length + " types";
    document.querySelectorAll(".switches button[data-lock]").forEach(function (x) { x.setAttribute("aria-pressed", String(x.getAttribute("data-lock") === state.lock)); });
    document.querySelectorAll(".switches button[data-variant]").forEach(function (x) { x.setAttribute("aria-pressed", String(x.getAttribute("data-variant") === state.variant)); });
  }

  // The notice for an address the map rewrote: what it wrote, and what the map reads instead.
  function rewritten(changes) {
    return changes.length ? "The map rewrote this address: " + changes.join("; ") + "." : "";
  }

  var routing = 0;
  function route() {
    var p = window.MapRoute.parse(location.hash);
    // A hash that is no route, such as #main from the skip link, names an element of the page: keep the view.
    if (!p.route) {
      if (state) return;
      p = { route: true, state: window.MapRoute.parse("").state, changes: [] };
    }
    var s = p.state, changes = p.changes.slice();
    var mine = ++routing;
    load(s.lock, s.variant).then(function (b) {
      if (mine !== routing) return;
      var key = s.lock + "." + s.variant;
      if (shownBuild !== key) index(b);
      if (!byName.has(s.type)) {
        var lower = s.type.toLowerCase();
        var near = B.types.find(function (x) { return x.name.toLowerCase() === lower; });
        if (near) changes.push(s.type + " reads as " + near.name);
        else changes.push("there is no type " + s.type + " " + LOCK_NAMES[s.lock].where + ", " + VARIANTS[s.variant].toLowerCase() + ", so the map opens at " + DEFAULT.type);
        s = Object.assign({}, s, { type: near ? near.name : DEFAULT.type, open: near ? s.open : [] });
      }
      var msg = rewritten(changes);
      if (location.hash !== hashOf(s)) history.replaceState(null, "", hashOf(s));
      var same = state && shownBuild === key && state.type === s.type && state.view === s.view && canon(state.open) === canon(s.open);
      state = s;
      setNotice(msg);
      if (same) return;
      if (shownBuild !== key) { shownBuild = key; renderLayers(); }
      info();
      highlight();
      renderTree();
      renderDetail();
      document.title = s.type + " · Type map · __SPEC_NAME__ JSON Schema";
    }).catch(function (e) {
      setNotice("The map's data didn't load: " + e.message + ". Serve the site over HTTP, not from a file.");
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.addEventListener("click", function (ev) {
      var tog = ev.target.closest(".tog[data-id]");
      if (tog && !tog.disabled) { expand(tog); return; }
      var v = ev.target.closest("[data-view]");
      if (v) { go({ view: v.getAttribute("data-view") }); return; }
      var b = ev.target.closest(".switches button");
      if (b) {
        var next = b.getAttribute("data-lock") ? { lock: b.getAttribute("data-lock") } : { variant: b.getAttribute("data-variant") };
        go(Object.assign(next, { open: [] }));
      }
    });
    var q = $("#q");
    q.addEventListener("input", function () {
      var t = q.value.trim().toLowerCase();
      document.querySelectorAll("#layers .chip").forEach(function (c) { c.classList.toggle("nomatch", !!t && c.getAttribute("data-n").toLowerCase().indexOf(t) < 0); });
    });
    q.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" || !B) return;
      var t = q.value.trim().toLowerCase();
      var hit = B.types.find(function (x) { return x.name.toLowerCase() === t; }) || B.types.find(function (x) { return x.name.toLowerCase().indexOf(t) >= 0; });
      if (hit) go({ type: hit.name, open: [] });
    });
    var rz;
    window.addEventListener("resize", function () { clearTimeout(rz); rz = setTimeout(function () { if (B) drawEdges(); }, 80); });
    window.addEventListener("hashchange", route);
    route();
  });
})();
