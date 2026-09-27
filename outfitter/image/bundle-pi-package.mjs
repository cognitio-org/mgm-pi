// Bundles a pi package's extension so pi's loader (jiti) evaluates a handful of modules instead of
// hundreds. Under gVisor each module's resolve/stat/read/eval is a run of syscalls: pi-subagents'
// ~290 modules took 4-16 s of every sandbox start (#142), pi-mcp-adapter's ~140 up to 1.7 s (#222).
//
// pi-subagents is split: index.js imports the extension (or the herdr bridge) dynamically, behind env
// checks, and a subagent CHILD pi (PI_SUBAGENT_CHILD=1) imports neither. With code splitting the entry
// stays tiny and each of those becomes a chunk loaded only when its import runs, so a child still
// loads next to nothing (one file: ~13 ms before, ~115 ms, measured, had it read the whole extension).
// pi-mcp-adapter is one file (see PACKAGES for why); esbuild keeps what it imports dynamically in lazy
// wrappers, so that code is parsed but only runs when first used.
//
// Both packages find their own files through `import.meta.url` (pi-subagents in ~20 places: built-in
// agents, prompts, runner scripts it spawns by path; pi-mcp-adapter: its scripting skill, the keyring
// helper and code-mode worker it starts by path, `createRequire` for its native modules, and
// `import.meta.dirname` for the UI bridge bundle). Bundling moves all of those into the output
// directory, so each of the package's own modules gets its `import.meta.url`/`.dirname`/`.filename`
// rewritten to its original file's, computed relative to the output directory at runtime (every chunk
// sits there): every path still resolves to the same file on disk, and those files stay in place (the
// package is only added to, never pruned). A dependency that locates files that way is rewritten the
// same way (PACKAGES' rewriteDeps), and anything with a native binding stays external.
//
// Usage: node bundle-pi-package.mjs <package dir> [esbuild module path]
// Writes <dir>/bundle/ and points package.json's pi.extensions at its entry (bundle/index.js, or .ts
// for a one-file bundle, see PACKAGES); leaves the original entry alone.
import { readFile, writeFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

if (!process.argv[2]) {
  console.error("usage: bundle-pi-package.mjs <package dir> [esbuild module path]");
  process.exit(2);
}
// esbuild hands the plugin real paths; a symlinked argument would match none of them and skip every
// rewrite without a word (which is exactly how a first build loaded fine but found 0 agents).
const pkgDir = realpathSync(path.resolve(process.argv[2]));
const esbuildPath = process.argv[3];
const require = createRequire(import.meta.url);
const esbuild = esbuildPath ? await import(esbuildPath) : require("esbuild");

const pkgFile = path.join(pkgDir, "package.json");
const pkg = JSON.parse(await readFile(pkgFile, "utf8"));
const tag = `bundle-pi-package(${pkg.name})`;

// Per package. Every pi package keeps @earendil-works/*, typebox and jiti external: pi resolves those
// itself, to its own copies, through jiti aliases.
//
// split: chunks, or one file. pi loads the entry through jiti, which applies those aliases to the
// entry's imports only. Before that, jiti tries importing a .js entry natively, and Node loads the
// entry's whole static graph from node_modules until it fails on @earendil-works/*, which isn't
// installed next to the package: wasted work, ~670 files once that graph reaches typebox (.pi/npm has
// its own copy). And every chunk is imported natively, so a chunk's external import skips the aliases
// unless it fails too. pi-subagents gets away with the second (each chunk importing typebox also
// imports @earendil-works/*) and needs the split for its child processes. pi-mcp-adapter is one file,
// named .ts (ext) so jiti transpiles it straight away: no native attempt, every import aliased. Plain
// JavaScript is valid TypeScript; jiti's file cache (prewarmed in the image) keeps the one-time
// transpile out of start-up.
//
// externals: also kept out of the bundle: native bindings, anything loaded by path or as a real
// package. rewriteDeps: dependencies that find their own files through import.meta, rewritten like the
// package's own modules instead of kept external.
const PACKAGES = {
  "pi-subagents": { split: true, ext: ".js", externals: ["undici"], rewriteDeps: [] },
  // @napi-rs/keyring and recheck load native binaries (through createRequire, when first needed).
  // undici is inlined: pi doesn't alias it, and inside the bundle it stays lazy, as it was. open finds
  // its bundled xdg-open script through import.meta.url.
  "pi-mcp-adapter": { split: false, ext: ".ts", externals: ["@napi-rs/keyring", "recheck"], rewriteDeps: ["open"] },
};
const settings = PACKAGES[pkg.name];
if (!settings) {
  console.error(`${tag}: no bundling settings for this package; add it to PACKAGES after checking its dependencies`);
  process.exit(2);
}
const entries = pkg.pi?.extensions ?? [];
if (entries.length !== 1) {
  console.error(`${tag}: expected exactly one pi.extensions entry, found ${JSON.stringify(entries)}`);
  process.exit(1);
}

const outdir = path.join(pkgDir, "bundle");
const srcRoot = pkgDir + path.sep;
const rewritten = [];

/** Whether `file` belongs to one of rewriteDeps: its innermost node_modules segment names the dep. */
function inRewriteDep(file) {
  const parts = file.split(path.sep);
  const i = parts.lastIndexOf("node_modules");
  if (i < 0) return false;
  const name = parts[i + 1]?.startsWith("@") ? `${parts[i + 1]}/${parts[i + 2]}` : parts[i + 1];
  return settings.rewriteDeps.includes(name);
}

/** Rewrites `import.meta.url` (and `.dirname`/`.filename`) in each of the package's own modules (and
 * rewriteDeps') to that module's original value, relative to the output directory at runtime. */
const keepImportMetaUrl = {
  name: "keep-import-meta-url",
  setup(build) {
    build.onLoad({ filter: /\.[cm]?[jt]s$/ }, async (args) => {
      // The package's own modules. It lives in a node_modules itself, so look below it: a dependency
      // nested in its own node_modules keeps its import.meta.url untouched, unless listed in rewriteDeps.
      const own = args.path.startsWith(srcRoot) && !path.relative(pkgDir, args.path).split(path.sep).includes("node_modules");
      if (!own && !inRewriteDep(args.path)) return undefined;
      const loader = /\.[cm]?ts$/.test(args.path) ? "ts" : "js";
      const source = await readFile(args.path, "utf8");
      if (!source.includes("import.meta.")) return { contents: source, loader };
      const rel = path.relative(outdir, args.path).split(path.sep).join("/");
      const url = `new URL(${JSON.stringify(rel.startsWith(".") ? rel : "./" + rel)}, import.meta.url)`;
      // process.getBuiltinModule (Node 22.3+): an expression, so no import has to be injected.
      const file = `process.getBuiltinModule("node:url").fileURLToPath(${url})`;
      const contents = source
        .replaceAll("import.meta.dirname", `process.getBuiltinModule("node:path").dirname(${file})`)
        .replaceAll("import.meta.filename", file)
        .replaceAll("import.meta.url", `${url}.href`);
      if (contents === source) return { contents: source, loader };
      rewritten.push(path.relative(pkgDir, args.path));
      return { contents, loader };
    });
  },
};

await rm(outdir, { recursive: true, force: true });
await esbuild.build({
  entryPoints: { index: path.join(pkgDir, entries[0]) },
  outdir,
  outExtension: { ".js": settings.ext },
  bundle: true,
  splitting: settings.split,
  format: "esm",
  platform: "node",
  target: "node22",
  external: ["@earendil-works/*", "typebox", "typebox/*", "jiti", ...settings.externals],
  plugins: [keepImportMetaUrl],
  // Bundled CommonJS (yaml's node build, ajv, cross-spawn, undici) calls require("process")/("buffer")
  // through esbuild's __require shim, which needs a real `require` in scope. A split chunk is loaded as
  // plain ESM, where there is none ("Dynamic require of "process" is not supported"), so every output
  // file gets one. esbuild renames the package's own top-level `require` bindings (require2, ...), so
  // this can't clash.
  banner: { js: 'import { createRequire as __piSubagentsCreateRequire } from "node:module"; var require = __piSubagentsCreateRequire(import.meta.url);' },
  logLevel: "warning",
  legalComments: "none",
});

// Both packages locate files through import.meta; none rewritten means the plugin matched nothing,
// and the bundle would load but find none of its own files (pi-subagents: no agents).
if (rewritten.length === 0) {
  console.error(`${tag}: rewrote import.meta in no module; refusing to ship a bundle that can't find its own files`);
  process.exit(1);
}

const entry = `./bundle/index${settings.ext}`;
pkg.pi = { ...pkg.pi, extensions: [entry] };
await writeFile(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
console.log(
  `${tag}: wrote ${path.relative(process.cwd(), outdir)}/ (import.meta kept in ${rewritten.length} modules) and pointed pi.extensions at ${entry}`,
);
