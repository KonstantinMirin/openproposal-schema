// The theme button every page shares: it cycles from the system theme to light, to dark, and back.
(function () {
  var order = ["system", "light", "dark"];
  var glyph = { system: "◐", light: "☀", dark: "☾" };
  function current() {
    return document.documentElement.getAttribute("data-theme") || "system";
  }
  function apply(t) {
    if (t === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
    try {
      if (t === "system") window.localStorage.removeItem("theme");
      else window.localStorage.setItem("theme", t);
    } catch (e) {
      // The choice lasts for this page only.
    }
    var b = document.getElementById("theme");
    if (b) {
      b.textContent = glyph[t];
      b.setAttribute("aria-label", "Color theme: " + t);
      b.title = "Color theme: " + t;
    }
  }
  document.addEventListener("DOMContentLoaded", function () {
    var b = document.getElementById("theme");
    if (!b) return;
    apply(current());
    b.addEventListener("click", function () {
      apply(order[(order.indexOf(current()) + 1) % order.length]);
    });
  });
})();
