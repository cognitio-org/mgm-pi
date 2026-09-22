// Tests for public/basic.js, the landing page's C64 BASIC V2 interpreter.
// Run with: node --test outfitter/landing/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

// basic.js is a plain browser script; loading it attaches Basic to globalThis.
await import(fileURLToPath(new URL("../public/basic.js", import.meta.url)));
const Basic = globalThis.Basic;

// A machine wired to an in-memory screen. Keys typed at INPUT come from `answers`.
function machine(opts = {}) {
  const screen = { text: "", colors: [], clears: 0 };
  const answers = opts.answers ? [...opts.answers] : [];
  const io = {
    write(s) { screen.text += s; },
    clear() { screen.text = ""; screen.clears++; },
    color(which, idx) { screen.colors.push([which, idx]); },
    input() { return Promise.resolve(answers.shift() ?? ""); },
    ...opts.io,
  };
  const m = new Basic.Machine(io, { slice: opts.slice || 10000, yield: opts.yield || setImmediate, seed: 1 });
  return { m, screen };
}

// Enter lines one by one and return everything printed.
async function run(lines, opts) {
  const { m, screen } = machine(opts);
  for (const l of lines) await m.enter(l);
  return { out: screen.text, m, screen };
}

// The screen as trimmed lines, handy for asserting on the shape of the output.
const rows = (s) => s.split("\n");

test("expression precedence follows the C64", async () => {
  const cases = {
    "2+3*4": " 14 ",
    "(2+3)*4": " 20 ",
    "-2^2": "-4 ",
    "2^3^2": " 64 ",
    "2^-1": " .5 ",
    "10-4-3": " 3 ",
    "1+2=3": "-1 ",
    "1<2 AND 2<1": " 0 ",
    "NOT 0": "-1 ",
    "NOT 1=2": "-1 ",
    "5 AND 3": " 1 ",
    "5 OR 3": " 7 ",
    "3 OR 4 AND 0": " 3 ",
    "7/2": " 3.5 ",
    '"A"<"B"': "-1 ",
    "1/3": " .333333333 ",
    "1E9": " 1E+09 ",
    ".001": " 1E-03 ",
    "123456789": " 123456789 ",
  };
  for (const [e, want] of Object.entries(cases)) {
    const { out } = await run(["PRINT " + e]);
    assert.equal(rows(out)[0], want, e);
  }
});

test("PRINT formatting: separators, zones, trailing semicolon", async () => {
  assert.equal(rows((await run(["PRINT 1;2"])).out)[0], " 1  2 ");
  assert.equal(rows((await run(['PRINT "A","B"'])).out)[0], "A         B");
  assert.equal(rows((await run(['PRINT "A";"B"'])).out)[0], "AB");
  assert.equal(rows((await run(['PRINT "X"TAB(5)"Y"'])).out)[0], "X    Y");
  assert.equal(rows((await run(['PRINT "X"SPC(3)"Y"'])).out)[0], "X   Y");
  assert.equal(rows((await run(["?-5"])).out)[0], "-5 ");
  // A PRINT ending in ; leaves the cursor on the line, so READY. follows directly.
  const { out } = await run(['10 PRINT "HI";', "RUN"]);
  assert.deepEqual(rows(out), ["HI", "READY.", ""]);
  // Otherwise READY. comes after a blank line, as on the real screen.
  assert.deepEqual(rows((await run(['PRINT "HI"'])).out), ["HI", "", "READY.", ""]);
});

test("PRINT wraps at 40 columns", async () => {
  const { out } = await run(['PRINT "' + "X".repeat(45) + '"']);
  assert.equal(rows(out)[0], "X".repeat(40));
  assert.equal(rows(out)[1], "XXXXX");
});

test("string functions", async () => {
  const cases = {
    'LEFT$("HELLO",2)': "HE",
    'RIGHT$("HELLO",3)': "LLO",
    'MID$("HELLO",2,3)': "ELL",
    'MID$("HELLO",4)': "LO",
    'LEN("HELLO")': " 5 ",
    'ASC("A")': " 65 ",
    "CHR$(65)": "A",
    "STR$(42)": " 42",
    'VAL("12.5E1")': " 125 ",
    'VAL("X")': " 0 ",
    '"AB"+"CD"': "ABCD",
    "INT(-2.5)": "-3 ",
    "ABS(-3)": " 3 ",
    "SGN(-9)": "-1 ",
    "SQR(16)": " 4 ",
  };
  for (const [e, want] of Object.entries(cases)) {
    assert.equal(rows((await run(["PRINT " + e])).out)[0], want, e);
  }
});

