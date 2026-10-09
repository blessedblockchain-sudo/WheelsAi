/**
 * What an agent's public page tells a visitor when the server refuses a chat
 * message or a task run, and what a chat may send. Pure: a panel passes the
 * status and body of the refusal (or the error event of a stream) and shows
 * the sentence that comes back.
 *
 * The sentences are chosen here from the refusal's code, never copied from
 * the server's wording, so a visitor reads the same plain words for a chat
 * and for a task and never a word about how the page is built.
 */

/** A refusal body as it arrived; nothing about it is trusted to be there. */
export interface PublicUseRefusalBody {
  error?: unknown;
  message?: unknown;
  reason?: unknown;
  scope?: unknown;
  retryAfterSeconds?: unknown;
  details?: unknown;
}

/** Which panel was refused: the wording of a few sentences depends on it. */
export type PublicUseKind = "chat" | "task";

export interface PublicUseNotice {
  /** One sentence for the visitor. */
  message: string;
  /** A task's answers that need another look: the question's key to its sentence. "" is the form as a whole. */
  fields: Record<string, string>;
  /** How long to wait before trying again, when the server said. */
  retryAfterSeconds: number | null;
  /** Public use has stopped: the panel gives way to the paused sentence. */
  paused: boolean;
}

export const PUBLIC_USE_MESSAGES = {
  noCharge: "You are not charged for using this page.",
  transcriptsStored: "What you send here is saved by this agent's owner.",
  paused: "This agent is paused. Its owner has turned off public use for now.",
  resultsPrivate: "This agent runs on its own. Its results are not shown publicly.",
  noResults: "No results yet.",
  visitorLimit: "You have reached the limit for now.",
  dayLimit: "This agent has reached its limit for today. Try again tomorrow.",
  busy: "This agent is getting a lot of use right now.",
  answersTooLong: "Your answers are too long. Shorten them and try again.",
  messageTooLong: "Your message is too long. Shorten it and try again.",
  answersInvalid: "Some answers need another look.",
  usageLimit: "This agent has reached its usage limit for now. Please try again later.",
  couldNotAnswer: "The agent could not answer just now. Please try again.",
  unavailable: "This agent is not available right now. Please try again later.",
  restarting: "The agent is restarting. Try again in a moment.",
  pageUnavailable: "This page is temporarily unavailable. Try again shortly.",
  wrongPlace: "This agent cannot be used from this page.",
  changed: "This agent has changed. Reload the page and try again.",
  chatUnreadable: "That message could not be sent. Start a new chat and try again.",
  answersUnreadable: "Your answers could not be read. Check them and try again.",
  offline: "The agent could not be reached. Check your connection and try again.",
  unknown: "Something went wrong. Please try again.",
} as const;

