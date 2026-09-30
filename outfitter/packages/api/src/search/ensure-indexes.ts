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
for (const idx of wanted) {
  const have = existing.find((e) => e.name === idx.name);
  const same = have && JSON.stringify(have.latestDefinition ?? have.definition) === JSON.stringify(idx.definition);
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
