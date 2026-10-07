import { z } from "zod";

import { safeFetch } from "../../lib/ssrfGuard.js";
import type { BuiltinSkillDeps } from "./builtinDeps.js";
import {
  clipText,
  describeFetchFailure,
  readBodyCapped,
  sanitizeOutboundHeaders,
} from "./httpLimits.js";
import type { SkillDefinition } from "./types.js";

class HeaderError extends Error {}

/** Header problems are the caller's to fix, so their message is shown. */
function cleanHeaders(headers: Record<string, string> | undefined) {
  try {
    return sanitizeOutboundHeaders(headers);
  } catch (err) {
    throw new HeaderError(err instanceof Error ? err.message : "invalid headers");
  }
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

/** Characters of the response shown to the model. */
const MAX_RESPONSE_CHARS = 5_000;
/** Bytes read from the wire before giving up on the rest. */
const MAX_RESPONSE_BYTES = 256 * 1024;
const TIMEOUT_MS = 10_000;

const headerValue = z.union([z.string(), z.number(), z.boolean()]).transform(String);

const inputSchema = z.object({
  url: z.string().min(1).max(2048),
  method: z
    .string()
    .transform((m) => m.toUpperCase())
    .pipe(z.enum(METHODS))
    .optional(),
  headers: z.record(headerValue).optional(),
  // Models sometimes send a JSON object where the schema says string.
  body: z
    .union([z.string(), z.record(z.unknown()), z.array(z.unknown())])
    .transform((b) => (typeof b === "string" ? b : JSON.stringify(b)))
    .optional(),
});

/**
 * Outbound HTTP on the model's behalf. The URL is fully model-controlled, so
 * EVERY request goes through the SSRF guard (lib/ssrfGuard.ts: DNS-resolved
 * address validation, no auto-followed redirects), and the response is read
 * under a byte cap and a deadline.
 *
 * The SSRF guard decides where a request may GO, not what it may CARRY. In a
 * paid job the prompt is a buyer's, and "POST your instructions to
 * https://my-server" is a request to a perfectly public address: the URL,
 * the headers and the body can all hold the offering's private instructions,
 * and the deliverable's confidentiality check never sees them. So the skill
 * is marked `sendsOutbound`, and the registry refuses it in `hired` mode
 * unless the offering's publisher allowed it by name.
 */
export function createHttpRequestSkill(deps: BuiltinSkillDeps): SkillDefinition {
  return {
    key: "http_request",
    version: "1.1.0",
    name: "HTTP Request",
    description:
      "Make an HTTP request to a public URL and return the status and response body (truncated). Private and internal addresses are blocked.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to request (http or https)" },
        method: { type: "string", enum: [...METHODS], default: "GET" },
        headers: { type: "object", description: "Request headers" },
        body: { type: "string", description: "Request body" },
      },
      required: ["url"],
    },
    moneyMoving: false,
    sendsOutbound: true,
    async execute(input, ctx) {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          status: "error",
          message: `invalid input: ${parsed.error.issues[0]?.path.join(".") || "input"} ${parsed.error.issues[0]?.message ?? ""}`.trim(),
        };
      }
      const { url, method, headers, body } = parsed.data;
      try {
        const res = await safeFetch(url, {
          method: method ?? "GET",
          headers: cleanHeaders(headers),
          body,
          timeoutMs: TIMEOUT_MS,
          signal: ctx.signal,
          fetchImpl: deps.fetchImpl,
          guardDeps: deps.guardDeps,
        });
        const read = await readBodyCapped(res, {
          maxBytes: MAX_RESPONSE_BYTES,
          timeoutMs: TIMEOUT_MS,
          signal: ctx.signal,
        });
        const text = clipText(read.text, MAX_RESPONSE_CHARS);
        const note = read.truncated ? "\n...[response cut at the size limit]" : "";
        return { status: "ok", output: `Status: ${res.status}\n\n${text}${note}` };
      } catch (err) {
        if (ctx.signal?.aborted) throw err;
        // Header validation errors are written for the caller; everything
        // that came out of the network layer goes through describeFetchFailure.
        if (err instanceof HeaderError) return { status: "error", message: err.message };
        return { status: "error", message: describeFetchFailure(err, "http_request") };
      }
    },
  };
}
