import {
  ApiError,
  paidUseApi,
  paidUseRefusalOf,
  paidWorkflowApi,
  type PaidUseAccessState,
  type PaidUseBilling,
  type PaidUseRefusal,
} from "@/lib/api";
import {
  PAID_USE_MESSAGES,
  agentPagePath,
  chargeLine,
  paidRefusalNotice,
  runTimeNote,
  taskDraftKey,
  workflowAccessAsAgent,
  workflowDraftKey,
  workflowPagePath,
  type PaidNotice,
  type PaidRefusedAct,
  type PaidSubject,
  type PaidUnit,
} from "@/lib/paid-use";
import type { ChatTurn } from "@/lib/public-use";
import {
  newSessionId,
  type PanelNotice,
  type PublicChatTransport,
  type PublicTaskTransport,
  type PublicUseEvent,
} from "./transport";

/**
 * The paid ways a panel reaches what is sold: an agent by its handle, or a
 * workflow on sale by its listing's slug, with the signed-in person's
 * session, paid from their credits. The answer arrives whole, so a send
 * yields it in one piece and then what it cost.
 */
export interface PaidTransportHooks {
  /** What one use is on this page. */
  unit: PaidUnit;
  /** What the page sells, for the words of a refusal. An agent unless it says. */
  subject?: PaidSubject;
  /** Why the person cannot use it right now, as the page already knows it; null when they can. */
  heldBack(): PanelNotice | null;
  /** A refusal as the panel shows it, with its action wired to the page. */
  toPanel(notice: PaidNotice): PanelNotice;
  /** Called after every use, answered or refused: the page reads the access again. */
  onUsed(): void;
  /** Called with what an answer cost. On a plan it carries the count after this use, so the page asks for nothing more. */
  onBilled?(billing: PaidUseBilling): void;
  /** Called with the body of a refused use: a plan that ended or is used up says where the person now stands. */
  onRefused?(refusal: PaidUseRefusal): void;
  /**
   * A run that can be stopped: called with false when one is sent, and with true when it was cancelled
   * (Stop, or the page closing) before its answer came. The page says what that means in its own words.
   */
  onStopped?(stopped: boolean): void;
}

/** The hooks of an agent's page: its chat and its run go by the agent's handle. */
export interface PaidAgentTransportHooks extends PaidTransportHooks {
  /** The name in the page's address, `/a/<handle>`. */
  handle: string;
}

/** A send the page stopped before it went: nothing was asked of the API and nothing charged. */
class HeldBack extends Error {
  constructor(readonly notice: PanelNotice) {
    super("held back");
    this.name = "HeldBack";
  }
}

function explainAs(hooks: PaidTransportHooks, act: PaidRefusedAct) {
  return (error: unknown): PanelNotice => {
    if (error instanceof HeldBack) return error.notice;
    if (error instanceof ApiError) {
      const refusal = paidUseRefusalOf(error);
      if (refusal) hooks.onRefused?.(refusal);
      return hooks.toPanel(paidRefusalNotice({ status: error.status, refusal, act, unit: hooks.unit, subject: hooks.subject }));
    }
    return hooks.toPanel(paidRefusalNotice({ status: 0, refusal: null, act, unit: hooks.unit, subject: hooks.subject }));
  };
}

/** One paid request: held back by the page, or sent, and either way the access is read again after. */
async function* paidSend<Result extends { billing: PaidUseBilling }>(
  hooks: PaidTransportHooks,
  call: () => Promise<Result>,
  read: (result: Result) => { text: string; line: string },
): AsyncGenerator<PublicUseEvent, void, unknown> {
  const held = hooks.heldBack();
  if (held) throw new HeldBack(held);
  let result: Result;
  try {
    result = await call();
  } finally {
    hooks.onUsed();
  }
  hooks.onBilled?.(result.billing);
  const { text, line } = read(result);
  yield { type: "delta", content: text };
  yield { type: "charged", line };
  yield { type: "done" };
}

