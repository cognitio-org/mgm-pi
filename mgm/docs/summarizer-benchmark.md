# Summarizer model benchmark (2026-09-20)

Same compaction fold for every model: 33 messages from a real mgm session (voice-extension
research), 36,651 chars ≈ 9.2k tokens, prompt from `.pi/extensions/compaction/lib.ts`
(`summaryPrompt`, 900-word budget), `max_tokens` 1638, sent through the LiteLLM router.
"List price per fold" uses the router's `/model/info` prices for 10k in + 1.5k out.

| Model (router alias) | Latency | List $/fold | Output words | Template compliance | Notes |
|---|---|---|---|---|---|
| `gpt-5-nano` | 8.9 s | 0.0011 | 0 | fails | spent the whole budget on hidden reasoning; with `reasoning_effort: minimal` 5.4 s, 627 words, but omitted the file lists |
| **`gpt-5.4-nano`** (default) | 8.4 s | 0.0039 | 581 | complete | keeps exact API signatures, paths, URLs |
| `gemini-3-5-flash-lite-low` | 2.6 s | 0.0068 | 229 | complete | fastest; terse even when told to prefer completeness |
| `gemini-3-7-flash-low` | 6.1 s | 0.0131 | 300 | complete | |
| `claude-haiku-4-5` | 13.7 s | 0.0175 | 545 | complete | previous default |

Verdict: `gpt-5.4-nano` retains the most detail at the second-lowest price and always follows the
template once the prompt asks for completeness. `gemini-3-5-flash-lite-low` is the pick when latency
matters more than detail. Billed amounts reported in `x-litellm-response-cost` varied between
identical runs (cache reads), so the table uses list prices. Change the default with
`/compaction model <alias>`; rerun this comparison with
`node scratch/abfold.mjs <session.jsonl> <key> <aliases…>` (`scratch/abfold.mjs`).
