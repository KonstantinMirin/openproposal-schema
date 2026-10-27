// A collapsible JSON tree with a toolbar: expand all, collapse all, and copy the JSON. The tree flows in the
// page, with no scroll region of its own, and opens to two levels unless `open` says otherwise.
// JsonTree.render(host, value, { open, refHref }) fills host; refHref(ref) gives the link for a "$ref" value, or null.
(function () {
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function count(n, array) {
    return n + " " + (array ? (n === 1 ? "item" : "items") : n === 1 ? "member" : "members");
  }
  function node(v, depth, key, opts) {
    if (v === null || typeof v !== "object") {
      if (key === "$ref" && typeof v === "string" && opts.refHref) {
        var href = opts.refHref(v);
        if (href) {
          var a = el("a", "j-ref", JSON.stringify(v));
          a.href = href;
          a.title = "Open the type this reference names";
          return a;
        }
      }
      return el("span", "j-" + (v === null ? "null" : typeof v), JSON.stringify(v));
    }
    var array = Array.isArray(v);
    var keys = array ? v.map(function (_, i) { return i; }) : Object.keys(v);
    if (keys.length === 0) return el("span", "j-punct", array ? "[]" : "{}");
    var d = el("details", "j-node");
    if (depth < opts.open) d.open = true;
    var s = el("summary");
    s.appendChild(el("span", "j-punct", array ? "[" : "{"));
    s.appendChild(el("span", "j-count", count(keys.length, array)));
    d.appendChild(s);
    var ul = el("ul");
    keys.forEach(function (k) {
      var li = el("li");
      if (!array) {
        li.appendChild(el("span", "j-key", JSON.stringify(k)));
        li.appendChild(el("span", "j-punct", ": "));
      }
      li.appendChild(node(v[k], depth + 1, array ? null : k, opts));
      ul.appendChild(li);
    });
    d.appendChild(ul);
    d.appendChild(el("span", "j-punct", array ? "]" : "}"));
    return d;
  }
  function button(label, fn) {
    var b = el("button", "tool", label);
    b.type = "button";
    b.addEventListener("click", fn);
    return b;
  }
  window.JsonTree = {
    render: function (host, value, opts) {
      opts = opts || {};
      if (opts.open === undefined) opts.open = 2;
      host.textContent = "";
      var tree = el("div", "jsontree");
      var tools = el("div", "tree-tools");
      tools.appendChild(button("Expand all", function () { tree.querySelectorAll("details").forEach(function (d) { d.open = true; }); }));
      tools.appendChild(button("Collapse all", function () { tree.querySelectorAll("details").forEach(function (d, i) { d.open = i === 0; }); }));
      var copy = button("Copy JSON", function () {
        var text = JSON.stringify(value, null, 2);
        var done = function (ok) {
          copy.textContent = ok ? "Copied" : "Copy failed";
          setTimeout(function () { copy.textContent = "Copy JSON"; }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
        else done(false);
      });
      tools.appendChild(copy);
      host.appendChild(tools);
      tree.appendChild(node(value, 0, null, opts));
      host.appendChild(tree);
      return tree;
    },
  };
})();
