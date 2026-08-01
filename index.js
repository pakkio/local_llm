#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = process.env.LOCAL_LLM_URL ?? "http://127.0.0.1:9000";
const DEFAULT_MODEL = process.env.LOCAL_LLM_MODEL ?? "gemma-4-e2b";
// This model emits a large reasoning_content block before the real answer;
// a low max_tokens truncates the reply before content is ever produced.
const DEFAULT_MAX_TOKENS = 2000;

const server = new McpServer({
  name: "local-llm",
  version: "1.0.0",
});

const stats = {
  requests: 0,
  errors: 0,
  promptTokens: 0,
  completionTokens: 0,
  wallTimeMs: 0,
  generationMs: 0,
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
      `Send a prompt to the local llama.cpp-compatible server at ${BASE_URL} ` +
      `(model: ${DEFAULT_MODEL}). The model is a small reasoning model that ` +
      "emits chain-of-thought before its final answer, so max_tokens defaults " +
      "high to avoid truncation.",
    inputSchema: {
      prompt: z.string().describe("The user message to send to the model"),
      system_prompt: z
        .string()
        .optional()
        .describe("Optional system prompt to steer the model's behavior"),
      max_tokens: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Max tokens to generate (default ${DEFAULT_MAX_TOKENS})`),
      include_reasoning: z
        .boolean()
        .optional()
        .describe("Include the model's reasoning_content in the result (default false)"),
      model: z.string().optional().describe(`Model name (default ${DEFAULT_MODEL})`),
    },
  },
  async ({ prompt, system_prompt, max_tokens, include_reasoning, model }) => {
    const messages = [];
    if (system_prompt) messages.push({ role: "system", content: system_prompt });
    messages.push({ role: "user", content: prompt });

    const body = {
      model: model ?? DEFAULT_MODEL,
      messages,
      max_tokens: max_tokens ?? DEFAULT_MAX_TOKENS,
    };

    stats.requests += 1;
    const startedAt = Date.now();

    let res;
    try {
      res = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      stats.errors += 1;
      return {
        content: [{ type: "text", text: `Failed to reach ${BASE_URL}: ${err.message}` }],
        isError: true,
      };
    }

    const data = await res.json();
    stats.wallTimeMs += Date.now() - startedAt;

    if (!res.ok || data.error) {
      stats.errors += 1;
      const msg = data.error?.message ?? `HTTP ${res.status}`;
      return {
        content: [{ type: "text", text: `Local LLM error: ${msg}` }],
        isError: true,
      };
    }

    if (data.usage) {
      stats.promptTokens += data.usage.prompt_tokens ?? 0;
      stats.completionTokens += data.usage.completion_tokens ?? 0;
    }
    if (data.timings?.predicted_ms) {
      stats.generationMs += data.timings.predicted_ms;
    }

    const choice = data.choices?.[0];
    const message = choice?.message ?? {};
    const finishReason = choice?.finish_reason;

    let text = message.content ?? "";
    if (!text && finishReason === "length") {
      text =
        "[No answer produced: max_tokens was exhausted by reasoning before an answer " +
        "was generated. Retry with a higher max_tokens.]";
    }

    if (include_reasoning && message.reasoning_content) {
      text += `\n\n---\nReasoning:\n${message.reasoning_content}`;
    }

    const usage = data.usage;
    if (usage) {
      text += `\n\n(finish_reason=${finishReason}, completion_tokens=${usage.completion_tokens}, prompt_tokens=${usage.prompt_tokens})`;
    }

    return { content: [{ type: "text", text }] };
  }
);

server.registerTool(
  "local_llm_health",
  {
    title: "Check local LLM health",
    description: `Check whether the local LLM server at ${BASE_URL} is up`,
    inputSchema: {},
  },
  async () => {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      const text = await res.text();
      return { content: [{ type: "text", text: `HTTP ${res.status}: ${text}` }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Unreachable: ${err.message}` }],
        isError: true,
      };
    }
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
      "(requests, tokens, throughput, errors). Resets when the server restarts.",
    inputSchema: {},
  },
  async () => {
    const genTokensPerSec =
      stats.generationMs > 0 ? (stats.completionTokens / (stats.generationMs / 1000)).toFixed(1) : "n/a";
    const avgWallMs = stats.requests > 0 ? Math.round(stats.wallTimeMs / stats.requests) : 0;

    const lines = [
      `Session started: ${stats.startedAt}`,
      `Requests: ${stats.requests} (errors: ${stats.errors})`,
      `Prompt tokens: ${stats.promptTokens}`,
      `Completion tokens: ${stats.completionTokens}`,
      `Avg generation speed: ${genTokensPerSec} tok/s`,
      `Avg wall time per request: ${avgWallMs} ms`,
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
