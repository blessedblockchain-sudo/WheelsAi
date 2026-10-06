import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpenAiStreamAdapter,
  extensionChunk,
  findToolNameConflict,
  MAX_COMPLETION_TOKENS,
  MAX_MESSAGE_CHARS,
  openAiError,
  parseChatCompletionRequest,
  pickProviderParams,
  SSE_DONE,
  sseFrame,
  toChatCompletion,
  toChunk,
  toolCallDeltas,
  usageChunk,
  type AdaptableOutcome,
  type OpenAiErrorCode,
  type ParsedChatRequest,
} from "../services/openaiCompat.js";

// services/openaiCompat.ts: the OpenAI wire format as a pure module. These
// tests are the definition of "drop-in" for /v1: what is accepted, what is
// refused by name, and what every response and stream frame looks like to an
// OpenAI SDK.

const USER = { role: "user", content: "hi" };

function parsed(body: unknown): ParsedChatRequest {
  const result = parseChatCompletionRequest(body);
  assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.error.body));
  return result.request;
}

function refused(body: unknown) {
  const result = parseChatCompletionRequest(body);
  assert.ok(!result.ok, "expected a refusal");
  return result.error;
}

// ============================================
// Request
// ============================================

test("string and text-part content normalise identically; image parts are refused naming messages[i].content", () => {
  const asString = parsed({ messages: [{ role: "user", content: "Hello world" }] });
  const asParts = parsed({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      },
    ],
  });
  assert.deepEqual(asParts.messages, asString.messages);
  assert.deepEqual(asString.messages, [{ role: "user", content: "Hello world" }]);

  const error = refused({
    messages: [
      USER,
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "https://example.test/a.png" } },
        ],
      },
    ],
  });
  assert.equal(error.status, 400);
  assert.equal(error.body.error.code, "unsupported_content");
  assert.equal(error.body.error.param, "messages[1].content");
  assert.match(error.body.error.message, /image_url/);

  assert.equal(
    refused({ messages: [{ role: "user", content: [{ type: "input_audio", input_audio: {} }] }] }).body.error.param,
    "messages[0].content",
  );
});

test("developer becomes a system turn", () => {
  const request = parsed({
    messages: [
      { role: "developer", content: "Answer in French." },
      { role: "system", content: "Be brief." },
      USER,
    ],
  });
  assert.deepEqual(request.messages, [
    { role: "system", content: "Answer in French." },
    { role: "system", content: "Be brief." },
    { role: "user", content: "hi" },
  ]);
});

test("a tool message without tool_call_id is refused", () => {
  const error = refused({ messages: [USER, { role: "tool", content: "42" }] });
  assert.equal(error.status, 400);
  assert.equal(error.body.error.code, "validation_failed");
  assert.equal(error.body.error.param, "messages[1].tool_call_id");
});

test("an assistant tool_calls turn and its tool result survive; `name` is accepted and dropped", () => {
  const request = parsed({
    messages: [
      { role: "user", content: "weather?", name: "ada" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "31C" }] },
    ],
  });
  assert.deepEqual(request.messages, [
    { role: "user", content: "weather?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } }],
    },
    { role: "tool", content: "31C", tool_call_id: "call_1" },
  ]);

  // Null content is only meaningful next to tool_calls.
  assert.equal(refused({ messages: [USER, { role: "assistant", content: null }] }).body.error.param, "messages[1].content");
  assert.equal(refused({ messages: [{ role: "user" }] }).body.error.param, "messages[0].content");
});

