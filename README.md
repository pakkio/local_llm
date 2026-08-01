# local_llm

MCP server that proxies Claude Code to a local llama.cpp-compatible server (model: `gemma-4-e2b`), so trivial/standalone questions can be answered for free instead of burning paid tokens.

## Setup

```bash
npm install
```

Register as an MCP server in Claude Code, pointing at `index.js`. Optional env vars:

- `LOCAL_LLM_URL` — base URL of the llama.cpp server (default `http://127.0.0.1:9000`)
- `LOCAL_LLM_MODEL` — model name (default `gemma-4-e2b`)

## Tools

| Tool | Purpose |
|---|---|
| `ask_local_llm` | Send a prompt to the local model. Params: `prompt`, `system_prompt`, `max_tokens`, `include_reasoning`, `model`. |
| `local_llm_health` | Check whether the local server is reachable. |
| `local_llm_stats` | Cumulative session stats: requests, tokens, throughput, and (if reviews were reported) factual error rate + estimated net savings. |
| `report_review` | Report the outcome of fact-checking an `ask_local_llm` answer (`had_errors`, `error_count`, `savings_pct`), so `local_llm_stats` can aggregate accuracy/savings. |

## For Claude: how to use this server

This is the standing policy for when and how to use `ask_local_llm` in a session.

**When to delegate.** Only route a question to the local LLM when BOTH hold:
1. It's banal/trivial — general knowledge, standard proofs, trivia, simple explanations.
2. It's standalone — not tied to the current conversation's context or to the user's project/codebase.

Don't use it for anything requiring codebase awareness, multi-step reasoning tied to prior conversation, or actions (tool use, file edits).

**Why.** The local LLM runs for free; Claude's own output costs the user paid tokens. Delegating trivial, standalone questions saves cost with no meaningful quality loss on simple content.

**Always review before relaying.** Fact-check the local LLM's answer against your own knowledge before showing it to the user, and correct any errors inline rather than passing them through. The local model tends to hallucinate specific facts (dates, dynasties, names of institutions) more than it errs on general concepts or standard math — be extra skeptical of concrete numbers/names. This check only catches errors on topics you already know well; a mistake on a niche/specialist topic could slip through.

**Report every review.** After fact-checking an `ask_local_llm` answer, call `report_review` with the outcome (`had_errors`, `error_count`, `savings_pct`). Don't just tally mentally — this is what lets `local_llm_stats` report real accuracy/savings numbers instead of raw token counts.

**Label responses.** Prefix each answer with `L:` when it came from the local LLM (even if corrected), or `C:` when Claude answered directly, so the user can see at a glance who answered.

**Mark uncertainty on direct answers too.** `C:` answers don't get an independent fact-check pass the way `L:` answers do. When answering a factual/trivia question directly and you're not fully confident, say so instead of stating it as settled.

**Scope note.** A broader difficulty ladder (banal → local LLM, simple → Haiku, medium → Sonnet, hard → Opus via spawned Agents) was considered and declined: spawned agents start cold with no conversation context, so tiering anything tied to the ongoing chat costs more than it saves. This server is only for the banal+standalone case.
