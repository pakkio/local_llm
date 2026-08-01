#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

// --- Direct llama-cli invocation, no llama-server / HTTP hop ------------
// A persistent `llama-cli -cnv` process is kept alive across calls (see
// below) instead of spawning fresh per request, so the model only pays
// its load/VRAM-upload cost once. No HTTP server, no port, no health-check
// race — switching models just kills the current session and lets the
// next call spawn a new one.
const PROJECT_DIR = process.env.LOCAL_LLM_PROJECT_DIR ?? "/home/pakkio/w/local_llm";
const CLI_BIN = path.join(PROJECT_DIR, "bin", "llama-cli");
const MODELS_DIR = path.join(PROJECT_DIR, "models");
// The binaries in bin/ were built when this project lived at a different
// path (their RUNPATH still points there), so their .so deps aren't found
// via the default loader search. Point LD_LIBRARY_PATH at the real build
// tree instead of relying on the (stale) baked-in rpath.
const LIB_DIR = path.join(PROJECT_DIR, "vendor", "llama.cpp", "build", "bin");
const CTX_SIZE = process.env.LOCAL_LLM_CTX_SIZE ?? "8192";
const NGL = process.env.LOCAL_LLM_NGL ?? "99";
// This model emits a large reasoning_content block before its final answer;
// a low max_tokens truncates the reply before content is ever produced.
const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_SYSTEM_PROMPT = "You are a helpful, concise assistant.";

const MODELS = {
  e2b: { alias: "gemma-4-e2b", file: "gemma-4-E2B_q4_0-it.gguf" },
  e4b: { alias: "gemma-4-e4b", file: "gemma-4-E4B_q4_0-it.gguf" },
};

let currentModelKey =
  Object.keys(MODELS).find((k) => MODELS[k].alias === process.env.LOCAL_LLM_MODEL) ??
  (MODELS[process.env.LOCAL_LLM_MODEL] ? process.env.LOCAL_LLM_MODEL : null) ??
  "e2b";

function resolveModelKey(input) {
  if (!input) return currentModelKey;
  if (MODELS[input]) return input;
  const byAlias = Object.keys(MODELS).find((k) => MODELS[k].alias === input);
  if (byAlias) return byAlias;
  throw new Error(`Unknown model "${input}". Valid: ${Object.keys(MODELS).join(", ")} (or their aliases)`);
}

function modelPathFor(key) {
  const p = path.join(MODELS_DIR, MODELS[key].file);
  if (!fs.existsSync(p)) throw new Error(`Model file not found: ${p}`);
  return p;
}

const FOOTER_RE = /\[ Prompt:\s*([\d.]+)\s*t\/s\s*\|\s*Generation:\s*([\d.]+)\s*t\/s\s*\]/;

const THINK_RE = /\[Start thinking\]([\s\S]*?)\[End thinking\]\s*/;

// --- Persistent llama-cli session -------------------------------------
// Spawning llama-cli fresh per call means reloading + re-uploading the
// model to VRAM every time (~3-5s). Instead, keep one long-lived
// `llama-cli -cnv` process around (per model/system_prompt/max_tokens
// combo — those are launch-time flags and can't change mid-session) and
// send it one line per call via stdin, sending "/clear" first so each
// call still sees a fresh, independent conversation (matching the old
// one-shot semantics) while the model itself stays resident.
const IDLE_TIMEOUT_MS = Number(process.env.LOCAL_LLM_IDLE_TIMEOUT_MS ?? 10 * 60 * 1000);
const CLEAR_RE = /Chat history cleared\.[\s\S]*?>\s?/;

let session = null; // { child, modelKey, systemPrompt, maxTokens, buffer, consumed, turns, idleTimer, dead }
let queue = Promise.resolve();

function killSession() {
  if (session) {
    clearTimeout(session.idleTimer);
    try {
      session.child.kill("SIGKILL");
    } catch {
      // already dead
    }
    session = null;
  }
}

function armIdleTimer(s) {
  clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(killSession, IDLE_TIMEOUT_MS);
  s.idleTimer.unref?.();
}

