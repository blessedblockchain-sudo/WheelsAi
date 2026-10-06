# OpenAI-compatible agent API — proof run

**Date:** 2026-10-06 · **Branch:** `feat/bags-launchpad` (working tree on top of `700e173`)
**Script:** `apps/api/scripts/run-agent-v1-proof.ts`
**Client:** the official `openai` npm package, version 7.28.0, with `maxRetries: 0`

The claim: *"OpenAI-Compatible API. Drop-in replacement for any OpenAI client. Streaming,
function calls, and tool use built in."* This run points the official OpenAI client at a
locally running WheelsAI API and drives a real agent on a real model: a models listing, a
plain completion, a streamed completion, a function-calling round trip, and one conversation
in which the agent's own server-side tool and the caller's function both take part.

Everything below is the exact command and its unedited output, with two exceptions: the API
key is shown by its prefix only, and the demo account's password is read from `$DEMO_PASSWORD`
rather than written here. Nothing was simulated; the model calls went to Groq.

---

## What was built

| | |
|---|---|
| `POST /v1/agents/{slug}/chat/completions` | an agent as an OpenAI model: streaming, caller functions, the agent's own skills and knowledge base |
| `GET /v1/agents/{slug}/models` | so `client.models.list()` works on the per-agent base URL |
| `POST /v1/chat/completions` | the unified base URL: `model` is `agent/<slug>` or the slug of a running model deployment |
| `GET /v1/models` | running deployments and agents, each with `wheelsai.kind` |
| errors under `/v1` | `{ error: { message, type, param, code } }` with `x-should-retry: false` where a retry cannot succeed |
| endpoints | built from `PUBLIC_API_URL`: `<api>/v1/agents/<slug>/chat/completions`. The invented `agents.wheelsai.io` host is gone |
| metering | a request counts as a plan API call when it is not a read and is made with an API key or to `/v1` |

Both entry points (the dashboard playground and `/v1`) run through one service,
`services/agentChat.ts`, so they cannot differ on who is charged or which tools run.

---

## The environment

A local Postgres (`localhost:5434`) and Redis (`localhost:6380`) as configured in
`apps/api/.env`, holding the seeded demo organization "Northwind AI Labs" (owner
`demo@northwind.ai`). Its agents use `free/groq/llama-3.3-70b`, the platform's free Groq
model (served upstream as `openai/gpt-oss-120b`, a reasoning model: its reasoning tokens are
part of `completion_tokens`). `GROQ_API_KEY` comes from `apps/api/.env`.

### 1. Start the API on port 4210, background workers off

```bash
cd apps/api
API_PORT=4210 PUBLIC_API_URL=http://localhost:4210 RATE_LIMIT_MAX_PER_MINUTE=1000 LOG_LEVEL=info \
EMBEDDING_BACKFILL_INTERVAL_MS=0 TOKEN_INDEXER_INTERVAL_MS=0 TREASURY_SETTLEMENT_INTERVAL_MS=0 \
TREASURY_SETTLEMENT_BATCH_INTERVAL_MS=0 PAYMENT_SUBMIT_INTERVAL_MS=0 PAYMENT_POLL_INTERVAL_MS=0 \
PAYMENT_REAP_INTERVAL_MS=0 FEE_ROUTER_INTERVAL_MS=0 BAGS_FEE_SWEEP_INTERVAL_MS=0 \
REPUTATION_ATTESTATION_INTERVAL_MS=0 DEPLOYMENT_STATUS_INTERVAL_MS=0 SCHEDULER_INTERVAL_MS=0 \
WORKFLOW_REAP_INTERVAL_MS=0 UPTIME_PROBER_INTERVAL_MS=0 ALERT_EVALUATOR_INTERVAL_MS=0 \
ANALYTICS_SNAPSHOT_INTERVAL_MS=0 SUBSCRIPTION_RENEWAL_INTERVAL_MS=0 PAYOUT_EXECUTOR_INTERVAL_MS=0 \
GPU_BILLING_INTERVAL_MS=0 \
npx tsx src/index.ts
```

`X402_SETTLEMENT_INTERVAL_MS` has a minimum of 1000 and was left at its default.
`curl -s -i http://localhost:4210/health` answered `HTTP/1.1 200 OK`.

