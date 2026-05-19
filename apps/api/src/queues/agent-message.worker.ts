/**
 * agent-message worker tick (plan A6).
 *
 * One call = one inbound message handled end-to-end:
 *   1. Resolve the deployment's outbound channel credentials (bot token etc.)
 *      and the OpenClaw node URL.
 *   2. POST the inbound message to `{nodeUrl}/message` so the running agent
 *      can reason and return a reply.
 *   3. If the agent produced text, build the platform-specific outbound
 *      request and fetch it.
 *   4. Return a DeliveryResult describing what happened. Failures that
 *      should be retried by BullMQ are thrown.
 *
 * Every IO surface is injected so unit tests run without Redis, fetch, or
 * a live OpenClaw container.
 */

import {
  buildReplyForPlatform,
  type OutboundCredentials,
} from "../services/channelDispatch.js";
import { classifyDispatchFailure } from "../services/dispatchRetryPolicy.js";
import type { AgentMessageJobPayload } from "./agent-message.queue.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("agent-message-worker");

export interface AgentReply {
  text: string;
  threadTs?: string;
}

export interface OutboundBinding {
  nodeUrl: string;
  credentials: OutboundCredentials;
}

export interface WorkerDeps {
  callAgent: (
    nodeUrl: string,
    payload: AgentMessageJobPayload,
  ) => Promise<AgentReply>;
  resolveOutboundCredentials: (
    deploymentId: string,
    platform: string,
  ) => Promise<OutboundBinding | null>;
  fetchFn: typeof fetch;
}

export type DeliveryResult =
  | { status: "delivered"; platformStatus: number }
  | {
      status: "skipped";
      reason: "no_channel_config" | "empty_reply";
    }
  | {
      status: "poison_dropped";
      reason: "auth_failed" | "missing_access" | "channel_gone" | "user_blocked_bot";
    };

export async function handleAgentMessage(
  payload: AgentMessageJobPayload,
  deps: WorkerDeps,
): Promise<DeliveryResult> {
  const binding = await deps.resolveOutboundCredentials(
    payload.deploymentId,
    payload.platform,
  );
  if (!binding) {
    logger.info(
      { deploymentId: payload.deploymentId, platform: payload.platform },
      "no outbound channel config; dropping",
    );
    return { status: "skipped", reason: "no_channel_config" };
  }

  let reply: AgentReply;
  try {
    reply = await deps.callAgent(binding.nodeUrl, payload);
  } catch (err) {
    logger.warn(
      { err, deploymentId: payload.deploymentId },
      "agent call failed; BullMQ will retry",
    );
    throw new Error(
      `agent_call_failed: ${(err as Error).message ?? "unknown"}`,
      { cause: err as Error },
    );
  }

  if (!reply.text || reply.text.trim() === "") {
    return { status: "skipped", reason: "empty_reply" };
  }

  const threadTs =
    reply.threadTs ??
    (payload.platform === "slack" ? payload.message.messageId : undefined);

  const req = buildReplyForPlatform({
    platform: payload.platform,
    credentials: binding.credentials,
    channelId: payload.message.channelId,
    text: reply.text,
    threadTs,
  });

  const res = await deps.fetchFn(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });

  // Slack returns 200 with {ok:false, error:...} for app-level failures, so we
  // always inspect the body and let the classifier decide. Grab the body text
  // up front; it's small and we may need it for both success and failure
  // logging paths.
  const bodyText = await res.text().catch(() => "");
  const headers = readResponseHeaders(res);

  const classification = classifyDispatchFailure({
    platform: payload.platform,
    status: res.status,
    body: bodyText,
    headers,
  });

  switch (classification.outcome) {
    case "no_failure":
      return { status: "delivered", platformStatus: res.status };

    case "poison":
      logger.warn(
        {
          deploymentId: payload.deploymentId,
          platform: payload.platform,
          status: res.status,
          reason: classification.reason,
          bodySnippet: bodyText.slice(0, 200),
        },
        "platform dispatch poisoned; dropping without retry",
      );
      return { status: "poison_dropped", reason: classification.reason };

    case "rate_limited":
      logger.warn(
        {
          deploymentId: payload.deploymentId,
          platform: payload.platform,
          retryAfterMs: classification.retryAfterMs,
        },
        "platform rate-limited; surfacing retry-after for BullMQ",
      );
      throw Object.assign(
        new Error(
          `rate_limited: ${payload.platform} retry after ${classification.retryAfterMs}ms`,
        ),
        { retryAfterMs: classification.retryAfterMs },
      );

    case "retriable":
      logger.warn(
        {
          deploymentId: payload.deploymentId,
          platform: payload.platform,
          status: res.status,
          reason: classification.reason,
          bodySnippet: bodyText.slice(0, 200),
        },
        "platform dispatch failed; BullMQ will retry",
      );
      throw new Error(
        `platform_dispatch_failed: ${payload.platform} returned ${res.status}`,
      );
  }
}

function readResponseHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  // Headers may be a Headers instance, a plain object, or our test stub.
  const h = (res as unknown as { headers?: unknown }).headers;
  if (!h) return out;
  if (typeof (h as Headers).forEach === "function") {
    (h as Headers).forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (typeof (h as { get?: (k: string) => string | null }).get === "function") {
    const get = (h as { get: (k: string) => string | null }).get;
    for (const k of ["retry-after"]) {
      const v = get.call(h, k);
      if (v != null) out[k] = v;
    }
    return out;
  }
  if (typeof h === "object") {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
      if (typeof v === "string") out[k.toLowerCase()] = v;
    }
  }
  return out;
}
