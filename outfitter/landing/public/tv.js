// "Dear Sysop" on the home page: a little beige TV in the hero plays the Outfitter intro, silent
// and looping; a click (or LOAD "DEAR SYSOP",8,1 at the prompt) switches on the big set: the
// picture opens out of a bright line, plays with sound, and an MTV-style credit block slides in.
// Closing collapses it to a line and a dot, like a CRT switching off.
//
// The videos come from outfitter/video (web.sh) into /video/. Until they're there the TV stays
// hidden, so the page never shows a broken player. Phones get the same set, sized to the screen;
// on a phone the big picture also asks for the browser's own full screen. Reduced motion, Save-Data
// or a cellular connection: the small set shows a still and plays nothing until it's clicked.
(function (root) {
  var FILES = {
    preview: "/video/dear-sysop-preview.mp4",   // small, silent, loops in the little TV
    full: "/video/dear-sysop.mp4",              // the big set, with sound
    poster: "/video/dear-sysop.jpg"
  };
  // The credit block, MTV style: artist, "title", album, label. On screen from CAPTION.at seconds
  // (after the logo) for CAPTION.for seconds.
  var CAPTION = { at: 3.4, for: 6.5 };

  // Whether the little set may play by itself.
  function shouldPreview(env) {
    if (env.reduced || env.saveData) return false;
    if (env.type === "cellular") return false;
    return !/(^|-)2g$|^3g$/.test(env.effectiveType || "");
  }

  function captionVisible(t) {
    return t >= CAPTION.at && t < CAPTION.at + CAPTION.for;
  }

  function clock(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return "";
    var s = Math.round(seconds);
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  root.KernalTV = { shouldPreview: shouldPreview, captionVisible: captionVisible, clock: clock,
    open: function () { return false; }, available: function () { return false; } };
  if (typeof document === "undefined" || !document.getElementById) return;

  var section = document.getElementById("tv");
  var setBtn = document.getElementById("tv-set");
  var small = document.getElementById("tv-small");
  var still = document.getElementById("tv-still");
  var length = document.getElementById("tv-length");
  var dialog = document.getElementById("tv-dialog");
  var big = document.getElementById("tv-big");
  var tube = document.getElementById("tv-tube");
  var credit = document.getElementById("tv-credit");
  var closeBtn = document.getElementById("tv-close");
  var soundBtn = document.getElementById("tv-unmute");
  if (!section || !dialog || !big || typeof dialog.showModal !== "function") return;

  var mq = function (q) { return root.matchMedia ? root.matchMedia(q).matches : false; };
  var conn = navigator.connection || {};
  var reduced = mq("(prefers-reduced-motion: reduce)");
  var phone = mq("(max-width: 640px), (pointer: coarse) and (max-height: 500px)");
  var preview = shouldPreview({ reduced: reduced, saveData: !!conn.saveData, type: conn.type,
    effectiveType: conn.effectiveType });
  var ready = false;

  function show(seconds) {
    if (ready) return;
    ready = true;
    section.hidden = false;
    var len = clock(seconds);
    if (len && length) length.textContent = "(" + len + ")";
  }

  // Show the set once something it needs has loaded: the still always, the preview when allowed.
  still.addEventListener("load", function () { if (!preview) show(); });
  still.addEventListener("error", function () { if (!preview) section.hidden = true; });
  still.src = FILES.poster;
  if (preview) {
    small.muted = true;
    small.poster = FILES.poster;   // what shows if the browser won't autoplay (e.g. Low Power Mode)
    small.addEventListener("loadedmetadata", function () { show(small.duration); });
    small.addEventListener("error", function () { section.hidden = true; ready = false; });
    small.src = FILES.preview;
    small.hidden = false;
    // Play only while the set is on screen.
    if ("IntersectionObserver" in root) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (dialog.open) return;
          if (e.isIntersecting) { var p = small.play(); if (p && p.catch) p.catch(function () {}); }
          else small.pause();
        });
      }, { threshold: 0.25 }).observe(small);
    } else {
      small.play().catch(function () {});
    }
  }

  // ---------- the big set ----------
  var closing = false;
  var endTimer = null;

  function animate(cls, ms) {
    return new Promise(function (resolve) {
      if (reduced) return resolve();
      tube.classList.add(cls);
      setTimeout(function () { tube.classList.remove(cls); resolve(); }, ms);
    });
  }

  function playWithSound() {
    big.muted = false;
    var p = big.play();
    if (!p || !p.catch) return;
    // No sound without a fresh click (LOAD at the prompt can outlast it): play silently and offer
    // a button for the sound.
    p.catch(function () {
      big.muted = true;
      soundBtn.hidden = false;
      big.play().catch(function () {});
    });
  }

  function open() {
    if (!ready || dialog.open) return false;
    closing = false;
    if (root.Floppy) root.Floppy.stop();
    small.pause();
    soundBtn.hidden = true;
    credit.classList.remove("on");
    if (!big.getAttribute("src")) big.src = FILES.full;
    big.currentTime = 0;
    dialog.showModal();
    playWithSound();          // inside the click, so the browser lets it have sound
    animate("power-on", 650);
    if (phone) {
      var fs = big.requestFullscreen || big.webkitRequestFullscreen;
      try {
        if (fs) { var r = fs.call(big); if (r && r.catch) r.catch(function () {}); }
        else if (big.webkitEnterFullscreen) big.webkitEnterFullscreen();
      } catch (e) {}
    }
    return true;
  }

  function close() {
    if (closing || !dialog.open) return;
    closing = true;
    clearTimeout(endTimer);
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {});
    animate("power-off", 450).then(function () {
      big.pause();
      dialog.close();
      closing = false;
      if (preview) small.play().catch(function () {});
    });
  }

  big.addEventListener("timeupdate", function () {
    credit.classList.toggle("on", captionVisible(big.currentTime));
  });
  big.addEventListener("ended", function () { endTimer = setTimeout(close, 1500); });
  big.addEventListener("play", function () { clearTimeout(endTimer); });

  setBtn.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  soundBtn.addEventListener("click", function () {
    big.muted = false;
    soundBtn.hidden = true;
    big.play().catch(function () {});
  });
  // Esc, or the phone's back gesture on some browsers: switch off with the animation.
  dialog.addEventListener("cancel", function (ev) { ev.preventDefault(); close(); });
  // A click on the dark surround (the dialog itself, not the set) switches off too.
  dialog.addEventListener("click", function (ev) { if (ev.target === dialog) close(); });

  root.KernalTV.open = open;
  root.KernalTV.available = function () { return ready; };
})(globalThis);
