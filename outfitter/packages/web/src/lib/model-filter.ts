// Pure filter logic for ModelPicker.tsx (E3.7), split out so it's testable without rendering a
// component -- this package has no React Testing Library set up, and every other web test in this
// repo is a plain function test (entry-view, relative-time, session-stream's mergeEntries).

import type { ModelRow } from "../api/client.ts";

/** Case-insensitive substring match against the model id, capped at `limit` rows so a large router
 * model list doesn't render an unbounded dropdown. An empty query returns the first `limit` rows
 * unfiltered (rather than nothing), so the list isn't empty on first focus. */
export function filterModels(models: ModelRow[], query: string, limit = 50): ModelRow[] {
  const q = query.trim().toLowerCase();
  const rows = q ? models.filter((m) => m.id.toLowerCase().includes(q)) : models;
  return rows.slice(0, limit);
}