### 2. Sign in as the demo owner and create an API key

```bash
curl -s -X POST http://localhost:4210/api/auth/login -H 'Content-Type: application/json' \
  -d "{"email":"demo@northwind.ai","password":"$DEMO_PASSWORD"}" > login.json
TOKEN=$(python3 -c "import json;print(json.load(open('login.json'))['token'])")

curl -s -X POST http://localhost:4210/api/auth/keys -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"agent-v1-proof-run"}' > key.json
```

```text
{'user': {'id': '6d691c9e-d5dd-4e11-8a5e-4442b8e3e0e6', 'email': 'demo@northwind.ai', 'createdAt': '2026-10-01T11:58:56.900Z'}, 'organization': {'id': 'ad698f19-bf63-4d1e-9402-fd6c51636a66', 'name': 'Northwind AI Labs'}, 'token': '<jwt>'}
```

```json
{
 "id": "80e952b1-b7a9-40f2-83ba-c3b234b69fcd",
 "key": "wheels_live_dlnB…",
 "apiKey": {
  "id": "80e952b1-b7a9-40f2-83ba-c3b234b69fcd",
  "keyPrefix": "wheels_live_dlnB",
  "name": "agent-v1-proof-run",
  "scopes": [],
  "lastUsedAt": null,
  "expiresAt": null,
  "createdAt": "2026-10-06T06:26:31.626Z",
  "status": "active"
 },
 "message": "Store this key securely - it cannot be retrieved again"
}
```

### 3. The agents now say where their API is

`GET /api/agents` with the key, printing `slug | apiEndpoint | openaiModel`:

```text
seo-auditor-marketplace | http://localhost:4210/v1/agents/seo-auditor-marketplace/chat/completions | agent/seo-auditor-marketplace
ops-runbook-bot | http://localhost:4210/v1/agents/ops-runbook-bot/chat/completions | agent/ops-runbook-bot
sales-qualifier | http://localhost:4210/v1/agents/sales-qualifier/chat/completions | agent/sales-qualifier
community-moderator | http://localhost:4210/v1/agents/community-moderator/chat/completions | agent/community-moderator
release-notes-writer | http://localhost:4210/v1/agents/release-notes-writer/chat/completions | agent/release-notes-writer
research-analyst | http://localhost:4210/v1/agents/research-analyst/chat/completions | agent/research-analyst
support-concierge | http://localhost:4210/v1/agents/support-concierge/chat/completions | agent/support-concierge
```

None of the seeded agents has a server-side skill enabled, so for the mixed-tools step a
temporary one was created through the API (and deleted at the end):

```bash
curl -s -X POST http://localhost:4210/api/agents -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{
  "name": "V1 Proof Calculator",
  "framework": "custom",
  "systemPrompt": "You are a precise assistant. Use your tools when asked to.",
  "tools": [{ "name": "calculator", "type": "function", "description": "Evaluate arithmetic" }],
  "modelConfig": { "externalModel": "free/groq/llama-3.3-70b", "temperature": 0 },
  "sourceType": "inline",
  "sourceCode": "// prompt-only agent used by docs/AGENT-V1-RUN.md"
}'
```

```json
{"agent":{"id":"4b5a8589-a36a-4c7b-8fd7-0ef5dfb34d51","name":"V1 Proof Calculator","slug":"v1-proof-calculator","framework":"custom","apiEndpoint":"http://localhost:4210/v1/agents/v1-proof-calculator/chat/completions","openaiBaseUrl":"http://localhost:4210/v1/agents/v1-proof-calculator","openaiModel":"agent/v1-proof-calculator"},"message":"Agent created successfully"}
```

---

## The run, with the official OpenAI client

```bash
cd apps/api
WHEELSAI_API_URL=http://localhost:4210 WHEELSAI_API_KEY=$(cat key.txt) \
MIXED_AGENT_SLUG=v1-proof-calculator npx tsx scripts/run-agent-v1-proof.ts
```

Exit code 0. Full output:

