import assert from "node:assert/strict";
import test from "node:test";

import {
  EmptyModelAnswerError,
  runToolLoop,
  ToolLoopExhaustedError,
  type CallModel,
  type CallModelRequest,
  type ModelTurn,
} from "../services/toolLoop.js";
import type { SkillResult, ToolSpec } from "../services/skills/types.js";

// Drives services/toolLoop.ts with a SCRIPTED model: no provider, no
// network. The properties under test are the bounds (4 rounds, output cap,
// per-call limits) and that every way a tool call can go wrong comes back to
// the model as a readable string instead of crashing the chat.

const turn = (over: Partial<ModelTurn> = {}): ModelTurn => ({
  content: "",
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 5 },
  finishReason: "stop",
  ...over,
});

const call = (name: string, args: unknown = {}, id = `id_${name}`) => ({
  id,
  name,
  arguments: typeof args === "string" ? args : JSON.stringify(args),
});

const spec = (name: string): ToolSpec => ({
  type: "function",
  function: {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
  },
});

function scripted(turns: ModelTurn[]) {
  const requests: CallModelRequest[] = [];
  const callModel: CallModel = async (req) => {
    // Snapshot: the loop keeps appending to the same array.
    requests.push({ ...req, messages: [...req.messages] });
    const next = turns[requests.length - 1];
    if (!next) throw new Error("model was called more often than scripted");
    return next;
  };
  return { callModel, requests };
}

const ok = (output: string): SkillResult => ({ status: "ok", output });

test("a direct answer makes one model call and runs no tools", async () => {
  const { callModel, requests } = scripted([turn({ content: "hello" })]);
  const result = await runToolLoop({
    messages: [{ role: "user", content: "hi" }],
    tools: [spec("calculator")],
    callModel,
    executeTool: async () => assert.fail("no tool should run"),
  });
  assert.equal(result.content, "hello");
  assert.equal(result.rounds, 0);
  assert.equal(requests.length, 1);
  assert.deepEqual(result.toolCalls, []);
});

test("a tool call on round 1 and content on round 2 yields the answer", async () => {
  const { callModel, requests } = scripted([
    turn({ toolCalls: [call("calculator", { expression: "17*23" })] }),
    turn({ content: "17 x 23 = 391" }),
  ]);
  const seen: Array<[string, unknown]> = [];
  const result = await runToolLoop({
    messages: [{ role: "user", content: "what is 17*23?" }],
    tools: [spec("calculator")],
    callModel,
    executeTool: async (name, input) => {
      seen.push([name, input]);
      return ok("391");
    },
  });

  assert.equal(result.content, "17 x 23 = 391");
  assert.equal(result.rounds, 1);
  assert.deepEqual(seen, [["calculator", { expression: "17*23" }]]);
  assert.deepEqual(result.toolCalls, [
    { round: 1, name: "calculator", status: "ok", detail: null },
  ]);
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 10 }, "usage sums across rounds");

  // The second request carries the assistant tool call AND its result.
  const second = requests[1]!.messages;
  assert.equal(second.at(-2)!.role, "assistant");
  assert.equal(second.at(-2)!.tool_calls![0]!.function.name, "calculator");
  assert.deepEqual(second.at(-1), { role: "tool", tool_call_id: "id_calculator", content: "391" });
});

test("tool rounds are capped at four, then the model is forced to answer", async () => {
  const toolTurn = () => turn({ toolCalls: [call("calculator", { expression: "1+1" })] });
  const { callModel, requests } = scripted([
    toolTurn(),
    toolTurn(),
    toolTurn(),
    toolTurn(),
    turn({ content: "final answer" }),
  ]);
  let executed = 0;
  const result = await runToolLoop({
    messages: [{ role: "user", content: "loop forever" }],
    tools: [spec("calculator")],
    callModel,
    executeTool: async () => {
      executed++;
      return ok("2");
    },
  });
  assert.equal(executed, 4);
  assert.equal(requests.length, 5);
  assert.equal(requests[3]!.toolChoice, "auto");
  assert.equal(requests[4]!.toolChoice, "none", "the last call forbids tools");
  assert.equal(result.content, "final answer");
});

test("a model that still asks for tools after the cap is an error, not a guess", async () => {
  const toolTurn = () => turn({ toolCalls: [call("calculator", { expression: "1" })] });
  const { callModel } = scripted([toolTurn(), toolTurn(), toolTurn(), toolTurn(), toolTurn()]);
  await assert.rejects(
    runToolLoop({
      messages: [{ role: "user", content: "x" }],
      tools: [spec("calculator")],
      callModel,
      executeTool: async () => ok("1"),
    }),
    ToolLoopExhaustedError,
  );
});

test("an unknown tool is an error message to the model, not a crash", async () => {
  const { callModel, requests } = scripted([
    turn({ toolCalls: [call("launch_missiles", {})] }),
    turn({ content: "I do not have that tool." }),
  ]);
  const result = await runToolLoop({
    messages: [{ role: "user", content: "x" }],
    tools: [spec("calculator")],
    callModel,
    executeTool: async () => assert.fail("must not execute an unlisted tool"),
  });
  const toolMessage = requests[1]!.messages.at(-1)!;
  assert.match(toolMessage.content!, /unknown tool "launch_missiles"/);
  assert.match(toolMessage.content!, /Available tools: calculator/);
  assert.equal(result.toolCalls[0]!.status, "unknown");
  assert.equal(result.content, "I do not have that tool.");
});

