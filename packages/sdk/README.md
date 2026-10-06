# @wheelsai/sdk

Typed TypeScript client for the WheelsAI API. Every method is one HTTP call to a documented
endpoint; the method names, paths, verbs and bodies are pinned by unit tests, in a table
written by hand from the API's routes (the tests do not read the API's code, so an API route
that moves has to be updated here on purpose). Private to the monorepo (not on npm yet); the
[CLI](../cli) is built on it. It has no runtime dependencies.

```ts
import { WheelsAI, WheelsAIError } from "@wheelsai/sdk";

const wheels = new WheelsAI({
  baseUrl: process.env.WHEELSAI_API_URL!,
  apiKey: process.env.WHEELSAI_API_KEY, // wheels_live_...; sent as `Authorization: Bearer`
});

const { agents } = await wheels.agents.list();
const agent = await wheels.agents.resolve("my-support-bot"); // slug or id, one request

const tiers = await wheels.models.gpuTiers();                // what this API can deploy now
const { deployment } = await wheels.agents.deploy(agent!.id, { gpuTier: tiers[0]!.id });
const { deployment: row } = await wheels.agents.getDeployment(agent!.id, deployment.id);
```

## Talking to an agent

Every agent has an OpenAI-compatible endpoint on the API, on as soon as the agent exists. Each
agent row says where: `apiEndpoint`, `openaiBaseUrl` and `openaiModel` (`agent/<slug>`); the
two URLs are `null` when the API has no public address configured.

```ts
// One call, OpenAI's response shape. `tools` are functions YOU run: they come back as
// message.tool_calls with finish_reason "tool_calls"; send a `tool` message per call to continue.
const reply = await wheels.agents.chatCompletion(
  "my-support-bot",
  { messages: [{ role: "user", content: "How long do refunds take?" }] },
  { timeoutMs: 120_000 },
);
console.log(reply.choices[0]?.message.content, reply.wheelsai?.model);

// The same on the unified base, where `model` picks an agent or a model deployment:
const { data: models } = await wheels.inference.listModels(); // free: not a metered call
await wheels.inference.chat({ model: "agent/my-support-bot", messages: [{ role: "user", content: "Hi" }] });
```

These methods return whole responses. For streaming, point the official OpenAI client at
`agent.openaiBaseUrl` (or `<api>/v1` with `model: "agent/<slug>"` or a deployment's slug) with your
WheelsAI API key. Model deployments stream and take `tools` too.

`agents.update(id, { entrypoint: "graph" })` makes an agent answer through its saved graph, and
`agents.usage(id, "7d")` returns its measured requests, errors, tokens and latency.

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
`inference` (OpenAI-compatible `/v1`), `versioning`, `openclaw` (chat channels), `platform`
(`/api/status`, `/api/public/stats`) and `skills`. Billing amounts are dollars, as the API
returns them. `agents.stop` and `billing.addCredits` no longer exist: the API has no such
endpoints (use `agents.stopDeployment` and `billing.checkout`).

## Build and test

```bash
npm run build -w @wheelsai/sdk       # dist/ (what `exports` points at; consumers import the compiled JS)
npm test -w @wheelsai/sdk            # node:test with an injected fake fetch, no network
npm run typecheck -w @wheelsai/sdk
```

`test/resources.test.ts` has one case per SDK method (verb, path, query, body and the
`Authorization` header) and a guard, read off the client itself, that fails when a method or a
whole resource is added without one. The suite runs in the blocking `sdk-cli` CI job.