/** A wait in words: "45 seconds", "4 minutes", "2 hours". Always rounded up. */
export function waitInWords(seconds: number): string {
  const whole = Math.max(1, Math.ceil(seconds));
  if (whole < 60) return `${whole} second${whole === 1 ? "" : "s"}`;
  const minutes = Math.ceil(whole / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

function tryAgainIn(retry: number | null): string {
  return retry !== null ? `Try again in ${waitInWords(retry)}.` : "Try again in a moment.";
}

/** A 422's details as field key to sentence; several about one question are joined. */
function fieldsOf(details: unknown): Record<string, string> {
  const fields: Record<string, string> = {};
  if (!Array.isArray(details)) return fields;
  for (const detail of details) {
    if (typeof detail !== "object" || detail === null) continue;
    const { field, message } = detail as { field?: unknown; message?: unknown };
    if (typeof message !== "string" || message.trim() === "") continue;
    const key = typeof field === "string" ? field : "";
    fields[key] = fields[key] ? `${fields[key]} ${message}` : message;
  }
  return fields;
}

/** The sentence for a refused chat message or task run. */
export function publicUseNotice(status: number, body: PublicUseRefusalBody | null, kind: PublicUseKind): PublicUseNotice {
  const code = typeof body?.error === "string" ? body.error : "";
  const reason = typeof body?.reason === "string" ? body.reason : "";
  const scope = typeof body?.scope === "string" ? body.scope : "";
  const retry =
    typeof body?.retryAfterSeconds === "number" && body.retryAfterSeconds > 0 ? Math.ceil(body.retryAfterSeconds) : null;
  const notice = (message: string, extra: Partial<PublicUseNotice> = {}): PublicUseNotice => ({
    message,
    fields: {},
    retryAfterSeconds: null,
    paused: false,
    ...extra,
  });

  if (status === 429) {
    if (scope === "key") {
      // The page's own budgets: a minute's worth, or the day's. Only the
      // day's asks for a wait longer than a minute.
      if (retry !== null && retry > 60) return notice(PUBLIC_USE_MESSAGES.dayLimit, { retryAfterSeconds: retry });
      return notice(`${PUBLIC_USE_MESSAGES.busy} ${tryAgainIn(retry)}`, { retryAfterSeconds: retry });
    }
    return notice(`${PUBLIC_USE_MESSAGES.visitorLimit} ${tryAgainIn(retry)}`, { retryAfterSeconds: retry });
  }
  if (status === 413) {
    return notice(kind === "task" ? PUBLIC_USE_MESSAGES.answersTooLong : PUBLIC_USE_MESSAGES.messageTooLong);
  }
  if (status === 422) return notice(PUBLIC_USE_MESSAGES.answersInvalid, { fields: fieldsOf(body?.details) });
  // A key that is switched off is as unknown as a wrong one: the link was
  // paused or turned off after this page loaded.
  if (status === 404) return notice(PUBLIC_USE_MESSAGES.paused, { paused: true });
  if (status === 403) return notice(PUBLIC_USE_MESSAGES.wrongPlace);
  if (status === 409) return notice(PUBLIC_USE_MESSAGES.changed);
  if (status === 400) {
    return notice(kind === "task" ? PUBLIC_USE_MESSAGES.answersUnreadable : PUBLIC_USE_MESSAGES.chatUnreadable);
  }
  if (status === 503) {
    if (code === "rate_limiter_unavailable") return notice(PUBLIC_USE_MESSAGES.pageUnavailable, { retryAfterSeconds: retry });
    if (reason === "quota_exhausted") return notice(PUBLIC_USE_MESSAGES.usageLimit);
    if (reason === "restarting") return notice(PUBLIC_USE_MESSAGES.restarting, { retryAfterSeconds: retry });
    return notice(PUBLIC_USE_MESSAGES.unavailable);
  }
  if (status === 502) return notice(PUBLIC_USE_MESSAGES.couldNotAnswer);
  return notice(PUBLIC_USE_MESSAGES.unknown);
}

/**
 * The sentence for a failure reported inside a stream that had started. The
 * event's own text is never shown: it can be a provider's.
 */
export function publicStreamNotice(_event?: { message?: string; code?: string | null }): PublicUseNotice {
  return { message: PUBLIC_USE_MESSAGES.couldNotAnswer, fields: {}, retryAfterSeconds: null, paused: false };
}

/** The sentence for a request that never got an answer at all (no network, a blocked request). */
export function publicOfflineNotice(): PublicUseNotice {
  return { message: PUBLIC_USE_MESSAGES.offline, fields: {}, retryAfterSeconds: null, paused: false };
}

// ============================================
// What a chat may send
// ============================================

export interface PublicChatLimits {
  maxMessages: number;
  maxMessageChars: number;
  maxTotalChars: number;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * The end of a conversation that fits the page's limits: the newest turns,
 * at most `maxMessages` of them and `maxTotalChars` characters together. The
 * last turn (the visitor's new message) is always kept; older turns fall off
 * the front, so a long chat goes on instead of being refused.
 */
export function chatWindow(turns: readonly ChatTurn[], limits: PublicChatLimits): ChatTurn[] {
  const kept: ChatTurn[] = [];
  let total = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (turn.content.length === 0) continue;
    const isLast = kept.length === 0;
    if (!isLast && (kept.length >= limits.maxMessages || total + turn.content.length > limits.maxTotalChars)) break;
    kept.unshift(turn);
    total += turn.content.length;
  }
  return kept;
}

/** Whether a task's answers are over the page's limit together, before anything is sent. */
export function answersTooLong(input: Record<string, unknown>, maxInputChars: number): boolean {
  let total = 0;
  const count = (value: unknown): void => {
    if (typeof value === "string") total += [...value].length;
    else if (typeof value === "number" || typeof value === "boolean") total += String(value).length;
    else if (Array.isArray(value)) value.forEach(count);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(count);
  };
  count(input);
  return total > maxInputChars;
}

/** A result's date as a visitor reads it: "12 Oct 2026, 09:00". "" when it is not a date. */
export function resultDate(iso: string, locale?: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
}