test("invalid JSON arguments come back as an error string", async () => {
  const { callModel, requests } = scripted([
    turn({ toolCalls: [call("calculator", "{not json")] }),
    turn({ content: "retrying" }),
  ]);
  const result = await runToolLoop({
    messages: [{ role: "user", content: "x" }],
    tools: [spec("calculator")],
    callModel,
    executeTool: async () => assert.fail("bad arguments must not reach the tool"),
  });
  assert.match(requests[1]!.messages.at(-1)!.content!, /^error: the arguments are not valid JSON/);
  assert.equal(result.toolCalls[0]!.status, "error");
});

test("empty arguments are treated as an empty object", async () => {
  const { callModel } = scripted([
    turn({ toolCalls: [call("file_read", "")] }),
    turn({ content: "done" }),
  ]);
  let received: unknown;
  await runToolLoop({
    messages: [{ role: "user", content: "x" }],
    tools: [spec("file_read")],
    callModel,
    executeTool: async (_n, input) => {
      received = input;
      return ok("files");
    },
  });
  assert.deepEqual(received, {});
});

test("unavailable and error results are rendered honestly for the model", async () => {
  const { callModel, requests } = scripted([
    turn({ toolCalls: [call("web_search", { query: "x" }, "a"), call("calculator", {}, "b")] }),
    turn({ content: "ok" }),
  ]);
  const result = await runToolLoop({
    messages: [{ role: "user", content: "x" }],
    tools: [spec("web_search"), spec("calculator")],
    callModel,
    executeTool: async (name) =>
      name === "web_search"
        ? { status: "unavailable", reason: "web search is not configured on this server" }
        : { status: "error", message: "bad expression" },
  });
  const toolMessages = requests[1]!.messages.filter((m) => m.role === "tool");
  assert.equal(toolMessages[0]!.content, "unavailable: web search is not configured on this server");
  assert.equal(toolMessages[1]!.content, "error: bad expression");
  assert.deepEqual(
    result.toolCalls.map((c) => [c.name, c.status, c.detail]),
    [
      ["web_search", "unavailable", "web search is not configured on this server"],
      ["calculator", "error", "bad expression"],
    ],
  );
});

test("tool output is clipped before it is fed back", async () => {
  const { callModel, requests } = scripted([
    turn({ toolCalls: [call("http_request", { url: "x" })] }),
    turn({ content: "ok" }),
  ]);
  await runToolLoop({
    messages: [{ role: "user", content: "x" }],
    tools: [spec("http_request")],
    callModel,
    maxToolOutputChars: 100,
    executeTool: async () => ok("A".repeat(5_000)),
  });
  const fed = requests[1]!.messages.at(-1)!.content!;
  assert.ok(fed.length < 200, `fed back ${fed.length} chars`);
  assert.match(fed, /\[truncated 4900 chars\]$/);
});

test("calls beyond the per-round limit are refused but still answered", async () => {
  const calls = Array.from({ length: 4 }, (_, i) => call("calculator", {}, `c${i}`));
  const { callModel, requests } = scripted([turn({ toolCalls: calls }), turn({ content: "ok" })]);
  let executed = 0;
  await runToolLoop({
    messages: [{ role: "user", content: "x" }],
    tools: [spec("calculator")],
    callModel,
    maxCallsPerRound: 2,
    executeTool: async () => {
      executed++;
      return ok("1");
    },
  });
  assert.equal(executed, 2);
  const toolMessages = requests[1]!.messages.filter((m) => m.role === "tool");
  assert.equal(toolMessages.length, 4, "every tool_call id gets a result, or the provider rejects the turn");
  assert.match(toolMessages[3]!.content!, /too many tool calls/);
});

test("a tool that hangs is timed out and reported", async () => {
  const { callModel, requests } = scripted([
    turn({ toolCalls: [call("http_request", { url: "x" })] }),
    turn({ content: "gave up" }),
  ]);
  const result = await runToolLoop({
    messages: [{ role: "user", content: "x" }],
    tools: [spec("http_request")],
    callModel,
    toolTimeoutMs: 30,
    executeTool: () => new Promise<SkillResult>(() => {}),
  });
  assert.match(requests[1]!.messages.at(-1)!.content!, /timed out after 30ms/);
  assert.equal(result.content, "gave up");
});

test("an empty final answer is an error that names the finish reason", async () => {
  const { callModel } = scripted([turn({ content: "  ", finishReason: "length" })]);
  await assert.rejects(
    runToolLoop({
      messages: [{ role: "user", content: "x" }],
      tools: [],
      callModel,
      executeTool: async () => ok(""),
    }),
    (err: unknown) => {
      assert.ok(err instanceof EmptyModelAnswerError);
      assert.match((err as Error).message, /finish_reason: length/);
      return true;
    },
  );
});

test("a pre-aborted signal stops the loop before any model call", async () => {
  const controller = new AbortController();
  controller.abort();
  const { callModel, requests } = scripted([turn({ content: "never" })]);
  await assert.rejects(
    runToolLoop({
      messages: [{ role: "user", content: "x" }],
      tools: [],
      callModel,
      signal: controller.signal,
      executeTool: async () => ok(""),
    }),
    (err: unknown) => (err as Error).name === "AbortError",
  );
  assert.equal(requests.length, 0);
});

test("aborting during a tool call cancels the run", async () => {
  const controller = new AbortController();
  const { callModel } = scripted([
    turn({ toolCalls: [call("http_request", { url: "x" })] }),
    turn({ content: "never" }),
  ]);
  const running = runToolLoop({
    messages: [{ role: "user", content: "x" }],
    tools: [spec("http_request")],
    callModel,
    signal: controller.signal,
    executeTool: (_n, _i, signal) =>
      new Promise<SkillResult>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(running, (err: unknown) => (err as Error).name === "AbortError");
});
