/**
 * Bounded reading of outbound HTTP responses.
 *
 * `safeFetch` bounds the time to the response HEADERS (its timer is cleared
 * once they arrive) and says nothing about the body, so a hostile or merely
 * slow server could feed an unbounded, endless body into `res.text()`. Every
 * tool that fetches a URL reads the body through here instead: a hard byte
 * cap and a wall-clock deadline, with the truncation reported rather than
 * hidden.
 */

import { SsrfBlockedError } from "../../lib/ssrfGuard.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("skills-http");

/**
 * The text a model, a graph author or a chat user may see when an outbound
 * request fails. The full error is logged; a blocked request is reported
 * through `SsrfBlockedError.publicMessage`, which never says what a host
 * resolved to (that would make the tool an internal-address oracle).
 */
export function describeFetchFailure(err: unknown, context: string): string {
  logger.warn({ err, context }, "outbound request failed");
  if (err instanceof SsrfBlockedError) return err.publicMessage;
  if (err instanceof Error && err.name === "TimeoutError") return "the request timed out";
  if (err instanceof Error && err.name === "AbortError") return "the request was aborted";
  return "the request failed";
}

export interface CappedBody {
  text: string;
  /** True when the body was longer than the cap (or the deadline cut it). */
  truncated: boolean;
  bytesRead: number;
}

export interface ReadBodyOptions {
  maxBytes: number;
  /** Wall-clock budget for the whole body. */
  timeoutMs: number;
  signal?: AbortSignal;
}

export async function readBodyCapped(
  res: Response,
  options: ReadBodyOptions,
): Promise<CappedBody> {
  if (!res.body) return { text: "", truncated: false, bytesRead: 0 };

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let truncated = false;

  let deadlineHit = false;
  const timer = setTimeout(() => {
    deadlineHit = true;
    void reader.cancel().catch(() => {});
  }, options.timeoutMs);
  const onAbort = () => void reader.cancel().catch(() => {});
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = options.maxBytes - bytesRead;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        bytesRead += Math.max(remaining, 0);
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      bytesRead += value.byteLength;
    }
  } catch (err) {
    if (options.signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }
    if (!deadlineHit) throw err;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }

  if (options.signal?.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }
  if (deadlineHit) truncated = true;

  const buffer = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(buffer),
    truncated,
    bytesRead,
  };
}

/** Clips text to a character budget, saying so inline. */
export function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

// ============================================
// Outbound request headers
// ============================================

const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
]);

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const MAX_HEADERS = 20;
const MAX_HEADER_VALUE = 4096;

/**
 * Validates headers that a model or a graph author supplied for an outbound
 * request. Names are allowlisted to token characters, values may not carry
 * CR/LF (header injection), and the headers that steer routing or framing
 * (Host, Content-Length, ...) are refused. Throws with a message naming the
 * offending header.
 */
export function sanitizeOutboundHeaders(
  input: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!input) return undefined;
  const entries = Object.entries(input);
  if (entries.length > MAX_HEADERS) {
    throw new Error(`too many headers (limit ${MAX_HEADERS})`);
  }
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!HEADER_NAME.test(name)) {
      throw new Error(`invalid header name "${name.slice(0, 40)}"`);
    }
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      throw new Error(`the "${name}" header cannot be set`);
    }
    if (value.length > MAX_HEADER_VALUE || /[\r\n]/.test(value)) {
      throw new Error(`invalid value for header "${name}"`);
    }
    out[name] = value;
  }
  return out;
}
