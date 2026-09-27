// Bundles pi-subagents' extension entry into one ESM file, so pi's loader (jiti) evaluates one module
// instead of ~290 (#142). Under gVisor each module's resolve/stat/read/eval is a run of syscalls,
// and that import took 4-16 s of every sandbox start.
//
// pi-subagents finds its own files through `import.meta.url` in ~20 places, at different depths
// (built-in agents, prompts, runner scripts it spawns by path, child extensions). A bundle would move
// all of those to the bundle's directory, so each module's `import.meta.url` is rewritten to its
// original file's URL, computed relative to the bundle at runtime: every path still resolves to the
// same file on disk, and those files stay in place (the package is only added to, never pruned).
//
// Usage: node bundle-pi-subagents.mjs <pi-subagents package dir> [esbuild module path]
// Writes <dir>/index.bundle.js and points package.json's pi.extensions at it; leaves index.js alone.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const pkgDir = path.resolve(process.argv[2] ?? "");
const esbuildPath = process.argv[3];
if (!process.argv[2]) {
  console.error("usage: bundle-pi-subagents.mjs <pi-subagents dir> [esbuild module path]");
  process.exit(2);
}
const require = createRequire(import.meta.url);
const esbuild = esbuildPath ? await import(esbuildPath) : require("esbuild");

const outfile = path.join(pkgDir, "index.bundle.js");
const srcRoot = pkgDir + path.sep;

/** Rewrites `import.meta.url` in each of the package's own modules to that module's original URL,
 * relative to wherever the bundle sits at runtime. */
const keepImportMetaUrl = {
  name: "keep-import-meta-url",
  setup(build) {
    build.onLoad({ filter: /\.[cm]?js$/ }, async (args) => {
      // The package's own modules only. It lives in a node_modules itself, so look below it: a
      // dependency nested in its own node_modules keeps its import.meta.url untouched.
      if (!args.path.startsWith(srcRoot)) return undefined;
      if (path.relative(pkgDir, args.path).split(path.sep).includes("node_modules")) return undefined;
      const source = await readFile(args.path, "utf8");
      if (!source.includes("import.meta.url")) return { contents: source, loader: "js" };
      const rel = path.relative(path.dirname(outfile), args.path).split(path.sep).join("/");
      const replacement = `new URL(${JSON.stringify("./" + rel)}, import.meta.url).href`;
      return { contents: source.replaceAll("import.meta.url", replacement), loader: "js" };
    });
  },
};

await esbuild.build({
  entryPoints: [path.join(pkgDir, "index.js")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  // pi resolves these itself (its own copies, through jiti aliases), and the runtime-only ones are
  // loaded by path or kept as real packages: never inline them.
  external: ["@earendil-works/*", "typebox", "typebox/*", "jiti", "undici"],
  plugins: [keepImportMetaUrl],
  logLevel: "warning",
  legalComments: "none",
});

const pkgFile = path.join(pkgDir, "package.json");
const pkg = JSON.parse(await readFile(pkgFile, "utf8"));
pkg.pi = { ...pkg.pi, extensions: ["./index.bundle.js"] };
await writeFile(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
console.log(`bundle-pi-subagents: wrote ${path.relative(process.cwd(), outfile)} and pointed pi.extensions at it`);
