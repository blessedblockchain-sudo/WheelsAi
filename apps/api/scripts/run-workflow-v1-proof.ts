/**
 * Proof run for workflows through the OpenAI-compatible API
 * (docs/WORKFLOWS-RUN.md, section I).
 *
 * Drives a running WheelsAI API with the OFFICIAL openai client and prints
 * what came back. Nothing here knows the API's code: it is the client a
 * customer would write.
 *
 *   WHEELSAI_API_URL    the API origin, e.g. http://localhost:4230
 *   WHEELSAI_API_KEY    an API key of the organization that owns the workflows
 *   WORKFLOW_SLUG       a workflow that publishes its answer with an output mapping
 *   UNMAPPED_SLUG       optional: a workflow with no output mapping
 *   DISABLED_SLUG       optional: a disabled workflow
 *   FAILING_SLUG        optional: a workflow whose run fails
 *   PROOF_ONLY          optional: "disconnect" runs section 7 alone
 *   ABORT_AFTER_MS      how long after the first chunk section 7 hangs up (default 250)
 *
 *   cd apps/api && npx tsx scripts/run-workflow-v1-proof.ts
 */

import OpenAI, { APIError } from "openai";
import { VERSION as openaiVersion } from "openai/version";

const apiUrl = (process.env.WHEELSAI_API_URL ?? "").replace(/\/+$/, "");
const apiKey = process.env.WHEELSAI_API_KEY ?? "";
const slug = process.env.WORKFLOW_SLUG ?? "";
if (!apiUrl || !apiKey || !slug) {
  console.error("Set WHEELSAI_API_URL, WHEELSAI_API_KEY and WORKFLOW_SLUG.");
  process.exit(2);
}

const model = `workflow/${slug}`;
// maxRetries 0: a repeat would be a second run. The timeout is past the
// workflow's own 10-minute limit, so this client never cancels a run by
// giving up first.
const options = { apiKey, maxRetries: 0, timeout: 11 * 60 * 1000 };
const client = new OpenAI({ ...options, baseURL: `${apiUrl}/v1` });
const workflowClient = new OpenAI({ ...options, baseURL: `${apiUrl}/v1/workflows/${slug}` });

const PROMPT =
  "Merged this week: 1) streaming for model deployments, 2) function calling for agents, 3) workflows answer through /v1.";

const show = (label: string, value: unknown) => console.log(`${label}: ${JSON.stringify(value)}`);
const section = (title: string) => console.log(`\n=== ${title} ===`);
const cut = (text: string | null | undefined, max = 220) =>
  !text ? text : text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text;

async function refused(label: string, call: () => Promise<unknown>) {
  try {
    await call();
    console.log(`${label}: UNEXPECTED SUCCESS`);
  } catch (err) {
    if (!(err instanceof APIError)) throw err;
    const body = err.error as Record<string, any> | undefined;
    show(label, {
      status: err.status,
      code: err.code,
      type: err.type,
      param: err.param,
      message: cut(err.message, 260),
      "x-should-retry": err.headers?.get?.("x-should-retry") ?? null,
      ...(body?.executionId && { executionId: body.executionId }),
      ...(body?.failedStep !== undefined && { failedStep: body.failedStep }),
      ...(body?.workflow?.steps && {
        steps: body.workflow.steps.map((s: any) => `${s.name}:${s.status}`),
      }),
    });
  }
}

async function main() {
  console.log(`openai client ${openaiVersion}  base ${apiUrl}/v1  model ${model}`);
  if (process.env.PROOF_ONLY !== "disconnect") await answers();
  await disconnect();
}

