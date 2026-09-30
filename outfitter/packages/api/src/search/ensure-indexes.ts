// Creates (or updates) session search's two Atlas indexes on `sessionChunks`, and optionally
// backfills chunks for every existing session (Sysop tools, #289). Run by deploy/atlas-search.sh:
//
//   MONGODB_URI=... node src/search/ensure-indexes.ts [--dry-run] [--backfill]
//
// Idempotent: an index that exists with the same definition is left alone; one whose definition
// differs is updated in place. Building the vector index makes Atlas embed every chunk (billed per
// token by Voyage through Atlas), so --dry-run prints what would change and how many chunks there are.

import { MongoClient } from "mongodb";
import { MongoStore } from "../store/mongo.ts";
import { SessionIndexer } from "./service.ts";
import { CHUNKS_COLLECTION, CHUNKS_TEXT_INDEX, CHUNKS_VECTOR_INDEX, DEFAULT_EMBED_MODEL, textIndexDefinition, vectorIndexDefinition } from "./indexes.ts";

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is required");
  process.exit(2);
}
const dryRun = process.argv.includes("--dry-run");
const backfill = process.argv.includes("--backfill");
const dbName = process.env.MONGODB_DB ?? "outfitter";
const model = process.env.SESSION_SEARCH_EMBED_MODEL || DEFAULT_EMBED_MODEL;

const client = new MongoClient(uri);
await client.connect();
const db = client.db(dbName);
const version = (await db.admin().command({ buildInfo: 1 })).version as string;
console.log(`mongodb ${version}${Number(version.split(".")[0]) < 8 ? " (hybrid search needs 8.0+)" : ""}`);
if (!(await db.listCollections({ name: CHUNKS_COLLECTION }).hasNext())) {
  if (dryRun) console.log(`would create collection ${CHUNKS_COLLECTION}`);
  else await db.createCollection(CHUNKS_COLLECTION);
}
const col = db.collection(CHUNKS_COLLECTION);

const wanted = [
  { name: CHUNKS_TEXT_INDEX, type: "search", definition: textIndexDefinition() },
  { name: CHUNKS_VECTOR_INDEX, type: "vectorSearch", definition: vectorIndexDefinition(model) },
];
type SearchIndexInfo = { name: string; status?: string; definition?: unknown; latestDefinition?: unknown };
const existing = (dryRun && !(await db.listCollections({ name: CHUNKS_COLLECTION }).hasNext()) ? [] : await col.listSearchIndexes().toArray()) as SearchIndexInfo[];
/** Every value we set is what Atlas has, ignoring key order and the defaults Atlas fills in. */
function covers(have: unknown, want: unknown): boolean {
  if (Array.isArray(want)) {
    if (!Array.isArray(have) || have.length !== want.length) return false;
    return want.every((w) => have.some((h) => covers(h, w)));
  }
  if (want && typeof want === "object") {
    if (!have || typeof have !== "object") return false;
    return Object.entries(want).every(([k, v]) => covers((have as Record<string, unknown>)[k], v));
  }
  return have === want;
}

function modelOf(def: unknown): string | undefined {
  const fields = (def as { fields?: Array<{ type?: string; model?: string }> } | undefined)?.fields ?? [];
  return fields.find((f) => f.type === "autoEmbed")?.model;
}

for (const idx of wanted) {
  const have = existing.find((e) => e.name === idx.name);
  const current = have?.latestDefinition ?? have?.definition;
  const same = have && covers(current, idx.definition);
  if (have && idx.type === "vectorSearch" && modelOf(current) && modelOf(current) !== modelOf(idx.definition)) {
    console.error(`${idx.name}: embeds with ${modelOf(current)}, asked for ${modelOf(idx.definition)}; a model can't change in place. Drop ${idx.name} first (everything is re-embedded).`);
    process.exitCode = 1;
    continue;
  }
  if (same) {
    console.log(`${idx.name}: up to date (${have.status ?? "unknown status"})`);
  } else if (dryRun) {
    console.log(`${idx.name}: would ${have ? "update" : "create"} ${JSON.stringify(idx.definition)}`);
  } else if (have) {
    await col.updateSearchIndex(idx.name, idx.definition);
    console.log(`${idx.name}: updated`);
  } else {
    await col.createSearchIndex(idx as never);
    console.log(`${idx.name}: created`);
  }
}

const sessions = await db.collection("sessions").countDocuments();
const entries = await db.collection("entries").countDocuments();
const chunks = await col.countDocuments();
console.log(`sessions ${sessions}, entries ${entries}, chunks now ${chunks}`);
await client.close();

if (backfill) {
  if (dryRun) {
    console.log(`would backfill chunks for ${sessions} sessions`);
  } else {
    const store = await MongoStore.connect(uri, dbName);
    const indexer = new SessionIndexer(store, (m) => console.error(m));
    let total = 0;
    for (const s of await store.sessions.list({ archived: "all" })) total += await indexer.reindexSession(s.id);
    console.log(`backfilled ${total} chunks`);
    await store.close();
  }
}
