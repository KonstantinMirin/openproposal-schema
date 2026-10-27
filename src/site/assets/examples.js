// The examples page's switches: show one build's payloads, and keep the choice in the address as #!/?lock=…&variant=….
// route.js reads the address, with the names the type map takes, and this file only ever writes the hash.
(function () {
  function state() {
    var p = window.MapRoute.parse(location.hash);
    var s = p.route ? p.state : window.MapRoute.DEFAULT;
    return { lock: s.lock, variant: s.variant, route: p.route };
  }
  var hashOf = function (s) { return "#!/?lock=" + s.lock + "&variant=" + s.variant; };
  function render() {
    var s = state();
    // An address in another spelling, such as variant=with-proposals, is rewritten in place.
    if (s.route && location.hash !== "" && location.hash !== hashOf(s)) history.replaceState(null, "", hashOf(s));
    document.querySelectorAll("section.build").forEach(function (el) {
      el.hidden = !(el.getAttribute("data-lock") === s.lock && el.getAttribute("data-variant") === s.variant);
    });
    document.querySelectorAll(".switches button[data-lock]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-lock") === s.lock));
    });
    document.querySelectorAll(".switches button[data-variant]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-variant") === s.variant));
    });
  }
  function go(next) {
    var s = state();
    location.hash = hashOf({ lock: next.lock || s.lock, variant: next.variant || s.variant });
  }
  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll(".switches button").forEach(function (b) {
      b.addEventListener("click", function () {
        go({ lock: b.getAttribute("data-lock"), variant: b.getAttribute("data-variant") });
      });
    });
    window.addEventListener("hashchange", render);
    render();
  });
})();
