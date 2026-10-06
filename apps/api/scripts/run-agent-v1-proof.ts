/**
 * Proof run for the OpenAI-compatible agent API (docs/AGENT-V1-RUN.md).
 *
 * Drives a running WheelsAI API with the OFFICIAL openai client and prints
 * what came back. Nothing here knows the API's code: it is the client a
 * customer would write.
 *
 *   WHEELSAI_API_URL   the API origin, e.g. http://localhost:4210
 *   WHEELSAI_API_KEY   an API key of the organization that owns the agent
 *   AGENT_SLUG         the agent to talk to (default support-concierge)
 *   MIXED_AGENT_SLUG   optional: an agent with the calculator skill enabled,
 *                      to show a server-side tool and a caller function together
 *
 *   cd apps/api && npx tsx scripts/run-agent-v1-proof.ts
 */

import OpenAI from "openai";
import { VERSION as openaiVersion } from "openai/version";

const apiUrl = (process.env.WHEELSAI_API_URL ?? "").replace(/\/+$/, "");
const apiKey = process.env.WHEELSAI_API_KEY ?? "";
const slug = process.env.AGENT_SLUG ?? "support-concierge";
if (!apiUrl || !apiKey) {
  console.error("Set WHEELSAI_API_URL and WHEELSAI_API_KEY.");
  process.exit(2);
}

const model = `agent/${slug}`;
// The unified base: `model` picks the agent. maxRetries 0 so every request
// printed below is exactly one request on the server.
const client = new OpenAI({ baseURL: `${apiUrl}/v1`, apiKey, maxRetries: 0 });
// The per-agent base, for clients tied to one model name.
const agentClient = new OpenAI({ baseURL: `${apiUrl}/v1/agents/${slug}`, apiKey, maxRetries: 0 });

const show = (label: string, value: unknown) => console.log(`${label}: ${JSON.stringify(value)}`);
const section = (title: string) => console.log(`\n=== ${title} ===`);

