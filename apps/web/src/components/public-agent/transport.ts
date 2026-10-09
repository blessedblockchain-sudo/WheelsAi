import { ApiError, publicUseApi } from "@/lib/api";
import {
  publicOfflineNotice,
  publicUseNotice,
  type ChatTurn,
  type PublicUseNotice,
  type PublicUseRefusalBody,
} from "@/lib/public-use";
import type { SseChatEvent } from "@/lib/sse";

/**
 * How a panel on an agent's public page reaches the agent. A panel draws the
 * same way whoever pays: it is handed one of these, sends through it, and
 * asks it what to say when a send is refused. This file holds the free ones,
 * over the page's publishable key with no sign-in and no cookies.
 */
export interface PublicTransport<Payload> {
  /** The answer as a stream of events. A refusal throws before the first event. */
  send(payload: Payload, signal: AbortSignal): AsyncIterable<SseChatEvent>;
  /** What to tell the visitor about something `send` threw. */
  explain(error: unknown): PublicUseNotice;
}

/** The conversation so far, ending with the visitor's new message. */
export type PublicChatTransport = PublicTransport<ChatTurn[]>;

/** A task form's answers. */
export type PublicTaskTransport = PublicTransport<Record<string, unknown>>;

function explainAs(kind: "chat" | "task") {
  return (error: unknown): PublicUseNotice => {
    if (error instanceof ApiError) {
      const body = typeof error.data === "object" && error.data !== null ? (error.data as PublicUseRefusalBody) : null;
      return publicUseNotice(error.status, body, kind);
    }
    return publicOfflineNotice();
  };
}

/** Groups one visit's messages when the owner keeps a copy; random, and never shown. */
function newSessionId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function freeChatTransport(publicKey: string): PublicChatTransport {
  let sessionId: string | null = null;
  return {
    send(messages, signal) {
      sessionId ??= newSessionId();
      return publicUseApi.chat(publicKey, { messages, sessionId }, signal);
    },
    explain: explainAs("chat"),
  };
}

export function freeTaskTransport(publicKey: string): PublicTaskTransport {
  return {
    send: (input, signal) => publicUseApi.run(publicKey, { input }, signal),
    explain: explainAs("task"),
  };
}
