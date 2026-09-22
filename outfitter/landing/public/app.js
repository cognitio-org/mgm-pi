// kernal.one: theme toggle, sound toggle, and the Commodore 64 command line: basic.js is the
// machine, this file is its screen, keyboard and disk drive. LOAD "OUTFITTER",8,1 spins up the
// drive (floppy.js) and launches app.kernal.one.
(function () {
  var root = document.documentElement;
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var border = document.getElementById("border");
  var APP_URL = "https://app.kernal.one";

  // ---------- theme ----------
  document.getElementById("theme-toggle").addEventListener("click", function () {
    var current = root.dataset.theme ||
      (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    var next = current === "light" ? "dark" : "light";
    root.dataset.theme = next;
    try { localStorage.setItem("kernalTheme", next); } catch (e) {}
    applyColors();   // a POKEd screen colour may need the other theme's text colour now
  });

  // ---------- sound (on unless muted; only ever plays after Return or a click) ----------
  var sound = document.getElementById("sound-toggle");
  function showSound() {
    var on = Floppy.enabled();
    sound.setAttribute("aria-pressed", on ? "true" : "false");
    sound.title = on ? "Floppy drive sound: on (click to mute)" : "Floppy drive sound: muted (click to unmute)";
  }
  showSound();
  // Fetch the clips as soon as someone heads for the prompt or the button, so LOAD starts instantly.
  ["pointerdown", "focusin", "keydown"].forEach(function (t) {
    document.addEventListener(t, function () { if (Floppy.enabled()) Floppy.preload(); }, { once: true });
  });
  sound.addEventListener("click", function () {
    var on = !Floppy.enabled();
    Floppy.setEnabled(on);
    showSound();
    if (on) Floppy.play("modem"); else Floppy.stop();
  });
  // A dial-up handshake the first time a visitor touches the page, unless that touch is the
  // sound button itself (muting has to stay silent). Any LOAD that follows cuts it off.
  function greet(ev) {
    document.removeEventListener("pointerdown", greet, true);
    document.removeEventListener("keydown", greet, true);
    if (!sound.contains(ev.target) && Floppy.enabled()) Floppy.play("modem");
  }
  document.addEventListener("pointerdown", greet, true);
  document.addEventListener("keydown", greet, true);

  function strobe(on) {
    if (!reduced) border.classList.toggle("loading", on);
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, reduced ? Math.min(ms, 150) : ms); }); }

  // ---------- POKE 53280/53281: border and screen colour ----------
  var PAL = Basic.PALETTE;
  var poked = { border: null, background: null };   // palette index, or null for the theme's own

  function luminance(hex) {
    var c = [1, 3, 5].map(function (i) {
      var v = parseInt(hex.substr(i, 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) {
    var x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  // The border is --frame and the screen is --bg, as in the theme. On a screen colour the theme's
  // text can't be read on (WCAG AA), the screen's text switches to black or white; panels keep
  // their own background, so they keep the theme's text.
  function applyColors() {
    var st = root.style;
    st.removeProperty("--screen-text");
    root.classList.remove("poked-ink");
    if (poked.border == null) st.removeProperty("--frame"); else st.setProperty("--frame", PAL[poked.border]);
    if (poked.background == null) { st.removeProperty("--bg"); return; }
    var bg = PAL[poked.background];
    st.setProperty("--bg", bg);
    var text = getComputedStyle(root).getPropertyValue("--text").trim();
    if (!/^#[0-9a-f]{6}$/i.test(text) || contrast(text, bg) < 4.5) {
      st.setProperty("--screen-text", contrast("#000000", bg) > contrast("#ffffff", bg) ? "#000000" : "#ffffff");
      root.classList.add("poked-ink");
    }
  }

  // ---------- the disk in drive 8 ----------
  var KERNAL_PRG = [
    '10 PRINT CHR$(18);" KERNAL CODING AGENT "',
    "20 PRINT",
    '30 PRINT "/CONNECT LOCAL";TAB(20);"YOUR OWN HARDWARE,"',
    '40 PRINT TAB(20);"LM STUDIO + MLX"',
    '50 PRINT "/CONNECT LITELLM";TAB(20);"THE SHARED ROUTER,"',
    '60 PRINT TAB(20);"SPEND TRACKED BY KEY"',
    '70 PRINT "/CONNECT OPENROUTER";TAB(20);"ANYTHING ELSE,"',
    '80 PRINT TAB(20);"ON YOUR OWN KEY"',
    '90 PRINT "/BUDGET";TAB(20);"WHAT THIS SESSION"',
    '100 PRINT TAB(20);"COSTS"',
    "110 PRINT",
    '120 PRINT "WATCH YOUR TOKENS. BUILD COOL STUFF."'
  ];
  // OUTFITTER is machine code started with SYS, the way most C64 software was; LIST shows the
  // one-line BASIC stub. "launch" files get the long drive clip.
  var BUILTIN = [
    { name: "OUTFITTER", type: "PRG", blocks: 12, program: ["10 SYS2061"], launch: true },
    { name: "KERNAL", type: "PRG", blocks: 8, program: KERNAL_PRG, launch: true },
    { name: "GURUS", type: "SEQ", blocks: 3 },
    { name: "TOKENS.LOG", type: "SEQ", blocks: 1 }
  ];
  var launchable = false;   // OUTFITTER is in memory, so SYS 2061 starts it

  // SAVEd programs live in localStorage, which can be missing, blocked or hold junk.
  function savedFiles() {
    try {
      var s = JSON.parse(localStorage.getItem("kernalDisk") || "{}");
      return s && typeof s === "object" ? s : {};
    } catch (e) { return {}; }
  }
  function disk() {
    var files = BUILTIN.slice(), saved = savedFiles(), used = 0;
    Object.keys(saved).forEach(function (name) {
      var lines = saved[name];
      if (!Array.isArray(lines)) return;
      lines = lines.filter(function (l) { return typeof l === "string"; });
      var blocks = Math.max(1, Math.ceil(lines.join("\n").length / 254));
      used += blocks;
      files.push({ name: name, type: "PRG", blocks: blocks, program: lines });
    });
    return { title: "KERNAL.ONE", id: "K1 2A", free: Math.max(0, 640 - used), files: files };
  }
  // LOAD finds programs only; the SEQ files are data.
  function findFile(pattern) {
    var files = disk().files;
    for (var i = 0; i < files.length; i++) {
      if (files[i].type === "PRG" && Basic.matchName(pattern, files[i].name)) return files[i];
    }
    return null;
  }

  function diskLoad(name, device, sec, m) {
    if (device !== 8) return { error: "DEVICE NOT PRESENT" };
    if (!name) return { error: "MISSING FILE NAME" };
    var file = name === "$" ? null : findFile(name);
    var big = !!(file && file.launch), searchMs = big ? 1100 : 700;
    stopBtn.hidden = true;
    m.print("\nSEARCHING FOR " + name);
    strobe(true);
    var clipMs = Floppy.play(big ? "launch" : "load");
    return wait(searchMs).then(function () {
      if (!file && name !== "$") { strobe(false); return { error: "FILE NOT FOUND" }; }
      m.print("\nLOADING");
      return wait(Math.max(clipMs - searchMs, 400)).then(function () {
        strobe(false);
        launchable = !!file && file.name === "OUTFITTER";
        autorun = launchable && !m.inProgram();
        return file ? { program: file.program } : { program: Basic.directory(disk()), raw: true };
      });
    });
  }

  function diskSave(name, device, sec, lines, m) {
    if (device !== 8) return { error: "DEVICE NOT PRESENT" };
    if (!name) return { error: "MISSING FILE NAME" };
    name = name.slice(0, 16);
    stopBtn.hidden = true;
    m.print("\nSAVING " + name);
    strobe(true);
    return wait(Floppy.play("load")).then(function () {
      strobe(false);
      // The disk's own files are a FILE EXISTS on the drive's error channel; BASIC says nothing.
      if (BUILTIN.some(function (f) { return f.name === name; })) return;
      var saved = savedFiles();
      saved[name] = lines;
      try { localStorage.setItem("kernalDisk", JSON.stringify(saved)); } catch (e) {}
    });
  }

  function sys(addr, m) {
    if (addr !== 2061 || !launchable) return;
    m.print("\nLAUNCHING APP.KERNAL.ONE ...");
    return wait(500).then(function () { window.location.href = APP_URL; });
  }

  // SYS 64738: blank screen, theme colours back, READY. The banner stays; it isn't in #term-out.
  function reset() {
    out.textContent = "";
    promptEl.textContent = "";
    poked.border = poked.background = null;
    applyColors();
    launchable = false;
    return wait(400);
  }

  // ---------- the screen ----------
  // Finished lines are <p>s in #term-out. The line still being written (a PRINT ending in ;, an
  // INPUT prompt) lives in #term-prompt, in front of whatever is being typed, so a prompt and its
  // answer share a line like on the C64.
  var out = document.getElementById("term-out");
  var form = document.getElementById("term-form");
  var input = document.getElementById("term-input");
  var echo = document.getElementById("term-echo");
  var promptEl = document.getElementById("term-prompt");
  var stopBtn = document.getElementById("term-stop");
  var MAX_LINES = 22;   // + banner + the line being typed: about a 25-row C64 screen
  var mode = "ready";   // "ready" at the prompt, "busy" while the machine runs, "input" at INPUT
  var answer = null;    // resolves the INPUT being typed
  var autorun = false;  // LOAD "OUTFITTER" types RUN by itself

  function write(text, color, rvs) {
    var parts = text.split("\n");
    for (var i = 0; i < parts.length; i++) {
      if (i) commitLine();
      if (parts[i]) append(parts[i], color, rvs);
    }
    while (out.childNodes.length > MAX_LINES) out.removeChild(out.firstChild);
  }
  function append(s, color, rvs) {
    var last = promptEl.lastChild;
    if (color == null && !rvs) {
      if (last && last.nodeType === 3) last.data += s;
      else promptEl.appendChild(document.createTextNode(s));
      return;
    }
    var span = document.createElement("span");
    span.textContent = s;
    if (rvs) span.className = "rvs";
    if (color != null) span.style[rvs ? "backgroundColor" : "color"] = PAL[color];
    promptEl.appendChild(span);
  }
  function commitLine() {
    var p = document.createElement("p");
    if (!promptEl.firstChild) p.textContent = " ";
    while (promptEl.firstChild) p.appendChild(promptEl.firstChild);
    out.appendChild(p);
  }

  var machine = new Basic.Machine({
    write: write,
    clear: function () { out.textContent = ""; promptEl.textContent = ""; },
    color: function (which, idx) { poked[which] = idx; applyColors(); },
    input: function () {
      return new Promise(function (resolve) { answer = resolve; setMode("input"); });
    },
    cancelInput: function () { answer = null; input.value = ""; syncEcho(); setMode("busy"); },
    load: diskLoad,
    save: diskSave,
    sys: sys,
    reset: reset
  });

  function syncEcho() {
    echo.textContent = input.value.toUpperCase();
    // Keep the caret at the end: the visible cursor is always drawn after the text.
    var n = input.value.length;
    if (input.selectionStart !== n) input.setSelectionRange(n, n);
  }
  input.addEventListener("input", syncEcho);
  input.addEventListener("keyup", syncEcho);
  input.addEventListener("focus", function () { form.classList.add("focused"); });
  input.addEventListener("blur", function () { form.classList.remove("focused"); });
  // Clicking anywhere on the screen text puts you at the prompt, like the real thing.
  document.getElementById("term").addEventListener("click", function (ev) {
    if (!window.getSelection().toString() && ev.target.tagName !== "KBD" && ev.target.tagName !== "BUTTON") {
      input.focus({ preventScroll: true });
    }
  });

  // While a program runs the line is read-only (keys go to GET) and a RUN/STOP button stands in
  // for Esc on touch screens. The log stops announcing until READY., so a loop can't flood a
  // screen reader.
  function setMode(m) {
    mode = m;
    form.classList.toggle("busy", m === "busy");
    input.readOnly = m === "busy";
    stopBtn.hidden = m === "ready";
    out.setAttribute("aria-live", m === "busy" ? "off" : "polite");
  }

  var HELP = [
    "BASIC V2, AS ON THE C64. TRY:",
    'LOAD "OUTFITTER",8,1     OPEN OUTFITTER',
    'LOAD "KERNAL",8 THEN RUN MEET KERNAL',
    'LOAD "$",8 THEN LIST     DISK DIRECTORY',
    "POKE 53280,2             BORDER COLOUR",
    "SYS 64738                RESET",
    "ESC                      RUN/STOP",
    "",
    "PRINT INPUT GET IF THEN GOTO GOSUB FOR",
    "NEXT DIM DATA READ POKE PEEK LIST RUN",
    "NEW CONT SAVE ... AND THE FUNCTIONS.",
    "",
    "10 PRINT CHR$(205.5+RND(1));:GOTO 10",
    "RUN",
    ""
  ];
  // HELP isn't C64 BASIC; the page answers it before the machine sees the line.
  function help() {
    machine.print(HELP.map(function (l) { return "\n" + l; }).join(""));
    machine.ready();
  }

  function submit() {
    if (mode === "busy") return Promise.resolve();
    var text = input.value.toUpperCase();
    input.value = "";
    syncEcho();
    write(text + "\n", machine.textColor, false);
    if (mode === "input") {
      var r = answer;
      answer = null;
      setMode("busy");
      if (r) r(text);
      return Promise.resolve();
    }
    if (/^\s*HELP\s*$/.test(text)) { help(); return Promise.resolve(); }
    setMode("busy");
    return machine.enter(text).then(function () {
      setMode("ready");
      if (autorun) {
        autorun = false;
        return wait(350).then(function () { return typeAndRun("RUN"); });
      }
    });
  }

  // Types `text` at the prompt a key at a time, then enters it.
  function typeAndRun(text) {
    if (mode !== "ready") return Promise.resolve();
    setMode("busy");
    input.value = "";
    syncEcho();
    var i = 0;
    return new Promise(function (resolve) {
      (function tick() {
        input.value = text.slice(0, ++i);
        echo.textContent = input.value.toUpperCase();
        if (i < text.length) setTimeout(tick, reduced ? 0 : 45 + Math.random() * 45);
        else setTimeout(function () { setMode("ready"); resolve(submit()); }, reduced ? 0 : 250);
      })();
    });
  }

  // Return runs the line. Handled on keydown rather than relying on implicit form submission,
  // which not every browser (or synthetic keypress) triggers for a lone input. While a program
  // runs, keys go to its keyboard buffer for GET.
  var KEYS = { ArrowUp: 145, ArrowDown: 17, ArrowLeft: 157, ArrowRight: 29, Backspace: 20, Delete: 20, Home: 19 };
  input.addEventListener("keydown", function (ev) {
    if (ev.isComposing) return;
    if (ev.key === "Enter") {
      ev.preventDefault();
      if (mode === "busy") machine.key(13); else submit();
      return;
    }
    if (mode !== "busy" || !machine.running || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    var code = ev.key.length === 1 ? ev.key.toUpperCase().charCodeAt(0) : KEYS[ev.key];
    if (code != null && code < 256) { ev.preventDefault(); machine.key(code); }
  });
  form.addEventListener("submit", function (ev) { ev.preventDefault(); });

  // Esc (or Ctrl+C with nothing selected) is RUN/STOP, wherever the focus is.
  document.addEventListener("keydown", function (ev) {
    var brk = ev.key === "Escape" ||
      (ev.ctrlKey && !ev.metaKey && (ev.key === "c" || ev.key === "C") && !window.getSelection().toString());
    if (brk && machine.running && machine.stop()) ev.preventDefault();
  });
  stopBtn.addEventListener("click", function () {
    machine.stop();
    input.focus({ preventScroll: true });
  });

  // Back button restores the page from cache mid-launch: reset to a clean prompt.
  window.addEventListener("pageshow", function (ev) {
    if (ev.persisted) { strobe(false); if (!machine.running) setMode("ready"); }
  });
})();
