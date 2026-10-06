/**
 * The tool loop: the model asks for tools, we run them, feed the results
 * back, and repeat until it answers in plain text.
 *
 * This is deliberately provider-agnostic. The model call is injected
 * (`callModel`), so the same loop drives every OpenAI-compatible provider and
 * is unit-testable with a scripted model. It is always NON-streaming:
 * streaming callers run the rounds here and then emit only the final answer
 * (see mastra-runtime.ts), which is why a streamed reply can no longer come
 * back empty when the model reaches for a tool.
 *
 * Bounds, all explicit:
 *   - at most `maxRounds` (4) rounds of tool use; if the model is still asking
 *     after that, one last call is made with tool_choice "none" to force an
 *     answer, and if it STILL asks for tools that is an error, not a guess
 *   - at most `maxCallsPerRound` calls honoured per round
 *   - every tool result is clipped before it is fed back, so one noisy tool
 *     cannot blow the context window
 *   - every call has a wall-clock timeout on top of the skill's own
 *   - an unknown tool, bad JSON arguments or a thrown skill is an error STRING
 *     handed back to the model, never a crash
 *
 * Client tools (OpenAI function calling): a caller may offer functions that IT
 * executes. Those are named in `clientToolNames`. When a model turn calls one,
 * the loop runs that turn's server calls as usual and then stops, handing the
 * client calls back (`clientToolCalls`) together with the transcript of what
 * happened server-side, so the conversation can be resumed when the caller
 * returns the results. A client call is never executed here and never
 * answered "unknown tool".
 */

import { randomUUID } from "node:crypto";

import { clipText } from "./skills/httpLimits.js";
import {
  skillResultToText,
  type SkillResult,
  type ToolSpec,
} from "./skills/types.js";

export const DEFAULT_MAX_TOOL_ROUNDS = 4;
export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 8_000;
export const DEFAULT_MAX_CALLS_PER_ROUND = 8;
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

export interface ModelToolCall {
  id: string;
  name: string;
  /** Raw JSON text, exactly as the model produced it. */
  arguments: string;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelTurn {
  content: string;
  toolCalls: ModelToolCall[];
  /** null when the provider reported no usage for this call. */
  usage: TokenUsage | null;
  finishReason?: string | null;
}

/** A function tool as offered to the model: a skill's spec or a caller's. */
export interface OfferedTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: object;
    strict?: boolean;
  };
}

export type ModelToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface CallModelRequest {
  messages: ModelMessage[];
  tools?: OfferedTool[];
  toolChoice?: ModelToolChoice;
  signal?: AbortSignal;
}

export type CallModel = (request: CallModelRequest) => Promise<ModelTurn>;

export interface ToolCallRecord {
  round: number;
  name: string;
  status: "ok" | "unavailable" | "error" | "unknown";
  /** Short, UI-safe note: the unavailable reason or the error message. */
  detail: string | null;
}