test("variables: two significant characters, integer and string types, arrays", async () => {
  const { out } = await run([
    "10 ABC=5:ABX=7:PRINT ABC",
    '20 A%=3.9:A$="S":PRINT A%;A$',
    "30 DIM B(3,3):B(2,3)=9:PRINT B(2,3)",
    "40 C(10)=1:PRINT C(10)",
    "RUN",
  ]);
  assert.deepEqual(rows(out).slice(0, 4), [" 7 ", " 3 S", " 9 ", " 1 "]);
  assert.match((await run(["10 C(11)=1", "RUN"])).out, /\?BAD SUBSCRIPT  ERROR IN 10/);
  assert.match((await run(["10 DIM A(2):DIM A(3)", "RUN"])).out, /\?REDIM'D ARRAY  ERROR IN 10/);
  assert.match((await run(['10 A$=5', "RUN"])).out, /\?TYPE MISMATCH  ERROR IN 10/);
  assert.match((await run(["10 A%=40000", "RUN"])).out, /\?ILLEGAL QUANTITY  ERROR IN 10/);
});

test("keywords crunch without spaces, like the real tokenizer", async () => {
  const { out } = await run(["10 FORI=1TO3:PRINTI;:NEXT", "RUN"]);
  assert.equal(rows(out)[0], " 1  2  3 ");
});

test("FOR/NEXT with STEP, nested loops and NEXT I,J", async () => {
  let { out } = await run(["10 FOR I=10 TO 1 STEP -3:PRINT I;:NEXT I", "RUN"]);
  assert.equal(rows(out)[0], " 10  7  4  1 ");
  ({ out } = await run(["10 FOR I=1 TO 2:FOR J=1 TO 2:PRINT I*10+J;:NEXT J,I", "RUN"]));
  assert.equal(rows(out)[0], " 11  12  21  22 ");
  ({ out } = await run(["10 FOR I=1 TO 3:NEXT:PRINT I", "RUN"]));
  assert.equal(rows(out)[0], " 4 ");
  ({ out } = await run(["10 NEXT", "RUN"]));
  assert.match(out, /\?NEXT WITHOUT FOR  ERROR IN 10/);
  // The loop runs in direct mode too.
  ({ out } = await run(["FOR I=1 TO 3:PRINT I;:NEXT"]));
  assert.equal(rows(out)[0], " 1  2  3 ");
});

test("GOSUB/RETURN and ON GOTO/GOSUB", async () => {
  let { out } = await run([
    '10 GOSUB 100:PRINT "BACK":END',
    '100 PRINT "SUB":RETURN',
    "RUN",
  ]);
  assert.deepEqual(rows(out).slice(0, 2), ["SUB", "BACK"]);
  ({ out } = await run(["10 RETURN", "RUN"]));
  assert.match(out, /\?RETURN WITHOUT GOSUB  ERROR IN 10/);
  ({ out } = await run([
    '10 FOR X=1 TO 3:ON X GOSUB 100,200,300:NEXT:END',
    '100 PRINT "A";:RETURN', '200 PRINT "B";:RETURN', '300 PRINT "C";:RETURN',
    "RUN",
  ]));
  assert.deepEqual(rows(out).slice(0, 2), ["ABC", "READY."]);
  ({ out } = await run(['10 ON 2 GOTO 20,30', '20 PRINT "NO"', '30 PRINT "YES"', "RUN"]));
  assert.equal(rows(out)[0], "YES");
});

test("DATA/READ/RESTORE", async () => {
  let { out } = await run([
    '10 READ A,B$,C:PRINT A;B$;C',
    '20 RESTORE:READ D:PRINT D',
    '30 DATA 1, "HI, THERE" ,3',
    "RUN",
  ]);
  assert.deepEqual(rows(out).slice(0, 2), [" 1 HI, THERE 3 ", " 1 "]);
  ({ out } = await run(["10 READ A,B", "20 DATA 1", "RUN"]));
  assert.match(out, /\?OUT OF DATA  ERROR IN 10/);
  ({ out } = await run(["10 READ A", "20 DATA X", "RUN"]));
  assert.match(out, /\?SYNTAX  ERROR IN 20/);
});

test("IF/THEN with a line number, a statement, and GOTO", async () => {
  let { out } = await run([
    '10 A=5:IF A>3 THEN PRINT "BIG":PRINT "STILL"',
    '20 IF A<3 THEN PRINT "SMALL":PRINT "NOT HERE"',
    "30 IF A=5 THEN 50",
    '40 PRINT "SKIPPED"',
    '50 IF A GOTO 70',
    '60 PRINT "SKIPPED TOO"',
    '70 PRINT "END"',
    "RUN",
  ]);
  assert.deepEqual(rows(out).slice(0, 3), ["BIG", "STILL", "END"]);
});

test("errors are authentic and carry the line number", async () => {
  const cases = [
    ["10 PRINT 1/0", "?DIVISION BY ZERO  ERROR IN 10"],
    ["10 GOTO 99", "?UNDEF'D STATEMENT  ERROR IN 10"],
    ["10 X=", "?SYNTAX  ERROR IN 10"],
    ['10 A$="X"+1', "?TYPE MISMATCH  ERROR IN 10"],
    ["10 PRINT CHR$(300)", "?ILLEGAL QUANTITY  ERROR IN 10"],
    ['10 A$="1234567890":FOR I=1 TO 5:A$=A$+A$:NEXT', "?STRING TOO LONG  ERROR IN 10"],
  ];
  for (const [line, msg] of cases) {
    const { out } = await run([line, "RUN"]);
    assert.deepEqual(rows(out).slice(-4), ["", msg, "READY.", ""], line);
  }
  // No line number in direct mode.
  assert.deepEqual(rows((await run(["FOO"])).out), ["", "?SYNTAX  ERROR", "READY.", ""]);
  assert.match((await run(["CONT"])).out, /\?CAN'T CONTINUE  ERROR/);
  assert.match((await run(["INPUT A"])).out, /\?ILLEGAL DIRECT  ERROR/);
});

test("program lines are stored, replaced, deleted and listed", async () => {
  const { m, out } = await run([
    '20 print "b"',
    "10 ?\"a\":goto20",
    '30 PRINT "GONE"',
    "30",
    '20 PRINT "B2"',
    "LIST",
  ]);
  assert.deepEqual(m.listing(), ['10 PRINT"A":GOTO20', '20 PRINT "B2"']);
  assert.deepEqual(rows(out), ["", '10 PRINT"A":GOTO20', '20 PRINT "B2"', "READY.", ""]);
  const r = await run(["10 REM A", "20 REM B", "30 REM C", "40 REM D", "LIST 20-30"]);
  assert.deepEqual(rows(r.out).slice(1, 3), ["20 REM B", "30 REM C"]);
  assert.deepEqual(rows((await run(["10 REM A", "20 REM B", "LIST -10"])).out).slice(1, 2), ["10 REM A"]);
  // NEW forgets the program.
  const n = await run(["10 REM A", "NEW"]);
  assert.deepEqual(n.m.listing(), []);
});

test("INPUT reads values, re-asks on bad numbers and accepts several at once", async () => {
  const { out } = await run(
    ['10 INPUT "NAME";N$', "20 INPUT A,B", '30 PRINT N$;A+B', "RUN"],
    { answers: ["ADA", "X", "1,2"] },
  );
  assert.ok(out.includes("NAME? "), out);
  assert.ok(out.includes("?REDO FROM START"), out);
  assert.ok(out.includes("ADA 3 "), out);
});

test("programs run in time slices: a GOTO loop yields and RUN/STOP breaks it", async () => {
  let yields = 0;
  const { m, screen } = machine({ slice: 50, yield: (fn) => { yields++; setImmediate(fn); } });
  await m.enter('10 PRINT "HI":GOTO 10');
  const done = m.enter("RUN");
  while (yields < 5) await new Promise((r) => setImmediate(r));
  assert.equal(m.running, true);
  m.stop();
  await done;
  assert.equal(m.running, false);
  assert.ok(screen.text.startsWith("HI\nHI\nHI\n"));
  assert.match(screen.text, /\nBREAK IN 10\nREADY\.\n$/);
  // CONT picks it up again.
  const again = m.enter("CONT");
  const before = screen.text.length;
  while (screen.text.length < before + 30) await new Promise((r) => setImmediate(r));
  m.stop();
  await again;
  assert.match(screen.text.slice(before), /HI\n/);
});

test("RUN/STOP interrupts INPUT", async () => {
  let asked;
  const { m, screen } = machine({ io: { input: () => new Promise((r) => { asked = r; }) } });
  await m.enter("10 INPUT A");
  const done = m.enter("RUN");
  await new Promise((r) => setImmediate(r));
  assert.ok(asked);
  m.stop();
  await done;
  assert.match(screen.text, /\? \nBREAK IN 10\nREADY\.\n$/);
});

test("POKE/PEEK the border and screen colours", async () => {
  const { out, screen } = await run(["POKE 53280,2:POKE 53281,16+7:PRINT PEEK(53280);PEEK(53281)"]);
  assert.deepEqual(screen.colors, [["border", 2], ["background", 7]]);
  assert.equal(rows(out)[0], " 2  7 ");
  assert.equal(rows((await run(["PRINT PEEK(53280)"])).out)[0], " 14 ");
  assert.match((await run(["POKE 53280,256"])).out, /ILLEGAL QUANTITY/);
});

test("PETSCII: the maze characters and CLR/HOME", async () => {
  const { out } = await run(['PRINT CHR$(205);CHR$(206);CHR$(92)']);
  assert.equal(rows(out)[0], "╲╱£");
  const c = await run(['PRINT "A";CHR$(147);"B"']);
  assert.equal(c.screen.clears, 1);
  assert.equal(rows(c.out)[0], "B");
  // The maze one-liner runs and wraps into 40-character rows.
  let yields = 0;
  const { m, screen } = machine({ slice: 100, yield: (fn) => { yields++; setImmediate(fn); } });
  await m.enter("10 PRINT CHR$(205.5+RND(1));:GOTO 10");
  const done = m.enter("RUN");
  while (yields < 10) await new Promise((r) => setImmediate(r));
  m.stop();
  await done;
  const maze = rows(screen.text)[0];
  assert.equal(maze.length, 40);
  assert.match(maze, /^[╱╲]+$/);
});

test("FRE, TI$, RND and DEF FN", async () => {
  const { out } = await run([
    "PRINT FRE(0)",
    'PRINT LEN(TI$)',
    "X=RND(-1):A=RND(1):X=RND(-1):B=RND(1):PRINT A=B;A>=0 AND A<1",
  ]);
  const r = rows(out);
  assert.equal(r[0], " 38911 ");
  assert.equal(r[3], " 6 ");
  assert.equal(r[6], "-1 -1 ");
  assert.equal(rows((await run(["10 DEF FNSQ(X)=X*X+1", "20 PRINT FNSQ(3)", "RUN"])).out)[0], " 10 ");
});

test("SYS 64738 resets: clears the screen, colours and program", async () => {
  let resets = 0;
  const { m, screen } = machine({ io: { reset: () => { resets++; } } });
  await m.enter("10 REM X");
  await m.enter("POKE 53280,0");
  await m.enter("SYS 64738");
  assert.equal(resets, 1);
  assert.deepEqual(m.listing(), []);
  assert.equal(m.peekMem(53280), 14);
  assert.match(screen.text, /READY\.\n$/);
});

test("LOAD and SAVE go through the disk hooks", async () => {
  const calls = [];
  const disk = {};
  const io = {
    load(name, device, sec, m) {
      calls.push(["load", name, device, sec]);
      if (device !== 8) return { error: "DEVICE NOT PRESENT" };
      m.print("\nSEARCHING FOR " + name + "\nLOADING");
      if (name === "$") return Promise.resolve({ program: Basic.directory({
        title: "KERNAL.ONE", id: "K1 2A", free: 640,
        files: [{ name: "OUTFITTER", type: "PRG", blocks: 12 }] }), raw: true });
      if (disk[name]) return Promise.resolve({ program: disk[name] });
      return Promise.resolve({ error: "FILE NOT FOUND" });
    },
    save(name, device, sec, lines) { calls.push(["save", name, device]); disk[name] = lines; },
  };
  const { m, screen } = machine({ io });
  await m.enter('10 PRINT "SAVED"');
  await m.enter('SAVE "PROG",8');
  await m.enter("NEW");
  await m.enter('LOAD "PROG",8');
  assert.deepEqual(m.listing(), ['10 PRINT "SAVED"']);
  assert.match(screen.text, /SEARCHING FOR PROG\nLOADING\nREADY\.\n$/);
  await m.enter('LOAD "NOPE",8');
  assert.match(screen.text, /\?FILE NOT FOUND  ERROR\nREADY\.\n$/);
  await m.enter('LOAD "PROG"');
  assert.match(screen.text, /\?DEVICE NOT PRESENT  ERROR\nREADY\.\n$/);
  assert.deepEqual(calls.map((c) => c.slice(0, 3)), [
    ["save", "PROG", 8], ["load", "PROG", 8], ["load", "NOPE", 8], ["load", "PROG", 1]]);
  // The directory lists like a program but won't RUN.
  await m.enter('LOAD "$",8');
  screen.text = "";
  await m.enter("LIST");
  assert.deepEqual(rows(screen.text).slice(1, 4),
    ['0 "KERNAL.ONE      " K1 2A', '12   "OUTFITTER"        PRG', "640 BLOCKS FREE."]);
  await m.enter("RUN");
  assert.match(screen.text, /\?SYNTAX  ERROR IN 0\nREADY\.\n$/);
});

test("LOAD without a disk hook: device not present", async () => {
  const { out } = await run(['LOAD "X",8'], { io: { load: undefined } });
  assert.match(out, /\?DEVICE NOT PRESENT  ERROR/);
});

test("SYS hands other addresses to the page", async () => {
  const seen = [];
  await run(["SYS 2061"], { io: { sys: (a) => { seen.push(a); } } });
  assert.deepEqual(seen, [2061]);
});

test("GET reads the keyboard buffer without waiting", async () => {
  const { m, screen } = machine();
  await m.enter('10 GET K$:IF K$="" THEN 10');
  await m.enter('20 PRINT "GOT ";K$');
  const done = m.enter("RUN");
  await new Promise((r) => setImmediate(r));
  m.key(81);
  await done;
  assert.match(screen.text, /GOT Q/);
});

test("matchName: C64 DOS wildcards", () => {
  assert.ok(Basic.matchName("*", "OUTFITTER"));
  assert.ok(Basic.matchName("OUT*", "OUTFITTER"));
  assert.ok(Basic.matchName("OUTFITTE?", "OUTFITTER"));
  assert.ok(!Basic.matchName("OUT", "OUTFITTER"));
  assert.ok(Basic.matchName("OUTFITTER", "OUTFITTER"));
});

test('LOAD "KERNAL" then RUN prints the Kernal boot screen within 40 columns', async () => {
  // The program lives in app.js (it's the page's disk); pull the array literal out of the source.
  const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const program = new Function("return " + /var KERNAL_PRG = (\[[\s\S]*?\]);/.exec(src)[1])();
  const io = { load: (name, device) => (device === 8 && name === "KERNAL" ? { program } : { error: "FILE NOT FOUND" }) };
  const { m, screen } = machine({ io });
  await m.enter('LOAD "KERNAL",8,1');
  screen.text = "";
  await m.enter("RUN");
  const lines = rows(screen.text);
  assert.equal(lines[0], " KERNAL CODING AGENT ");
  assert.ok(lines.some((l) => l.startsWith("/CONNECT LOCAL") && l.includes("YOUR OWN HARDWARE")));
  assert.ok(lines.includes("WATCH YOUR TOKENS. BUILD COOL STUFF."));
  assert.ok(lines.every((l) => l.length <= 40), lines.join("\n"));
  assert.deepEqual(lines.slice(-3), ["", "READY.", ""]);
});
