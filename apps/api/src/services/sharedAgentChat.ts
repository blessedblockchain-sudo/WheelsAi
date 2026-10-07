/**
 * The agent-chat call every non-interactive caller shares: scheduled tasks,
 * "trigger now", workflow steps, batch jobs, the test runner and paid jobs
 * (Offerings and Jobs).
 *
 * It is NOT a second chat implementation. It hands the prompt to
 * prepareAgentChat (services/agentChat.ts), the core behind the playground
 * and /v1, and turns that core's answers into what these callers expect: a
 * `{ content, usage }` on success, a thrown Error carrying the reason
 * otherwise. So model resolution (an organization's own hosted model and a
 * graph-entrypoint agent included), the free-tier limiter, marketplace
 * metering, the tool mode, usage recording and registration for shutdown are
 * the core's, in the core's order, and cannot differ from an interactive
 * chat's.
 *
 * What is this caller's own:
 *   - the source ("scheduled", "job", "test" or "hired"), which is the tool
 *     mode's base and what the usage row is filed under;
 *   - for a paid job ("hired") only: the offering's private instructions and
 *     tool allowlist. Any other mode that brings them is refused, so private
 *     instructions can never ride into a run whose tools are not restricted;
 *   - the limit on how long the chat may take. A caller that passes a signal
 *     bounds the run itself (a task's timeout can be an hour), so the core's
 *     interactive deadline is switched off; a caller that passes none keeps it.
 *
 * Pure: every effect is in the AgentChatDeps it is given.
 */

import {
  prepareAgentChat,
  SHUTTING_DOWN,
  type AgentChatDeps,
  type AgentChatFailure,
  type AgentChatRefusal,
  type AgentChatSource,
} from "./agentChat.js";
import type { ExecuteScheduledTaskDeps } from "./executeScheduledTask.js";
import {
  MarketplaceLicenceRevokedError,
  MarketplacePaymentRequiredError,
} from "./marketplaceMetering.js";
import type { ToolMode } from "./skills/types.js";

export const FREE_TIER_LIMIT_MESSAGE =
  "free-model limit reached for this org; retry later or use your own provider key";

/** The modes a run with nobody watching may ask for. */
const SOURCE_OF_MODE: Partial<Record<ToolMode, AgentChatSource>> = {
  scheduled: "scheduled",
  job: "job",
  test: "test",
  hired: "hired",
};

function aborted(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError");
}

/** The Error a caller records for a chat that was refused before it ran. */
function refusalError(
  refusal: AgentChatRefusal,
  agentId: string,
  signal: AbortSignal | undefined,
): Error {
  switch (refusal.kind) {
    case "agent_not_found":
      return new Error(`agent ${agentId} not found in this organization`);
    case "rate_limited":
      return new Error(FREE_TIER_LIMIT_MESSAGE);
    // The same typed errors a graph run throws, so a caller that tells a
    // billing refusal from a failed run sees one shape for both.
    case "licence_revoked":
      return new MarketplaceLicenceRevokedError(refusal.listingTitle, refusal.revocation, refusal.token);
    case "payment_required":
      return new MarketplacePaymentRequiredError({
        requiredCents: refusal.requiredCents,
        balanceCents: refusal.balanceCents,
        listingTitle: refusal.listingTitle,
      });
    case "shutting_down":
      return new Error(SHUTTING_DOWN);
    case "client_gone":
      return aborted(signal);
    default:
      return new Error(refusal.message);
  }
}

function failureError(failure: AgentChatFailure, signal: AbortSignal | undefined): Error {
  // The caller's own timeout or cancel: it must see its abort, not a failed
  // model call it would go on to retry.
  if (failure.code === "client_gone") return aborted(signal);
  return new Error(failure.message);
}

export function createRunAgentChat(
  /** A getter is called on first use, so building an executor opens nothing. */
  deps: AgentChatDeps | (() => AgentChatDeps),
): ExecuteScheduledTaskDeps["runAgentChat"] {
  let built: AgentChatDeps | null = typeof deps === "function" ? null : deps;
  const chatDeps = () => (built ??= (deps as () => AgentChatDeps)());

  return async ({ agent, prompt, mode, signal, systemAddendum, toolAllowlist }) => {
    const source = SOURCE_OF_MODE[mode ?? "scheduled"];
    if (!source) {
      throw new Error(`agent runs without a client cannot use the "${mode}" tool mode`);
    }
    if (source !== "hired" && (systemAddendum !== undefined || toolAllowlist !== undefined)) {
      throw new Error(`job instructions and a tool allowlist apply to hired runs only, not "${source}"`);
    }

    const prepared = await prepareAgentChat(
      {
        orgId: agent.orgId,
        agent: { id: agent.id },
        caller: "owner",
        source,
        messages: [{ role: "user", content: prompt }],
        signal: signal ?? new AbortController().signal,
        ...(signal && { deadlineMs: null }),
        ...(systemAddendum && { systemAddendum }),
        ...(toolAllowlist && toolAllowlist.length > 0 && { toolAllowlist }),
      },
      chatDeps(),
    );
    if (!prepared.ok) throw refusalError(prepared.refusal, agent.id, signal);

    const completed = await prepared.session.complete();
    if (!completed.ok) {
      throw completed.refusal
        ? refusalError(completed.refusal, agent.id, signal)
        : failureError(completed.failure, signal);
    }
    // Only what the provider reported: a graph run, or a provider that sent no
    // count, has no usage - which is not the same as zero tokens.
    return {
      content: completed.result.content,
      ...(completed.result.reportedUsage && { usage: completed.result.reportedUsage }),
      // What a paid job meters: which model answered, and on whose keys.
      model: prepared.session.modelId,
      platformModel: prepared.session.platformModel,
      toolCallCount: completed.result.toolCalls?.length ?? 0,
    };
  };
}
