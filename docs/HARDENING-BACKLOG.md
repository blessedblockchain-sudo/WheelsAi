# Hardening backlog

Problems the October 2026 verification passes found and that are still open, with the reason each one was left. Everything critical or major from those passes is fixed; what remains here is minor unless marked. Add to this file instead of leaving a known problem only in a review thread, and delete an entry when its fix lands.

Updated 2026-10-07.

## Marketplace

- **A buyer's copy of a graph agent arrives needing configuration (major).** An install copies the graph, but any literal text in an API node's URL, headers or body, in a code node's source, or in the input of an `http_request` or `code_interpreter` tool node stays with the publisher, because nothing distinguishes a credential from harmless text. The buyer is told which nodes to fill in, not what the values were. A copy can arrive working once graphs can reference named secrets that each organization supplies for itself; that needs its own design, because a published graph must not be able to send a buyer's secrets to the publisher's server. Prompts, tools and source code are still copied as before.
- An owed contributor share is recorded and withheld from the publisher, but it is assigned to the contributor only when their payout profile exists, which happens when they open Revenue and Payouts. There is no background sweep.
- Shares that went to the publisher before contributor earnings were recorded are not recovered; nothing recorded them.
- A renewal that fails on every attempt is rotated to the back of the queue, not retired, and nothing alerts on it beyond the worker's error count.
- A subscriber who had not cancelled renewal keeps the 3-day grace period after a listing leaves monthly pricing, although no renewal can happen there.

## Offerings and jobs

