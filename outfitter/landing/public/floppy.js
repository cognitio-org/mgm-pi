// The page's sounds (sounds/CREDITS.md): launch.mp3 is a floppy head seek then a few seconds of
// reading (LOAD "OUTFITTER" / "KERNAL"); load.mp3 is a pair of seeks (any other disk access);
// modem.mp3 is a dial-up handshake, played once when a visitor first touches the page and when
// sound is switched back on. One clip at a time: starting one cuts off whatever is playing. On
// unless muted: every play follows a keypress or a click, so autoplay blocking never applies. A
// browser that can't play them just stays silent.
window.Floppy = (function () {
  var clips = {};

  function clip(name) {
    if (!clips[name]) {
      clips[name] = new Audio("/sounds/" + name + ".mp3");
      clips[name].preload = "auto";
      clips[name].volume = 0.8;
    }
    return clips[name];
  }

  // Plays a clip from the start. Returns its length in ms (known lengths, so callers can time
  // animations without waiting for metadata).
  var LENGTH_MS = { launch: 4750, load: 1350, modem: 4320 };
  function play(name) {
    if (!enabled()) return LENGTH_MS[name] || 0;
    stop();
    try {
      var a = clip(name);
      a.currentTime = 0;
      var p = a.play();
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
    return LENGTH_MS[name] || 0;
  }

  // The first-visit modem. Resolves false only when the browser refused to play (no user
  // activation yet, e.g. a touch that became a scroll), so the page can try again on the next
  // click or key; being cut off by a LOAD counts as played.
  function playGreeting() {
    if (!enabled()) return Promise.resolve(true);
    stop();
    try {
      var a = clip("modem");
      a.currentTime = 0;
      var p = a.play();
      if (!p || !p.then) return Promise.resolve(true);
      return p.then(function () { return true; }, function (e) { return !(e && e.name === "NotAllowedError"); });
    } catch (e) { return Promise.resolve(true); }
  }

  function stop() {
    for (var k in clips) { try { clips[k].pause(); } catch (e) {} }
  }

  function preload() {
    try { clip("launch"); clip("load"); clip("modem"); } catch (e) {}
  }

  function enabled() {
    try { return localStorage.getItem("kernalSound") !== "off"; } catch (e) { return true; }
  }

  function setEnabled(on) {
    try { localStorage.setItem("kernalSound", on ? "on" : "off"); } catch (e) {}
  }

  return { play: play, playGreeting: playGreeting, stop: stop, preload: preload, enabled: enabled, setEnabled: setEnabled };
})();
