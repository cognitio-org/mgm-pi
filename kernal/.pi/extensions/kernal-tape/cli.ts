#!/usr/bin/env node
/**
 * Headless half of `kernal --tape <id>` (../../../bin/kernal), run before pi starts: fetches the
 * tape with the Dongle, reviews it against the pin (lib.ts reviewTape: the summary and a pin on
 * first play, a field-level diff when the cloud changed it), installs its npm packages on the
 * person's yes, and writes what pi should be started with.
 *
 * Usage: node cli.ts play <id> <out dir> [--no-ask]
 *   <out dir>/args  pi flags, NUL-separated (a NUL inside one is refused, never split)
 *   <out dir>/env   KEY=VALUE, NUL-separated (Kernal's KERNAL_TAPE* markers only)
 * <out dir> is bin/kernal's private `mktemp -d`; both files are created new (`wx`). Prompts and
 * notes go to stderr; the questions are read from stdin, which must be a terminal. --no-ask (print
 * mode), or stdin or stderr not a terminal: nothing is asked, the pinned version plays, an unpinned
 * tape fails.
 * Exit 0 with both files written, else 1 with the reason on stderr.
 */
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { outfitterCredentials } from "../_shared/outfitter-env.ts";
import { httpTransport } from "../outfitter-admin/transport.ts";
import { readSettings } from "../connect/settings.ts";
import { repoInfo } from "../_shared/repo.ts";
import {
  changeIntro, installPackages, launchPlan, npmRunner, ownPackages, packagePlan, pinIntro, promptText, repoWarning, reviewTape, shortHash, tapeDir, tapeNpmDir, transportFetch,
  type Reviewer,
} from "./lib.ts";

const say = (m: string) => process.stderr.write(`${m}\n`);

/** A yes/no on the terminal; `p` shows the full prompts first (when there are any). */
export function terminalReviewer(ask: (q: string) => Promise<string>, out: (m: string) => void = say): Reviewer {
  const yesNo = async (question: string, prompts?: string): Promise<boolean> => {
    for (;;) {
      const a = (await ask(`${question} [y/N${prompts ? "/p = show the full prompts" : ""}] `)).trim().toLowerCase();
      if (a === "p" && prompts) {
        out(prompts);
        continue;
      }
      return a === "y" || a === "yes";
    }
  };
  return {
    async pin(tape, summary) {
      out(`\n${pinIntro(tape, summary)}`);
      return yesNo(`Pin this version of tape ${tape.id} and play it?`, promptText(tape));
    },
    async change(pinned, cloud, changes) {
      out(`\n${changeIntro(pinned, cloud, changes)}`);
      return yesNo("Pin and play the new version? No keeps the pinned one", promptText(cloud));
    },
  };
}

async function main(): Promise<number> {
  const [cmd, ref, out, ...rest] = process.argv.slice(2);
  if (cmd !== "play" || !ref || !out) {
    say("usage: cli.ts play <tape id> <out> [--no-ask]");
    return 2;
  }
  const interactive = !rest.includes("--no-ask") && process.stdin.isTTY === true && process.stderr.isTTY === true;
  let rl: ReturnType<typeof createInterface> | undefined;
  const ask = async (q: string) => {
    rl ??= createInterface({ input: process.stdin, output: process.stderr });
    return rl.question(q);
  };
  try {
    const { api, token } = outfitterCredentials(process.env);
    const transport = api && token ? httpTransport(api, token) : undefined;
    const dir = tapeDir();
    const review = await reviewTape(ref, { dir, fetch: transport ? transportFetch(transport) : undefined, reviewer: interactive ? terminalReviewer(ask) : undefined });
    for (const n of review.notes) say(`kernal --tape: ${n}`);
    if (!review.ok || !review.tape) {
      say(`kernal --tape: ${review.error ?? "nothing to play"}`);
      return 1;
    }
    const tape = review.tape;
    const npmDir = tapeNpmDir(dir, tape.id);
    const own = ownPackages(readSettings());
    let packages = packagePlan(tape, npmDir, own);
    // KERNAL_TAPE_ASKED: a /tape restart, whose TUI already asked about these.
    if (packages.missing.length && interactive && process.env.KERNAL_TAPE_ASKED !== "1") {
      say(`\nTape ${tape.id} loads npm packages Kernal doesn't have yet: ${packages.missing.map((p) => p.spec).join(", ")}.\nThey install into ${npmDir} with install scripts off, and run as you in this session.`);
      const a = (await ask("Install them now? [y/N] ")).trim().toLowerCase();
      if (a === "y" || a === "yes") {
        const res = await installPackages(packages.missing, npmDir, npmRunner);
        if (!res.ok) say(`kernal --tape: npm install failed; playing without them:\n${res.output}`);
        packages = packagePlan(tape, npmDir, own);
      }
    }
    const plan = launchPlan(tape, packages, npmDir, process.env, join(dir, "run"));
    if (plan.args.some((a) => a.includes("\0"))) throw new Error("a tape value holds a NUL; refusing to play it");
    for (const n of plan.notes) say(`kernal --tape: ${n}`);
    const here = await repoInfo(process.cwd());
    if (here.note) say(`kernal --tape: repo: ${here.note}`);
    const warn = repoWarning(tape, here.repo);
    if (warn) say(`kernal --tape: ${warn} (a hint: it plays anyway)`);
    writeFileSync(join(out, "args"), plan.args.map((a) => `${a}\0`).join(""), { mode: 0o600, flag: "wx" });
    writeFileSync(join(out, "env"), Object.entries(plan.env).map(([k, v]) => `${k}=${v}\0`).join(""), { mode: 0o600, flag: "wx" });
    say(`kernal: playing tape ${tape.id} (${shortHash(review.pin?.hash ?? "")})${here.repo ? ` in ${here.repo}` : ", no repo"}${review.offline ? ", offline" : ""}`);
    return 0;
  } finally {
    rl?.close();
  }
}

if (/kernal-tape[\\/]cli\.ts$/.test(process.argv[1] ?? "")) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      say(`kernal --tape: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