export interface ToolLoopArgs {
  messages: ModelMessage[];
  /** Server-side tools: the agent's skills, executed by `executeTool`. */
  tools: ToolSpec[];
  /** Functions the CALLER executes. Offered to the model, never run here. */
  clientTools?: OfferedTool[];
  /**
   * The caller's tool_choice. Applies to the FIRST model call only: forcing
   * a function on every round would loop on it until the rounds ran out.
   */
  toolChoice?: ModelToolChoice;
  /** Test seam; ids are `call_<32 hex>` by default. */
  newCallId?: () => string;
  executeTool: (name: string, input: unknown, signal?: AbortSignal) => Promise<SkillResult>;
  callModel: CallModel;
  maxRounds?: number;
  maxToolOutputChars?: number;
  maxCallsPerRound?: number;
  toolTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface ToolLoopResult {
  content: string;
  /** Summed over every model call; a call that reported none adds zero. */
  usage: TokenUsage;
  /**
   * The same sum, or null when ANY model call reported no usage. Callers that
   * show or bill usage read this one: a partial sum is not the usage.
   */
  reportedUsage: TokenUsage | null;
  /** Rounds of tool use performed (0 when the model answered directly). */
  rounds: number;
  toolCalls: ToolCallRecord[];
  finishReason: string | null;
  /**
   * Non-empty when the loop stopped to hand calls back to the caller. Then
   * `content` may be empty and `finishReason` is "tool_calls".
   */
  clientToolCalls: ModelToolCall[];
  /**
   * Every message this run appended to the conversation it was given: the
   * assistant turns that asked for tools and the server tool results. On a
   * hand-back, its last assistant turn lists server AND client calls; the
   * caller only ever sees the client ones.
   */
  transcript: ModelMessage[];
}

/** The model produced no answer text (e.g. it spent max_tokens reasoning). */
export class EmptyModelAnswerError extends Error {
  constructor(finishReason?: string | null) {
    super(
      `the model returned no answer${finishReason ? ` (finish_reason: ${finishReason})` : ""}`,
    );
    this.name = "EmptyModelAnswerError";
  }
}

/** The model kept requesting tools past the round limit. */
export class ToolLoopExhaustedError extends Error {
  constructor(rounds: number) {
    super(`the model kept requesting tools after ${rounds} rounds and never produced an answer`);
    this.name = "ToolLoopExhaustedError";
  }
}

function addUsage(a: TokenUsage, b: TokenUsage | null): TokenUsage {
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/** 37 characters: OpenAI rejects a tool_call_id longer than 40. */
function defaultCallId(): string {
  return `call_${randomUUID().replace(/-/g, "")}`;
}

function parseArguments(raw: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const text = raw.trim();
  if (text.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return {
      ok: false,
      message: `the arguments are not valid JSON (${err instanceof Error ? err.message : "parse error"})`,
    };
  }
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

/**
 * Runs `fn` under a timeout, propagating the parent's cancellation. The timer
 * is a real (ref'd) timeout that is always cleared: `AbortSignal.timeout` is
 * unref'd, which lets a script's event loop exit while a hung tool is still
 * pending.
 */
async function runWithTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = parent
    ? AbortSignal.any([parent, timeoutController.signal])
    : timeoutController.signal;

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return { timedOut: false, value: await Promise.race([fn(signal), aborted]) };
  } catch (err) {
    if (parent?.aborted) throw err;
    if (timeoutController.signal.aborted) return { timedOut: true };
    throw err;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function runToolLoop(args: ToolLoopArgs): Promise<ToolLoopResult> {
  const maxRounds = args.maxRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  const maxOutputChars = args.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  const maxCalls = args.maxCallsPerRound ?? DEFAULT_MAX_CALLS_PER_ROUND;
  const toolTimeoutMs = args.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const { signal } = args;

  const enabled = new Set(args.tools.map((t) => t.function.name));
  const clientNames = new Set((args.clientTools ?? []).map((t) => t.function.name));
  const newCallId = args.newCallId ?? defaultCallId;
  const messages: ModelMessage[] = [...args.messages];
  const given = messages.length;
  const toolCalls: ToolCallRecord[] = [];
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let usageReported = true;

  const offered: OfferedTool[] = [...args.tools, ...(args.clientTools ?? [])];
  const tools = offered.length > 0 ? offered : undefined;

  const count = (turn: ModelTurn) => {
    usage = addUsage(usage, turn.usage);
    if (!turn.usage) usageReported = false;
  };

  const result = (
    turn: ModelTurn,
    rounds: number,
    clientToolCalls: ModelToolCall[],
  ): ToolLoopResult => ({
    content: turn.content,
    usage,
    reportedUsage: usageReported ? usage : null,
    rounds,
    toolCalls,
    finishReason: clientToolCalls.length > 0 ? "tool_calls" : (turn.finishReason ?? null),
    clientToolCalls,
    transcript: messages.slice(given),
  });

  const answer = (turn: ModelTurn, rounds: number): ToolLoopResult => {
    if (turn.content.trim().length === 0) {
      throw new EmptyModelAnswerError(turn.finishReason);
    }
    return result(turn, rounds, []);
  };

  for (let round = 1; round <= maxRounds; round++) {
    if (signal?.aborted) throw abortError();
    const raw = await args.callModel({
      messages,
      tools,
      toolChoice: round === 1 ? (args.toolChoice ?? "auto") : "auto",
      signal,
    });
    count(raw);

    if (raw.toolCalls.length === 0) return answer(raw, round - 1);

    // Providers reuse ids ("call_1"), send empty ones, and repeat them
    // across conversations. A handed-back call is looked up by its id when
    // the caller returns the result, so every call gets one of ours.
    const turn: ModelTurn = {
      ...raw,
      toolCalls: raw.toolCalls.map((c) => ({ ...c, id: newCallId() })),
    };

    messages.push({
      role: "assistant",
      content: turn.content.length > 0 ? turn.content : null,
      tool_calls: turn.toolCalls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.arguments },
      })),
    });

    const clientCalls = turn.toolCalls.filter((c) => clientNames.has(c.name));

    for (const [index, call] of turn.toolCalls.entries()) {
      let text: string;
      let record: ToolCallRecord;

      // The caller runs this one; its result arrives in the next request.
      if (clientNames.has(call.name)) continue;

      if (index >= maxCalls) {
        text = `error: too many tool calls in one round (the limit is ${maxCalls}); this call was not run`;
        record = { round, name: call.name, status: "error", detail: "too many calls in one round" };
      } else if (!enabled.has(call.name)) {
        text = `error: unknown tool "${call.name}". Available tools: ${[...enabled].join(", ") || "none"}`;
        record = { round, name: call.name, status: "unknown", detail: "not an enabled tool" };
      } else {
        const parsed = parseArguments(call.arguments);
        if (!parsed.ok) {
          text = `error: ${parsed.message}`;
          record = { round, name: call.name, status: "error", detail: parsed.message };
        } else {
          const outcome = await runWithTimeout(
            (toolSignal) => args.executeTool(call.name, parsed.value, toolSignal),
            toolTimeoutMs,
            signal,
          );
          if (outcome.timedOut) {
            text = `error: the tool timed out after ${toolTimeoutMs}ms`;
            record = { round, name: call.name, status: "error", detail: "timed out" };
          } else {
            const result = outcome.value;
            text = skillResultToText(result);
            record = {
              round,
              name: call.name,
              status: result.status,
              detail:
                result.status === "unavailable"
                  ? result.reason
                  : result.status === "error"
                    ? result.message
                    : null,
            };
          }
        }
      }

      toolCalls.push(record);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: clipText(text, maxOutputChars),
      });
    }

    // The turn's server calls have run; the rest is the caller's to do. An
    // empty content here is normal - the answer comes after their results.
    if (clientCalls.length > 0) return result(turn, round, clientCalls);
  }

  // The model is still asking for tools after the last allowed round: make
  // one final call that forbids tools so it has to answer from what it has.
  if (signal?.aborted) throw abortError();
  const last = await args.callModel({ messages, tools, toolChoice: "none", signal });
  count(last);
  if (last.toolCalls.length > 0) throw new ToolLoopExhaustedError(maxRounds);
  return answer(last, maxRounds);
}
