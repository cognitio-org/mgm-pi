// Commodore 64 BASIC V2 for kernal.one's command line: a small but real interpreter. Lines are
// crunched into keyword tokens the way the C64 does it (no word boundaries, so FORI=1TO9 works and
// SCORE hides an OR), expressions follow the ROM's operator precedence, output is PETSCII on a
// 40-column screen, and the error messages are the real ones. It knows nothing about the page:
// everything it shows or asks for goes through an injected io object, so the same file runs under
// node --test. Programs run in time slices and yield between them, so an endless GOTO loop never
// freezes the tab and RUN/STOP can always get in.
(function (root, factory) {
  var Basic = factory();
  if (typeof module === "object" && module && module.exports) module.exports = Basic;
  root.Basic = Basic;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // The V2 token table, in ROM order: crunching takes the first keyword that matches, not the
  // longest, which is why INPUT# and PRINT# sit before INPUT and PRINT.
  var KEYWORDS = ["END", "FOR", "NEXT", "DATA", "INPUT#", "INPUT", "DIM", "READ", "LET", "GOTO",
    "RUN", "IF", "RESTORE", "GOSUB", "RETURN", "REM", "STOP", "ON", "WAIT", "LOAD", "SAVE",
    "VERIFY", "DEF", "POKE", "PRINT#", "PRINT", "CONT", "LIST", "CLR", "CMD", "SYS", "OPEN",
    "CLOSE", "GET", "NEW", "TAB(", "TO", "FN", "SPC(", "THEN", "NOT", "STEP", "AND", "OR",
    "SGN", "INT", "ABS", "USR", "FRE", "POS", "SQR", "RND", "LOG", "EXP", "COS", "SIN", "TAN",
    "ATN", "PEEK", "LEN", "STR$", "VAL", "ASC", "CHR$", "LEFT$", "RIGHT$", "MID$", "GO"];
  var K = {};
  KEYWORDS.forEach(function (w, i) { K[w] = i; });

  // Pepto's C64 palette, indexed like the VIC-II colour registers.
  var PALETTE = ["#000000", "#ffffff", "#813338", "#75cec8", "#8e3c97", "#56ac4d", "#2e2c9b",
    "#edf171", "#8e5029", "#553800", "#c46c71", "#4a4a4a", "#7b7b7b", "#a9ff9f", "#706deb", "#b2b2b2"];
  var COLOR_NAMES = ["BLACK", "WHITE", "RED", "CYAN", "PURPLE", "GREEN", "BLUE", "YELLOW", "ORANGE",
    "BROWN", "LIGHT RED", "DARK GREY", "GREY", "LIGHT GREEN", "LIGHT BLUE", "LIGHT GREY"];
  // PRINT CHR$(n) colour control codes -> palette index.
  var COLOR_CODES = { 144: 0, 5: 1, 28: 2, 159: 3, 156: 4, 30: 5, 31: 6, 158: 7, 129: 8, 149: 9,
    150: 10, 151: 11, 152: 12, 153: 13, 154: 14, 155: 15 };

  // PETSCII -> Unicode for the upper-case/graphics character set. 205/206 are the diagonals the
  // famous one-line maze is made of. The shifted and C= graphics repeat in the 96-127 and 224-254
  // ranges, exactly as they do on the machine.
  var GFX_SHIFT = ["─", "♠", "│", "─", "─", "─", "─", "│",
    "│", "╮", "╰", "╯", "⌞", "╲", "╱", "⌜", "⌝", "●",
    "▁", "♥", "▏", "╭", "╳", "○", "♣", "▕", "♦", "┼",
    "▒", "│", "π", "◥"];                                   // 192-223
  var GFX_CBM = [" ", "▌", "▄", "▔", "▁", "▏", "▒", "▕", "▒",
    "◤", "▐", "├", "▗", "└", "┐", "▂", "┌", "┴", "┬",
    "┤", "▎", "▍", "▐", "▔", "▀", "▃", "▟", "▖", "▝",
    "┘", "▘", "▚"];                                            // 160-191
  var PETSCII = [];
  (function () {
    for (var c = 0; c < 256; c++) {
      var ch = null;
      if (c >= 32 && c < 96) ch = String.fromCharCode(c);
      else if (c >= 96 && c < 128) ch = GFX_SHIFT[c - 96];
      else if (c >= 160 && c < 192) ch = GFX_CBM[c - 160];
      else if (c >= 192 && c < 224) ch = GFX_SHIFT[c - 192];
      else if (c >= 224 && c < 255) ch = GFX_CBM[c - 224];
      else if (c === 255) ch = "π";
      PETSCII[c] = ch;
    }
    PETSCII[92] = "£"; PETSCII[94] = "↑"; PETSCII[95] = "←";
  })();

  var WIDTH = 40;              // screen columns; PRINT wraps here like the real screen editor
  var FREE = 38911;            // BASIC bytes free on a stock C64 (the banner's "TOKENS FREE")
  var MAX_STACK = 100;         // FOR/GOSUB frames before ?OUT OF MEMORY
  var DONE = { done: true };   // a statement ended the run (END, STOP, error, ...)
  var YIELD = { yield: true };
  var BREAK = { brk: true };   // INPUT interrupted by RUN/STOP

  function BasicError(msg, line) { this.message = msg; this.line = line; }
  function err(msg, line) { return new BasicError(msg, line); }

  function isDigit(t) { return typeof t === "string" && t >= "0" && t <= "9"; }
  function isLetter(t) { return typeof t === "string" && t >= "A" && t <= "Z"; }

  // Typed text arrives as ordinary Unicode: upper-case it (the C64 boots in upper-case/graphics
  // mode) and map the few keys that have a PETSCII home of their own.
  function normalize(s) {
    return String(s).toUpperCase().replace(/[£π↑←]/g, function (c) {
      return { "£": "\\", "π": "ÿ", "↑": "^", "←": "_" }[c];
    });
  }

  // Crunch a line into tokens: keyword indexes (numbers) and single characters (strings). Nothing
  // is tokenized inside quotes, after REM, or in DATA up to the next colon.
  function crunch(s) {
    var out = [], i = 0, quote = false, mode = 0; // mode 1 = DATA, 2 = REM
    while (i < s.length) {
      var ch = s[i];
      if (quote || mode === 2) {
        if (ch === '"') quote = !quote;
        out.push(ch); i++; continue;
      }
      if (ch === '"') { quote = true; out.push(ch); i++; continue; }
      if (mode === 1) { if (ch === ":") mode = 0; out.push(ch); i++; continue; }
      if (ch === "?") { out.push(K.PRINT); i++; continue; }
      if (isLetter(ch)) {
        var kw = -1;
        for (var k = 0; k < KEYWORDS.length; k++) {
          if (s.startsWith(KEYWORDS[k], i)) { kw = k; break; }
        }
        if (kw >= 0) {
          out.push(kw);
          i += KEYWORDS[kw].length;
          if (kw === K.REM) mode = 2; else if (kw === K.DATA) mode = 1;
          continue;
        }
      }
      out.push(ch); i++;
    }
    return out;
  }

  function detokenize(toks) {
    var s = "";
    for (var i = 0; i < toks.length; i++) s += typeof toks[i] === "number" ? KEYWORDS[toks[i]] : toks[i];
    return s;
  }

  // Numbers print the way the ROM prints them: nine significant digits, no leading zero,
  // scientific notation below 0.01 and from 1E9 up.
  function fmtNum(n) {
    if (n === 0) return "0";
    var neg = n < 0, e = Math.abs(n).toExponential(8).split("e");
    var digits = e[0].replace(".", "").replace(/0+$/, ""), exp = +e[1], s;
    if (exp >= -2 && exp < 9) {
      if (exp >= 0) {
        s = digits.length > exp + 1 ? digits.slice(0, exp + 1) + "." + digits.slice(exp + 1)
          : digits + "0".repeat(exp + 1 - digits.length);
      } else {
        s = "." + "0".repeat(-exp - 1) + digits;
      }
    } else {
      var ae = Math.abs(exp);
      s = digits[0] + (digits.length > 1 ? "." + digits.slice(1) : "") + "E" +
        (exp < 0 ? "-" : "+") + (ae < 10 ? "0" : "") + ae;
    }
    return (neg ? "-" : "") + s;
  }

  // The ROM's number reader: spaces are ignored, parsing stops at the first thing that doesn't
  // fit. strict (INPUT, READ) wants the whole string to be a number and returns null if not.
  function fin(s, strict) {
    var t = s.replace(/ /g, "");
    var m = /^([+-]?)(\d*)(\.\d*)?(?:E([+-]?\d+))?/.exec(t);
    if (strict && (m[0].length !== t.length || (!m[2] && !m[3]))) return null;
    var body = m[2] + (m[3] || "");
    if (body === "" || body === ".") return 0;
    return check(parseFloat(m[1] + body + (m[4] ? "E" + m[4] : "")));
  }

  function check(v) {
    if (!isFinite(v) || Math.abs(v) > 1.70141183e38) throw err("OVERFLOW");
    return Math.abs(v) < 2.9387e-39 ? 0 : v;
  }
  function num(v) { if (typeof v !== "number") throw err("TYPE MISMATCH"); return v; }
  function str(v) { if (typeof v !== "string") throw err("TYPE MISMATCH"); return v; }
  function int16(v) {
    v = Math.trunc(num(v));
    if (v < -32768 || v > 32767) throw err("ILLEGAL QUANTITY");
    return v;
  }
  function byte(v, lo, hi) {
    v = Math.trunc(num(v));
    if (v < (lo || 0) || v > (hi == null ? 255 : hi)) throw err("ILLEGAL QUANTITY");
    return v;
  }
  function strLen(s) { if (s.length > 255) throw err("STRING TOO LONG"); return s; }

  // mulberry32: RND needs a generator it can re-seed (RND(-1) always gives the same sequence).
  function mulberry(seed) {
    var t = (seed + 0x6d2b79f5) >>> 0;
    var r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return { seed: t, value: ((r ^ (r >>> 14)) >>> 0) / 4294967296 };
  }

  // INPUT splits a reply on commas; quotes protect commas, a colon ends the reply.
  function splitInput(s) {
    var items = [], cur = "", quoted = false, q = false, extra = false;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (q) { if (c === '"') q = false; else cur += c; continue; }
      if (c === '"' && !cur.trim()) { q = quoted = true; cur = ""; continue; }
      if (quoted && c !== "," && c !== ":") continue;
      if (c === ",") { items.push(quoted ? cur : cur.trim()); cur = ""; quoted = false; continue; }
      if (c === ":") { extra = true; break; }
      cur += c;
    }
    items.push(quoted ? cur : cur.trim());
    return { items: items, extra: extra };
  }

  // C64 DOS file name patterns: * matches the rest, ? any one character.
  function matchName(pattern, name) {
    for (var i = 0; i < pattern.length; i++) {
      if (pattern[i] === "*") return true;
      if (i >= name.length || (pattern[i] !== "?" && pattern[i] !== name[i])) return false;
    }
    return pattern.length === name.length;
  }

  // A disk directory as the program LOAD "$",8 puts in memory: the block count is the line
  // number, and the header line starts with RVS ON, which is why it lists in reverse video.
  function directory(disk) {
    var lines = ['0 \u0012"' + (disk.title + "                ").slice(0, 16) + '" ' + disk.id];
    disk.files.forEach(function (f) {
      var n = String(f.blocks);
      lines.push(n + " " + " ".repeat(Math.max(0, 4 - n.length)) +
        ('"' + f.name + '"' + " ".repeat(19)).slice(0, Math.max(19, f.name.length + 3)) + f.type);
    });
    lines.push(disk.free + " BLOCKS FREE.");
    return lines;
  }

  // ---------------------------------------------------------------------------------------------

  function Machine(io, opts) {
    opts = opts || {};
    this.io = io || {};
    this.slice = opts.slice || 32;          // statements per time slice (~2000/s at 16 ms)
    this.yieldFn = opts.yield || function (fn) { setTimeout(fn, 16); };
    this.now = opts.now || (typeof performance !== "undefined"
      ? function () { return performance.now(); } : function () { return Date.now(); });
    this.t0 = this.now();
    this.tiOffset = 0;
    this.seed = (opts.seed != null ? opts.seed : Math.floor(Math.random() * 4294967296)) >>> 0;
    this.prog = [];
    this.running = false;
    this.cont = null;
    this.col = 0;
    this.wrapped = false;
    this.obuf = "";
    this.keys = [];
    this.inDos = false;
    this.powerOn();
    this.clr();
  }
  var M = Machine.prototype;

  M.powerOn = function () {
    this.mem = new Uint8Array(65536);
    this.mem[53280] = 14;   // light blue border
    this.mem[53281] = 6;    // blue screen
    this.textColor = null;  // null = the page's own text colour
    this.rvs = false;
    this.lineIndex = null;
    this.data = null;
  };

  M.clr = function () {
    this.vars = new Map();
    this.arrays = new Map();
    this.fns = new Map();
    this.stack = [];
    this.dataIdx = 0;
  };

  // ---------- output ----------

  M.flush = function () {
    if (this.obuf) {
      var s = this.obuf;
      this.obuf = "";
      if (this.io.write) this.io.write(s, this.textColor, this.rvs);
    }
  };
  M.setAttr = function (color, rvs) {
    if (color === this.textColor && rvs === this.rvs) return;
    this.flush();
    this.textColor = color;
    this.rvs = rvs;
  };
  // Everything visible goes through here as PETSCII: control codes act, the rest is mapped to
  // Unicode, and the cursor wraps at 40 columns.
  M.out = function (s) {
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 13 || c === 10) {
        // A CR straight after a wrap would leave a blank row; the 40-column line already ended.
        if (this.wrapped) { this.wrapped = false; continue; }
        if (this.rvs) this.setAttr(this.textColor, false);   // CR ends reverse video
        this.obuf += "\n";
        this.col = 0;
        continue;
      }
      if (c < 32 || (c >= 128 && c < 160)) { this.control(c); continue; }
      this.obuf += c < 256 ? PETSCII[c] : s[i];
      this.wrapped = false;
      if (++this.col >= WIDTH) { this.obuf += "\n"; this.col = 0; this.wrapped = true; }
    }
  };
  M.control = function (c) {
    if (c === 147) {                  // CLR/HOME
      this.obuf = "";
      if (this.io.clear) this.io.clear();
      this.col = 0;
      this.wrapped = false;
    } else if (c === 18) this.setAttr(this.textColor, true);
    else if (c === 146) this.setAttr(this.textColor, false);
    else if (COLOR_CODES[c] != null) this.setTextColor(COLOR_CODES[c]);
    // Cursor movement, HOME, DEL and the charset switch have no screen to act on here.
  };
  M.setTextColor = function (idx) {
    this.mem[646] = idx;
    this.setAttr(idx, this.rvs);
  };

  // For io hooks (the disk drive's SEARCHING FOR ... messages).
  M.print = function (s) { this.out(normalize(s).replace(/\n/g, "\r")); this.flush(); };
  M.ready = function () {
    this.out("\rREADY.\r");
    this.flush();
    this.keys = [];
  };

  // ---------- entering lines ----------

  // A typed line: numbered lines edit the program, anything else runs at once. Resolves when the
  // machine is back at READY.
  M.enter = function (text) {
    if (this.running) return Promise.resolve();
    text = normalize(text);
    this.col = 0;
    this.wrapped = false;
    var m = /^\s*(\d+)\s*(.*)$/.exec(text);
    if (m) {
      var n = +m[1];
      if (n > 63999) { this.out("\r?SYNTAX  ERROR"); this.ready(); return Promise.resolve(); }
      this.storeLine(n, m[2]);
      return Promise.resolve();
    }
    if (!text.trim()) return Promise.resolve();
    this.pc = { line: { num: -1, toks: crunch(text) }, idx: -1, pos: 0 };
    return this.loop();
  };

  M.storeLine = function (n, rest) {
    var i, p = this.prog;
    for (i = 0; i < p.length && p[i].num !== n; i++);
    if (!rest.trim()) {
      if (i < p.length) p.splice(i, 1);
    } else {
      var line = { num: n, toks: crunch(rest) };
      if (i < p.length) p[i] = line;
      else {
        for (i = 0; i < p.length && p[i].num < n; i++);
        p.splice(i, 0, line);
      }
    }
    this.changed();
  };

  // Editing the program, like on the real thing, forgets the variables and CONT.
  M.changed = function () {
    this.lineIndex = null;
    this.data = null;
    this.cont = null;
    this.clr();
  };

  // Replace the whole program from listing lines ("10 PRINT ..."). raw keeps the text as is
  // instead of crunching it (a disk directory isn't BASIC, it only lists like it). keepVars is
  // LOAD from a running program: the C64 chains into the new one with the variables intact.
  M.setProgram = function (lines, raw, keepVars) {
    this.prog = [];
    for (var i = 0; i < lines.length; i++) {
      var m = /^\s*(\d+) ?(.*)$/.exec(lines[i]);
      if (!m) continue;
      this.prog.push({ num: +m[1], toks: raw ? m[2].split("") : crunch(normalize(m[2])) });
    }
    if (!keepVars) return this.changed();
    this.lineIndex = null;
    this.data = null;
    this.dataIdx = 0;
    this.cont = null;
    this.stack = [];
  };

  M.listing = function () {
    return this.prog.map(function (l) { return l.num + " " + detokenize(l.toks); });
  };

  // ---------- the run loop ----------

  M.loop = function () {
    var self = this;
    this.running = true;
    this.stopReq = false;
    return new Promise(function (resolve) {
      function finish() {
        self.running = false;
        self.inDos = false;
        self.flush();
        resolve();
      }
      function step() {
        var r;
        try { r = self.runSlice(); } catch (e) { self.fail(e); return finish(); }
        if (r === DONE) return finish();
        self.flush();
        if (r === YIELD) return self.yieldFn(step);
        r.then(function (v) {
          self.inDos = false;
          if (v === DONE) return finish();
          try { self.endStatement(); } catch (e) { self.fail(e); return finish(); }
          step();
        }, function (e) { self.fail(e); finish(); });
      }
      step();
    });
  };

  M.runSlice = function () {
    for (var n = 0; n < this.slice; n++) {
      if (this.stopReq) { this.stopReq = false; return this.doBreak(); }
      var p = this.pc, t = this.peek();
      if (t === null) {
        if (p.idx < 0) { this.ready(); return DONE; }
        if (p.idx + 1 >= this.prog.length) { this.cont = null; this.ready(); return DONE; }
        this.pc = { line: this.prog[p.idx + 1], idx: p.idx + 1, pos: 0 };
        continue;
      }
      if (t === ":") { p.pos++; continue; }
      this.stmtStart = p.pos;
      this.jumped = false;
      var r = this.statement();
      if (r === DONE) return DONE;
      if (r && typeof r.then === "function") return r;
      this.endStatement();
    }
    return YIELD;
  };

  M.endStatement = function () {
    if (this.jumped) return;
    var t = this.peek();
    if (t !== null && t !== ":") throw err("SYNTAX");
  };

  M.inProgram = function () { return this.pc && this.pc.idx >= 0; };
  M.lineSuffix = function () { return this.inProgram() ? " IN " + this.pc.line.num : ""; };

  M.fail = function (e) {
    if (!(e instanceof BasicError)) {
      if (typeof console !== "undefined") console.error(e);
      e = err(e instanceof RangeError ? "OUT OF MEMORY" : "SYNTAX");
    }
    var where = e.line != null ? " IN " + e.line : this.lineSuffix();
    if (this.inProgram()) this.cont = null;
    this.pendingInput = null;
    this.out("\r?" + e.message + "  ERROR" + where);
    this.ready();
  };

  M.halt = function (msg) {
    if (msg) this.out(msg);
    this.ready();
    return DONE;
  };

  // RUN/STOP: remember where we were so CONT can pick it up.
  M.doBreak = function () {
    this.cont = this.inProgram() ? this.copyPc() : null;
    return this.halt("\rBREAK" + this.lineSuffix());
  };

  // RUN/STOP from the keyboard. Takes effect between statements, or at once in INPUT.
  M.stop = function () {
    if (!this.running || this.inDos) return false;
    if (this.pendingInput) {
      var resolve = this.pendingInput;
      this.pendingInput = null;
      if (this.io.cancelInput) this.io.cancelInput();
      resolve(BREAK);
    } else {
      this.stopReq = true;
    }
    return true;
  };

  // A key for GET; the C64's keyboard buffer holds ten.
  M.key = function (code) {
    if (this.keys.length < 10) this.keys.push(String.fromCharCode(code));
  };

  M.copyPc = function () { return { line: this.pc.line, idx: this.pc.idx, pos: this.pc.pos }; };

  // ---------- token reader (the ROM's CHRGET: spaces are skipped everywhere but in strings) ----

  M.peek = function () {
    var p = this.pc, t = p.line.toks;
    while (p.pos < t.length && t[p.pos] === " ") p.pos++;
    return p.pos < t.length ? t[p.pos] : null;
  };
  M.accept = function (tok) {
    if (this.peek() === tok) { this.pc.pos++; return true; }
    return false;
  };
  M.expect = function (tok) { if (!this.accept(tok)) throw err("SYNTAX"); };
  M.atEnd = function () { var t = this.peek(); return t === null || t === ":"; };

  // Skip to the end of the statement (DATA, DEF): quotes protect colons.
  M.skipStatement = function () {
    var p = this.pc, t = p.line.toks, q = false;
    while (p.pos < t.length && (q || t[p.pos] !== ":")) {
      if (t[p.pos] === '"') q = !q;
      p.pos++;
    }
  };

  M.lineNum = function () {
    var s = "";
    while (isDigit(this.peek())) s += this.pc.line.toks[this.pc.pos++];
    var n = s ? +s : 0;
    if (n > 63999) throw err("SYNTAX");
    return n;
  };

  M.findLine = function (n) {
    if (!this.lineIndex) {
      this.lineIndex = new Map();
      for (var i = 0; i < this.prog.length; i++) {
        if (!this.lineIndex.has(this.prog[i].num)) this.lineIndex.set(this.prog[i].num, i);
      }
    }
    var idx = this.lineIndex.get(n);
    if (idx == null) throw err("UNDEF'D STATEMENT");
    return idx;
  };
  M.jump = function (n) {
    var i = this.findLine(n);
    this.pc = { line: this.prog[i], idx: i, pos: 0 };
    this.jumped = true;
  };
  M.push = function (frame) {
    if (this.stack.length >= MAX_STACK) throw err("OUT OF MEMORY");
    this.stack.push(frame);
  };

  // ---------- variables ----------

  // A variable reference: only the first two characters of a name count, $ and % pick the type,
  // and a ( makes it an array element.
  M.varRef = function () {
    var t = this.peek();
    if (!isLetter(t)) throw err("SYNTAX");
    var name = t;
    this.pc.pos++;
    while (isLetter(t = this.peek()) || isDigit(t)) { name += t; this.pc.pos++; }
    var type = "";
    if (t === "$" || t === "%") { type = t; this.pc.pos++; }
    var ref = { key: name.slice(0, 2) + type, type: type };
    if (this.peek() === "(") {
      this.pc.pos++;
      ref.idx = [];
      do {
        var v = Math.trunc(num(this.expr()));
        if (v < 0 || v > 32767) throw err("ILLEGAL QUANTITY");
        ref.idx.push(v);
      } while (this.accept(","));
      this.expect(")");
    }
    return ref;
  };

  M.jiffies = function () {
    return Math.floor(((this.now() - this.t0) * 0.06 + this.tiOffset) % 5184000 + 5184000) % 5184000;
  };

  M.element = function (ref) {
    var a = this.arrays.get(ref.key);
    if (!a) a = this.dim(ref.key, ref.type, ref.idx.map(function () { return 10; }));
    if (a.dims.length !== ref.idx.length) throw err("BAD SUBSCRIPT");
    var off = 0;
    for (var i = 0; i < a.dims.length; i++) {
      if (ref.idx[i] >= a.dims[i]) throw err("BAD SUBSCRIPT");
      off = off * a.dims[i] + ref.idx[i];
    }
    return { a: a, off: off };
  };

  M.dim = function (key, type, sizes) {
    if (this.arrays.has(key)) throw err("REDIM'D ARRAY");
    var dims = sizes.map(function (s) { return s + 1; });
    var n = dims.reduce(function (x, y) { return x * y; }, 1);
    if (n * 5 > this.fre()) throw err("OUT OF MEMORY");
    var a = { dims: dims, data: new Array(n).fill(type === "$" ? "" : 0), type: type };
    this.arrays.set(key, a);
    return a;
  };

  M.getVar = function (ref) {
    if (ref.idx) { var e = this.element(ref); return e.a.data[e.off]; }
    if (ref.key === "TI") return this.jiffies();
    if (ref.key === "TI$") {
      var s = Math.floor(this.jiffies() / 60);
      return [s / 3600, (s / 60) % 60, s % 60].map(function (x) {
        return ("0" + Math.floor(x)).slice(-2);
      }).join("");
    }
    if (ref.key === "ST") return 0;
    var v = this.vars.get(ref.key);
    return v === undefined ? (ref.type === "$" ? "" : 0) : v;
  };

  M.setVar = function (ref, v) {
    if (ref.type === "$") str(v);
    else {
      num(v);
      if (ref.type === "%") v = int16(v);
    }
    if (ref.idx) { var e = this.element(ref); e.a.data[e.off] = v; return; }
    if (ref.key === "TI" || ref.key === "ST") throw err("SYNTAX");
    if (ref.key === "TI$") {
      if (!/^\d{6}$/.test(v)) throw err("ILLEGAL QUANTITY");
      var target = ((+v.slice(0, 2) * 60 + +v.slice(2, 4)) * 60 + +v.slice(4)) * 60;
      if (target >= 5184000) throw err("ILLEGAL QUANTITY");
      this.tiOffset = target - (this.now() - this.t0) * 0.06;
      return;
    }
    this.vars.set(ref.key, v);
  };

  // Plausible free memory: the stock 38911 bytes, less what the program and variables take.
  M.fre = function () {
    var used = 0;
    this.prog.forEach(function (l) { used += l.toks.length + 5; });
    this.vars.forEach(function (v) { used += 7 + (typeof v === "string" ? v.length : 0); });
    this.arrays.forEach(function (a) {
      used += 7 + a.data.length * (a.type === "%" ? 2 : a.type === "$" ? 3 : 5);
    });
    return Math.max(0, FREE - used);
  };

  // ---------- expressions: OR < AND < NOT < relations < + - < * / < unary - < ^ ----------

  M.expr = function () {
    var a = this.andExpr();
    while (this.accept(K.OR)) a = int16(a) | int16(this.andExpr());
    return a;
  };
  M.andExpr = function () {
    var a = this.relExpr();
    while (this.accept(K.AND)) a = int16(a) & int16(this.relExpr());
    return a;
  };
  M.relExpr = function () {
    var a = this.addExpr();
    for (;;) {
      var op = 0, t;
      while ((t = this.peek()) === "<" || t === "=" || t === ">") {
        op |= t === "<" ? 1 : t === "=" ? 2 : 4;
        this.pc.pos++;
      }
      if (!op) return a;
      var b = this.addExpr();
      if (typeof a !== typeof b) throw err("TYPE MISMATCH");
      a = ((op & 1) && a < b) || ((op & 2) && a === b) || ((op & 4) && a > b) ? -1 : 0;
    }
  };
  M.addExpr = function () {
    var a = this.mulExpr(), t;
    while ((t = this.peek()) === "+" || t === "-") {
      this.pc.pos++;
      var b = this.mulExpr();
      if (t === "+" && typeof a === "string") a = strLen(a + str(b));
      else a = check(t === "+" ? num(a) + num(b) : num(a) - num(b));
    }
    return a;
  };
  M.mulExpr = function () {
    var a = this.unary(), t;
    while ((t = this.peek()) === "*" || t === "/") {
      this.pc.pos++;
      var b = num(this.unary());
      num(a);
      if (t === "/" && b === 0) throw err("DIVISION BY ZERO");
      a = check(t === "*" ? a * b : a / b);
    }
    return a;
  };
  M.unary = function () {
    if (this.accept("-")) return -num(this.unary());
    if (this.accept("+")) return this.unary();
    return this.power();
  };
  M.power = function () {
    var a = this.primary();
    while (this.accept("^")) {
      var b = num(this.powOperand());
      num(a);
      if (a === 0 && b < 0) throw err("DIVISION BY ZERO");
      var r = Math.pow(a, b);
      if (isNaN(r)) throw err("ILLEGAL QUANTITY");
      a = check(r);
    }
    return a;
  };
  M.powOperand = function () {
    if (this.accept("-")) return -num(this.powOperand());
    if (this.accept("+")) return this.powOperand();
    return this.primary();
  };

  M.primary = function () {
    var t = this.peek(), p = this.pc;
    if (t === null) throw err("SYNTAX");
    if (t === "(") {
      p.pos++;
      var v = this.expr();
      this.expect(")");
      return v;
    }
    if (t === '"') return this.stringLiteral();
    if (isDigit(t) || t === ".") return this.number();
    if (isLetter(t)) return this.getVar(this.varRef());
    if (t === "ÿ") { p.pos++; return Math.PI; }
    if (typeof t !== "number") throw err("SYNTAX");
    p.pos++;
    if (t === K.NOT) return ~int16(this.relExpr());
    if (t === K.FN) return this.callFn();
    return this.func(t);
  };

  M.stringLiteral = function () {
    var p = this.pc, toks = p.line.toks, i = p.pos + 1, s = "";
    while (i < toks.length && toks[i] !== '"') {
      s += typeof toks[i] === "number" ? KEYWORDS[toks[i]] : toks[i];
      i++;
    }
    p.pos = i < toks.length ? i + 1 : i;   // an unclosed string runs to the end of the line
    return s;
  };

  M.number = function () {
    var s = "", t;
    while (isDigit(t = this.peek()) || (t === "." && s.indexOf(".") < 0)) { s += t; this.pc.pos++; }
    if (this.peek() === "E") {
      this.pc.pos++;
      s += "E";
      t = this.peek();
      if (t === "+" || t === "-") { s += t; this.pc.pos++; }
      while (isDigit(this.peek())) s += this.pc.line.toks[this.pc.pos++];
    }
    return fin(s, false);
  };

  M.args = function (n) {
    this.expect("(");
    var a = [this.expr()];
    while (a.length < n && this.accept(",")) a.push(this.expr());
    this.expect(")");
    return a;
  };

  M.func = function (t) {
    var a, s, n;
    switch (t) {
      case K.SGN: a = num(this.args(1)[0]); return a > 0 ? 1 : a < 0 ? -1 : 0;
      case K.INT: return Math.floor(num(this.args(1)[0]));
      case K.ABS: return Math.abs(num(this.args(1)[0]));
      case K.USR: this.args(1); throw err("ILLEGAL QUANTITY");  // the vector's default target
      case K.FRE: this.args(1); return this.fre();
      case K.POS: this.args(1); return this.col;
      case K.SQR:
        a = num(this.args(1)[0]);
        if (a < 0) throw err("ILLEGAL QUANTITY");
        return Math.sqrt(a);
      case K.RND: return this.rnd(num(this.args(1)[0]));
      case K.LOG:
        a = num(this.args(1)[0]);
        if (a <= 0) throw err("ILLEGAL QUANTITY");
        return Math.log(a);
      case K.EXP: return check(Math.exp(num(this.args(1)[0])));
      case K.COS: return Math.cos(num(this.args(1)[0]));
      case K.SIN: return Math.sin(num(this.args(1)[0]));
      case K.TAN: return check(Math.tan(num(this.args(1)[0])));
      case K.ATN: return Math.atan(num(this.args(1)[0]));
      case K.PEEK: return this.peekMem(byte(this.args(1)[0], 0, 65535));
      case K.LEN: return str(this.args(1)[0]).length;
      case K["STR$"]:
        a = num(this.args(1)[0]);
        return (a >= 0 ? " " : "") + fmtNum(a);
      case K.VAL: return fin(str(this.args(1)[0]), false);
      case K.ASC:
        s = str(this.args(1)[0]);
        if (!s) throw err("ILLEGAL QUANTITY");
        return s.charCodeAt(0) & 255;
      case K["CHR$"]: return String.fromCharCode(byte(this.args(1)[0]));
      case K["LEFT$"]:
        a = this.args(2);
        if (a.length < 2) throw err("SYNTAX");
        return str(a[0]).slice(0, byte(a[1]));
      case K["RIGHT$"]:
        a = this.args(2);
        if (a.length < 2) throw err("SYNTAX");
        s = str(a[0]);
        n = byte(a[1]);
        return n >= s.length ? s : s.slice(s.length - n);
      case K["MID$"]:
        a = this.args(3);
        if (a.length < 2) throw err("SYNTAX");
        s = str(a[0]);
        var start = byte(a[1], 1);
        return a.length > 2 ? s.substr(start - 1, byte(a[2])) : s.slice(start - 1);
    }
    throw err("SYNTAX");
  };

  M.rnd = function (x) {
    if (x === 0) return Math.random();
    if (x < 0) {
      var h = Math.floor(Math.abs(x) * 1000003) ^ 0x2545f491;
      this.seed = h >>> 0;
    }
    var r = mulberry(this.seed);
    this.seed = r.seed;
    return r.value;
  };

  M.callFn = function () {
    var name = "", t;
    while (isLetter(t = this.peek()) || (name && isDigit(t))) { name += t; this.pc.pos++; }
    if (!name) throw err("SYNTAX");
    var f = this.fns.get(name.slice(0, 2));
    if (!f) throw err("UNDEF'D FUNCTION");
    var arg = num(this.args(1)[0]);
    var had = this.vars.has(f.param), old = this.vars.get(f.param), saved = this.pc;
    this.vars.set(f.param, arg);
    this.pc = { line: f.line, idx: f.idx, pos: f.pos };
    try {
      return num(this.expr());
    } finally {
      this.pc = saved;
      if (had) this.vars.set(f.param, old); else this.vars.delete(f.param);
    }
  };

  // ---------- memory ----------

  M.peekMem = function (a) {
    if (a === 53280 || a === 53281) return this.mem[a] & 15;
    if (a === 646) return this.textColor == null ? 14 : this.textColor;
    if (a === 198) return this.keys.length;        // keys waiting in the buffer
    if (a === 197) return this.keys.length ? 1 : 64;
    if (a >= 160 && a <= 162) return (this.jiffies() >> ((162 - a) * 8)) & 255;
    return this.mem[a];
  };

  M.pokeMem = function (a, v) {
    this.mem[a] = v;
    if (a === 53280 || a === 53281) {
      if (this.io.color) this.io.color(a === 53280 ? "border" : "background", v & 15);
    } else if (a === 646) this.setTextColor(v & 15);
    else if (a === 198 && v < this.keys.length) this.keys.length = v;
  };

  // ---------- statements ----------

  M.statement = function () {
    var t = this.peek();
    if (typeof t === "number") {
      this.pc.pos++;
      var h = STATEMENTS[t];
      if (!h) throw err("SYNTAX");
      return h.call(this);
    }
    if (isLetter(t)) return this.assign();
    throw err("SYNTAX");
  };

  M.assign = function () {
    var ref = this.varRef();
    this.expect("=");
    this.setVar(ref, this.expr());
  };

  M.illegalDirect = function () { if (!this.inProgram()) throw err("ILLEGAL DIRECT"); };

  // Async statements (INPUT, LOAD, SAVE, SYS hooks) return promises; the run loop waits for them.
  M.readLine = function () {
    var self = this;
    return new Promise(function (resolve) {
      self.pendingInput = resolve;
      Promise.resolve(self.io.input ? self.io.input() : "").then(function (line) {
        if (self.pendingInput === resolve) { self.pendingInput = null; resolve(line); }
      });
    });
  };

  M.doInput = function (prompt, refs) {
    var self = this, start = this.stmtStart;
    function ask(text, from) {
      self.out(text);
      self.flush();
      return self.readLine().then(function (line) {
        if (line === BREAK) { self.pc.pos = start; return self.doBreak(); }
        self.col = 0;
        self.wrapped = false;
        line = normalize(line);
        if (!line.trim()) return;   // a bare Return (at ? or ??) leaves the variables alone
        var r = splitInput(line), vals = [];
        for (var i = 0; i < r.items.length && from + i < refs.length; i++) {
          var ref = refs[from + i], v = r.items[i];
          if (ref.type !== "$") {
            v = v === "" ? 0 : fin(v, true);
            if (v === null) { self.out("?REDO FROM START\r"); return ask(prompt + "? ", 0); }
          }
          vals.push(v);
        }
        vals.forEach(function (v, i) { self.setVar(refs[from + i], v); });
        if (from + vals.length < refs.length) return ask("?? ", from + vals.length);
        if (r.extra || r.items.length > vals.length) self.out("?EXTRA IGNORED\r");
      });
    }
    return ask(prompt + "? ", 0);
  };

  M.loadStmt = function (verb) {
    var name = "", device = 1, sec = 0;
    if (!this.atEnd()) {
      name = str(this.expr());
      if (this.accept(",")) {
        device = byte(this.expr());
        if (this.accept(",")) sec = byte(this.expr());
      }
    }
    var hook = verb === "SAVE" ? this.io.save : this.io.load;
    if (!hook) throw err("DEVICE NOT PRESENT");
    var self = this, direct = !this.inProgram();
    this.flush();
    this.inDos = true;
    var r = verb === "SAVE"
      ? hook.call(this.io, name, device, sec, this.listing(), this)
      : hook.call(this.io, name, device, sec, this);
    return Promise.resolve(r).then(function (res) {
      if (res && res.error) throw err(res.error);
      if (verb === "SAVE") return;
      if (res && res.program) self.setProgram(res.program, res.raw, !direct);
      if (direct) return self.halt("");
      // LOAD from a running program chains: the new program starts at once, variables kept.
      if (!self.prog.length) { self.ready(); return DONE; }
      self.pc = { line: self.prog[0], idx: 0, pos: 0 };
      self.jumped = true;
    });
  };

  // SYS 64738 is the reset vector: a cold start.
  M.coldStart = function () {
    var self = this;
    this.prog = [];
    this.changed();
    this.powerOn();
    this.keys = [];
    this.flush();
    this.inDos = true;
    return Promise.resolve(this.io.reset ? this.io.reset() : null).then(function () {
      self.col = 0;
      self.wrapped = false;
      self.out("READY.\r");
      self.flush();
      return DONE;
    });
  };

  M.list = function () {
    var lo = 0, hi = 65535;
    if (isDigit(this.peek())) {
      lo = hi = this.lineNum();
      if (this.accept("-")) hi = isDigit(this.peek()) ? this.lineNum() : 65535;
    } else if (this.accept("-")) {
      hi = this.lineNum();
    }
    for (var i = 0; i < this.prog.length; i++) {
      var l = this.prog[i];
      if (l.num >= lo && l.num <= hi) this.out("\r" + l.num + " " + detokenize(l.toks));
    }
  };

  var STATEMENTS = {};
  STATEMENTS[K.END] = function () {
    this.cont = this.inProgram() ? this.copyPc() : null;
    return this.halt("");
  };
  STATEMENTS[K.STOP] = function () {
    this.cont = this.inProgram() ? this.copyPc() : null;
    return this.halt("\rBREAK" + this.lineSuffix());
  };
  STATEMENTS[K.REM] = function () {
    this.pc.pos = this.pc.line.toks.length;
  };
  STATEMENTS[K.DATA] = function () { this.skipStatement(); };
  STATEMENTS[K.LET] = function () { this.assign(); };

  STATEMENTS[K.PRINT] = function () {
    var newline = true, t;
    while (!this.atEnd()) {
      t = this.peek();
      if (t === ";") { this.pc.pos++; newline = false; continue; }
      if (t === ",") {
        this.pc.pos++;
        this.out(" ".repeat(10 - this.col % 10));   // 10-column print zones
        newline = false;
        continue;
      }
      if (t === K["TAB("] || t === K["SPC("]) {
        this.pc.pos++;
        var n = byte(this.expr());
        this.expect(")");
        if (t === K["SPC("]) this.out(" ".repeat(n));
        else if (n > this.col) this.out(" ".repeat(n - this.col));
        newline = false;
        continue;
      }
      var v = this.expr();
      this.out(typeof v === "number" ? (v < 0 ? "" : " ") + fmtNum(v) + " " : v);
      newline = true;
    }
    if (newline) this.out("\r");
  };

  STATEMENTS[K.GOTO] = function () { this.jump(this.lineNum()); };
  STATEMENTS[K.GO] = function () { this.expect(K.TO); this.jump(this.lineNum()); };
  STATEMENTS[K.GOSUB] = function () {
    var n = this.lineNum();
    this.push({ type: "gosub", pc: this.copyPc() });
    this.jump(n);
  };
  STATEMENTS[K.RETURN] = function () {
    while (this.stack.length && this.stack[this.stack.length - 1].type !== "gosub") this.stack.pop();
    var f = this.stack.pop();
    if (!f) throw err("RETURN WITHOUT GOSUB");
    this.pc = { line: f.pc.line, idx: f.pc.idx, pos: f.pc.pos };
  };

  STATEMENTS[K.IF] = function () {
    var v = this.expr(), t = this.peek();
    var truth = typeof v === "string" ? v.length > 0 : v !== 0;
    if (t === K.GOTO) {
      this.pc.pos++;
      var n = this.lineNum();
      if (truth) this.jump(n); else this.pc.pos = this.pc.line.toks.length;
      return;
    }
    this.expect(K.THEN);
    this.jumped = true;          // what follows THEN is a new statement, not trailing garbage
    if (!truth) { this.pc.pos = this.pc.line.toks.length; return; }
    if (isDigit(this.peek())) this.jump(this.lineNum());
  };

  STATEMENTS[K.ON] = function () {
    var v = byte(this.expr()), t = this.peek();
    if (t !== K.GOTO && t !== K.GOSUB) throw err("SYNTAX");
    this.pc.pos++;
    var lines = [this.lineNum()];
    while (this.accept(",")) lines.push(this.lineNum());
    if (v < 1 || v > lines.length) return;
    if (t === K.GOSUB) this.push({ type: "gosub", pc: this.copyPc() });
    this.jump(lines[v - 1]);
  };

  STATEMENTS[K.FOR] = function () {
    var ref = this.varRef();
    if (ref.type === "$") throw err("TYPE MISMATCH");
    if (ref.type || ref.idx) throw err("SYNTAX");
    this.expect("=");
    this.setVar(ref, num(this.expr()));
    this.expect(K.TO);
    var limit = num(this.expr()), step = 1;
    if (this.accept(K.STEP)) step = num(this.expr());
    // A FOR on a variable that already has a loop open replaces it (and anything inside it).
    for (var i = this.stack.length - 1; i >= 0 && this.stack[i].type === "for"; i--) {
      if (this.stack[i].key === ref.key) { this.stack.length = i; break; }
    }
    this.push({ type: "for", key: ref.key, limit: limit, step: step, pc: this.copyPc() });
  };

  STATEMENTS[K.NEXT] = function () {
    do {
      var key = null;
      if (isLetter(this.peek())) key = this.varRef().key;
      var i = this.stack.length - 1;
      for (; i >= 0 && this.stack[i].type === "for"; i--) {
        if (key === null || this.stack[i].key === key) break;
      }
      if (i < 0 || this.stack[i].type !== "for") throw err("NEXT WITHOUT FOR");
      this.stack.length = i + 1;
      var f = this.stack[i];
      var v = check((this.vars.get(f.key) || 0) + f.step);
      this.vars.set(f.key, v);
      // Done once past the limit in the step's direction; STEP 0 never gets there.
      if (f.step > 0 ? v <= f.limit : f.step < 0 ? v >= f.limit : true) {
        this.pc = { line: f.pc.line, idx: f.pc.idx, pos: f.pc.pos };
        this.jumped = true;
        return;
      }
      this.stack.pop();
    } while (this.accept(","));
  };

  STATEMENTS[K.DIM] = function () {
    do {
      var ref = this.varRef();
      if (ref.idx) this.dim(ref.key, ref.type, ref.idx);
    } while (this.accept(","));
  };

  STATEMENTS[K.READ] = function () {
    if (!this.data) this.data = this.collectData();
    do {
      var ref = this.varRef();
      var item = this.data[this.dataIdx];
      if (!item) throw err("OUT OF DATA");
      this.dataIdx++;
      var v = item.text;
      if (ref.type !== "$") {
        v = v === "" ? 0 : fin(v, true);
        if (v === null) throw err("SYNTAX", item.line);   // reported against the DATA line
      }
      this.setVar(ref, v);
    } while (this.accept(","));
  };
  STATEMENTS[K.RESTORE] = function () { this.dataIdx = 0; };

  M.collectData = function () {
    var items = [];
    this.prog.forEach(function (l) {
      var t = l.toks, i = 0, q = false;
      for (; i < t.length; i++) {
        if (t[i] === '"') q = !q;
        if (q || t[i] !== K.DATA) continue;
        i++;
        var cur = "", quoted = false, inq = false;
        for (; i <= t.length; i++) {
          var c = i < t.length ? t[i] : ":";
          if (inq) { if (c === '"') inq = false; else cur += c; continue; }
          if (c === '"' && !cur.trim()) { inq = quoted = true; cur = ""; continue; }
          if (quoted && c !== "," && c !== ":") continue;   // nothing counts after the closing quote
          if (c === "," || c === ":") {
            items.push({ text: quoted ? cur : cur.trim(), line: l.num });
            cur = "";
            quoted = false;
            if (c === ":") break;
            continue;
          }
          cur += typeof c === "number" ? KEYWORDS[c] : c;
        }
      }
    });
    return items;
  };

  STATEMENTS[K.INPUT] = function () {
    this.illegalDirect();
    var prompt = "";
    if (this.peek() === '"') {
      prompt = this.stringLiteral();
      this.expect(";");
    }
    var refs = [];
    do refs.push(this.varRef()); while (this.accept(","));
    return this.doInput(prompt, refs);
  };

  STATEMENTS[K.GET] = function () {
    if (this.accept("#")) throw err("FILE NOT OPEN");
    this.illegalDirect();
    do {
      var ref = this.varRef(), k = this.keys.shift() || "";
      if (ref.type === "$") this.setVar(ref, k);
      else if (!k) this.setVar(ref, 0);
      else if (isDigit(k)) this.setVar(ref, +k);
      else throw err("SYNTAX");
    } while (this.accept(","));
  };

  STATEMENTS[K.DEF] = function () {
    this.illegalDirect();
    this.expect(K.FN);
    var name = "", t;
    while (isLetter(t = this.peek()) || (name && isDigit(t))) { name += t; this.pc.pos++; }
    if (!name) throw err("SYNTAX");
    this.expect("(");
    var param = this.varRef();
    if (param.type || param.idx) throw err("SYNTAX");
    this.expect(")");
    this.expect("=");
    this.fns.set(name.slice(0, 2), { param: param.key, line: this.pc.line, idx: this.pc.idx, pos: this.pc.pos });
    this.skipStatement();
  };

  STATEMENTS[K.POKE] = function () {
    var a = byte(this.expr(), 0, 65535);
    this.expect(",");
    this.pokeMem(a, byte(this.expr()));
  };

  // WAIT addr,mask[,xor] spins until a bit comes up; WAIT 198,1 waits for a key.
  STATEMENTS[K.WAIT] = function () {
    var a = byte(this.expr(), 0, 65535);
    this.expect(",");
    var mask = byte(this.expr()), x = 0;
    if (this.accept(",")) x = byte(this.expr());
    if (((this.peekMem(a) ^ x) & mask) === 0) {
      this.pc.pos = this.stmtStart;
      this.jumped = true;
    }
  };

  STATEMENTS[K.SYS] = function () {
    var a = byte(this.expr(), 0, 65535);
    if (a === 64738) return this.coldStart();
    if (!this.io.sys) return;
    this.flush();
    var r = this.io.sys(a, this);
    if (r && typeof r.then === "function") { this.inDos = true; return r; }
  };

  STATEMENTS[K.LOAD] = function () { return this.loadStmt("LOAD"); };
  STATEMENTS[K.SAVE] = function () { return this.loadStmt("SAVE"); };

  STATEMENTS[K.LIST] = function () {
    this.list();
    if (this.inProgram()) return this.halt("");   // LIST in a program lists, then stops
  };

  STATEMENTS[K.RUN] = function () {
    this.clr();
    this.data = null;
    this.cont = null;
    if (isDigit(this.peek())) { this.jump(this.lineNum()); return; }
    if (!this.prog.length) return this.halt("");
    this.pc = { line: this.prog[0], idx: 0, pos: 0 };
    this.jumped = true;
  };

  STATEMENTS[K.CONT] = function () {
    if (!this.cont || this.inProgram()) throw err("CAN'T CONTINUE");
    this.pc = this.cont;
    this.cont = null;
    this.jumped = true;
  };

  STATEMENTS[K.CLR] = function () { this.clr(); };
  STATEMENTS[K.NEW] = function () {
    this.prog = [];
    this.changed();
    if (this.inProgram()) return this.halt("");
  };

  // No files or printers behind these: CLOSE and OPEN quietly do nothing, and anything that
  // talks to an open file finds none.
  STATEMENTS[K.OPEN] = function () { this.skipStatement(); };
  STATEMENTS[K.CLOSE] = function () { this.skipStatement(); };
  STATEMENTS[K["PRINT#"]] = STATEMENTS[K["INPUT#"]] = STATEMENTS[K.CMD] = function () {
    throw err("FILE NOT OPEN");
  };

  return {
    Machine: Machine,
    PALETTE: PALETTE,
    COLOR_NAMES: COLOR_NAMES,
    KEYWORDS: KEYWORDS,
    crunch: crunch,
    detokenize: detokenize,
    fmtNum: fmtNum,
    matchName: matchName,
    directory: directory,
    toUnicode: function (s) {
      var o = "";
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        o += c < 256 ? (PETSCII[c] || "") : s[i];
      }
      return o;
    }
  };
});
