import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/bundler-plugins/vite";
import type { PluginOption } from "vite";

// Sentry source maps (#423). Only when SENTRY_AUTH_TOKEN is set at build time, which today means
// the api image build in Cloud Build (packages/api/Dockerfile, deploy/cloudbuild-api-sentry.yaml).
// Without it -- local dev, CI, tests, and image builds before the owner stores the token -- this
// adds nothing and the build is exactly as before: no plugin, no source maps.
//
// With it: Vite writes "hidden" maps (no sourceMappingURL comment in the bundles), the plugin
// injects a debug ID into each bundle and its map, uploads both by debug ID, then deletes every
// .map so none reach dist/ (the Dockerfile deletes them again, belt and braces). Debug IDs match
// a stack frame to its map without any release, so no release is created here: the web app takes
// its release from the api at runtime (#421). SENTRY_RELEASE, if a build ever sets it, only labels
// the upload.
//
// The plugin is @sentry/bundler-plugins (its ./vite export is what @sentry/vite-plugin re-exports),
// pinned to the same version as @sentry/react: @sentry/vite-plugin 5.x still depends on the 10.x
// bundler plugins and would pull a second @sentry/core into the tree.
export function sentrySourceMaps(env: Record<string, string | undefined>): {
  plugins: PluginOption[];
  sourcemap: boolean | "hidden";
} {
  const authToken = env.SENTRY_AUTH_TOKEN?.trim();
  if (!authToken) return { plugins: [], sourcemap: false };
  const release = env.SENTRY_RELEASE?.trim() || undefined;
  const dist = new URL("./dist/", import.meta.url).pathname;
  return {
    sourcemap: "hidden",
    plugins: [
      sentryVitePlugin({
        authToken,
        org: env.SENTRY_ORG,
        project: env.SENTRY_PROJECT,
        telemetry: false,
        sourcemaps: {
          assets: `${dist}**`,
          filesToDeleteAfterUpload: `${dist}**/*.map`,
        },
        release: {
          name: release,
          inject: false,
          create: false,
          finalize: false,
          setCommits: false,
          deploy: false,
        },
        // A Sentry outage or a revoked token must not stop a release: warn and ship without maps.
        errorHandler: (err) => {
          console.warn(`sentry: source map upload failed, continuing without it: ${err.message}`);
        },
      }),
    ],
  };
}

const sentry = sentrySourceMaps(process.env);

// Dev proxy to the local api (packages/api, `npm run dev` there) so the web dev server can hit
// /api/* and /agent/* (SSE) without CORS wrangling. Production build is static files served by
// packages/api/src/routes/static.ts at "/", same origin, no proxy needed.
export default defineConfig({
  plugins: [react(), ...sentry.plugins],
  // OUTFITTER_DEV baked in at build time (not runtime -- Vite only exposes VITE_-prefixed env vars
  // to import.meta.env by default) so App.tsx's dev-only /panic-test route (the KERNAL PANIC
  // screen, for a screenshot) can gate on the same flag the API already uses, without adding a
  // second env var to remember. A production build with OUTFITTER_DEV unset bakes in "" (falsy),
  // same as never setting it.
  define: {
    "import.meta.env.OUTFITTER_DEV": JSON.stringify(process.env.OUTFITTER_DEV ?? ""),
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8082",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: sentry.sourcemap,
  },
  test: {
    // Node by default: most of this suite is pure logic (tokenizers, key handling, game engines,
    // status derivation) and spinning up a jsdom per file cost ~13s of a ~21s run. Files that need
    // a DOM opt in with a `@vitest-environment jsdom` docblock on their first line.
    environment: "node",
    // jsdom's Storage API needs a real (non-opaque) origin to back localStorage/sessionStorage;
    // the default "about:blank" leaves window.localStorage undefined.
    environmentOptions: {
      jsdom: { url: "http://localhost/" },
    },
  },
});
