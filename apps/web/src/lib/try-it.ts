/**
 * What Try it tells a visitor when the server refuses. Pure: the panel
 * passes the status and body of the refusal, and shows what comes back.
 *
 * The server's refusals already say nothing internal (services/publicChat.ts
 * has its own vocabulary); this file only chooses what the visitor can do
 * next.
 */

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

export function tryItNotice(status: number, body: TryItRefusalBody | null, now: Date = new Date()): TryItNotice {
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
          ? "Your network changed, so this preview session ended. Start a new one to keep chatting."
          : "This preview session ended. Start a new one to keep chatting.",
      action: "session",
      ended: false,
    };
  }
  if (code === "turnstile_required") return { message: "Complete the check to start chatting.", action: "none", ended: false };
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
          ? `This agent's free previews are used up for today. They start again in ${wait(seconds)}. You can still install or hire it.`
          : "This agent's free previews are used up for today. You can still install or hire it.",
      action: "none",
      ended: true,
    };
  }
  if (status === 429) {
    if (scope === "session") {
      return {
        message: "You have used every message in this preview. Install or hire the agent to keep going.",
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
    return { message: "This agent answers through a graph, which cannot be previewed yet.", action: "none", ended: true };
  }
  if (status === 400 || status === 413) {
    const message = typeof body?.message === "string" && body.message ? body.message : "That message could not be sent.";
    return { message, action: "none", ended: false };
  }
  if (status === 503) {
    return {
      message:
        code === "rate_limiter_unavailable"
          ? "Previews are switched off for a moment because their limits cannot be counted. Try again shortly."
          : "This agent is not available right now. Try again shortly.",
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
    return "This agent answers through a graph of steps, which cannot be previewed yet. You can install it or hire it for a task instead.";
  }
  if (reason === "no_model_available") {
    return "Previews run on a free model that WheelsAI provides, and none is available on this server right now.";
  }
  return "This agent cannot be previewed right now.";
}
