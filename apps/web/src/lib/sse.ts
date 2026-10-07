/**
 * The chat stream every surface reads: the dashboard playground, Try it on a
 * listing, and (as the same rules, hand-written without imports) the
 * embeddable widget in public/widget.js.
 *
 *   data: {"choices":[{"delta":{"content":"..."}}]}
 *   data: {"wheelsai":{"toolCalls":[...]}}
 *   data: {"error":{"message":"..."}}
 *   data: [DONE]
 *
 * Pure: bytes in, events out. A failure reported inside a 200 stream is an
 * event, never swallowed, so a caller cannot show a half answer as a whole
 * one.
 */

export type SseChatEvent =
  | { type: "delta"; content: string }
  | { type: "toolCalls"; toolCalls: unknown[] }
  | { type: "error"; message: string; code: string | null }
  | { type: "done" };

const FALLBACK_ERROR = "The model stream failed";

/** The events of one line of the stream; most lines carry none or one. */
export function parseSseLine(line: string): SseChatEvent[] {
  if (!line.startsWith("data:")) return [];
  const data = line.slice(5).trim();
  if (data === "") return [];
  if (data === "[DONE]") return [{ type: "done" }];

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    // A line that is not JSON is not an event (a proxy's comment, a split
    // the provider should not have made).
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const chunk = parsed as {
    error?: unknown;
    wheelsai?: { toolCalls?: unknown } | null;
    choices?: Array<{ delta?: { content?: unknown } | null } | null> | null;
  };

  if (chunk.error) {
    const error = chunk.error as { message?: unknown; code?: unknown } | string;
    if (typeof error === "string") return [{ type: "error", message: error, code: null }];
    return [
      {
        type: "error",
        message: typeof error.message === "string" && error.message ? error.message : FALLBACK_ERROR,
        code: typeof error.code === "string" ? error.code : null,
      },
    ];
  }

  const events: SseChatEvent[] = [];
  const toolCalls = chunk.wheelsai?.toolCalls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) events.push({ type: "toolCalls", toolCalls });
  const content = Array.isArray(chunk.choices) ? chunk.choices[0]?.delta?.content : undefined;
  if (typeof content === "string" && content.length > 0) events.push({ type: "delta", content });
  return events;
}

/**
 * The events of a streamed chat response, in order, ending after `done` (or
 * when the body ends). The reader is released however the caller stops.
 */
export async function* readSseChat(body: ReadableStream<Uint8Array>): AsyncGenerator<SseChatEvent, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        for (const event of parseSseLine(line.replace(/\r$/, ""))) {
          yield event;
          if (event.type === "done") return;
        }
      }
    }
    // A last line with no newline after it still counts.
    for (const event of parseSseLine(buffer.replace(/\r$/, ""))) yield event;
  } finally {
    reader.releaseLock();
  }
}