async function answers() {
  const prompt = PROMPT;

  // ------------------------------------------------------------------
  section("1. models.list()  (unified base)");
  const models = await client.models.list();
  for (const entry of models.data) {
    show("model", { id: entry.id, wheelsai: (entry as any).wheelsai });
  }

  section("1b. models.list()  (per-workflow base)");
  const own = await workflowClient.models.list();
  show("models", own.data.map((entry) => entry.id));

  // ------------------------------------------------------------------
  section("2. chat.completions.create()  (plain, unified base)");
  let started = Date.now();
  const plain = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
  });
  show("waited ms", Date.now() - started);
  show("id", plain.id);
  show("object", plain.object);
  show("model", plain.model);
  show("finish_reason", plain.choices[0]?.finish_reason);
  show("message.role", plain.choices[0]?.message.role);
  show("message.content", cut(plain.choices[0]?.message.content));
  show("usage", plain.usage ?? null);
  const run = (plain as any).wheelsai?.workflow;
  show("wheelsai.workflow", {
    slug: run?.slug,
    executionId: run?.executionId,
    status: run?.status,
    durationMs: run?.durationMs,
    steps: run?.steps?.map((s: any) => ({ name: s.name, type: s.type, status: s.status, durationMs: s.durationMs })),
  });
  console.log(`RUN_ID_PLAIN=${run?.executionId}`);

  // ------------------------------------------------------------------
  section("3. chat.completions.create({ stream: true })  (per-workflow base)");
  started = Date.now();
  const stream = await workflowClient.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
    stream: true,
    stream_options: { include_usage: true },
  });
  let chunks = 0;
  let text = "";
  let firstAt: number | null = null;
  let firstExtension: unknown = null;
  let lastExtension: any = null;
  let finish: string | null = null;
  let usage: unknown = null;
  for await (const chunk of stream) {
    chunks += 1;
    firstAt ??= Date.now() - started;
    const extension = (chunk as any).wheelsai;
    if (extension) {
      firstExtension ??= extension;
      lastExtension = extension;
    }
    text += chunk.choices[0]?.delta?.content ?? "";
    finish = chunk.choices[0]?.finish_reason ?? finish;
    if (chunk.usage) usage = chunk.usage;
  }
  show("first chunk after ms", firstAt);
  show("first chunk wheelsai", firstExtension);
  show("stream finished after ms", Date.now() - started);
  show("chunks", chunks);
  show("finish_reason", finish);
  show("content", cut(text));
  show("usage (include_usage)", usage);
  show("last wheelsai.workflow", {
    executionId: lastExtension?.workflow?.executionId,
    status: lastExtension?.workflow?.status,
    steps: lastExtension?.workflow?.steps?.map((s: any) => `${s.name}:${s.status}`),
  });

  // ------------------------------------------------------------------
  if (process.env.UNMAPPED_SLUG) {
    section("4. a workflow with no output mapping: the last successful step is the answer");
    const unmapped = await client.chat.completions.create({
      model: `workflow/${process.env.UNMAPPED_SLUG}`,
      messages: [{ role: "user", content: "In one sentence: what changed in agent tooling this week?" }],
    });
    show("model", unmapped.model);
    show("message.content", cut(unmapped.choices[0]?.message.content));
    show("usage", unmapped.usage ?? null);
    show(
      "steps",
      (unmapped as any).wheelsai?.workflow?.steps?.map((s: any) => `${s.name}:${s.status}`),
    );
  }

  // ------------------------------------------------------------------
  section("5. refusals (no run is started)");
  await refused("tools", () =>
    client.chat.completions.create({
      model,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }],
    }),
  );
  await refused("unknown workflow", () =>
    client.chat.completions.create({ model: "workflow/no-such-workflow", messages: [{ role: "user", content: "hi" }] }),
  );
  await refused("no user message", () =>
    client.chat.completions.create({ model, messages: [{ role: "system", content: "be brief" }] }),
  );
  if (process.env.DISABLED_SLUG) {
    await refused("disabled workflow", () =>
      client.chat.completions.create({
        model: `workflow/${process.env.DISABLED_SLUG}`,
        messages: [{ role: "user", content: "hi" }],
      }),
    );
  }

  // ------------------------------------------------------------------
  if (process.env.FAILING_SLUG) {
    section("6. a run that fails");
    await refused("failed run", () =>
      client.chat.completions.create({
        model: `workflow/${process.env.FAILING_SLUG}`,
        messages: [{ role: "user", content: "Summarise this week's changes." }],
      }),
    );
  }

}

async function disconnect() {
  section("7. the client disconnects while the run works");
  const prompt = PROMPT;
  const abortAfterMs = Number(process.env.ABORT_AFTER_MS ?? 250);
  const abort = new AbortController();
  let abortedRun: string | null = null;
  try {
    const leaving = await workflowClient.chat.completions.create(
      { model, messages: [{ role: "user", content: prompt }], stream: true },
      { signal: abort.signal },
    );
    for await (const chunk of leaving) {
      // The first chunk names the run; then this client walks away.
      if (abortedRun === null) {
        abortedRun = (chunk as any).wheelsai?.workflow?.executionId ?? null;
        if (abortedRun) setTimeout(() => abort.abort(), abortAfterMs);
      }
    }
    // The openai client ends the iteration quietly when its own signal aborts.
    console.log(
      abort.signal.aborted
        ? `client aborted ${abortAfterMs} ms after the first chunk; the stream ended with no answer`
        : "stream ended without the abort: UNEXPECTED",
    );
  } catch (err) {
    show("client error", (err as Error).name);
  }
  console.log(`RUN_ID_ABORTED=${abortedRun}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