test("n≠1, logprobs, audio and legacy functions are refused naming the parameter", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ n: 2 }, "n"],
    [{ logprobs: true }, "logprobs"],
    [{ top_logprobs: 3 }, "top_logprobs"],
    [{ audio: { voice: "alloy", format: "wav" } }, "audio"],
    [{ modalities: ["text", "audio"] }, "modalities"],
    [{ functions: [{ name: "f" }] }, "functions"],
    [{ function_call: "auto" }, "function_call"],
    [{ logit_bias: { "50256": -100 } }, "logit_bias"],
  ];
  for (const [extra, param] of cases) {
    const error = refused({ messages: [USER], ...extra });
    assert.equal(error.status, 400, param);
    assert.equal(error.body.error.code, "unsupported_parameter", param);
    assert.equal(error.body.error.param, param);
    assert.equal(error.body.error.type, "invalid_request_error");
  }
  // The values that mean "the default" are not refusals.
  parsed({ messages: [USER], n: 1, logprobs: false, modalities: ["text"], logit_bias: {}, top_logprobs: null });
});

test("unknown fields are ignored", () => {
  const request = parsed({
    messages: [{ ...USER, cache_control: { type: "ephemeral" } }],
    model: "gpt-4o",
    service_tier: "auto",
    store: true,
    metadata: { trace: "abc" },
    reasoning_effort: "low",
    some_future_field: { nested: true },
  });
  assert.equal(request.model, "gpt-4o");
  assert.deepEqual(request.messages, [{ role: "user", content: "hi" }]);
  assert.deepEqual(request.params, {}, "nothing unknown becomes a provider parameter");
});

test("max_completion_tokens wins over max_tokens and both cap at the agent ceiling", () => {
  assert.equal(parsed({ messages: [USER], max_tokens: 100, max_completion_tokens: 200 }).params.max_tokens, 200);
  assert.equal(parsed({ messages: [USER], max_tokens: 100 }).params.max_tokens, 100);
  assert.equal(parsed({ messages: [USER], max_completion_tokens: MAX_COMPLETION_TOKENS }).params.max_tokens, 32768);
  assert.equal(parsed({ messages: [USER] }).params.max_tokens, undefined, "unset leaves the agent's own limit");

  assert.equal(refused({ messages: [USER], max_tokens: MAX_COMPLETION_TOKENS + 1 }).body.error.param, "max_tokens");
  assert.equal(
    refused({ messages: [USER], max_completion_tokens: MAX_COMPLETION_TOKENS + 1 }).body.error.param,
    "max_completion_tokens",
  );
  assert.equal(refused({ messages: [USER], max_tokens: 0 }).body.error.param, "max_tokens");
});

test("sampling parameters are validated and only the allowlisted ones are kept", () => {
  const request = parsed({
    messages: [USER],
    temperature: 0,
    top_p: 0.9,
    stop: ["\n\n", "END"],
    seed: 42,
    presence_penalty: -2,
    frequency_penalty: 2,
    user: "user-1",
    response_format: { type: "json_schema", json_schema: { name: "a", schema: { type: "object" } } },
    stream: true,
    stream_options: { include_usage: true },
  });
  assert.deepEqual(request.params, {
    temperature: 0,
    top_p: 0.9,
    stop: ["\n\n", "END"],
    seed: 42,
    presence_penalty: -2,
    frequency_penalty: 2,
    user: "user-1",
    response_format: { type: "json_schema", json_schema: { name: "a", schema: { type: "object" } } },
  });
  assert.equal(request.stream, true);
  assert.equal(request.includeUsage, true);

  assert.equal(refused({ messages: [USER], temperature: 2.5 }).body.error.param, "temperature");
  assert.equal(refused({ messages: [USER], top_p: 1.5 }).body.error.param, "top_p");
  assert.equal(refused({ messages: [USER], stop: ["a", "b", "c", "d", "e"] }).body.error.param, "stop");
  assert.equal(refused({ messages: [USER], response_format: { type: "xml" } }).body.error.param, "response_format.type");
  assert.equal(refused({ messages: [] }).body.error.param, "messages");
  assert.equal(refused({ messages: [{ role: "robot", content: "x" }] }).body.error.param, "messages[0].role");
  assert.equal(refused("not an object").body.error.code, "validation_failed");

  // The runtime applies the same allowlist again at the wire.
  assert.deepEqual(pickProviderParams({ top_p: 0.5, model: "x", messages: [], api_key: "k", seed: null }), {
    top_p: 0.5,
  });
});

