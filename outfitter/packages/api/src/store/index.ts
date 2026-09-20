import type { Store } from "./types.ts";

export * from "./types.ts";
export { MemoryStore } from "./memory.ts";

/** Builds the configured Store. MONGODB_URI=memory (the default) never imports the mongodb driver. */
export async function openStore(mongodbUri: string): Promise<Store> {
  if (mongodbUri === "memory") {
    const { MemoryStore } = await import("./memory.ts");
    return new MemoryStore();
  }
  const { MongoStore } = await import("./mongo.ts");
  return MongoStore.connect(mongodbUri);
}
