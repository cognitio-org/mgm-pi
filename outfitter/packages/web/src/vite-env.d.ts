/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Baked in at build time from the OUTFITTER_DEV process env var (vite.config.ts's `define`) --
   * gates App.tsx's dev-only /panic-test route the same way the API's OUTFITTER_DEV gates its own
   * dev-only behavior. */
  readonly OUTFITTER_DEV?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
