// Reads the greeting cookie app.kernal.one sets after sign-in (packages/web welcome-cookie.ts).
// The cookie is not a login. Anything that fails the name check is ignored, and the text is
// written with textContent so it cannot become markup.
(function (root) {
  var COOKIE = "kernal_welcome";
  var NAME = /^[\p{L}][\p{L}\p{M}'’.\-]{0,39}$/u;

  function read(header) {
    if (!header) return "";
    var parts = String(header).split(";");
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i].trim();
      var eq = part.indexOf("=");
      if (eq < 0 || part.slice(0, eq).trim() !== COOKIE) continue;
      var raw;
      try {
        raw = decodeURIComponent(part.slice(eq + 1).trim());
      } catch (e) {
        return "";
      }
      raw = raw.normalize("NFKC").trim();
      return NAME.test(raw) ? raw : "";
    }
    return "";
  }

  function show(doc) {
    var el = doc.getElementById("welcome");
    if (!el) return;
    var name = read(doc.cookie || "");
    if (!name) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.textContent = "Welcome back, " + name + ".";
    el.hidden = false;
  }

  root.KernalWelcome = { read: read, show: show };
  if (typeof document !== "undefined" && document.getElementById) show(document);
})(globalThis);
