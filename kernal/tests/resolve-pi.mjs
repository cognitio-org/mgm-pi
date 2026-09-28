// Test-only resolver: pi resolves "@earendil-works/pi-ai" and "@earendil-works/pi-tui" for its
// extensions at runtime, but they are nested dependencies of pi-coding-agent, invisible to plain
// Node from this directory. Resolve those specifiers as if imported from inside pi-coding-agent.
// Loaded with: node --import ./tests/resolve-pi.mjs --test tests/
import { registerHooks } from "node:module";
const parent = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    // The vendored pi-listen (#250) still imports pi's pre-rename names; pi aliases them at runtime.
    const renamed = specifier.replace(/^@mariozechner\/pi-(coding-agent|ai|tui)(?=\/|$)/, "@earendil-works/pi-$1");
    if (renamed !== specifier) specifier = renamed;
    if (specifier === "@earendil-works/pi-coding-agent") return nextResolve(specifier, { ...context, parentURL: new URL("../package.json", import.meta.url).href });
    if (/^@earendil-works\/pi-(ai|tui)(\/|$)/.test(specifier)) return nextResolve(specifier, { ...context, parentURL: parent });
    // pi's loader resolves the vendored pi-listen's extensionless relative imports ("./voice/config");
    // plain Node needs the ".ts".
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL?.includes("/vendor/pi-listen/")) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
