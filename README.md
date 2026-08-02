# local-llm

MCP server that lets Claude Code delegate trivial, standalone questions to a local Gemma 4 model (via llama.cpp), so they don't burn paid tokens.

## Architecture

Each `ask_local_llm` call spawns `llama-cli` directly (one process per request, via Node's `execFile`) and parses its stdout. There is **no persistent server and no HTTP hop** — earlier versions ran `llama-server` and talked to it over `http://127.0.0.1:9000`, but that design was dropped:

- The `bin/llama-cli` and `bin/llama-server` binaries were built when this project lived at a different path. Their RUNPATH is baked to that old location, so their shared libs (`libllama-cli-impl.so` etc.) aren't found by the default loader — this server sets `LD_LIBRARY_PATH` to `vendor/llama.cpp/build/bin` explicitly on every spawn to work around it, rather than relying on the binaries' own rpath.
- Running a persistent `llama-server` meant managing a port, a health-check race on startup, and killing/respawning it to switch models — real failure surface for no benefit on an 8GB GPU where E2B and E4B can't be resident at once anyway.
- Direct CLI invocation makes "switching models" a pure pointer change (see below) at the cost of reloading the model from disk on every single call (~3-5s overhead per request instead of near-zero after the first).

`llama-cli` is invoked with `-cnv -st --simple-io --no-display-prompt --log-disable`, so it runs one conversation turn and exits. Gemma 4 emits its chain-of-thought wrapped in `[Start thinking] ... [End thinking]` before the final answer; the server splits on that marker to return a clean answer separately from the reasoning (only included if `include_reasoning: true`). If `[Start thinking]` appears with no matching `[End thinking]`, `max_tokens` ran out mid-reasoning and no answer was produced — retry with a higher `max_tokens`.

## Setup

```bash
npm install
```

Register as an MCP server in Claude Code, pointing at `index.js`. Optional env vars:

- `LOCAL_LLM_PROJECT_DIR` — path to the local_llm project (models/binaries live here; default `/home/pakkio/w/local_llm`)
- `LOCAL_LLM_MODEL` — initial active model, `e2b`, `e4b`, or `12b` (or their aliases `gemma-4-e2b`/`gemma-4-e4b`/`gemma-4-12b`); default `e2b`
- `LOCAL_LLM_CTX_SIZE` — context size passed to `llama-cli` for e2b/e4b (default `8192`). The `12b` entry hardcodes a smaller `4096` regardless of this var — see below.
- `LOCAL_LLM_NGL` — GPU layers to offload (default `99`, i.e. all layers on GPU)

All three models must already be downloaded into `models/` under `LOCAL_LLM_PROJECT_DIR`:
- `gemma-4-E2B_q4_0-it.gguf` (~3.3GB, official Google QAT q4_0)
- `gemma-4-E4B_q4_0-it.gguf` (~5.1GB, official Google QAT q4_0)
- `gemma-4-12B-it-Q3_K_S.gguf` (~5.7GB, bartowski quant — **not** the official Q4_0 12B build, which at 6.98GB doesn't fully fit on an 8GB GPU; see below)

## Tools

| Tool | Purpose |
|---|---|
| `ask_local_llm` | Send a prompt to the active model. Params: `prompt`, `system_prompt`, `max_tokens` (default 2000 — the model's chain-of-thought counts against this), `include_reasoning`, `model` (`e2b`/`e4b`/`12b`, overrides the active model for this call only). |
| `switch_local_llm_model` | Set the active model (`e2b`, `e4b`, or `12b`) for subsequent `ask_local_llm` calls. Instant — no process to stop/start, just changes which GGUF the next call loads. |
| `local_llm_health` | Static readiness check: confirms `llama-cli --version` runs (catches `LD_LIBRARY_PATH`/missing-.so issues) and that the active model's GGUF file exists. No network involved. |
| `local_llm_stats` | Cumulative session stats: requests, generation speed (tok/s), wall time, and (if reviews were reported) factual error rate + estimated net savings. Token counts aren't tracked — `llama-cli --simple-io`'s footer only reports tok/s, not token counts. |
| `report_review` | Report the outcome of fact-checking an `ask_local_llm` answer (`had_errors`, `error_count`, `savings_pct`), so `local_llm_stats` can aggregate accuracy/savings. |

## E2B vs E4B vs 12B

Measured head-to-head on 10 test prompts (general knowledge, math, bibliography, code in Python/Scheme/6510 assembly — the E2B/E4B set and the 12B set are comparable but not identical prompts):

| | E2B (~3.3GB) | E4B (~5.1GB) | 12B (~5.7GB, Q3_K_S) |
|---|---|---|---|
| Requests with errors | 7/10 (70%) | 5/10 (50%) | 2/10 (20%) |
| Generation speed | ~109 tok/s | ~63 tok/s | ~20-24 tok/s |

12B is meaningfully more accurate than either smaller model, at roughly a quarter of E2B's speed. It's the only one of the three that got a bibliography year right on retest and produced genuinely correct, non-trivial code (walrus-operator one-liners, `lru_cache` memoization) — though it also produced one genuinely broken snippet (`@lru_cache(None=None)`, invalid Python syntax), so its answers still need review like the smaller models'.

**Why Q3_K_S and not the official Q4_0 12B build:** the Q4_0 GGUF (6.98GB) doesn't fully fit in an 8GB GPU's VRAM under WSL2 — even 34/48 layers offloaded OOMs, and the best working partial-offload config (28-32/48 layers) landed at only ~4.5-6.5 tok/s, CPU-bottlenecked on the rest. Q3_K_S (5.72GB) fits entirely in VRAM (`-ngl 99`), eliminating the CPU bottleneck, at no measured accuracy cost (2/10 errors either way on a 10-question spot check).

**None of the three can produce valid 6502/6510 assembly**, but the failure mode differs by size: E2B/E4B confidently invent non-existent opcodes; 12B (both Q4_0 and Q3_K_S) instead gets stuck in an unresolved off-by-one reasoning loop and never emits a final answer at all, even given 3000+ tokens — confirmed not to be a token-budget artifact, and not fixed by requantizing. This instruction set is likely too underrepresented in training data for any of these sizes to get right.

## For Claude: how to use this server

This is the standing policy for when and how to use `ask_local_llm` in a session.

**When to delegate.** Only route a question to the local LLM when BOTH hold:
1. It's banal/trivial — general knowledge, standard proofs, trivia, simple explanations.
2. It's standalone — not tied to the current conversation's context or to the user's project/codebase.

Don't use it for anything requiring codebase awareness, multi-step reasoning tied to prior conversation, or actions (tool use, file edits).

**Why.** The local LLM runs for free; Claude's own output costs the user paid tokens. Delegating trivial, standalone questions saves cost with no meaningful quality loss on simple content.

**Always review before relaying.** Fact-check the local LLM's answer against your own knowledge before showing it to the user, and correct any errors inline rather than passing them through. The local model tends to hallucinate specific facts (dates, dynasties, book/series titles, names of institutions) more than it errs on general concepts, standard math, or common-language code — be extra skeptical of concrete numbers/names/titles, and of any code in a rarely-used language (e.g. 6502/6510 assembly). This check only catches errors on topics you already know well; a mistake on a niche/specialist topic could slip through.

**Report every review.** After fact-checking an `ask_local_llm` answer, call `report_review` with the outcome (`had_errors`, `error_count`, `savings_pct`). Don't just tally mentally — this is what lets `local_llm_stats` report real accuracy/savings numbers instead of raw token counts.

**Label responses.** Prefix each answer with `L:` when it came from the local LLM (even if corrected), or `C:` when Claude answered directly, so the user can see at a glance who answered.

**Mark uncertainty on direct answers too.** `C:` answers don't get an independent fact-check pass the way `L:` answers do. When answering a factual/trivia question directly and you're not fully confident, say so instead of stating it as settled.

**Model choice.** Default to whichever model is already active. If the user is doing rapid-fire trivial questions, `e2b` is fastest. If accuracy matters more than latency, prefer `switch_local_llm_model("12b")` — it's the most accurate of the three at ~20-24 tok/s; `e4b` is a middle ground when GPU memory is tight (12b needs ~5.7GB VRAM free). Never expect any of them to produce working 6502/6510 assembly.

**Scope note.** A broader difficulty ladder (banal → local LLM, simple → Haiku, medium → Sonnet, hard → Opus via spawned Agents) was considered and declined: spawned agents start cold with no conversation context, so tiering anything tied to the ongoing chat costs more than it saves. This server is only for the banal+standalone case.
