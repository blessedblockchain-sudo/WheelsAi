/**
 * What Try it tells a visitor when the server refuses. Pure: the panel
 * passes the status and body of the refusal, and shows what comes back.
 *
 * The server's refusals already say nothing internal (services/publicChat.ts
 * has its own vocabulary); this file only chooses what the visitor can do
 * next.
 */

import { inputAsText, runLineOf, type TaskField } from "@wheelsai/shared/agent-kind";

import { PUBLIC_USE_MESSAGES } from "./public-use";
import { fieldsFromSchema } from "./schema-form";

export interface TryItRefusalBody {
  error?: unknown;
  message?: unknown;
  reason?: unknown;
  scope?: unknown;
  retryAfterSeconds?: unknown;
  resetsAt?: unknown;
}

export interface TryItNotice {
  message: string;
  /** `session` = a fresh session may fix it; `signin` = show the sign-in link. */
  action: "none" | "session" | "signin";
  /** The preview is over for now: stop offering the input. */
  ended: boolean;
}

function wait(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * What a visitor does once a preview is used up: install or hire for a
 * listing that sells copies, use it on its page for one that sells use.
 */
export function previewUsedUpLine(sells?: "use" | "copies" | null): string {
  return sells === "use"
    ? "You have used every message in this preview. Use the agent on its page to keep going."
    : "You have used every message in this preview. Install or hire the agent to keep going.";
}

export function tryItNotice(
  status: number,
  body: TryItRefusalBody | null,
  now: Date = new Date(),
  sells?: "use" | "copies" | null,
): TryItNotice {
  const stillCan = sells === "use" ? "You can still use it on its page." : "You can still install or hire it.";
  const code = typeof body?.error === "string" ? body.error : "";
  const reason = typeof body?.reason === "string" ? body.reason : "";
  const scope = typeof body?.scope === "string" ? body.scope : "";
  const retry =
    typeof body?.retryAfterSeconds === "number" && body.retryAfterSeconds > 0 ? Math.ceil(body.retryAfterSeconds) : null;

  if (code === "signin_required" || (code === "trial_session_invalid" && reason === "signin_required")) {
    return { message: "Sign in to try this agent.", action: "signin", ended: true };
  }
  if (code === "trial_session_invalid") {
    return {
      message:
        reason === "network_changed"
          ? "Your network changed, so this preview session ended. Start a new one to keep going."
          : "This preview session ended. Start a new one to keep going.",
      action: "session",
      ended: false,
    };
  }
  if (code === "turnstile_required") return { message: "Complete the check to start.", action: "none", ended: false };
  if (code === "turnstile_failed") {
    return { message: "The check did not pass. Reload the page and try it again, or sign in.", action: "signin", ended: false };
  }
  if (code === "turnstile_unavailable") {
    return { message: "The check could not be made right now. Try again shortly, or sign in.", action: "signin", ended: false };
  }
  if (code === "trial_cap_reached") {
    const resets = typeof body?.resetsAt === "string" ? new Date(body.resetsAt) : null;
    const seconds = resets && !Number.isNaN(resets.getTime()) ? Math.ceil((resets.getTime() - now.getTime()) / 1000) : null;
    return {
      message:
        seconds !== null && seconds > 0
          ? `This agent's free previews are used up for today. They start again in ${wait(seconds)}. ${stillCan}`
          : `This agent's free previews are used up for today. ${stillCan}`,
      action: "none",
      ended: true,
    };
  }
  if (status === 429) {
    if (scope === "session") {
      return {
        message: previewUsedUpLine(sells),
        action: "none",
        ended: true,
      };
    }
    const when = retry !== null ? ` Try again in ${wait(retry)}.` : " Try again in a moment.";
    return {
      message: scope === "global" ? `Previews are busy right now.${when}` : `You are sending messages too quickly.${when}`,
      action: "none",
      ended: false,
    };
  }
  if (status === 404) return { message: "This listing is no longer available.", action: "none", ended: true };
  if (status === 501) {
    return {
      message: "This agent answers through a graph, so Try it cannot preview it. Install it to chat with it.",
      action: "none",
      ended: true,
    };
  }
  if (status === 400 || status === 413) {
    const message = typeof body?.message === "string" && body.message ? body.message : "That message could not be sent.";
    return { message, action: "none", ended: false };
  }
  if (status === 503) {
    return {
      message:
        code === "rate_limiter_unavailable"
          ? "Previews are temporarily unavailable. Try again shortly."
          : "This agent is not available right now. Try again shortly.",
      action: "none",
      ended: false,
    };
  }
  if (code === "answer_withheld") {
    return {
      message: typeof body?.message === "string" && body.message ? body.message : "This answer could not be shown. Try asking in another way.",
      action: "none",
      ended: false,
    };
  }
  if (status === 502) return { message: "The agent could not answer just now. Try again.", action: "none", ended: false };
  return { message: "Something went wrong. Try again.", action: "none", ended: false };
}

/** Why a listing has no preview at all. */
export function tryItDisabledMessage(reason: string | null): string {
  if (reason === "graph_agent_preview") {
    return "This agent answers through a graph of steps, so Try it cannot preview it. You can install it or hire it for a task instead.";
  }
  if (reason === "no_model_available") {
    return "Previews run on a free model that WheelsAI provides, which is temporarily unavailable. Try again later.";
  }
  return "This agent cannot be previewed right now.";
}

// ============================================
// What the panel draws, and what it sends
// ============================================

/** `chat`: a conversation. `form`: the agent's form and one result. `sample`: one button and one result. */
export type TryItMode = "chat" | "form" | "sample";

/**
 * Which of the three the panel draws for a listing's agent. A task agent
 * whose form cannot be drawn (no schema, or one with no questions) is
 * tried as a chat: a typed message is what its default form asks for.
 */
export function tryItMode(agentKind: string | null | undefined, inputSchema: unknown): TryItMode {
  if (agentKind === "scheduled") return "sample";
  if (agentKind === "task") return fieldsFromSchema(inputSchema).freeform ? "chat" : "form";
  return "chat";
}

/**
 * A form's answers as the one message Try it sends, worded as a run of the
 * agent words them (inputAsText): each answer under its question's label,
 * in the form's order, unanswered questions left out, and a form with one
 * question is just its answer. "" when nothing was answered.
 */
export function tryItFormMessage(inputSchema: unknown, input: Record<string, unknown> | null | undefined): string {
  const fields: TaskField[] = fieldsFromSchema(inputSchema).fields.map((field) => ({
    key: field.name,
    label: field.title,
    type: "short_text",
    required: field.required,
  }));
  return inputAsText(fields, input);
}

/** The one message "Run a sample" sends: what a self-running agent is told at each run. */
export function tryItSampleMessage(): string {
  return runLineOf(null);
}

export const TRY_IT_WORDS = {
  runSample: "Run a sample",
  useListing:
    "This sample runs on a free model that WheelsAI provides. The agent itself may use a different model, so its answers can differ.",
  answersInvalid: PUBLIC_USE_MESSAGES.answersInvalid,
  answersTooLong: PUBLIC_USE_MESSAGES.answersTooLong,
  answersEmpty: "Answer at least one question to run it.",
  formHint: "Fill in the form to see what the agent gives back.",
  sampleHint: "This agent runs on its own. Run a sample to see what it produces.",
} as const;

/** The sentence under the heading on a listing that sells use; null on any other listing. */
export function tryItUseSentence(sells: "use" | "copies" | null | undefined): string | null {
  return sells === "use" ? TRY_IT_WORDS.useListing : null;
}

/**
 * What stands in the way of sending a form's answers: null when the message
 * can go. `maxMessageChars` is the server's limit for one message.
 */
export function tryItFormProblem(message: string, maxMessageChars: number): string | null {
  if (message.trim() === "") return TRY_IT_WORDS.answersEmpty;
  if (message.length > maxMessageChars) return TRY_IT_WORDS.answersTooLong;
  return null;
}
