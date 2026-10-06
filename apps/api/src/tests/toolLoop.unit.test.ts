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
  // The result answers the id the loop assigned, not the provider's own.
  const assignedId = second.at(-2)!.tool_calls![0]!.id;
  assert.match(assignedId, /^call_[0-9a-f]{32}$/);
  assert.deepEqual(second.at(-1), { role: "tool", tool_call_id: assignedId, content: "391" });
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

// ============================================
// Client tools (OpenAI function calling)
// ============================================

const clientTool = (name: string) => ({
  type: "function" as const,
  function: { name, description: `${name} (runs on the caller's side)` },
});

test("a client tool call ends the loop and is returned, never executed or reported unknown", async () => {
  const { callModel, requests } = scripted([
    turn({ toolCalls: [call("get_weather", { city: "Lagos" })], finishReason: "tool_calls" }),
  ]);
  const result = await runToolLoop({
    messages: [{ role: "user", content: "weather in Lagos?" }],
    tools: [spec("calculator")],
    clientTools: [clientTool("get_weather")],
    callModel,
    executeTool: async () => assert.fail("a client tool is never executed server-side"),
  });

  assert.equal(requests.length, 1, "the loop stops: the caller has to act next");
  assert.deepEqual(
    result.clientToolCalls.map((c) => [c.name, c.arguments]),
    [["get_weather", '{"city":"Lagos"}']],
  );
  assert.equal(result.finishReason, "tool_calls");
  assert.deepEqual(result.toolCalls, [], "it is not a server tool call, and not 'unknown'");
  // Both kinds of tool were offered to the model.
  assert.deepEqual(
    requests[0]!.tools!.map((t) => t.function.name),
    ["calculator", "get_weather"],
  );
  // No tool message was fabricated for the call the caller still has to run.
  assert.deepEqual(result.transcript.map((m) => m.role), ["assistant"]);
});

test("a mixed turn runs its server calls and hands back only the client calls with the server transcript", async () => {
  const { callModel } = scripted([
    turn({
      content: "Let me check both.",
      toolCalls: [call("calculator", { expression: "2+2" }), call("get_weather", { city: "Oslo" })],
    }),
  ]);
  const ran: string[] = [];
  const result = await runToolLoop({
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "2+2 and the weather" },
    ],
    tools: [spec("calculator")],
    clientTools: [clientTool("get_weather")],
    callModel,
    executeTool: async (name) => {
      ran.push(name);
      return ok("4");
    },
  });

  assert.deepEqual(ran, ["calculator"], "the server call in the same turn still ran");
  assert.deepEqual(result.clientToolCalls.map((c) => c.name), ["get_weather"]);
  assert.deepEqual(result.toolCalls, [{ round: 1, name: "calculator", status: "ok", detail: null }]);
  assert.equal(result.content, "Let me check both.");

  // The transcript is what resuming needs: the assistant turn with BOTH
  // calls, and the result of the one that ran here. Nothing the caller sent.
  const [assistant, toolResult, ...rest] = result.transcript;
  assert.deepEqual(rest, []);
  assert.deepEqual(
    assistant!.tool_calls!.map((c) => c.function.name),
    ["calculator", "get_weather"],
  );
  assert.equal(toolResult!.role, "tool");
  assert.equal(toolResult!.content, "4");
  assert.equal(toolResult!.tool_call_id, assistant!.tool_calls![0]!.id);
  assert.equal(result.clientToolCalls[0]!.id, assistant!.tool_calls![1]!.id);
});

test("an empty-content turn with client calls is not EmptyModelAnswerError", async () => {
  const { callModel } = scripted([turn({ content: "", toolCalls: [call("lookup")] })]);
  const result = await runToolLoop({
    messages: [{ role: "user", content: "x" }],
    tools: [],
    clientTools: [clientTool("lookup")],
    callModel,
    executeTool: async () => assert.fail("not run"),
  });
  assert.equal(result.content, "");
  assert.equal(result.clientToolCalls.length, 1);
});

test("the caller tool_choice is sent on the first call only", async () => {
  const { callModel, requests } = scripted([
    turn({ toolCalls: [call("calculator", { expression: "1+1" })] }),
    turn({ content: "2" }),
  ]);
  const choice = { type: "function" as const, function: { name: "lookup" } };
  await runToolLoop({
    messages: [{ role: "user", content: "x" }],
    tools: [spec("calculator")],
    clientTools: [clientTool("lookup")],
    toolChoice: choice,
    callModel,
    executeTool: async () => ok("2"),
  });
  assert.deepEqual(requests[0]!.toolChoice, choice);
  assert.equal(requests[1]!.toolChoice, "auto", "forcing it again would loop until the rounds ran out");
});

test("every call gets a fresh unique id", async () => {
  // The provider reuses one id for every call, across rounds.
  const { callModel, requests } = scripted([
    turn({ toolCalls: [call("calculator", {}, "call_1"), call("calculator", {}, "call_1")] }),
    turn({ toolCalls: [call("calculator", {}, "call_1")] }),
    turn({ content: "done" }),
  ]);
  await runToolLoop({
    messages: [{ role: "user", content: "x" }],
    tools: [spec("calculator")],
    callModel,
    executeTool: async () => ok("1"),
  });
  const last = requests[2]!.messages;
  const assigned = last.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []);
  assert.equal(assigned.length, 3);
  assert.equal(new Set(assigned).size, 3, "no two calls share an id");
  assert.ok(assigned.every((id) => id !== "call_1" && id.length <= 40));
  // Every tool result answers exactly one assigned id.
  const answered = last.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
  assert.deepEqual([...answered].sort(), [...assigned].sort());
});

test("usage a provider did not report is null, never a partial sum", async () => {
  const { callModel } = scripted([
    turn({ toolCalls: [call("calculator")] }),
    turn({ content: "ok", usage: null }),
  ]);
  const result = await runToolLoop({
    messages: [{ role: "user", content: "x" }],
    tools: [spec("calculator")],
    callModel,
    executeTool: async () => ok("1"),
  });
  assert.equal(result.reportedUsage, null);
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5 }, "the legacy sum counts what was reported");
});