function spawnSession(modelKey, systemPrompt, maxTokens) {
  const modelPath = modelPathFor(modelKey);
  const args = [
    "-m", modelPath,
    "-ngl", String(NGL),
    "-c", String(CTX_SIZE),
    "-n", String(maxTokens),
    "-cnv",
    "--simple-io", "--no-display-prompt", "--log-disable",
    "-sys", systemPrompt,
  ];
  const child = spawn(CLI_BIN, args, {
    env: { ...process.env, LD_LIBRARY_PATH: LIB_DIR },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const s = { child, modelKey, systemPrompt, maxTokens, buffer: "", consumed: 0, turns: 0, idleTimer: null, dead: false };
  child.stdout.on("data", (d) => { s.buffer += d.toString(); });
  child.stderr.on("data", (d) => { s.buffer += d.toString(); });
  child.on("exit", () => {
    s.dead = true;
    if (session === s) session = null;
  });
  session = s;
  return s;
}

function waitForPattern(s, re, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      const m = s.buffer.slice(s.consumed).match(re);
      if (m) {
        clearInterval(iv);
        resolve(m);
      } else if (s.dead) {
        clearInterval(iv);
        reject(new Error(`llama-cli exited unexpectedly\n${s.buffer.slice(-1500)}`));
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`Timed out waiting for llama-cli response\n${s.buffer.slice(-1500)}`));
      }
    }, 100);
  });
}

async function clearHistory(s) {
  const before = s.consumed;
  s.child.stdin.write("/clear\n");
  const m = await waitForPattern(s, CLEAR_RE, 10000);
  s.consumed = before + m.index + m[0].length;
}

function extractFirstTurnText(raw) {
  // Only the very first turn after spawn is preceded by the startup
  // banner instead of a plain "> " ready-marker.
  const bannerIdx = raw.indexOf("available commands:");
  const rest = bannerIdx >= 0 ? raw.slice(bannerIdx) : raw;
  const promptIdx = rest.indexOf("> ");
  return promptIdx >= 0 ? rest.slice(promptIdx + 2) : rest;
}

async function askSession({ prompt, systemPrompt, maxTokens, modelKey }) {
  let s = session;
  const reusable = s && !s.dead && s.modelKey === modelKey && s.systemPrompt === systemPrompt && s.maxTokens === maxTokens;
  if (!reusable) {
    killSession();
    s = spawnSession(modelKey, systemPrompt, maxTokens);
  } else {
    await clearHistory(s);
  }

  const before = s.consumed;
  s.child.stdin.write(`${prompt}\n`);
  const footerMatch = await waitForPattern(s, FOOTER_RE, 180000);
  const rawSlice = s.buffer.slice(before, before + footerMatch.index);
  const body = (s.turns === 0 ? extractFirstTurnText(rawSlice) : rawSlice.replace(/^[\s\S]*?>\s?/, "")).trim();

  s.turns += 1;
  s.consumed = before + footerMatch.index + footerMatch[0].length;
  armIdleTimer(s);

  const promptTokPerSec = parseFloat(footerMatch[1]);
  const genTokPerSec = parseFloat(footerMatch[2]);

  const thinkMatch = body.match(THINK_RE);
  if (thinkMatch) {
    const reasoning = thinkMatch[1].trim();
    const text = body.slice(thinkMatch.index + thinkMatch[0].length).trim();
    return { text, reasoning, truncated: false, promptTokPerSec, genTokPerSec };
  }
  const truncated = body.includes("[Start thinking]");
  return { text: truncated ? "" : body, reasoning: truncated ? body : null, truncated, promptTokPerSec, genTokPerSec };
}

function runLlamaCli(args) {
  const task = () => askSession(args);
  const result = queue.then(task);
  // keep the queue alive even if this call rejects, so later calls aren't stuck
  queue = result.catch(() => {});
  return result;
}

process.on("exit", killSession);

function checkBinary() {
  return new Promise((resolve) => {
    execFile(
      CLI_BIN,
      ["--version"],
      { env: { ...process.env, LD_LIBRARY_PATH: LIB_DIR }, timeout: 10000 },
      (err, stdout, stderr) => {
        if (err) resolve({ ok: false, detail: (stderr || err.message).slice(-500) });
        else resolve({ ok: true, detail: (stdout || stderr).trim().split("\n").slice(0, 3).join(" | ") });
      }
    );
  });
}

