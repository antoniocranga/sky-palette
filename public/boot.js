/*
 * First-paint tint. Runs synchronously from the head, before the stylesheet
 * and the app bundle, so a deep link starts with the right browser-chrome
 * colour instead of flashing the home sky. Kept as an external file because the
 * Worker's CSP allows 'self' scripts only (no inline script).
 */
(function () {
  try {
    var view = new URLSearchParams(location.search).get("view");
    var theme = view === "detail" ? "#ffffff" : "#000000";
    var surface = view === "detail" ? "#ffffff" : "#000000";
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme);
    document.documentElement.style.backgroundColor = surface;
    var rule = document.createElement("style");
    rule.id = "initial-surface";
    /* Vite appends the stylesheet after this script, hence !important. */
    rule.textContent = "body{background-color:" + surface + " !important}";
    document.head.appendChild(rule);
  } catch (error) {
    /* Non-blocking: the runtime tint corrects it after boot. */
  }
})();
