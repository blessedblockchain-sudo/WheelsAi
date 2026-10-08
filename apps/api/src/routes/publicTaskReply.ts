/**
 * How a public task run's result (services/publicTask.ts) becomes an HTTP
 * response. A refusal and a stream are sent exactly as a public chat's are
 * (routes/publicChatReply.ts: the same bodies, the same Retry-After, the
 * same heartbeat for idle proxies); only the JSON answer differs, because a
 * run gives back one result, not a message of a conversation.
 */

import type { FastifyReply } from "fastify";

import type { PublicTaskResult } from "../services/publicTask.js";
import { sendPublicChatResult } from "./publicChatReply.js";

export async function sendPublicTaskResult(
  reply: FastifyReply,
  result: PublicTaskResult,
  abort: AbortController,
): Promise<FastifyReply | void> {
  if (result.kind !== "result") return sendPublicChatResult(reply, result, abort);
  reply.header("cache-control", "no-store");
  return reply.status(200).send({ output: result.output, toolCalls: result.toolCalls });
}
