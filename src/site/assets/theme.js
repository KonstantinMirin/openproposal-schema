// Applies the reader's chosen color theme before the page paints. The site follows the system theme unless the reader picks one.
(function () {
  try {
    var t = window.localStorage.getItem("theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (e) {
    // Storage can be blocked; the system theme applies.
  }
})();