const server = new McpServer({
  name: "local-llm",
  version: "2.0.0",
});

const stats = {
  requests: 0,
  errors: 0,
  wallTimeMs: 0,
  genTokPerSecSum: 0,
  genTokPerSecCount: 0,
  startedAt: new Date().toISOString(),
  reviewedRequests: 0,
  requestsWithErrors: 0,
  errorsFound: 0,
  savingsPctSum: 0,
};

server.registerTool(
  "ask_local_llm",
  {
    title: "Ask local LLM",
    description:
      "Runs the local Gemma 4 model via a persistent llama-cli process (spawned lazily, reused " +
      "across calls, auto-killed after idle timeout) — the model stays resident in VRAM instead " +
      "of reloading every call, while each call still gets a fresh conversation (history is " +
      "cleared automatically). The model is a small reasoning model that emits chain-of-thought " +
      "before its final answer, so max_tokens defaults high to avoid truncation. Changing model, " +
      "system_prompt, or max_tokens from what the current session was started with forces a restart.",
    inputSchema: {
      prompt: z.string().describe("The user message to send to the model"),
      system_prompt: z
        .string()
        .optional()
        .describe(`Optional system prompt to steer the model's behavior (default: "${DEFAULT_SYSTEM_PROMPT}")`),
      max_tokens: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Max tokens to generate (default ${DEFAULT_MAX_TOKENS})`),
      include_reasoning: z
        .boolean()
        .optional()
        .describe("Include the model's reasoning (chain-of-thought) in the result (default false)"),
      model: z.string().optional().describe(`Model to use: ${Object.keys(MODELS).join(" | ")} (default: currently active — see switch_local_llm_model)`),
    },
  },
  async ({ prompt, system_prompt, max_tokens, include_reasoning, model }) => {
    stats.requests += 1;
    const startedAt = Date.now();

    let modelKey;
    try {
      modelKey = resolveModelKey(model);
    } catch (err) {
      stats.errors += 1;
      return { content: [{ type: "text", text: err.message }], isError: true };
    }

    let result;
    try {
      result = await runLlamaCli({
        prompt,
        systemPrompt: system_prompt ?? DEFAULT_SYSTEM_PROMPT,
        maxTokens: max_tokens ?? DEFAULT_MAX_TOKENS,
        modelKey,
      });
    } catch (err) {
      stats.errors += 1;
      return { content: [{ type: "text", text: err.message }], isError: true };
    }

    stats.wallTimeMs += Date.now() - startedAt;
    if (result.genTokPerSec != null) {
      stats.genTokPerSecSum += result.genTokPerSec;
      stats.genTokPerSecCount += 1;
    }

    let text = result.text;
    if (result.truncated) {
      text = "[No answer produced: max_tokens was exhausted by reasoning before an answer " +
        "was generated. Retry with a higher max_tokens.]";
    }

    if (include_reasoning && result.reasoning) {
      text += `\n\n---\nReasoning:\n${result.reasoning}`;
    }

    if (result.genTokPerSec != null) {
      text += `\n\n(model: ${MODELS[modelKey].alias}, gen: ${result.genTokPerSec} t/s)`;
    }

    return { content: [{ type: "text", text }] };
  }
);

server.registerTool(
  "local_llm_health",
  {
    title: "Check local LLM readiness",
    description:
      "Checks that llama-cli runs (correct LD_LIBRARY_PATH, no missing .so) and that the active " +
      "model's GGUF file exists. There's no server to ping anymore — this is a static file/binary check.",
    inputSchema: {},
  },
  async () => {
    const bin = await checkBinary();
    if (!bin.ok) {
      return { content: [{ type: "text", text: `llama-cli not runnable: ${bin.detail}` }], isError: true };
    }
    try {
      const p = modelPathFor(currentModelKey);
      return {
        content: [
          { type: "text", text: `OK: ${bin.detail} | active model: ${MODELS[currentModelKey].alias} (${p})` },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
  }
);

server.registerTool(
  "switch_local_llm_model",
  {
    title: "Switch local LLM model (E2B / E4B)",
    description:
      "Selects which Gemma 4 size ask_local_llm uses by default. Since there's no persistent " +
      "server anymore, this is just a pointer change — instant, nothing to stop or start. Only " +
      "takes effect on the next ask_local_llm call.",
    inputSchema: {
      model: z.enum(["e2b", "e4b"]).describe(
        "e2b = Gemma 4 E2B (~3.3GB, faster) | e4b = Gemma 4 E4B (~5.1GB, larger/slower, likely better quality)"
      ),
    },
  },
  async ({ model }) => {
    try {
      modelPathFor(model); // validate the file exists before switching
    } catch (err) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
    currentModelKey = model;
    return { content: [{ type: "text", text: `Active model set to ${MODELS[model].alias}. Takes effect on the next ask_local_llm call.` }] };
  }
);

server.registerTool(
  "report_review",
  {
    title: "Report fact-check review of a local LLM answer",
    description:
      "Call this after fact-checking an ask_local_llm response against your own knowledge, " +
      "so local_llm_stats can report factual error rate and estimated net token savings " +
      "(the server has no way to judge accuracy on its own — this is self-reported by the caller).",
    inputSchema: {
      had_errors: z
        .boolean()
        .describe("Whether the reviewed answer contained factual errors that needed correcting"),
      error_count: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Number of distinct factual errors found (defaults to 1 if had_errors is true)"),
      savings_pct: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe(
          "Estimated % of the response usable verbatim / net token savings (0-100). " +
            "Defaults to 100 if no errors, 30 if errors were found."
        ),
    },
  },
  async ({ had_errors, error_count, savings_pct }) => {
    stats.reviewedRequests += 1;
    if (had_errors) {
      stats.requestsWithErrors += 1;
      stats.errorsFound += error_count ?? 1;
    }
    const pct = savings_pct ?? (had_errors ? 30 : 100);
    stats.savingsPctSum += pct;

    return {
      content: [
        {
          type: "text",
          text: `Review recorded (reviewed: ${stats.reviewedRequests}, with errors: ${stats.requestsWithErrors}).`,
        },
      ],
    };
  }
);

server.registerTool(
  "local_llm_stats",
  {
    title: "Local LLM usage stats",
    description:
      "Cumulative usage stats for ask_local_llm calls made during this MCP server session " +
      "(requests, throughput, errors). Resets when the server restarts. Token counts aren't " +
      "available in direct-CLI mode (llama-cli's --simple-io footer only reports tok/s, not " +
      "token counts), so only generation speed and wall time are tracked here.",
    inputSchema: {},
  },
  async () => {
    const avgGenTokPerSec =
      stats.genTokPerSecCount > 0 ? (stats.genTokPerSecSum / stats.genTokPerSecCount).toFixed(1) : "n/a";
    const avgWallMs = stats.requests > 0 ? Math.round(stats.wallTimeMs / stats.requests) : 0;

    const lines = [
      `Session started: ${stats.startedAt}`,
      `Active model: ${MODELS[currentModelKey].alias} (${currentModelKey})`,
      `Requests: ${stats.requests} (errors: ${stats.errors})`,
      `Avg generation speed: ${avgGenTokPerSec} tok/s`,
      `Avg wall time per request: ${avgWallMs} ms (includes per-call model load — no persistent server)`,
      `Total wall time: ${stats.wallTimeMs} ms`,
    ];

    if (stats.reviewedRequests > 0) {
      const errorRatePct = ((stats.requestsWithErrors / stats.reviewedRequests) * 100).toFixed(1);
      const avgSavingsPct = (stats.savingsPctSum / stats.reviewedRequests).toFixed(1);
      lines.push(
        `Reviewed: ${stats.reviewedRequests}/${stats.requests} requests`,
        `Factual error rate: ${errorRatePct}% of reviewed requests (${stats.errorsFound} errors found)`,
        `Avg estimated net savings: ${avgSavingsPct}%`
      );
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
