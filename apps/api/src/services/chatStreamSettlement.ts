/**
 * Forwards a chat stream to a client and settles marketplace billing on what
 * actually happened.
 *
 * The old playground code settled as soon as the byte loop finished, which
 * billed the buyer for streams that carried a provider error event (an HTTP
 * 200 stream can embed one) and for streams that ended with no answer at all.
 * Settlement now follows the stream's OUTCOME: a real answer settles, anything
 * else - provider error, empty answer, truncated stream, client gone - refunds.
 */

import type { ServerResponse } from "node:http";

import type { ChatStream, StreamOutcome } from "./mastra-runtime.js";

export const CLIENT_GONE = "client disconnected before the answer was delivered";

/**
 * An AbortController that fires when the client goes away - INCLUDING when it
 * already has.
 *
 * `close` is emitted once. A client that hangs up while an earlier hook is
 * still awaiting (auth, the rate limiter) has already had its `close` by the
 * time a route handler runs, so a listener attached there never fires and the
 * run would carry on, and bill, for nobody. Nothing has been written at that
 * point, so a destroyed response can only mean the client left.
 *
 * Call it before the handler's first await.
 */
export function abortOnClientClose(res: ServerResponse): AbortController {
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });
  if (res.destroyed) abort.abort();
  return abort;
}

/**
 * Watches whether a streamed answer reaches the client. Call it BEFORE the
 * first write; the returned function is `forwardAndSettle`'s `delivered`.
 *
 * `finish` on a live socket = every byte was handed to the OS; `close` before
 * that = the client left first. Two things Node does make the obvious check
 * wrong, and both used to bill for an answer nobody received:
 *
 *   - a response that is already destroyed emits neither event, ever again,
 *     and write()/end() on it do not throw. That case is answered up front
 *     instead of being left to the timeout, which read it as "delivered";
 *   - end() on a socket that died a moment ago still emits `finish` and sets
 *     `writableFinished`, though the bytes went nowhere. So `finish` only
 *     counts while the socket it was written to is still alive.
 */
export function watchDelivery(
  res: ServerResponse,
  clientGone: AbortSignal,
  // A slow reader must not hold the billing decision open forever.
  timeoutMs = 5_000,
): () => Promise<boolean> {
  const flushed = new Promise<boolean>((resolve) => {
    if (res.destroyed) {
      resolve(false);
      return;
    }
    // Held now: the response lets go of its socket once it finishes.
    const socket = res.socket;
    res.once("finish", () => resolve(socket ? !socket.destroyed : true));
    res.once("close", () => resolve(false));
  });
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finished = await Promise.race([
      flushed,
      new Promise<boolean>((resolve) => {
        // Still open and still draining is a slow reader, which is billed.
        timer = setTimeout(() => resolve(!res.destroyed), timeoutMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    return finished && !clientGone.aborted;
  };
}

export interface SettleableMeter {
  settle(): Promise<void>;
  refund(reason: string): Promise<void>;
}

export async function forwardAndSettle(args: {
  chat: ChatStream;
  /** Write one chunk to the client; may throw when the client is gone. */
  write: (chunk: Uint8Array) => void;
  /** End the client response. Called before billing so the client is not kept waiting. */
  end: () => void;
  /**
   * Whether the answer actually reached the client. A write to a closed socket
   * does not throw (Node returns false), and a tool-using chat produces its
   * whole answer before the first byte is sent, so "the provider finished" says
   * nothing about delivery. Checked after the stream ends; when it returns
   * false the buyer is refunded even though an answer was generated.
   * Omitted means "assume delivered".
   */
  delivered?: () => boolean | Promise<boolean>;
  meter: SettleableMeter | null;
}): Promise<StreamOutcome> {
  const reader = args.chat.stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      try {
        args.write(value);
      } catch {
        // The client went away mid-stream: stop pulling from the provider.
        // Cancelling makes the outcome a failure, so the buyer is refunded.
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch {
    // The stream errored; its outcome already records why.
  } finally {
    reader.releaseLock();
    args.end();
  }

  let outcome = await args.chat.outcome;
  if (outcome.ok && args.delivered && !(await args.delivered())) {
    outcome = {
      ok: false,
      error: CLIENT_GONE,
      toolCalls: outcome.toolCalls,
    };
  }
  if (outcome.ok) {
    await args.meter?.settle();
  } else {
    await args.meter?.refund(outcome.error);
  }
  return outcome;
}
