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
 */

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
  usage: TokenUsage;
  finishReason?: string | null;
}

export interface CallModelRequest {
  messages: ModelMessage[];
  tools?: ToolSpec[];
  toolChoice?: "auto" | "none";
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
  tools: ToolSpec[];
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
  usage: TokenUsage;
  /** Rounds of tool use performed (0 when the model answered directly). */
  rounds: number;
  toolCalls: ToolCallRecord[];
  finishReason: string | null;
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

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
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
  const messages: ModelMessage[] = [...args.messages];
  const toolCalls: ToolCallRecord[] = [];
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  const tools = args.tools.length > 0 ? args.tools : undefined;

  const answer = (turn: ModelTurn, rounds: number): ToolLoopResult => {
    if (turn.content.trim().length === 0) {
      throw new EmptyModelAnswerError(turn.finishReason);
    }
    return {
      content: turn.content,
      usage,
      rounds,
      toolCalls,
      finishReason: turn.finishReason ?? null,
    };
  };

  for (let round = 1; round <= maxRounds; round++) {
    if (signal?.aborted) throw abortError();
    const turn = await args.callModel({ messages, tools, toolChoice: "auto", signal });
    usage = addUsage(usage, turn.usage);

    if (turn.toolCalls.length === 0) return answer(turn, round - 1);

    messages.push({
      role: "assistant",
      content: turn.content.length > 0 ? turn.content : null,
      tool_calls: turn.toolCalls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.arguments },
      })),
    });

    for (const [index, call] of turn.toolCalls.entries()) {
      let text: string;
      let record: ToolCallRecord;

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
  }

  // The model is still asking for tools after the last allowed round: make
  // one final call that forbids tools so it has to answer from what it has.
  if (signal?.aborted) throw abortError();
  const last = await args.callModel({ messages, tools, toolChoice: "none", signal });
  usage = addUsage(usage, last.usage);
  if (last.toolCalls.length > 0) throw new ToolLoopExhaustedError(maxRounds);
  return answer(last, maxRounds);
}
