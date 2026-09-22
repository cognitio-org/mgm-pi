// Test-only resolver: pi resolves "@earendil-works/pi-ai" and "@earendil-works/pi-tui" for its
// extensions at runtime, but they are nested dependencies of pi-coding-agent, invisible to plain
// Node from this directory. Resolve those specifiers as if imported from inside pi-coding-agent.
// Loaded with: node --import ./tests/resolve-pi.mjs --test tests/
import { registerHooks } from "node:module";
const parent = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^@earendil-works\/pi-(ai|tui)(\/|$)/.test(specifier)) return nextResolve(specifier, { ...context, parentURL: parent });
    return nextResolve(specifier, context);
  },
});
