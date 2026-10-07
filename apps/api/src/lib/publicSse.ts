/**
 * What a streamed answer looks like to an anonymous visitor (the web chat
 * widget and Try it).
 *
 * The runtime's stream is the provider's own SSE, forwarded byte for byte:
 * right for an owner's playground, wrong for a stranger. It carries the
 * provider's error text (which can name the model, the account and its
 * quota), the completion ids and the token usage, and the detail of every
 * tool call. `toPublicStream` re-encodes it into the least a chat window
 * needs, and nothing else passes:
 *
 *   data: {"choices":[{"delta":{"content":"..."}}]}
 *   data: {"wheelsai":{"toolCalls":[{"name":"web_search","status":"ok"}]}}
 *   data: {"choices":[{"delta":{},"finish_reason":"stop"}]}
 *   data: {"error":{"code":"model_error","message":"<generic>"}}
 *   data: [DONE]
 *
 * It is an allowlist: an event this file does not recognise is dropped, not
 * forwarded.
 *
 * Pure: bytes in, bytes out.
 */

import type { ChatStream } from "../services/mastra-runtime.js";

export const PUBLIC_MODEL_ERROR = {
  code: "model_error",
  message: "The agent could not answer just now. Please try again.",
} as const;

export interface PublicToolCall {
  name: string;
  status: "ok" | "unavailable" | "error";
}

/** A tool call as a visitor may see it: which tool, and whether it worked. */
export function publicToolCalls(calls: unknown): PublicToolCall[] {
  if (!Array.isArray(calls)) return [];
  const out: PublicToolCall[] = [];
  for (const call of calls) {
    const name = (call as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || name.length === 0) continue;
    const status = (call as { status?: unknown }).status;
    out.push({
      name: name.slice(0, 64),
      // The detail (an unavailable reason, an error message) can name
      // configuration; it stays with the owner.
      status: status === "ok" || status === "unavailable" ? status : "error",
    });
  }
  return out;
}

const encoder = new TextEncoder();
const event = (payload: unknown) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
const DONE = encoder.encode("data: [DONE]\n\n");

/** A provider that never sends a newline must not grow the buffer unbounded. */
const MAX_LINE_CHARS = 1_000_000;

export function toPublicStream(chat: ChatStream): ChatStream {
  const decoder = new TextDecoder();
  let buffer = "";
  let errored = false;

  const line = (text: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!text.startsWith("data:")) return;
    const data = text.slice(5).trim();
    if (data === "[DONE]") {
      controller.enqueue(DONE);
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof json !== "object" || json === null) return;
    const chunk = json as {
      error?: unknown;
      choices?: unknown;
      wheelsai?: { toolCalls?: unknown } | null;
    };

    if (chunk.error !== undefined && chunk.error !== null) {
      // Said once, in our words. Whatever follows a provider error is not an
      // answer.
      if (!errored) controller.enqueue(event({ error: PUBLIC_MODEL_ERROR }));
      errored = true;
      return;
    }
    if (errored) return;

    const toolCalls = publicToolCalls(chunk.wheelsai?.toolCalls);
    if (toolCalls.length > 0) controller.enqueue(event({ wheelsai: { toolCalls } }));

    const choice = Array.isArray(chunk.choices)
      ? (chunk.choices[0] as { delta?: { content?: unknown } | null; finish_reason?: unknown } | undefined)
      : undefined;
    if (!choice) return;
    const content = choice.delta?.content;
    const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : null;
    const hasContent = typeof content === "string" && content.length > 0;
    if (!hasContent && !finishReason) return;
    controller.enqueue(
      event({
        choices: [
          {
            delta: hasContent ? { content } : {},
            ...(finishReason && { finish_reason: finishReason }),
          },
        ],
      }),
    );
  };

  const drain = (controller: TransformStreamDefaultController<Uint8Array>, final: boolean) => {
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      line(buffer.slice(0, newline).replace(/\r$/, ""), controller);
      buffer = buffer.slice(newline + 1);
    }
    if (final && buffer.length > 0) {
      line(buffer.replace(/\r$/, ""), controller);
      buffer = "";
    }
    if (buffer.length > MAX_LINE_CHARS) buffer = "";
  };

  const stream = chat.stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        buffer += decoder.decode(bytes, { stream: true });
        drain(controller, false);
      },
      flush(controller) {
        buffer += decoder.decode();
        drain(controller, true);
      },
    }),
  );

  // The same outcome: billing and the transcript follow what the runtime
  // saw, not what a visitor was shown of it.
  return { stream, outcome: chat.outcome };
}