test("client tools are validated, and tool_choice must name one of them", () => {
  const tool = (name: string) => ({ type: "function", function: { name, parameters: { type: "object" } } });
  const request = parsed({
    messages: [USER],
    tools: [tool("get_weather"), { type: "function", function: { name: "lookup", description: "d", strict: true } }],
    tool_choice: { type: "function", function: { name: "lookup" } },
    parallel_tool_calls: false,
  });
  assert.deepEqual(request.tools.map((t) => t.function.name), ["get_weather", "lookup"]);
  assert.deepEqual(request.tools[1]!.function, { name: "lookup", description: "d", strict: true });
  assert.deepEqual(request.toolChoice, { type: "function", function: { name: "lookup" } });
  assert.equal(request.params.parallel_tool_calls, false);
  assert.equal(parsed({ messages: [USER] }).toolChoice, null);

  const unknown = refused({ messages: [USER], tools: [tool("a")], tool_choice: { type: "function", function: { name: "b" } } });
  assert.equal(unknown.body.error.code, "unknown_tool_choice");
  assert.equal(unknown.body.error.param, "tool_choice");
  assert.equal(refused({ messages: [USER], tool_choice: "required" }).body.error.code, "unknown_tool_choice");
  assert.equal(refused({ messages: [USER], tools: [tool("bad name!")] }).body.error.param, "tools[0].function.name");
  assert.equal(refused({ messages: [USER], tools: [tool("a"), tool("a")] }).body.error.param, "tools[1].function.name");

  // A caller's function may not take the name of a platform skill.
  assert.equal(findToolNameConflict(request.tools, ["calculator", "web_search"]), null);
  assert.equal(findToolNameConflict(parsed({ messages: [USER], tools: [tool("web_search")] }).tools, ["calculator", "web_search"]), "web_search");
});

test("a conversation over the size cap is refused naming messages", () => {
  const error = refused({ messages: [{ role: "user", content: "x".repeat(MAX_MESSAGE_CHARS + 1) }] });
  assert.equal(error.status, 400);
  assert.equal(error.body.error.code, "messages_too_large");
  assert.equal(error.body.error.param, "messages");
});

// ============================================
// Responses
// ============================================

const META = { id: "chatcmpl-test", created: 1_760_000_000, model: "agent/support-bot" };

test("a completion has id chatcmpl-*, object, created, model, choices[0].message, finish_reason and usage.total_tokens", () => {
  const completion = toChatCompletion({
    ...META,
    content: "Hello!",
    finishReason: "stop",
    usage: { inputTokens: 12, outputTokens: 3 },
    extension: { agent: { slug: "support-bot" } },
  });
  assert.deepEqual(completion, {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1_760_000_000,
    model: "agent/support-bot",
    system_fingerprint: null,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello!", refusal: null },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    wheelsai: { agent: { slug: "support-bot" } },
  });
  const choice = (toChatCompletion({ ...META, content: "cut", finishReason: "length" }).choices as any[])[0];
  assert.equal(choice.finish_reason, "length");
  // A provider's own vocabulary never reaches the client.
  assert.equal((toChatCompletion({ ...META, content: "x", finishReason: "eos_token" }).choices as any[])[0].finish_reason, "stop");
});

test("usage is omitted when the provider reported none", () => {
  for (const usage of [null, undefined]) {
    const completion = toChatCompletion({ ...META, content: "Hello!", usage });
    assert.ok(!("usage" in completion), "an unknown is not sent as zero");
  }
  assert.equal(usageChunk(META, null), null);
});