- **A buyer can reject any deliverable inside the 72-hour window and is refunded in full after having read it (major, by design of the claim).** Each rejection is recorded as a dispute on the publisher and the reason is shown to them; nothing yet limits a buyer who rejects everything. A per-buyer rejection rate, and what to do above a threshold, is a policy decision.
- A paid job's use of the platform's free-model keys is metered on the job and taken from the publisher's share when the job settles. A job that is refunded (failed, expired, rejected) earned nothing, so its model usage is recorded but not charged to anyone. The free-tier limiter still counts it against the publisher's organization.
- In a paid job `http_request` runs only when the offering names it in `allowedTools`. Once a publisher names it nothing narrows it further: any method, any public address, and no check on what the request carries, so a buyer's input can still talk that agent into sending the offering's instructions out. The form and the docs say so. A per-offering list of allowed hosts would let a publisher use the tool without that exposure; it is not built.
- An agent that answers through its graph cannot be given `allowedTools`, so its `http_request` nodes never run in a paid job and there is no way to allow them. The dashboard's offering form sets `allowedTools` for agent offerings only; a workflow offering's can be set through the API, and a workflow step that is a graph agent then refuses the allowlist when the job runs, not when the offering is saved.
- `web_search` and `code_interpreter` are not treated as outbound. A search query goes to the configured search provider, not to an address the model chooses; the sandbox runner is required by its contract to have no network egress, which the API cannot verify.
- The offering's `termsVersion` is an unkeyed digest that covers the private instructions. It reveals nothing of them, but someone who already holds an exact copy of an offering's title, description, schema, checks and instructions could confirm the instructions against it. Keying it needs a server secret passed into the offering views.
- An API key may hire without `expected`. It is then hired at the offering's terms when the request arrives: the key's per-job cap bounds the price, and nothing bounds the delivery time or the checks. Requiring `expected` of keys too would break scripts that hire by id; the SDK sends it whenever it is given the offering.
- Only `expected` protects a buyer from an edit to an active offering. Requiring a pause before the price, delivery time, checks or instructions of an active offering can change would also stop a publisher from changing instructions under jobs that are funded and not yet started (a job's price, checks and output format are fixed at hire; the instructions are read when it runs).
- One JSON Schema validation is bounded (1,000,000 work units and 2,000,000 pattern-matching steps, together a few tenths of a second at worst, as measured on a development machine), and one compile is bounded by 500 subschemas, boolean schemas and dependency names included (about 0.15 seconds there). A request can still run several in a row on the event loop: up to 5 samples on `POST /api/offerings/validate` and on a save, and up to 10 `json_schema` or `regex` checks on one deliverable, each inside its own bound. Moving user-schema work to a worker thread, or yielding between checks, would take it off the request path altogether.
- The validation budget depends on ajv evaluating the work meter before any other keyword of a subschema, which ajv has no public option for: `services/jsonSchema.ts` reorders ajv's rule groups, refuses to validate if the meter is not first, and a unit test (a fan-out whose every evaluation fails) pins the behaviour. An ajv upgrade has to pass that test.
- ajv keeps every distinct `pattern` it has compiled for the life of the process (its code-generation scope is not emptied when a schema is evicted from the validator cache), so memory grows slowly with the number of different patterns publishers have ever saved.
- A schema whose root refers to itself with `"$ref": "#"` does not compile (ajv cannot resolve it with schema registration off, which is off so that one organization's `$id` cannot collide with another's). Recursion through `#/definitions/...` or `#/$defs/...` works.
- The confidentiality check catches only a verbatim run of eight words from the private instructions or a system prompt. A paraphrase, a translation or an encoding passes.
- A workflow job runs in the job runner's worker, not through the workflow queue, because that queue's worker (`queues/workflow-run.queue.ts`) binds steps as the owner's own batch run. When the job's time budget ends the run row records "worker shutting down" as its error, which is the wrong label for a deadline; the job itself is recorded correctly as expired.
- A worker that dies mid-job holds the job until its lease lapses (the run's budget plus a minute, so up to 16 minutes); the lease is not renewed or shortened by a heartbeat, so a short job waits out a long lease before another worker takes it over.
- A buyer's copy of a marketplace agent that no install row points at any more is not recognised as a copy (see the provenance item under Skills), so it could be offered. The sellability check refuses every copy an install row still names.
- A product run that throws fails the job at once and refunds the buyer; only a deliverable that fails its checks is retried. In the proof run (`docs/AGENT-JOBS-RUN.md`, sections E1 and I) a connection timeout to the model provider failed three paid jobs this way. A failure before the model was reached is safe to retry inside the job's time budget; one after a tool ran is not, which is why nothing is retried today. The chat core would have to say which kind it was.
- The dashboard's hire, accept, reject and cancel buttons are shown to every member; a member who is not an owner or admin is refused by the API (`insufficient_role`) and told why, after clicking. The web app has no notion of the signed-in member's role to hide them with.
- `apps/web/e2e/jobs.spec.ts` needs the seeded demo organizations (a buyer with credits, a publisher with an agent), a running job worker and a reachable model; it skips itself without `E2E_DEMO_PASSWORD`. It is not part of any CI run, and no accessibility scan (axe) is installed for it.
- The sweeper loads each kind of overdue job oldest first, up to 1,000 a tick. Rows that fail on every tick are retried every tick and are not rotated behind the others.
- Job input and output are stored on the job row with no retention policy, and a deliverable larger than 512 KB fails the job.

## Authentication and API keys

- A member removed from an organization keeps access on routes guarded only by `requireAuth` until their token expires (up to 24 hours). Role-gated routes and token refresh check the current membership. Closing the rest needs a per-user session version checked on every request.
- API-key scopes are enforced on `/v1` (`agents:invoke`, `workflows:invoke`), on offerings and jobs, and on installing a listing (`marketplace:install`). Spend scopes must be granted by name. On the rest of the API `requireRole` still lets every API key through, so a key cut down to one scope can still call the routes that have no scope of their own.
- A key granted `jobs:review` or `marketplace:install` has no spend cap; only `jobs:hire` carries caps. Accepting releases money already in escrow and an install charges at most the listing's price, so the exposure is bounded by what the organization already committed or by one listing price per call.
- Rolling an agent back to a version that has no graph snapshot leaves the current graph in place.

## Skills, tool loop and graph engine

- A buyer's copy of a marketplace agent that no install row points at any more still runs without the trial restrictions. Recognising it needs a provenance column on `Agent`, written when the copy is made.
- The knowledge search route still returns the embedding provider's error body (`services/knowledge.ts`, `trySemanticSearch`).
- After a hard kill, per-request `MarketplaceRevenue` rows left pending and graph executions left `running` are not reaped.
- On shutdown, in-flight graph runs get 15 seconds to settle (`GRAPH_RUN_DRAIN_MS`) and the queue workers stop after that; the Fly `kill_timeout` is 60 seconds, so the order and the budget should be reviewed together.
- An agent chat may run for 120 seconds (`AGENT_CHAT_TIMEOUT_MS`), longer than the shutdown drain. A chat cut off by a deploy is cancelled and refunded; one cut off by a hard kill leaves its marketplace charge pending (see the reaper item above).
- `/v1` uses the API's global CORS policy; there is no per-route browser origin policy for it.
- The agent file store's count limit is enforced under a 30-second lease. An upload that was already fully sent when the lease lapsed can land late and exceed the limit by one file. Nothing is deleted, so no data is lost.

## SDK and CLI

- The SDK's route table is maintained by hand. Checking it against the API needs a route inventory exported from `apps/api`.
- There is no `wheelsai stop` command; `agents.stopDeployment` exists in the SDK.
- **The landing page's CLI preview shows output the CLI does not print (major):** a latency figure, a tool count, a treasury address and a marketplace listing for a command without `--publish`. It is scheduled with the agent `/v1` endpoint and measured latency work, which make the endpoint and the latency real.
- The API accepts `enableWallet` and `walletConfig` on an agent deployment and ignores them (agent budgets, phase 3).
- `wheelsai logs` for an agent deployment has no logs to show until deployment log streaming is built.

## Workflows and the scheduler

- A workflow answered through `/v1` with `stream: true` opens the stream at once and delivers the finished answer as chunks. It is not token by token.
- The scheduler worker runs one tick at a time: the tasks of a tick run in a pool, but the next tick waits for the slowest of them, retries included.
- A scheduled workflow run that fails sends `workflow.failed`, not `scheduled_task.failed`.
- A model step in a workflow has not been run against a live GPU deployment; no Nosana deployment can be started locally. The same holds for streaming on a model deployment through `/v1`.

## Deploy and billing

- If a request that changed the replica count crashed after Nosana applied the change, the time until the status worker reconciles the count (about 5 minutes plus one tick) is billed at the old count.
- When Nosana had already stopped a deployment and no stop time was recorded, the final billing window ends at the last billed second, so up to one billing interval goes unbilled.
- A training job that completes normally does not have its leftover Nosana vault reclaimed. Cancelled and failed training jobs, and every agent deployment, are handed to the orphan sweep.

## Custom domains

- **No certificate has been issued through the edge (major, blocks the claim).** The edge app, its addresses and its secrets do not exist yet (`docs/FOUNDER-ACTIONS.md` section 12). Everything up to the certificate authority was run locally (`docs/CUSTOM-DOMAIN-RUN.md`); the staging run listed there is what proves the claim.
- The dashboard pages for custom domains were type-checked and their wording unit-tested, but not opened in a browser against a running API.
- The host routing table holds every verified domain in each API machine's memory and reloads all of them every `CUSTOM_DOMAIN_ROUTE_REFRESH_MS`. A switch-off, new token or delete applies at once only on the machine that handled it; the others follow within one reload.
- The edge is one machine with one volume. A second machine needs shared certificate storage (a Caddy storage module), which is not built.
- The proof the checker asks for (`GET /.well-known/wheelsai-domain` through the edge) is a per-domain constant, answered for any verified domain including a paused one, and readable by anyone who can reach the hostname.
- An edge that asked about a hostname before it was verified is told "unknown" for up to 60 seconds after verification (the remembered answer), so the first certificate can be delayed by that long.
- The certificate question answers for a hostname only by its verified claim. Nothing limits how many unknown names one client can make the edge ask about, beyond the 60-second memory of "unknown".
- When the certificate question refuses a hostname because an issuance budget is spent (429 `issuance_budget_*`), the owner is not told why: the checker's handshake is refused by the edge and the domain reads as waiting for its certificate. The refusal is logged on the API only.
- The issuance budget counts every "yes" for a hostname without an observed certificate, including the repeats several simultaneous first handshakes cause, so a busy new hostname can use up to 5 of its organization's 30 for one certificate. It errs towards refusing.
- The per-organization domain limit and the issuance limits are server-wide settings (`CUSTOM_DOMAIN_MAX_PER_ORG`, `CUSTOM_DOMAIN_ISSUANCE_*`); there is no per-organization override for a customer who needs more.
- "Check now" (`POST /api/domains/:id/verify`) is limited only by the API's general rate limit; each call makes DNS lookups.
- Request counters count only forwarded requests made with the owning organization's credentials, and stop counting new domains beyond 10,000 buffered between flushes.
- Deleting a domain is two statements (the row, then its events), not a transaction; the worst case is orphan event rows.
- `API_HOST = "::"` (needed by the edge) also makes the API reachable by every app on the Fly organization's private network, with `X-Forwarded-For` trusted for one hop. Only the platform's own apps are on that network today.
- The PROXY protocol allow-list of the edge (`EDGE_PROXY_PROTOCOL_ALLOW`, default `172.16.0.0/12`) is the documented guess at where Fly's proxy connects from; it is confirmed or corrected on the first staging deploy.
- The deployments API reference page does not list `customEndpoint` yet; the custom-domains guide does.
- A member of an organization who owns no organization could not sign in during the proof run (`priya@northwind.ai`: "User has no organization"), so the owner-or-admin guard on domain writes was exercised by unit test only. The sign-in problem is outside custom domains and was not investigated.

## Web chat channel and Try it

- **Try it cannot preview an agent whose entrypoint is its graph (major, narrows the "every listing" claim).** A graph's nodes choose their own models and provider keys, so the run cannot be moved onto the platform's free models, and running it as it is would spend the publisher's keys for anonymous visitors. `runPublicChat` answers 501 `not_supported` / `graph_agent_preview` for such a listing, and `prepareAgentChat` refuses a platform-funded graph chat as a second guard. Closing it needs a model override that reaches every llm node of a graph run (`services/runAgentGraph.ts`).
- The limiter counts attempts, not answers: a message that is admitted and then fails at the model still uses one of the key's daily cap, or one of a listing's platform-funded messages for the day. A publisher-funded message is the exception (it is refunded, and its count with it).
- A wildcard origin is refused directly under a top-level name (`https://*.com`) but there is no public-suffix list, so `https://*.co.uk` is accepted.
- A widget message is counted against its key's limits and the owner's plan before the organization's free-model allowance (so a key's cap bounds what visitors can spend of that allowance). The other side of that order: while the allowance itself is used up, each refused widget message still uses one of the key's daily cap and one of the plan's API calls, at most the key's cap a day. Closing it needs a limiter that counts the key and the organization in one step.
- The widget has no per-session limit. Its session id is chosen by the client, so a limit on it would bound nothing; the per-address and per-key limits are what hold.
- All limiter keys share one Redis hash tag so the multi-key script runs in Redis Cluster, which also puts every public-chat counter in one slot.
- The limit of 20 live keys per agent is a count followed by an insert, not one statement: two creations at the same moment can leave an agent with 21. It bounds a list and guards nothing.
- A publisher-funded Try it message that finishes later than 15 minutes after its hold is refunded by the reaper even if its answer then arrives (the late settle changes nothing). Chats are cut off long before that (`AGENT_CHAT_TIMEOUT_MS`, at most 10 minutes), so the gap is only reachable by raising that limit past the reaper's.
- Publisher-funded message revenue is taken from the publisher's credits and recorded as `trial_usage` ledger rows and `trial_charges`; it is not yet in a platform revenue report.
- Limiter refusals (`rate_limiter_unavailable`) are logged at error level but raise no alert of their own; while Redis is down every widget and every Try it answers 503 by design.
- The widget's configuration and chat routes are also behind the API's global per-address limit (100 a minute, fails open). A site whose visitors share one address (an office, a carrier NAT) reaches the widget's own per-address limits first.
- A server started with no Redis at all answers no request on any route (seen in the proof run, `docs/WEB-WIDGET-RUN.md` section E4: nothing came back within 20 seconds). The public chat limiter itself reported "did not connect" and would have refused; the request never reached it. When Redis goes away under a running server the public routes answer 503 in milliseconds, as designed. What hangs a cold start is the API's other Redis-backed plumbing (the global rate limit and the queues), which is outside this feature.
- OpenClaw channel rows saved as `web` before the "Web Chat" option started creating a web chat key are still in the table. Nothing serves them and the public agent page shows them as "configured, not live yet"; they are not converted into keys.
- `apps/web/public/widget.js` is served with `Cache-Control: public, max-age=300` and no version in its address, so a fix reaches every embed within five minutes and a breaking change to the widget routes has to stay compatible with the script of five minutes ago.
- The widget was run in headless Chromium only (`e2e/widget.spec.ts` and the proof run). Firefox, Safari, a phone and a real screen reader have not been tried.
- The repository's `@playwright/test` and `playwright-core` want different Chromium builds; the two new specs were run with the installed one through a throwaway config. `npm run test:e2e` as configured needs `npx playwright install` first.
- The model catalog labels `free/groq/llama-3.3-70b` "GPT-OSS 120B (Groq)", and the Try it tab shows that label as the answering model. The label is the catalog's (it predates this work); whichever is true, the id and the label should name the same model.