```text
openai client 7.28.0  base http://localhost:4210/v1  model agent/support-concierge

=== 1. models.list()  (unified base) ===
model: {"id":"support-llm","owned_by":"wheelsai","wheelsai":{"kind":"deployment"}}
model: {"id":"agent/support-concierge","owned_by":"wheelsai","wheelsai":{"kind":"agent"}}
model: {"id":"agent/research-analyst","owned_by":"wheelsai","wheelsai":{"kind":"agent"}}
model: {"id":"agent/release-notes-writer","owned_by":"wheelsai","wheelsai":{"kind":"agent"}}
model: {"id":"agent/community-moderator","owned_by":"wheelsai","wheelsai":{"kind":"agent"}}
model: {"id":"agent/sales-qualifier","owned_by":"wheelsai","wheelsai":{"kind":"agent"}}
model: {"id":"agent/ops-runbook-bot","owned_by":"wheelsai","wheelsai":{"kind":"agent"}}
model: {"id":"agent/seo-auditor-marketplace","owned_by":"wheelsai","wheelsai":{"kind":"agent"}}
model: {"id":"agent/v1-proof-calculator","owned_by":"wheelsai","wheelsai":{"kind":"agent"}}

=== 1b. models.list()  (per-agent base) ===
models: ["agent/support-concierge"]

=== 2. chat.completions.create()  (plain) ===
id: "chatcmpl-2d94cc8d-a033-44e5-916d-55657d28cbc4"
object: "chat.completion"
model: "agent/support-concierge"
finish_reason: "stop"
content: "I can assist you with any questions or issues you have regarding the Northwind Cloud developer platform."
usage: {"prompt_tokens":121,"completion_tokens":97,"total_tokens":218}
wheelsai: {"agent":{"slug":"support-concierge","version":"1.2.0"},"model":"free/groq/llama-3.3-70b","runtime":"platform","billing":null,"retrieval":null,"tool_calls":[]}

=== 3. chat.completions.create({ stream: true, include_usage }) ===
first chunk: {"id":"chatcmpl-84d5436a-b303-4d1c-a7cc-ffc17a9e7474","object":"chat.completion.chunk","created":1791268143,"model":"agent/support-concierge","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}],"wheelsai":{"agent":{"slug":"support-concierge","version":"1.2.0"},"model":"free/groq/llama-3.3-70b","runtime":"platform","billing":null,"retrieval":null}}
chunks: 14
distinct ids: 1
models seen: ["agent/support-concierge"]
first token after ms: 94
text: "One, two, three, four, five."
finish_reason: "stop"
usage chunk: {"prompt_tokens":121,"completion_tokens":55,"total_tokens":176}

=== 4. function calling round trip  (per-agent base) ===
model: "agent/support-concierge"
finish_reason: "tool_calls"
content: null
tool_calls: [{"id":"call_e4e62f1569b14bb28f8282c5c794780e","type":"function","function":{"name":"get_order_status","arguments":"{\"order_id\":\"1042\"}"}}]
ran locally: {"name":"get_order_status","args":{"order_id":"1042"},"result":{"order_id":"1042","status":"out for delivery","eta":"today by 18:00"}}
finish_reason: "stop"
content: "Your order **#1042** is currently **out for delivery** and is expected to arrive **today by 6 PM**. Let me know if there’s anything else I can help with!"
usage: {"prompt_tokens":239,"completion_tokens":73,"total_tokens":312}

=== 5. the same hand-back, streamed ===
tool_calls: [{"arguments":"{\"order_id\":\"77\"}","id":"fc_e3a078b9-a18b-40de-98c2-e05c891ff8a1","name":"get_order_status"}]
finish_reason: "tool_calls"

=== 5b. the agent's own tool and the caller's function in one conversation  (agent/v1-proof-calculator) ===
turn 1 finish_reason: "tool_calls"
turn 1 server tool calls (wheelsai.tool_calls): [{"round":1,"name":"calculator","status":"ok","detail":null}]
turn 1 handed back (message.tool_calls): [{"id":"call_75233209745d446985a3d127940be9e5","type":"function","function":{"name":"get_order_status","arguments":"{\"order_id\":\"1042\"}"}}]
turn 2 finish_reason: "stop"
turn 2 server tool calls (wheelsai.tool_calls): []
turn 2 handed back (message.tool_calls): null
turn 2 content: "Here are the results you asked for:\n\n- **1234 × 5678 = 7,006,652**  \n- **Order 1042** is **out for delivery** and is expected **today by 18:00**."

=== 6. errors, as the client reports them ===
unknown agent: {"class":"NotFoundError","status":404,"type":"invalid_request_error","code":"agent_not_found","param":null,"message":"404 No agent with that slug exists in this organization.","x-should-retry":"false"}
unknown model: {"class":"NotFoundError","status":404,"type":"invalid_request_error","code":"model_not_found","param":null,"message":"404 No running model deployment has the slug 'gpt-4o'. GET /v1/models lists what this key can call; agents are named 'agent/<slug>'.","x-should-retry":"false"}
n=2: {"class":"BadRequestError","status":400,"type":"invalid_request_error","code":"unsupported_parameter","param":"n","message":"400 Only n=1 is supported.","x-should-retry":null}
bad key: {"class":"AuthenticationError","status":401,"type":"invalid_request_error","code":"invalid_api_key","param":null,"message":"401 Missing or invalid API key. Send it as 'Authorization: Bearer <key>'; keys are created in the dashboard under API Keys.","x-should-retry":null}
```

