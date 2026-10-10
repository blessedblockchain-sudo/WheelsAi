import { ApiError, paidUseApi, paidUseRefusalOf } from "@/lib/api";
import {
  PAID_USE_MESSAGES,
  chargeLine,
  paidRefusalNotice,
  type PaidNotice,
  type PaidRefusedAct,
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
 * The paid ways a panel reaches an agent: by the agent's handle, with the
 * signed-in person's session, paid from their credits. The answer arrives
 * whole, so a send yields it in one piece and then what it cost.
 */
export interface PaidTransportHooks {
  /** The name in the page's address, `/a/<handle>`. */
  handle: string;
  /** What one use is on this page. */
  unit: PaidUnit;
  /** Why the person cannot use the agent right now, as the page already knows it; null when they can. */
  heldBack(): PanelNotice | null;
  /** A refusal as the panel shows it, with its action wired to the page. */
  toPanel(notice: PaidNotice): PanelNotice;
  /** Called after every use, answered or refused: the page reads the access again. */
  onUsed(): void;
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
      return hooks.toPanel(
        paidRefusalNotice({ status: error.status, refusal: paidUseRefusalOf(error), act, unit: hooks.unit }),
      );
    }
    return hooks.toPanel(paidRefusalNotice({ status: 0, refusal: null, act, unit: hooks.unit }));
  };
}

/** One paid request: held back by the page, or sent, and either way the access is read again after. */
async function* paidSend<Result>(
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
  const { text, line } = read(result);
  yield { type: "delta", content: text };
  yield { type: "charged", line };
  yield { type: "done" };
}

export function paidChatTransport(hooks: PaidTransportHooks): PublicChatTransport {
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

export function paidTaskTransport(hooks: PaidTransportHooks): PublicTaskTransport {
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