async function main() {
  console.log(`openai client ${openaiVersion}  base ${apiUrl}/v1  model ${model}`);

  // ------------------------------------------------------------------
  section("1. models.list()  (unified base)");
  const models = await client.models.list();
  for (const entry of models.data) {
    show("model", { id: entry.id, owned_by: entry.owned_by, wheelsai: (entry as any).wheelsai });
  }

  section("1b. models.list()  (per-agent base)");
  const own = await agentClient.models.list();
  show("models", own.data.map((entry) => entry.id));

  // ------------------------------------------------------------------
  section("2. chat.completions.create()  (plain)");
  const plain = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: "In one short sentence, what can you help me with?" }],
    max_completion_tokens: 600,
    temperature: 0,
  });
  show("id", plain.id);
  show("object", plain.object);
  show("model", plain.model);
  show("finish_reason", plain.choices[0]?.finish_reason);
  show("content", plain.choices[0]?.message.content);
  show("usage", plain.usage);
  show("wheelsai", (plain as any).wheelsai);

  // ------------------------------------------------------------------
  section("3. chat.completions.create({ stream: true, include_usage })");
  const stream = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: "Count from one to five in words, separated by commas." }],
    max_completion_tokens: 600,
    temperature: 0,
    stream: true,
    stream_options: { include_usage: true },
  });
  let chunks = 0;
  let text = "";
  let firstTokenMs: number | null = null;
  const started = Date.now();
  const ids = new Set<string>();
  const modelsSeen = new Set<string>();
  let finish: string | null = null;
  let usage: unknown = null;
  let opening: unknown = null;
  for await (const chunk of stream) {
    chunks += 1;
    ids.add(chunk.id);
    modelsSeen.add(chunk.model);
    if (chunks === 1) opening = chunk;
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (delta && firstTokenMs === null) firstTokenMs = Date.now() - started;
    text += delta;
    if (chunk.choices[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }
  show("first chunk", opening);
  show("chunks", chunks);
  show("distinct ids", ids.size);
  show("models seen", [...modelsSeen]);
  // Counted from when the response headers arrived, not from the request.
  show("first token after ms", firstTokenMs);
  show("text", text);
  show("finish_reason", finish);
  show("usage chunk", usage);

  // ------------------------------------------------------------------
  section("4. function calling round trip  (per-agent base)");
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "get_order_status",
        description: "Look up the shipping status of an order by its id.",
        parameters: {
          type: "object",
          properties: { order_id: { type: "string", description: "The order id, e.g. 1042" } },
          required: ["order_id"],
        },
      },
    },
  ];
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "user", content: "Where is my order 1042? Use the order lookup." },
  ];
  // "this-name-is-ignored": on the per-agent base the path picks the agent.
  const first = await agentClient.chat.completions.create({
    model: "this-name-is-ignored",
    messages,
    tools,
    tool_choice: "required",
    temperature: 0,
  });
  const reply = first.choices[0]!.message;
  show("model", first.model);
  show("finish_reason", first.choices[0]?.finish_reason);
  show("content", reply.content);
  show("tool_calls", reply.tool_calls);
  if (!reply.tool_calls || reply.tool_calls.length === 0) {
    throw new Error("the model did not call the function");
  }

  messages.push(reply);
  for (const call of reply.tool_calls) {
    if (call.type !== "function") continue;
    const args = JSON.parse(call.function.arguments) as { order_id?: string };
    // The caller's own code runs the function.
    const result = { order_id: args.order_id, status: "out for delivery", eta: "today by 18:00" };
    show("ran locally", { name: call.function.name, args, result });
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
  }
  const second = await agentClient.chat.completions.create({
    model: "this-name-is-ignored",
    messages,
    tools,
    temperature: 0,
    max_completion_tokens: 600,
  });
  show("finish_reason", second.choices[0]?.finish_reason);
  show("content", second.choices[0]?.message.content);
  show("usage", second.usage);

  // ------------------------------------------------------------------
  section("5. the same hand-back, streamed");
  const toolStream = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: "Where is my order 77? Use the order lookup." }],
    tools,
    tool_choice: "required",
    temperature: 0,
    stream: true,
  });
  const streamedCalls: Record<number, { id?: string; name?: string; arguments: string }> = {};
  let toolFinish: string | null = null;
  for await (const chunk of toolStream) {
    for (const call of chunk.choices[0]?.delta?.tool_calls ?? []) {
      const slot = (streamedCalls[call.index] ??= { arguments: "" });
      if (call.id) slot.id = call.id;
      if (call.function?.name) slot.name = call.function.name;
      slot.arguments += call.function?.arguments ?? "";
    }
    if (chunk.choices[0]?.finish_reason) toolFinish = chunk.choices[0].finish_reason;
  }
  show("tool_calls", Object.values(streamedCalls));
  show("finish_reason", toolFinish);

  // ------------------------------------------------------------------
  // Optional: an agent that has a server-side skill (calculator) enabled.
  // One model turn can then mix the agent's own tool with the caller's.
  const mixedSlug = process.env.MIXED_AGENT_SLUG;
  if (mixedSlug) {
    section(`5b. the agent's own tool and the caller's function in one conversation  (agent/${mixedSlug})`);
    const mixedModel = `agent/${mixedSlug}`;
    const mixed: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: "user",
        content:
          "Two things: use the calculator to work out 1234 * 5678, and use the order lookup for order 1042. Then tell me both results.",
      },
    ];
    for (let turn = 1; turn <= 4; turn += 1) {
      const answer = await client.chat.completions.create({ model: mixedModel, messages: mixed, tools, temperature: 0 });
      const message = answer.choices[0]!.message;
      show(`turn ${turn} finish_reason`, answer.choices[0]?.finish_reason);
      show(`turn ${turn} server tool calls (wheelsai.tool_calls)`, (answer as any).wheelsai?.tool_calls);
      show(`turn ${turn} handed back (message.tool_calls)`, message.tool_calls ?? null);
      if (!message.tool_calls || message.tool_calls.length === 0) {
        show(`turn ${turn} content`, message.content);
        break;
      }
      mixed.push(message);
      for (const call of message.tool_calls) {
        if (call.type !== "function") continue;
        const args = JSON.parse(call.function.arguments) as { order_id?: string };
        mixed.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ order_id: args.order_id, status: "out for delivery", eta: "today by 18:00" }),
        });
      }
    }
  }

  // ------------------------------------------------------------------
  section("6. errors, as the client reports them");
  const failures: Array<[string, () => Promise<unknown>]> = [
    [
      "unknown agent",
      () => client.chat.completions.create({ model: "agent/no-such-agent", messages: [{ role: "user", content: "hi" }] }),
    ],
    [
      "unknown model",
      () => client.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    ],
    [
      "n=2",
      () => client.chat.completions.create({ model, n: 2, messages: [{ role: "user", content: "hi" }] }),
    ],
    [
      "bad key",
      () =>
        new OpenAI({ baseURL: `${apiUrl}/v1`, apiKey: "wheels_live_not-a-real-key", maxRetries: 0 }).chat.completions.create({
          model,
          messages: [{ role: "user", content: "hi" }],
        }),
    ],
  ];
  for (const [label, run] of failures) {
    try {
      await run();
      show(label, "UNEXPECTED SUCCESS");
    } catch (err) {
      if (err instanceof OpenAI.APIError) {
        show(label, {
          class: err.constructor.name,
          status: err.status,
          type: err.type,
          code: err.code,
          param: err.param,
          message: err.message,
          "x-should-retry": err.headers?.get?.("x-should-retry") ?? null,
        });
      } else {
        throw err;
      }
    }
  }
}

main().catch((err) => {
  console.error("\nPROOF RUN FAILED");
  console.error(err);
  process.exit(1);
});
