// After a deploy, the open tab still runs the previous build's JavaScript, whose dynamic
// import() URLs name hashed files the new server no longer has (routes/static.ts 404s those on
// purpose). Chrome reports that as "Failed to fetch dynamically imported module". Reload once so
// the uncached index.html pulls the new chunks. A second failure is a real outage: show it.

import { lazy, type ComponentType, type LazyExoticComponent } from "react";

const STORAGE_KEY = "outfitter:chunk-reload";
/** Drop the storage key this long after startup so a later document can reload for a new deploy.
 * A document that was itself the recovery load still refuses, via an in-memory latch. */
const CLEAR_AFTER_MS = 10_000;

const STALE_CHUNK =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS for/;

export function isStaleChunkError(error: unknown): boolean {
  return error instanceof Error && STALE_CHUNK.test(error.message);
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ChunkReload {
  /** True when the page is reloading (or already is) and the caller should wait.
   * False when this failure should be shown. */
  reloadForStaleChunk: () => boolean;
  clearChunkReload: () => void;
}

export interface ChunkReloadDeps {
  storage?: StorageLike | null;
  reload?: () => void;
}

function browserStorage(): StorageLike | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

function storageHasKey(storage: StorageLike | null): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(STORAGE_KEY) != null;
  } catch {
    return false;
  }
}

export function createChunkReload(deps: ChunkReloadDeps = {}): ChunkReload {
  const storage = deps.storage === undefined ? browserStorage() : deps.storage;
  const reload = deps.reload ?? (() => window.location.reload());
  let reloading = false;
  // This document was opened by a chunk reload. A slow failure here must not reload again
  // after clearChunkReload drops the key, or the tab reloads forever.
  const recovering = storageHasKey(storage);

  function reloadForStaleChunk(): boolean {
    if (reloading) return true;
    if (recovering) return false;
    if (!storage) return false;
    try {
      if (storage.getItem(STORAGE_KEY)) return false;
      storage.setItem(STORAGE_KEY, "1");
    } catch {
      return false;
    }
    reloading = true;
    try {
      reload();
    } catch {
      // location.reload is unimplemented in some test DOMs. The flag is already stored.
    }
    return true;
  }

  function clearChunkReload(): void {
    if (!storage) return;
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {
      // Same restricted storage as above: leave the flag, so we reload at most once.
    }
  }

  return { reloadForStaleChunk, clearChunkReload };
}

const shared = createChunkReload();

export function reloadForStaleChunk(): boolean {
  return shared.reloadForStaleChunk();
}

/** A promise that never settles, so React.lazy stays on its Suspense fallback during the reload
 * instead of rendering the crash screen for a frame. Null means rethrow. */
export function hangIfStaleChunk<T>(error: unknown, reload: () => boolean = reloadForStaleChunk): Promise<T> | null {
  if (!isStaleChunkError(error)) return null;
  if (!reload()) return null;
  return new Promise<T>(() => {});
}

export function lazyRoute<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(() =>
    factory().catch((error: unknown) => {
      const waiting = hangIfStaleChunk<{ default: T }>(error);
      if (waiting) return waiting;
      throw error;
    }),
  );
}

interface PreloadErrorEvent {
  payload?: unknown;
}

interface ChunkReloadHost {
  addEventListener(type: string, listener: (event: PreloadErrorEvent) => void): void;
  setTimeout(handler: () => void, timeout: number): unknown;
}

const installedHosts = new Set<ChunkReloadHost>();

/** Vite dispatches this for every failed dynamic import, including a module that threw while
 * evaluating. Only a missing chunk should reload. The event stays uncancelled so the original
 * rejection still reaches lazyRoute. */
export function installChunkReload(host: ChunkReloadHost = window, controller: ChunkReload = shared): void {
  if (installedHosts.has(host)) return;
  installedHosts.add(host);
  host.addEventListener("vite:preloadError", (event) => {
    if (!isStaleChunkError(event.payload)) return;
    controller.reloadForStaleChunk();
  });
  host.setTimeout(() => controller.clearChunkReload(), CLEAR_AFTER_MS);
}
