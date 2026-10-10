/**
 * An answer that is held until it is complete and has been checked.
 *
 * A paid answer must not repeat the instructions of the agent that wrote it
 * (services/assertions.ts, detectInstructionLeak). A check like that needs
 * the whole answer, and a stream that has already sent half of it cannot
 * take the half back. So nothing is forwarded while the runtime streams:
 * `holdUntilChecked` buffers the stream's bytes, and only when the stream
 * has ended does it ask `accept` about the text.
 *
 *   accepted   the buffered answer is released whole: as `text`, and as a
 *              stream that carries every buffered byte in one piece, with
 *              the runtime's own outcome.
 *   refused    nothing of the answer is released. The outcome becomes a
 *              failure whose error is ANSWER_WITHHELD (`code:
 *              "answer_withheld"` here), and the stream is one error event.
 *   upstream   the runtime's stream failed, or was aborted: its outcome
 *              passes through as it is, `accept` is never asked, and
 *              nothing of a partial answer is released.
 *
 * The text that is checked is read from the stream's own bytes. The
 * outcome's `content` is cut at STREAM_CONTENT_KEPT_CHARS
 * (services/mastra-runtime.ts), so checking it would let anything past
 * that point through unread.
 *
 * Pure: bytes in, bytes out.
 */

import type { ChatStream, StreamOutcome } from "../services/mastra-runtime.js";

/** The error of an outcome whose answer was produced and not released. */
export const ANSWER_WITHHELD = "answer_withheld";

/**
 * The most a held answer may be. An answer is bounded by the agent's
 * max_tokens, so this only stops a misbehaving provider from growing the
 * process; an answer past it is not released.
 */
export const HELD_ANSWER_MAX_BYTES = 8 * 1024 * 1024;

type AnsweredOutcome = Extract<StreamOutcome, { ok: true }>;
type FailedOutcome = Extract<StreamOutcome, { ok: false }>;

export type HeldAnswer =
  | {
      ok: true;
      /** The whole answer, as it was checked. */
      text: string;
      /** The runtime's outcome, with `content` the whole text. */
      outcome: AnsweredOutcome;
      /** Every buffered byte in one piece, and the outcome above. */
      chat: ChatStream;
    }
  | {
      ok: false;
      /** `answer_withheld`: produced, checked and refused. `upstream`: the runtime's own failure. */
      code: "answer_withheld" | "upstream";
      outcome: FailedOutcome;
      /** One error event; never a byte of the answer. */
      chat: ChatStream;
    };

const encoder = new TextEncoder();

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function errorStream(code: string): ReadableStream<Uint8Array> {
  return streamOf([encoder.encode(`data: ${JSON.stringify({ error: { code } })}\n\ndata: [DONE]\n\n`)]);
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  const whole = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    whole.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return whole;
}

/** The answer text of an OpenAI-format SSE body: every content delta, in order. */
export function answerTextOf(body: Uint8Array): string {
  const text = new TextDecoder().decode(body);
  let answer = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]" || data.length === 0) continue;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    const choices = (json as { choices?: unknown } | null)?.choices;
    if (!Array.isArray(choices)) continue;
    const content = (choices[0] as { delta?: { content?: unknown } | null } | undefined)?.delta?.content;
    if (typeof content === "string") answer += content;
  }
  return answer;
}

/**
 * Reads `chat` to its end, then asks `accept` about the whole answer. Not
 * one byte of the answer leaves before `accept` has said yes. Never throws:
 * an `accept` that throws has not accepted.
 */
export async function holdUntilChecked(
  chat: ChatStream,
  accept: (text: string) => boolean | Promise<boolean>,
): Promise<HeldAnswer> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  let tooLarge = false;

  const reader = chat.stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > HELD_ANSWER_MAX_BYTES) {
        tooLarge = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  } catch {
    // The stream errored; its outcome records why.
  } finally {
    reader.releaseLock();
  }

  const outcome = await chat.outcome;

  const failed = (code: "answer_withheld" | "upstream", failure: FailedOutcome): HeldAnswer => ({
    ok: false,
    code,
    outcome: failure,
    chat: { stream: errorStream(code === "upstream" ? "model_error" : ANSWER_WITHHELD), outcome: Promise.resolve(failure) },
  });

  // The runtime's own failure, or an abort: as it is.
  if (!outcome.ok) return failed("upstream", outcome);
  if (tooLarge) {
    return failed("upstream", {
      ok: false,
      error: "the answer was too large to check",
      toolCalls: outcome.toolCalls,
      code: "truncated",
    });
  }

  const body = concat(chunks, length);
  const text = answerTextOf(body);
  let accepted = false;
  try {
    accepted = (await accept(text)) === true;
  } catch {
    accepted = false;
  }
  if (!accepted) {
    return failed("answer_withheld", { ok: false, error: ANSWER_WITHHELD, toolCalls: outcome.toolCalls });
  }

  const released: AnsweredOutcome = { ...outcome, content: text };
  return {
    ok: true,
    text,
    outcome: released,
    chat: { stream: streamOf([body]), outcome: Promise.resolve(released) },
  };
}