test("client tool calls render as tool_calls with finish_reason tool_calls and null content", () => {
  const completion = toChatCompletion({
    ...META,
    content: "",
    finishReason: "stop",
    toolCalls: [{ id: "call_abc", name: "get_weather", arguments: '{"city":"Lagos"}' }],
  });
  const choice = (completion.choices as any[])[0];
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(choice.message.content, null);
  assert.deepEqual(choice.message.tool_calls, [
    { id: "call_abc", type: "function", function: { name: "get_weather", arguments: '{"city":"Lagos"}' } },
  ]);
  assert.deepEqual(toolCallDeltas([{ id: "call_abc", name: "f", arguments: "{}" }]), [
    { index: 0, id: "call_abc", type: "function", function: { name: "f", arguments: "{}" } },
  ]);
});

test("the extension chunk carries choices: [] so chunk.choices[0] never throws", () => {
  const chunk = extensionChunk(META, { toolCalls: [{ name: "calculator", status: "ok" }] }) as any;
  assert.deepEqual(chunk.choices, []);
  assert.equal(chunk.object, "chat.completion.chunk");
  assert.equal(chunk.id, META.id);
  // What an OpenAI SDK consumer writes:
  assert.equal(chunk.choices[0]?.delta?.content, undefined);
  assert.deepEqual(toChunk(META, { content: "hi" }), {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1_760_000_000,
    model: "agent/support-bot",
    choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
  });
});

// ============================================
// Stream adapter
// ============================================

const enc = new TextEncoder();

function upstream(events: string[], outcome: AdaptableOutcome & Record<string, unknown>) {
  return {
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        // Split mid-frame: a provider's chunk boundaries are not frame boundaries.
        const all = events.join("");
        const cut = Math.floor(all.length / 2);
        controller.enqueue(enc.encode(all.slice(0, cut)));
        controller.enqueue(enc.encode(all.slice(cut)));
        controller.close();
      },
    }),
    outcome: Promise.resolve(outcome),
  };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

const providerChunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-PROVIDER",
    object: "chat.completion.chunk",
    created: 1,
    model: "openai/gpt-oss-120b",
    system_fingerprint: "fp_provider",
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    ...extra,
  })}\n\n`;

const OPTIONS = { ...META, includeUsage: false };

function frames(sse: string): any[] {
  return sse
    .split("\n\n")
    .filter((f) => f.length > 0 && f !== "data: [DONE]")
    .map((f) => JSON.parse(f.slice(6)));
}

test("every frame is data: <json>\\n\\n and success ends with exactly one [DONE]", async () => {
  const adapted = createOpenAiStreamAdapter(
    upstream(
      [
        ": provider keep-alive\n\n",
        providerChunk({ role: "assistant", content: "Hel" }),
        "event: ping\ndata: {}\n\n",
        providerChunk({ content: "lo" }),
        providerChunk({}, "stop"),
        "data: [DONE]\n\n",
      ],
      { ok: true, usage: null },
    ),
    OPTIONS,
  );
  const out = await drain(adapted.stream);
  const parts = out.split("\n\n");
  assert.equal(parts.pop(), "", "the stream ends on a frame boundary");
  for (const part of parts) {
    assert.match(part, /^data: /);
    if (part !== "data: [DONE]") JSON.parse(part.slice(6));
  }
  assert.equal(out.split("data: [DONE]").length - 1, 1, "exactly one [DONE]");
  assert.ok(out.endsWith(SSE_DONE));
  assert.equal(
    frames(out)
      .map((f) => f.choices[0]?.delta?.content ?? "")
      .join(""),
    "Hello",
  );
  assert.equal(sseFrame({ a: 1 }), 'data: {"a":1}\n\n');
});

test("the stream adapter rewrites id and model to ours, strips x_groq and vendor delta fields", async () => {
  const adapted = createOpenAiStreamAdapter(
    upstream(
      [
        providerChunk({ role: "assistant", content: "" }, null, { x_groq: { id: "req_1" } }),
        providerChunk({ reasoning: "thinking about it..." }),
        providerChunk({ content: "Hi", reasoning_content: "secret chain of thought" }),
        providerChunk({}, "eos_token", { x_groq: { usage: { prompt_tokens: 5, completion_tokens: 1 } } }),
        "data: [DONE]\n\n",
      ],
      { ok: true, usage: { inputTokens: 5, outputTokens: 1 } },
    ),
    OPTIONS,
  );
  const out = await drain(adapted.stream);
  assert.ok(!/PROVIDER|gpt-oss|x_groq|fp_provider|reasoning|thinking/.test(out), out);
  const all = frames(out);
  for (const frame of all) {
    assert.equal(frame.id, "chatcmpl-test");
    assert.equal(frame.model, "agent/support-bot");
    assert.equal(frame.created, 1_760_000_000);
    assert.equal(frame.object, "chat.completion.chunk");
  }
  assert.equal(all.length, 3, "the reasoning-only delta leaves nothing to forward");
  assert.deepEqual(all[1].choices[0].delta, { content: "Hi" });
  assert.equal(all[2].choices[0].finish_reason, "stop");
  assert.ok(!out.includes('"usage"'), "usage was not asked for");
});

test("the runtime's extension event and tool_call deltas come through in OpenAI shape", async () => {
  const adapted = createOpenAiStreamAdapter(
    upstream(
      [
        `data: ${JSON.stringify({ wheelsai: { toolCalls: [{ name: "calculator", status: "ok", detail: null }] } })}\n\n`,
        providerChunk({
          tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "get_weather", arguments: "" }, vendor: 1 }],
        }),
        providerChunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":"Oslo"}' } }] }),
        providerChunk({}, "tool_calls"),
        "data: [DONE]\n\n",
      ],
      { ok: true, usage: null },
    ),
    OPTIONS,
  );
  const all = frames(await drain(adapted.stream));
  // One empty-delta choice: `chunk.choices[0].delta.content` must not throw.
  assert.deepEqual(all[0].choices, [{ index: 0, delta: {}, finish_reason: null }]);
  assert.deepEqual(all[0].wheelsai.toolCalls[0].name, "calculator");
  assert.deepEqual(all[1].choices[0].delta, {
    tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "get_weather", arguments: "" } }],
    role: "assistant",
  });
  assert.deepEqual(all[2].choices[0].delta.tool_calls, [{ index: 0, function: { arguments: '{"city":"Oslo"}' } }]);
  assert.equal(all[3].choices[0].finish_reason, "tool_calls");
});

test("include_usage adds one final usage chunk; without it none is sent", async () => {
  const events = [
    providerChunk({ role: "assistant", content: "Hi" }),
    providerChunk({}, "stop"),
    // The provider's own usage chunk (requested upstream for every chat).
    `data: ${JSON.stringify({ id: "chatcmpl-PROVIDER", choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const outcome = { ok: true, usage: { inputTokens: 7, outputTokens: 2 } };

  const withUsage = await drain(
    createOpenAiStreamAdapter(upstream(events, outcome), { ...META, includeUsage: true }).stream,
  );
  const usageFrames = frames(withUsage).filter((f) => f.usage);
  assert.equal(usageFrames.length, 1);
  assert.deepEqual(usageFrames[0], {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1_760_000_000,
    model: "agent/support-bot",
    choices: [],
    usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
  });
  assert.ok(withUsage.endsWith(`${sseFrame(usageFrames[0])}${SSE_DONE}`), "usage is the last chunk before [DONE]");

  const without = await drain(createOpenAiStreamAdapter(upstream(events, outcome), OPTIONS).stream);
  assert.ok(!without.includes('"usage"'));

  // Asked for, but the provider reported none: no chunk, not a zero.
  const unreported = await drain(
    createOpenAiStreamAdapter(upstream(events.slice(0, 2), { ok: true, usage: null }), { ...META, includeUsage: true }).stream,
  );
  assert.ok(!unreported.includes('"usage"'));
  assert.ok(unreported.endsWith(SSE_DONE));
});

test("a failed stream ends with one sanitized error event and NO [DONE]; provider error text never passes", async () => {
  // A provider error event inside an HTTP 200 stream.
  const providerError = await drain(
    createOpenAiStreamAdapter(
      upstream(
        [
          providerChunk({ role: "assistant", content: "Par" }),
          `data: ${JSON.stringify({ error: { message: "Org org-internal-9 exceeded quota for key gsk_live_ABCD" } })}\n\n`,
        ],
        { ok: false, code: "provider_error" },
      ),
      OPTIONS,
    ).stream,
  );
  assert.ok(!providerError.includes("gsk_live") && !providerError.includes("org-internal"));
  assert.ok(!providerError.includes("[DONE]"));
  const last = frames(providerError).at(-1);
  assert.deepEqual(last, {
    error: {
      message: "The model provider reported an error mid-stream.",
      type: "server_error",
      param: null,
      code: "upstream_error",
    },
  });
  assert.equal(frames(providerError).filter((f) => f.error).length, 1);

  // The runtime appends its "no answer" event AFTER the provider's [DONE].
  // Clients stop at [DONE], so the upstream one must be held back.
  const empty = await drain(
    createOpenAiStreamAdapter(
      upstream(
        [
          providerChunk({ reasoning: "..." }),
          providerChunk({}, "length"),
          "data: [DONE]\n\n",
          `data: ${JSON.stringify({ error: { message: "the model returned no answer (finish_reason: length)" } })}\n\n`,
        ],
        { ok: false, code: "empty_answer" },
      ),
      OPTIONS,
    ).stream,
  );
  assert.ok(!empty.includes("[DONE]"));
  assert.equal(frames(empty).at(-1).error.code, "empty_answer");

  const timedOut = await drain(
    createOpenAiStreamAdapter(upstream([providerChunk({ content: "x" })], { ok: false, code: "deadline" }), OPTIONS).stream,
  );
  assert.equal(frames(timedOut).at(-1).error.code, "upstream_timeout");
});

test("cancelling the adapted stream cancels the upstream one", async () => {
  let cancelled = false;
  const source = {
    stream: new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(enc.encode(providerChunk({ content: "tick" })));
      },
      cancel() {
        cancelled = true;
      },
    }),
    outcome: new Promise<AdaptableOutcome>(() => {}),
  };
  const reader = createOpenAiStreamAdapter(source, OPTIONS).stream.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(cancelled, true);
});

