// The two Atlas indexes session search uses (Sysop tools, #289), shared by the store's queries
// (store/mongo.ts) and the script that creates them (search/ensure-indexes.ts, deploy/atlas-search.sh).
// Two of the Free tier's three search-or-vector indexes.

export const CHUNKS_COLLECTION = "sessionChunks";
export const CHUNKS_TEXT_INDEX = "chunks_text";
export const CHUNKS_VECTOR_INDEX = "chunks_vec";

/** Voyage model Atlas embeds with, on write and at query time. voyage-4-lite is the low-cost one;
 * SESSION_SEARCH_EMBED_MODEL picks another (voyage-4, voyage-code-4, ...). Changing it means a new
 * index: an index's model can't be edited in place. */
export const DEFAULT_EMBED_MODEL = "voyage-4-lite";

/** Fields every search can filter on; `at` is createdAt as a Date, for range filters. */
const FILTER_FIELDS = ["ownerEmail", "guruId", "repo", "role", "sessionId", "at"] as const;

export function textIndexDefinition() {
  return {
    mappings: {
      dynamic: false,
      fields: {
        text: { type: "string", analyzer: "lucene.english" },
        ownerEmail: { type: "token" },
        guruId: { type: "token" },
        repo: { type: "token" },
        role: { type: "token" },
        sessionId: { type: "token" },
        at: { type: "date" },
      },
    },
  };
}

export function vectorIndexDefinition(model = DEFAULT_EMBED_MODEL) {
  return {
    fields: [
      { type: "autoEmbed", modality: "text", path: "text", model, numDimensions: 512, quantization: "scalar" },
      ...FILTER_FIELDS.map((path) => ({ type: "filter", path })),
    ],
  };
}
