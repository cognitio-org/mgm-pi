/** Picks the teleport Store implementation: MGM_TELEPORT_STORE=outfitter selects OutfitterStore
 * (the Outfitter cloud API, see ./outfitter-store.ts); any other value (or unset) keeps the
 * existing GitStore behavior, where MGM_TELEPORT_STORE is a local clone directory instead. Shared
 * by index.ts (the pi extension) and cli.ts (`mgm --teleport`, headless). */
import { GitStore, type Store, type Warn } from "./lib.ts";
import { OutfitterStore } from "./outfitter-store.ts";

export function createStore(warn: Warn): Store {
  if (process.env.MGM_TELEPORT_STORE === "outfitter") return new OutfitterStore({ warn });
  return new GitStore({ warn });
}