// ============================================
// Errors
// ============================================

test("openAiError maps every refusal to status, type and code, sets x-should-retry and retry-after, and sanitises internal detail", () => {
  const table: Array<[OpenAiErrorCode, number, string, boolean]> = [
    // code, status, type, x-should-retry: false?
    ["validation_failed", 400, "invalid_request_error", false],
    ["unsupported_parameter", 400, "invalid_request_error", false],
    ["unsupported_content", 400, "invalid_request_error", false],
    ["tool_name_conflict", 400, "invalid_request_error", false],
    ["unknown_tool_choice", 400, "invalid_request_error", false],
    ["agent_model_key_missing", 400, "invalid_request_error", false],
    ["provider_rejected_request", 400, "invalid_request_error", false],
    ["invalid_api_key", 401, "invalid_request_error", false],
    ["marketplace_payment_required", 402, "payment_required", true],
    ["licence_revoked", 403, "permission_error", true],
    ["insufficient_scope", 403, "permission_error", true],
    ["agent_not_found", 404, "invalid_request_error", true],
    ["model_not_found", 404, "invalid_request_error", true],
    ["request_too_large", 413, "invalid_request_error", true],
    ["rate_limit_exceeded", 429, "requests", false],
    ["plan_limit_reached", 429, "insufficient_quota", true],
    ["provider_rate_limited", 429, "requests", false],
    ["internal_error", 500, "server_error", false],
    ["model_provider_not_configured", 501, "server_error", true],
    ["hosted_model_not_available", 501, "server_error", true],
    ["hosted_model_not_running", 503, "server_error", true],
    ["agent_graph_missing", 400, "invalid_request_error", true],
    ["graph_run_failed", 502, "server_error", false],
    ["x402_payment_required", 402, "payment_required", true],
    // A used payment stays used: an SDK must not retry a 409 into more metered calls.
    ["payment_already_used", 409, "invalid_request_error", true],
    ["upstream_error", 502, "server_error", false],
    ["provider_auth_failed", 502, "server_error", true],
    ["provider_model_not_found", 502, "server_error", true],
    ["empty_answer", 502, "server_error", false],
    ["tool_loop_exhausted", 502, "server_error", false],
    ["upstream_timeout", 504, "server_error", false],
  ];
  for (const [code, status, type, noRetry] of table) {
    const error = openAiError(code);
    assert.equal(error.status, status, code);
    assert.equal(error.body.error.type, type, code);
    assert.equal(error.body.error.code, code);
    assert.equal(error.body.error.param, null);
    assert.ok(error.body.error.message.length > 0, code);
    assert.equal(error.headers["x-should-retry"], noRetry ? "false" : undefined, code);
    assert.deepEqual(Object.keys(error.body), ["error"]);
  }
  // A provider 401 is our configuration, never the caller's key.
  assert.notEqual(openAiError("provider_auth_failed").status, 401);

  const limited = openAiError("rate_limit_exceeded", { retryAfterSeconds: 12.2 });
  assert.equal(limited.headers["retry-after"], "13");
  assert.equal(openAiError("rate_limit_exceeded", { retryAfterSeconds: 0 }).headers["retry-after"], "1");
  assert.equal(openAiError("upstream_error").headers["retry-after"], undefined);

  const paid = openAiError("marketplace_payment_required", {
    message: '"Support Pro" is billed per request.',
    extra: { requiredCents: 5, balanceCents: 0, listingTitle: "Support Pro", code: "spoofed", type: "spoofed" },
  });
  assert.equal(paid.body.error.requiredCents, 5);
  assert.equal(paid.body.error.listingTitle, "Support Pro");
  assert.equal(paid.body.error.code, "marketplace_payment_required", "extras cannot overwrite the contract fields");
  assert.equal(paid.body.error.type, "payment_required");

  const leaked = openAiError("internal_error", {
    message:
      "Invalid `prisma.agent.findFirst()` invocation in /home/app/apps/api/src/services/agentChat.ts:120:31",
  });
  assert.equal(leaked.body.error.message, "The request could not be completed.");
  assert.equal(
    openAiError("validation_failed", { param: "messages[0].content", message: "A user message needs content." }).body.error.message,
    "A user message needs content.",
  );
});

test("an opening extension rides on OpenAI's own first chunk and the role is not sent twice", async () => {
  const adapted = createOpenAiStreamAdapter(
    upstream(
      [providerChunk({ role: "assistant", content: "Hi" }), providerChunk({ content: "!" }), providerChunk({}, "stop"), "data: [DONE]\n\n"],
      { ok: true, usage: null },
    ),
    { ...OPTIONS, opening: { agent: { slug: "support-bot" }, runtime: "platform" } },
  );
  const out = await drain(adapted.stream);
  const all = frames(out);
  assert.deepEqual(all[0].choices, [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
  assert.deepEqual(all[0].wheelsai, { agent: { slug: "support-bot" }, runtime: "platform" });
  // Every frame has a choice, so the unguarded consumer loop survives.
  for (const frame of all) assert.equal(frame.choices.length, 1);
  assert.equal(all.map((f) => f.choices[0].delta.content ?? "").join(""), "Hi!");
  assert.equal(all.filter((f) => f.choices[0].delta.role).length, 1);
  assert.ok(out.endsWith(SSE_DONE));
});