What each section shows:

1. **Models.** One base URL lists the organization's running model deployment
   (`support-llm`) and its agents (`agent/<slug>`). The per-agent base lists exactly that agent.
2. **Plain completion.** A `chat.completion` named `agent/support-concierge`, with the
   provider's reported usage and the `wheelsai` extension saying which model answered.
3. **Streaming.** 14 chunks under one id and one model name, `finish_reason: "stop"`, and the
   usage chunk that `include_usage` asked for. ("first token after ms" is measured from the
   moment the client had the response headers, not from the request, so it is not a latency
   figure for the agent.) The
   first chunk is OpenAI's own opening chunk (assistant role, empty content) carrying the
   `wheelsai` object.
4. **Function calling.** On the per-agent base, with a `model` name the server ignores. The
   model called the caller's `get_order_status`; the response ended with
   `finish_reason: "tool_calls"`; the script ran the function locally and sent the result back
   as a `tool` message; the agent answered from it.
5. **The same hand-back streamed**, assembled from `delta.tool_calls`.
   **5b.** One conversation with both kinds of tool. In turn 1 the model asked for the agent's
   own `calculator` and the caller's `get_order_status` together: the calculator ran on the
   platform (`wheelsai.tool_calls`), and only `get_order_status` was handed back. In turn 2 the
   caller replayed just what it had been shown plus its result, and the answer contains
   **both** results, including `1234 × 5678 = 7,006,652`, which the caller never had: the
   server put its own half of the turn back from the continuation store.
6. **Errors** arrive as the client's own typed exceptions (`NotFoundError`,
   `BadRequestError`, `AuthenticationError`) with our `code`, and `x-should-retry: false`
   on the ones a retry cannot fix.

### The raw stream

```bash
curl -sN -D sse-headers.txt http://localhost:4210/v1/agents/support-concierge/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'Origin: http://localhost:3000' -H 'X-Request-Id: proof-sse-1' \
  -d '{"messages":[{"role":"user","content":"Say hello in three words."}],"stream":true,"stream_options":{"include_usage":true},"max_completion_tokens":300,"temperature":0}'
```

