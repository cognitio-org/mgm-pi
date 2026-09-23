import { describe, expect, it } from "vitest";
import { createChunkReload, hangIfStaleChunk, installChunkReload, isStaleChunkError } from "../src/lib/chunk-reload.ts";

const CHUNK = "Failed to fetch dynamically imported module: https://app.kernal.one/assets/SessionPage-5UGgYCdr.js";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

describe("isStaleChunkError", () => {
  it("matches the browser messages for a missing hashed chunk", () => {
    expect(isStaleChunkError(new TypeError(CHUNK))).toBe(true);
    expect(isStaleChunkError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isStaleChunkError(new TypeError("error loading dynamically imported module: /assets/SessionPage-5UGgYCdr.js"))).toBe(true);
    expect(isStaleChunkError(new Error("Unable to preload CSS for https://app.kernal.one/assets/SessionPage-x.css"))).toBe(true);
  });

  it("ignores ordinary failures", () => {
    expect(isStaleChunkError(new Error("boom"))).toBe(false);
    expect(isStaleChunkError(CHUNK)).toBe(false);
    expect(isStaleChunkError(null)).toBe(false);
  });
});

describe("createChunkReload", () => {
  it("reloads once, and the recovery document does not reload again after the flag is cleared", () => {
    const storage = memoryStorage();
    const reloads: number[] = [];
    const first = createChunkReload({
      storage,
      reload: () => {
        reloads.push(1);
      },
    });
    expect(first.reloadForStaleChunk()).toBe(true);
    expect(first.reloadForStaleChunk()).toBe(true);
    expect(reloads).toEqual([1]);

    const secondReloads: number[] = [];
    const second = createChunkReload({
      storage,
      reload: () => {
        secondReloads.push(1);
      },
    });
    expect(second.reloadForStaleChunk()).toBe(false);
    expect(secondReloads).toEqual([]);

    second.clearChunkReload();
    // Same document: clearing the key must not arm another reload.
    expect(second.reloadForStaleChunk()).toBe(false);
    expect(secondReloads).toEqual([]);

    const thirdReloads: number[] = [];
    const third = createChunkReload({
      storage,
      reload: () => {
        thirdReloads.push(1);
      },
    });
    expect(third.reloadForStaleChunk()).toBe(true);
    expect(thirdReloads).toEqual([1]);
  });

  it("does not reload when the flag cannot be stored", () => {
    const reloads: number[] = [];
    const reload = () => {
      reloads.push(1);
    };
    const broken = createChunkReload({
      storage: {
        getItem() {
          throw new Error("blocked");
        },
        setItem() {
          throw new Error("blocked");
        },
        removeItem() {
          throw new Error("blocked");
        },
      },
      reload,
    });
    expect(broken.reloadForStaleChunk()).toBe(false);
    expect(createChunkReload({ storage: null, reload }).reloadForStaleChunk()).toBe(false);
    expect(reloads).toEqual([]);
  });
});

describe("hangIfStaleChunk", () => {
  it("returns a promise that does not settle when a reload is underway", async () => {
    const waiting = hangIfStaleChunk(new TypeError(CHUNK), () => true);
    expect(waiting).toBeInstanceOf(Promise);
    let settled = false;
    waiting!.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it("returns null when the failure should be shown", () => {
    expect(hangIfStaleChunk(new Error("boom"), () => true)).toBeNull();
    expect(hangIfStaleChunk(new TypeError(CHUNK), () => false)).toBeNull();
  });
});

describe("installChunkReload", () => {
  it("reloads only for a missing chunk, once, and a later document can reload after the flag is cleared", () => {
    const storage = memoryStorage();
    const reloads: number[] = [];
    const chunk = createChunkReload({
      storage,
      reload: () => {
        reloads.push(1);
      },
    });
    let onPreload: ((event: { payload?: unknown }) => void) | undefined;
    let onClear: (() => void) | undefined;
    let listeners = 0;
    const host = {
      addEventListener(_type: string, listener: (event: { payload?: unknown }) => void) {
        listeners += 1;
        onPreload = listener;
      },
      setTimeout(handler: () => void) {
        onClear = handler;
        return 0;
      },
    };
    installChunkReload(host, chunk);
    installChunkReload(host, chunk);
    expect(listeners).toBe(1);

    onPreload!({});
    onPreload!({ payload: new Error("boom") });
    expect(reloads).toEqual([]);

    onPreload!({ payload: new TypeError(CHUNK) });
    onPreload!({ payload: new TypeError(CHUNK) });
    expect(reloads).toEqual([1]);

    onClear!();
    const nextReloads: number[] = [];
    const next = createChunkReload({
      storage,
      reload: () => {
        nextReloads.push(1);
      },
    });
    expect(next.reloadForStaleChunk()).toBe(true);
    expect(nextReloads).toEqual([1]);
  });
});
