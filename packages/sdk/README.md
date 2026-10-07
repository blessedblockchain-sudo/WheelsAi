# @wheelsai/sdk

Typed TypeScript client for the WheelsAI API. Every method is one HTTP call to a documented
endpoint, and unit tests pin each method's path, verb and body. It has no runtime
dependencies, and the [CLI](../cli) is built on it. Build it from a checkout of this
repository (see [Build and test](#build-and-test)).

```ts
import { WheelsAI, WheelsAIError } from "@wheelsai/sdk";

const wheels = new WheelsAI({
  baseUrl: process.env.WHEELSAI_API_URL!,
  apiKey: process.env.WHEELSAI_API_KEY, // wheels_live_...; sent as `Authorization: Bearer`
});

const { agents } = await wheels.agents.list();
const agent = await wheels.agents.resolve("my-support-bot"); // slug or id, one request

const tiers = await wheels.models.gpuTiers();                // the GPU tiers open for deployment now
const { deployment } = await wheels.agents.deploy(agent!.id, { gpuTier: tiers[0]!.id });
const { deployment: row } = await wheels.agents.getDeployment(agent!.id, deployment.id);
```

## Talking to an agent

Every agent has an OpenAI-compatible endpoint on the API, on as soon as the agent exists. Each
agent row says where: `apiEndpoint`, `openaiBaseUrl` and `openaiModel` (`agent/<slug>`); the
two URLs are `null` when they cannot be determined.

```ts
// One call, OpenAI's response shape. `tools` are functions YOU run: they come back as
// message.tool_calls with finish_reason "tool_calls"; send a `tool` message per call to continue.
const reply = await wheels.agents.chatCompletion(
  "my-support-bot",
  { messages: [{ role: "user", content: "How long do refunds take?" }] },
  { timeoutMs: 120_000 },
);
console.log(reply.choices[0]?.message.content, reply.wheelsai?.model);

// The same on the unified base, where `model` picks an agent, a workflow or a model deployment:
const { data: models } = await wheels.inference.listModels(); // free: not a metered call
await wheels.inference.chat({ model: "agent/my-support-bot", messages: [{ role: "user", content: "Hi" }] });

// A workflow answers as a chat completion too: one call is one run, and its output is the answer.
const { orchestrations } = await wheels.workflows.list();
const workflow = orchestrations[0]; // .slug, .apiEndpoint, .openaiBaseUrl, .openaiModel ("workflow/<slug>")
const result = await wheels.workflows.chatCompletion(
  workflow.slug,
  { messages: [{ role: "user", content: "Changes merged this week: ..." }] },
  { timeoutMs: workflow.timeout + 60_000 }, // a client that gives up first cancels the run
);
console.log(result.choices[0]?.message.content, result.wheelsai?.workflow.executionId);
```

These methods return whole responses. For streaming, point the official OpenAI client at
`agent.openaiBaseUrl` (or `<api>/v1` with `model: "agent/<slug>"` or a deployment's slug) with your
WheelsAI API key. Model deployments stream and take `tools` too.

`agents.update(id, { entrypoint: "graph" })` makes an agent answer through its saved graph, and
`agents.usage(id, "7d")` returns its requests, errors, tokens and latency.

## Hiring an offering

An offering is a fixed task a publisher's agent, workflow or model runs for a set price. Hiring
puts the price in escrow; it is released when you accept the deliverable and refunded when the
job is rejected, fails its checks, expires or is cancelled.

```ts
const { offerings } = await wheels.offerings.search({ productKind: "agent", query: "brief" });
const offering = offerings[0]!;

const { job } = await wheels.offerings.hire(
  offering, // the offering as you read it: its price, delivery time and termsVersion are sent along
  { topic: "GPU rental prices" }, // must match offering.inputSchema
  { idempotencyKey: "order-42" }, // a retry with the same key returns this job, charged once
);

let current = (await wheels.jobs.get(job.id)).job;
while (current.status === "funded" || current.status === "running") {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  current = (await wheels.jobs.get(job.id)).job;
}
if (current.status === "submitted") {
  console.log(current.output?.text);
  await wheels.jobs.accept(job.id, { rating: 5 }); // or wheels.jobs.reject(job.id, "why")
}
```

A publisher can edit an active offering. Passing the offering object holds the hire to the terms
you read: if its price, delivery time, checks or instructions changed since, the hire is refused
with 409 `offering_terms_changed`, nothing is charged, and `err.data.current` has the terms as they
are now. Hiring by id (`hire(offering.id, ...)`) sends no expected terms unless you pass
`{ expected: { priceCents } }`; an API key is then hired at the current terms, inside its per-job
cap.

An API key can hire only when it was granted `jobs:hire` by name, with both spend caps; accepting
and rejecting need `jobs:review`. A key with no scopes, or with `*`, cannot spend:

```ts
await wheels.auth.createApiKey({
  name: "buyer agent",
  scopes: ["jobs:hire", "jobs:read", "jobs:review"],
  maxJobPriceCents: 500, // the most one job may cost
  dailySpendCapCents: 2000, // the most the key may spend in one UTC day
});
```

Publishers use `offerings.create`, `update`, `validate`, `testRun`, `activate`, `pause` and
`archive`, and read incoming jobs with `jobs.list({ role: "publisher" })`.

## Authentication

An API key (`apiKey`) and a session token (`token`, from `auth.login`) are both sent as
`Authorization: Bearer <credential>`; a token wins if both are set. `login` can answer a
two-factor challenge: check with `isTwoFactorChallenge(result)` and finish with `auth.login2fa`.

Some routes need a session rather than an API key (`auth.listApiKeys`, `auth.createApiKey`,
`auth.revokeApiKey`, `auth.refresh`, `auth.organizations`, `auth.switchOrg`, `billing.checkout`,
`billing.portal`).
They answer `401` to a key. The agent graph routes (`agents.getGraph`, `saveGraph`) authorize by
user too, and answer an opaque `404` to a key.

## Errors

Every failure throws a `WheelsAIError`: `status` (the HTTP status, or `0` for a network error or
timeout), `message` (the API's `message` or `error`, with zod field errors spelled out), `code`
(the API's `error` code, e.g. `insufficient_credits`) and `data` (the parsed body, which carries
extras such as `requiredCents` or a token-gated listing's `tokenSymbol` and `mintAddress`).
The `/v1` API answers in OpenAI's shape, `{ error: { message, type, param, code } }`; `message`
and `code` are read from there too (e.g. `agent_not_found`, `plan_limit_reached`).
Requests time out after 30 seconds (`timeoutMs`); `agents.chatCompletion`, `agents.playgroundChat`,
`inference.chat` and `inference.chatCompletion` take `{ timeoutMs }` as a last argument for a
longer wait on one call.

Ids and slugs are percent-encoded into the path. An empty one, `.` and `..` are refused (they
would name a different route). A credential containing whitespace or control characters is
refused before anything is sent, with an error that does not repeat it.

## Resources

`auth`, `agents`, `deployments` (model deployments), `models`, `billing`, `marketplace`,
`inference` (OpenAI-compatible `/v1`), `workflows` (definitions are read-only here: `list`, `get`,
`run`, `getRun`, `cancelRun`, `chatCompletion`), `offerings` and `jobs` (above), `versioning`, `openclaw` (chat channels), `platform`
(`/api/status`, `/api/public/stats`) and `skills`. Billing amounts are dollars, as the API
returns them. To stop an agent's deployment use `agents.stopDeployment`; to buy credits, use
`billing.checkout`.

## Build and test

```bash
npm run build -w @wheelsai/sdk       # dist/ (what `exports` points at; consumers import the compiled JS)
npm test -w @wheelsai/sdk            # node:test with an injected fake fetch, no network
npm run typecheck -w @wheelsai/sdk
```

`test/resources.test.ts` has one case per SDK method (verb, path, query, body and the
`Authorization` header) and a guard, read off the client itself, that fails when a method or a
whole resource is added without one.