```text
data: {"id":"chatcmpl-2634dd2c-5126-4566-a2c8-cb352d2a9119","object":"chat.completion.chunk","created":1791268161,"model":"agent/support-concierge","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}],"wheelsai":{"agent":{"slug":"support-concierge","version":"1.2.0"},"model":"free/groq/llama-3.3-70b","runtime":"platform","billing":null,"retrieval":null}}

data: {"id":"chatcmpl-2634dd2c-5126-4566-a2c8-cb352d2a9119","object":"chat.completion.chunk","created":1791268161,"model":"agent/support-concierge","choices":[{"index":0,"delta":{"content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-2634dd2c-5126-4566-a2c8-cb352d2a9119","object":"chat.completion.chunk","created":1791268161,"model":"agent/support-concierge","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-2634dd2c-5126-4566-a2c8-cb352d2a9119","object":"chat.completion.chunk","created":1791268161,"model":"agent/support-concierge","choices":[{"index":0,"delta":{"content":","},"finish_reason":null}]}

data: {"id":"chatcmpl-2634dd2c-5126-4566-a2c8-cb352d2a9119","object":"chat.completion.chunk","created":1791268161,"model":"agent/support-concierge","choices":[{"index":0,"delta":{"content":" dear"},"finish_reason":null}]}

data: {"id":"chatcmpl-2634dd2c-5126-4566-a2c8-cb352d2a9119","object":"chat.completion.chunk","created":1791268161,"model":"agent/support-concierge","choices":[{"index":0,"delta":{"content":" friend"},"finish_reason":null}]}

data: {"id":"chatcmpl-2634dd2c-5126-4566-a2c8-cb352d2a9119","object":"chat.completion.chunk","created":1791268161,"model":"agent/support-concierge","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}

data: {"id":"chatcmpl-2634dd2c-5126-4566-a2c8-cb352d2a9119","object":"chat.completion.chunk","created":1791268161,"model":"agent/support-concierge","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"id":"chatcmpl-2634dd2c-5126-4566-a2c8-cb352d2a9119","object":"chat.completion.chunk","created":1791268161,"model":"agent/support-concierge","choices":[],"usage":{"prompt_tokens":115,"completion_tokens":101,"total_tokens":216}}

data: [DONE]
```

Selected response headers (`grep` over `sse-headers.txt`). The CORS, request-id and rate-limit
headers used to be dropped on streamed responses; they are present:

```text
HTTP/1.1 200 OK
x-content-type-options: nosniff
access-control-allow-origin: http://localhost:3000
x-request-id: proof-sse-1
x-ratelimit-remaining-requests: 187
x-ratelimit-reset-requests: 9s
Content-Type: text/event-stream
Cache-Control: no-cache
X-Accel-Buffering: no
```

No provider id, provider model name or vendor field (`x_groq`) appears in the stream; every
chunk carries our id and `agent/support-concierge`.

### Named refusals

```bash
# a running model deployment, through the unified base
curl -s -i http://localhost:4210/v1/chat/completions -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"support-llm","messages":[{"role":"user","content":"hi"}]}'
# a workflow
curl -s -i http://localhost:4210/v1/chat/completions -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"workflow/nightly","messages":[{"role":"user","content":"hi"}]}'
# an endpoint this API does not have
curl -s -i -X POST http://localhost:4210/v1/responses -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{}'
# no credentials
curl -s -i http://localhost:4210/v1/models
```

Status line, `x-should-retry` and body of each:

```text
--- deployment via unified base
HTTP/1.1 503 Service Unavailable
{"error":{"reason":"Service Unavailable","message":"No healthy nodes available for this deployment","type":"server_error","param":null,"code":"service_unavailable"}}
--- workflow
HTTP/1.1 501 Not Implemented
x-should-retry: false
{"error":{"message":"Workflows are not served through the OpenAI-compatible API yet. Run a workflow with POST /api/orchestrations/{id}/execute.","type":"server_error","param":"model","code":"workflow_api_not_available"}}
--- /v1/responses
HTTP/1.1 404 Not Found
{"error":{"message":"POST /v1/responses is not part of this API. The OpenAI-compatible endpoints are POST /v1/chat/completions, POST /v1/agents/{slug}/chat/completions, POST /v1/{deployment}/chat/completions and GET /v1/models.","type":"invalid_request_error","param":null,"code":"not_found"}}
--- no key
HTTP/1.1 401 Unauthorized
{"error":{"message":"Missing or invalid API key. Send it as 'Authorization: Bearer <key>'; keys are created in the dashboard under API Keys.","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}
```

The seeded `support-llm` deployment is a database row with no GPU node behind it, so the
unified route reaches the real deployment handler and gets its honest `503`. (After this
run the redundant `"reason":"Service Unavailable"` field was dropped from that body; a
`reason` is now sent only when it is a machine-readable code such as `gpu_billing_stalled`.) A model
deployment answering through `/v1` was **not** exercised live in this run (see below).

### Metering

`GET /api/billing/plan` before and after: four model listings (three on `/v1/models`, one on
`/v1/agents/support-concierge/models`), then one chat completion.

