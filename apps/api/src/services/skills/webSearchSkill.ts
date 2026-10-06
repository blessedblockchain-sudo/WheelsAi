import { z } from "zod";

import { safeFetch } from "../../lib/ssrfGuard.js";
import type { BuiltinSkillDeps } from "./builtinDeps.js";
import { clipText, describeFetchFailure, readBodyCapped } from "./httpLimits.js";
import type { SkillDefinition } from "./types.js";

/**
 * Web search via Tavily (https://docs.tavily.com/documentation/api-reference/endpoint/search).
 * One provider on purpose: a second would be a second thing to configure,
 * bill and debug for no product gain. Key: TAVILY_API_KEY (config/skills.ts).
 */
export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_EXCERPT_CHARS = 600;

const inputSchema = z.object({
  query: z.string().trim().min(1).max(400),
  max_results: z.coerce.number().int().min(1).max(10).default(5),
});

const responseSchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string().default(""),
        url: z.string().default(""),
        content: z.string().default(""),
        score: z.number().optional(),
      }),
    )
    .default([]),
});

const UNCONFIGURED = "web search is not configured on this server";

export function createWebSearchSkill(deps: BuiltinSkillDeps): SkillDefinition {
  const apiKey = () => {
    const state = deps.getConfig();
    return state.error ? undefined : state.config.tavilyApiKey;
  };
  const unavailableReason = () => {
    const state = deps.getConfig();
    return state.error
      ? `web search is misconfigured on this server (${state.error})`
      : UNCONFIGURED;
  };

  return {
    key: "web_search",
    version: "1.0.0",
    name: "Web Search",
    description:
      "Search the web and return the top results with a short excerpt and URL for each.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        max_results: { type: "number", description: "Number of results (1-10)", default: 5 },
      },
      required: ["query"],
    },
    moneyMoving: false,
    requires: ["TAVILY_API_KEY"],
    availability: () =>
      apiKey() ? { available: true } : { available: false, reason: unavailableReason() },

    async execute(input, ctx) {
      const key = apiKey();
      if (!key) return { status: "unavailable", reason: unavailableReason() };

      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) {
        return { status: "error", message: "query must be a non-empty string" };
      }
      const { query, max_results } = parsed.data;

      try {
        const res = await safeFetch(TAVILY_SEARCH_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            query,
            max_results,
            search_depth: "basic",
            include_answer: false,
          }),
          timeoutMs: TIMEOUT_MS,
          // The API key rides in a header; never let a redirect carry it on.
          maxRedirects: 0,
          signal: ctx.signal,
          fetchImpl: deps.fetchImpl,
          guardDeps: deps.guardDeps,
        });
        const body = await readBodyCapped(res, {
          maxBytes: MAX_RESPONSE_BYTES,
          timeoutMs: TIMEOUT_MS,
          signal: ctx.signal,
        });

        if (res.status === 401 || res.status === 403) {
          return {
            status: "error",
            message: "the web search provider rejected this server's API key",
          };
        }
        if (res.status === 429) {
          return { status: "error", message: "the web search provider's rate limit was reached" };
        }
        if (!res.ok) {
          return {
            status: "error",
            message: `the web search provider returned HTTP ${res.status}`,
          };
        }

        let json: unknown;
        try {
          json = JSON.parse(body.text);
        } catch {
          return { status: "error", message: "the web search provider returned a non-JSON response" };
        }
        const parsedBody = responseSchema.safeParse(json);
        if (!parsedBody.success) {
          return {
            status: "error",
            message: "the web search provider returned an unexpected response shape",
          };
        }

        const results = parsedBody.data.results;
        if (results.length === 0) {
          return { status: "ok", output: `No web results found for "${query}".` };
        }
        const lines = results.map(
          (r, i) =>
            `[${i + 1}] ${r.title || "(untitled)"}\n${r.url}\n${clipText(r.content, MAX_EXCERPT_CHARS)}`,
        );
        return {
          status: "ok",
          output: `Web results for "${query}" (Tavily):\n\n${lines.join("\n\n")}`,
          data: { results },
        };
      } catch (err) {
        if (ctx.signal?.aborted) throw err;
        return { status: "error", message: describeFetchFailure(err, "web_search") };
      }
    },
  };
}
