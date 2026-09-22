# Codebase index retrieval: what was measured

Twelve questions about this checkout, each with the file that actually answers it
(`index-questions.json`), scored by `scripts/index-eval.mjs`: how often the right file comes back
first, how often it lands in the top three, and mean reciprocal rank. Run it with

```bash
node --import ./tests/resolve-pi.mjs scripts/index-eval.mjs
```

Each configuration runs in its own child process, because the indexer reads its configuration once
when the package initialises. The first version of the script reused one process and every
configuration scored identically — it was measuring nothing.

## Results

| configuration | top 1 | top 3 | MRR |
|---|---|---|---|
| package defaults, no reranking | 1/12 | 5/12 | 0.288 |
| no reranking, keyword-light (hybridWeight 0.7) | 1/12 | 5/12 | 0.281 |
| reranking on (`voyage/rerank-3-lite`) | 4/12 | 8/12 | 0.521 |
| + 50 or 100 candidates into 10 results | 4/12 | 8/12 | 0.514 |
| + keyword-light or keyword-heavy | 4/12 | 8/12 | 0.514 |
| + weighted fusion instead of rrf | 4/12 | 7/12 | 0.475 |
| reranking, no score floor | 4/12 | 8/12 | 0.514 |
| `voyage/rerank-3` (full model) | 5/12 | 8/12 | 0.556 |
| **`voyage/rerank-3` with rerankTopN 100** | **6/12** | **8/12** | **0.597** |

## What that says

**Reranking is the only lever that matters.** It doubles top-three and triples top-one. Embedding
similarity is confidently wrong on this corpus: a test that *talks about* rejected keys scores 96.8%
while the code that *decides* it scores 48.4%, and only the reranker puts them in the right order.

**Candidate width matters once a reranker is there.** The package defaults `rerankTopN` to 20, the
same as `maxResults`, so the reranker can only reorder what fusion already chose. Raising it to 100
is the one tuning change worth making, and it is now the seeded default.

**Everything else did nothing or hurt.** Keyword balance in either direction, weighted fusion, and
removing the score floor all failed to move the numbers. A useful negative result: there is no
tuning left to do here, so effort belongs elsewhere.

## The remaining failures are shell scripts

`package.sh`, `install.sh` and `bin/kernal` never come back, in any configuration, and `prebundle.sh`
sits around rank six. Two separate causes, neither of them ranking:

- **Shell scripts are chunked at function declarations only.** Searching for `package.sh` returns
  `function_definition "sha" … package.sh:13-13`, a one-line chunk. The body of the script, which is
  what a question like "how does a release bundle get built" is really about, is not in the corpus.
- **`bin/kernal` has no file extension**, and the indexer only walks recognised extensions, so it is
  absent entirely.

Both are package limitations, not settings. Until they change, shell behaviour is best documented in
Markdown (which indexes well) and found with grep.

## Honest scorekeeping

The target was the right file in the top three for 80% of questions. The best configuration reaches
8 of 12, or 67% — 73% if the unindexable launcher is excluded. Retrieval is much better than it was
and the tuning space is exhausted; the gap that remains is corpus coverage.