```text
before:            {"plan": "pro", "usage": {"agents": 7, "apiCallsThisMonth": 25}}
after 4 model lists: {"plan": "pro", "usage": {"agents": 7, "apiCallsThisMonth": 25}}
completion HTTP 200
after 1 completion:  {"plan": "pro", "usage": {"agents": 7, "apiCallsThisMonth": 26}}
```

Reads are free; a completion counts once.

---

## What went wrong on the way, and why

The first two attempts of the client script failed. Both are recorded because both are the
system doing what it should with a real failure.

**Attempt 1: the provider call timed out connecting.** The first chat completion after the
server started answered `502`:

```text
=== 2. chat.completions.create()  (plain) ===

PROOF RUN FAILED
InternalServerError: 502 the model call failed
    at Function.generate (/home/bprime/Bounties/WheelsAi/apps/api/node_modules/openai/src/core/error.ts:99:14)
    at OpenAI.makeStatusError (/home/bprime/Bounties/WheelsAi/apps/api/node_modules/openai/src/client.ts:894:28)
    at OpenAI.makeRequest (/home/bprime/Bounties/WheelsAi/apps/api/node_modules/openai/src/client.ts:1918:24)
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
    at async main (/home/bprime/Bounties/WheelsAi/apps/api/scripts/run-agent-v1-proof.ts:51:17) {
  status: 502,
  ...
  error: {
    message: 'the model call failed',
    type: 'server_error',
    param: null,
    code: 'upstream_error'
  },
```

The server log shows the cause: `TypeError: fetch failed: Connect Timeout Error` from the
`fetch` to Groq. This machine has no IPv6 route (`curl -6 https://api.groq.com` cannot
connect, `curl -4` connects in 0.19 s) while DNS returns IPv6 addresses first; the first
connection from the freshly started process did not complete in time. Three standalone
`node -e "fetch('https://api.groq.com/openai/v1/models')"` calls afterwards each answered in
about 0.8 s, and every later call from the server succeeded. It is a property of this
network, not of the code. The client saw an OpenAI-shaped 502 with no internal detail, and
nothing was charged.

**Attempt 2: my own token cap was too low for a reasoning model.** The script first asked
for `max_completion_tokens: 80` (plain) and `40` (stream). The free model reasons before it
answers, and the reasoning counts against the cap:

```text
=== 2. chat.completions.create()  (plain) ===
id: "chatcmpl-33d0a393-eb48-490e-a51f-f918801f9c7c"
object: "chat.completion"
model: "agent/support-concierge"
finish_reason: "length"
content: "I can assist you with"
usage: {"prompt_tokens":121,"completion_tokens":80,"total_tokens":201}
wheelsai: {"agent":{"slug":"support-concierge","version":"1.2.0"},"model":"free/groq/llama-3.3-70b","runtime":"platform","billing":null,"retrieval":null,"tool_calls":[]}

=== 3. chat.completions.create({ stream: true, include_usage }) ===

PROOF RUN FAILED
APIError: The model returned no answer.
```

The plain answer was cut off and said so (`finish_reason: "length"`, 80 completion tokens).
The stream spent all 40 tokens reasoning and produced no text, so it ended with one error
event and no `[DONE]`, which the client raised as an exception:

```text
  error: {
    message: 'The model returned no answer.',
    type: 'server_error',
    param: null,
    code: 'empty_answer'
  },
  code: 'empty_answer',
  param: null,
  type: 'server_error'
}
```

That is the contract for a stream that fails after its headers are sent. The caps were raised
to 600 and the run above is the third attempt, unchanged since.

---

## Clean-up

```text
delete temp agent: {"message":"Agent deleted"}
revoke key: {"message":"API key revoked"} HTTP 200
revoked key now: HTTP 401
```

The API process was sent `SIGTERM`, stopped its queues and exited 0;
`ss -ltn | grep ":4210 "` then printed nothing (port 4210 is free). Over the whole run the
server logged one `ERROR` (the connect timeout of attempt 1) and one `WARN` (the empty
stream of attempt 2).

