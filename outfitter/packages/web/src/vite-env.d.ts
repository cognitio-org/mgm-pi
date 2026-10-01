/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Baked in at build time from the OUTFITTER_DEV process env var (vite.config.ts's `define`) --
   * gates App.tsx's dev-only /panic-test route the same way the API's OUTFITTER_DEV gates its own
   * dev-only behavior. */
  readonly OUTFITTER_DEV?: string;
  /** Overrides lib/sentry.ts's default DSN. Vite only exposes VITE_-prefixed vars to
   * import.meta.env by default, so this is the one env var a fork or a staging build sets to
   * point error/performance reporting at a different Sentry project. */
  readonly VITE_SENTRY_DSN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
