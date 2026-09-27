// Bundles pi-subagents' extension so pi's loader (jiti) evaluates a handful of modules instead of
// ~290 (#142). Under gVisor each module's resolve/stat/read/eval is a run of syscalls, and that import
// took 4-16 s of every sandbox start.
//
// Split, not one file: index.js imports the extension (or the herdr bridge) dynamically, behind env
// checks, and a subagent CHILD pi (PI_SUBAGENT_CHILD=1) imports neither. With code splitting the entry
// stays tiny and each of those becomes a chunk loaded only when its import runs, so a child still
// loads next to nothing (one file: ~13 ms before, ~115 ms, measured, had it read the whole extension).
//
// pi-subagents finds its own files through `import.meta.url` in ~20 places, at different depths
// (built-in agents, prompts, runner scripts it spawns by path, child extensions). Bundling moves all
// of those into the output directory, so each module's `import.meta.url` is rewritten to its original
// file's URL, computed relative to the output directory at runtime (every chunk sits there): every
// path still resolves to the same file on disk, and those files stay in place (the package is only
// added to, never pruned).
//
// Usage: node bundle-pi-subagents.mjs <pi-subagents package dir> [esbuild module path]
// Writes <dir>/bundle/ and points package.json's pi.extensions at bundle/index.js; leaves index.js alone.
import { readFile, writeFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

if (!process.argv[2]) {
  console.error("usage: bundle-pi-subagents.mjs <pi-subagents dir> [esbuild module path]");
  process.exit(2);
}
// esbuild hands the plugin real paths; a symlinked argument would match none of them and skip every
// rewrite without a word (which is exactly how a first build loaded fine but found 0 agents).
const pkgDir = realpathSync(path.resolve(process.argv[2]));
const esbuildPath = process.argv[3];
const require = createRequire(import.meta.url);
const esbuild = esbuildPath ? await import(esbuildPath) : require("esbuild");

const outdir = path.join(pkgDir, "bundle");
const srcRoot = pkgDir + path.sep;
const rewritten = [];

/** Rewrites `import.meta.url` in each of the package's own modules to that module's original URL,
 * relative to the output directory at runtime. */
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
      const rel = path.relative(outdir, args.path).split(path.sep).join("/");
      rewritten.push(path.relative(pkgDir, args.path));
      const replacement = `new URL(${JSON.stringify(rel.startsWith(".") ? rel : "./" + rel)}, import.meta.url).href`;
      return { contents: source.replaceAll("import.meta.url", replacement), loader: "js" };
    });
  },
};

await rm(outdir, { recursive: true, force: true });
await esbuild.build({
  entryPoints: { index: path.join(pkgDir, "index.js") },
  outdir,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  // pi resolves these itself (its own copies, through jiti aliases), and the runtime-only ones are
  // loaded by path or kept as real packages: never inline them.
  external: ["@earendil-works/*", "typebox", "typebox/*", "jiti", "undici"],
  plugins: [keepImportMetaUrl],
  // Bundled CommonJS (yaml's node build) calls require("process")/("buffer") through esbuild's
  // __require shim, which needs a real `require` in scope. A split chunk is loaded as plain ESM, where
  // there is none ("Dynamic require of "process" is not supported"), so every output file gets one.
  // esbuild renames the package's own top-level `require` bindings (require2, ...), so this can't clash.
  banner: { js: 'import { createRequire as __piSubagentsCreateRequire } from "node:module"; var require = __piSubagentsCreateRequire(import.meta.url);' },
  logLevel: "warning",
  legalComments: "none",
});

// Every pi-subagents release so far locates files through import.meta.url; none rewritten means the
// plugin matched nothing, and the bundle would load but find no agents.
if (rewritten.length === 0) {
  console.error("bundle-pi-subagents: rewrote import.meta.url in no module; refusing to ship a bundle that can't find its own files");
  process.exit(1);
}

const pkgFile = path.join(pkgDir, "package.json");
const pkg = JSON.parse(await readFile(pkgFile, "utf8"));
pkg.pi = { ...pkg.pi, extensions: ["./bundle/index.js"] };
await writeFile(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
console.log(
  `bundle-pi-subagents: wrote ${path.relative(process.cwd(), outdir)}/ (import.meta.url kept in ${rewritten.length} modules) and pointed pi.extensions at bundle/index.js`,
);