The run left two traces in the demo database: the revoked API key row `agent-v1-proof-run`,
and this month's API-call counter, which ended one higher than the last figure above
(deleting the temporary agent was a write made with the key).

---

## What this run does not show

- **A model deployment answering through `/v1`, streamed or not.** A Nosana deployment
  cannot be started from this machine (no GPU node, no funded market), so there is no
  recorded run of one and none is imitated here. What exists instead is said under
  "Added after this run" below.
- **A paid marketplace agent** (402, refund on failure) and **a knowledge-base citation**.
  `support-concierge` is bound to a knowledge base but `retrieval` came back `null` in this
  run; why was not investigated here. The charge, settle and refund paths under `/v1` are
  covered by `agentCompletionsRoute.unit.test.ts` with the real agent-chat core.
- **The Python client.** Only the Node client was run. The streamed chunks all carry a choice
  (except the usage chunk a caller asks for), which is what the Python quickstart loop needs.
- **Workflows through `/v1`.** Not built in this change; `model: "workflow/…"` answers the
  named `501` above.
- **A streamed hand-back uses the provider's tool-call id** (`fc_…` in section 5) while a
  non-streamed one uses ours (`call_<32 hex>`). Both round-trip; they are not yet uniform.

## Added after this run (2026-10-06), not re-run live

The recorded run above is unchanged. These were built afterwards and are covered by tests
only; none of them has a recorded run, for the reason given with each.

- **Model deployments speak the same wire format.** `POST /v1/{deployment}/chat/completions`
  and the deployment branch of `POST /v1/chat/completions` now stream (`stream: true` used to
  end in a 502 and mark the node unhealthy), forward `tools` and `tool_choice`, pass the model
  server's own status through in OpenAI's error shape, and keep the node call's timeout alive
  until the last byte. vLLM is started with `--enable-auto-tool-choice` and a parser for
  Llama 3.1/3.2, Qwen 2.5 and Mistral 7B v0.3.
  *Not run live:* no Nosana deployment is available locally. The closest thing to a proof is
  the test "the official OpenAI client streams, calls tools and reads errors from a model
  deployment" in `inferenceStreaming.unit.test.ts`: the real route behind a real HTTP
  listener, read by the official `openai` client (stream with usage, a tool call, the tool
  result sent back, a typed 400), with the **model server scripted** in vLLM's format. It
  shows the client accepts what the proxy sends. It does not show a GPU node, vLLM's parser
  flags or the `v0.6.3` image working; those need a real deployment.
- **Agents on a WheelsAI-hosted model** (`wheelsai/<model id>`) resolve to the organization's
  own running deployment instead of answering 501. *Not run live:* same reason.
- **Graph agents.** An agent whose `entrypoint` is `graph` answers the playground and `/v1`
  by running its saved graph. *Not run live:* it needs migration
  `20261007110000_agent_entrypoint_usage`, which had not been applied to the demo database
  when this was written (migrations are applied after review).
- **Agent usage.** Every chat is added to an hourly rollup and read back by
  `GET /api/agents/{id}/usage`. The upsert statement was executed against the local Postgres
  on a temporary table inside a transaction that was rolled back (five chats, two sources;
  counts, token sums and the histogram came back as expected). *Not run live through the
  API:* same migration.
- **Shutdown.** In-flight agent chats are cancelled and refunded on SIGTERM, alongside graph
  runs. Covered by `agentChat.unit.test.ts`; no process was killed mid-chat to record it.

## Tests

```bash
cd apps/api
npx tsx --test src/tests/agentCompletionsRoute.unit.test.ts   # 25 pass
npx tsx --test src/tests/openaiV1Router.unit.test.ts          # 7 pass
npx tsx --test src/tests/openaiCompat.unit.test.ts            # 22 pass
npx tsx --test src/tests/apiCallMetering.unit.test.ts         # 24 pass
npx tsx --test src/tests/inferenceStreaming.unit.test.ts      # 19 pass (model deployments)
npx tsx --test src/tests/agentChat.unit.test.ts               # 39 pass (graph, hosted models, shutdown)
npx tsx --test src/tests/hostedModel.unit.test.ts             # 5 pass
npx tsx --test src/tests/agentUsage.unit.test.ts              # 10 pass
```