export function paidChatTransport(hooks: PaidAgentTransportHooks): PublicChatTransport {
  let sessionId: string | null = null;
  return {
    send(messages: ChatTurn[]) {
      sessionId ??= newSessionId();
      const id = sessionId;
      return paidSend(
        hooks,
        () => paidUseApi.chat(hooks.handle, { messages, sessionId: id }),
        (result) => ({ text: result.message.content, line: chargeLine(result.billing, hooks.unit) }),
      );
    },
    explain: explainAs(hooks, "chat"),
    waitingLabel: PAID_USE_MESSAGES.waiting,
  };
}

export function paidTaskTransport(hooks: PaidAgentTransportHooks): PublicTaskTransport {
  return {
    send: (input: Record<string, unknown>) =>
      paidSend(
        hooks,
        () => paidUseApi.run(hooks.handle, { input }),
        (result) => ({ text: result.output.text, line: chargeLine(result.billing, hooks.unit) }),
      ),
    explain: explainAs(hooks, "task"),
    waitingLabel: PAID_USE_MESSAGES.waiting,
  };
}

/**
 * The paid run of a workflow on sale, by its listing's slug. The body is the
 * form's answers and nothing else. A run can take minutes, so it can be
 * stopped: the panel shows Stop while it runs (this transport has no waiting
 * label), and Stop, or the page closing, cancels the request and with it the
 * run. The API gives back what it took for a run whose answer was not
 * delivered; the page reads the credits again after every run, stopped or not.
 */
export function paidWorkflowTransport(slug: string, hooks: PaidTransportHooks): PublicTaskTransport {
  return {
    send: (input: Record<string, unknown>, signal: AbortSignal) =>
      paidSend(
        hooks,
        async () => {
          hooks.onStopped?.(false);
          try {
            return await paidWorkflowApi.run(slug, { input }, signal);
          } catch (error) {
            // A cancelled request rejects with the browser's abort error, never with the API's answer.
            if (signal.aborted) hooks.onStopped?.(true);
            throw error;
          }
        },
        ({ output, billing }) => ({ text: output.text, line: chargeLine(billing, hooks.unit) }),
      ),
    explain: explainAs(hooks, "task"),
  };
}

// ============================================
// The door: how the gate reaches what is sold
// ============================================

/**
 * What the gate needs to know of the thing it sells, as data: how to read
 * the person's access, how the form is run, the page's own path (sign-in and
 * sign-up come back to it), the key the form's unsent answers are kept under,
 * and the subject its sentences are worded for. The gate draws the same
 * price, plans, start, count and form for both.
 */
export interface PaidDoor {
  subject: PaidSubject;
  /** The page's own path: `/a/<handle>` or `/w/<slug>`. */
  path: string;
  /** Where the form's unsent answers are kept while the person signs in. */
  draftKey: string;
  /** Where the signed-in person stands, in the shape the gate draws. */
  readAccess(): Promise<PaidUseAccessState>;
  /** The paid way the form is run. */
  taskTransport(hooks: PaidTransportHooks): PublicTaskTransport;
  /**
   * An agent's own: its handle (its chat, its results and the recheck of a pause go by it) and its name,
   * and the free try on its listing's page. Null on a workflow's page, which has none of them.
   */
  agent: { handle: string; name: string } | null;
  /** Said under the form, after the privacy sentence; null on an agent's page, which says it above. */
  runNote: string | null;
}

/** An agent's door: today's calls by its handle, and an agent's words. */
export function agentDoor(handle: string, name: string): PaidDoor {
  return {
    subject: "agent",
    path: agentPagePath(handle),
    draftKey: taskDraftKey(handle),
    readAccess: () => paidUseApi.access(handle),
    taskTransport: (hooks) => paidTaskTransport({ ...hooks, handle }),
    agent: { handle, name },
    runNote: null,
  };
}

/**
 * A workflow's door, by its listing's slug: its access (its owner read as the
 * owner's case), its paid run, its page `/w/<slug>`, and the longest a run
 * may take, as the public read said it.
 */
export function workflowDoor(slug: string, maxRunMinutes: number): PaidDoor {
  return {
    subject: "workflow",
    path: workflowPagePath(slug),
    draftKey: workflowDraftKey(slug),
    readAccess: async () => workflowAccessAsAgent(await paidWorkflowApi.access(slug)),
    taskTransport: (hooks) => paidWorkflowTransport(slug, { ...hooks, subject: "workflow" }),
    agent: null,
    runNote: runTimeNote(maxRunMinutes),
  };
}
