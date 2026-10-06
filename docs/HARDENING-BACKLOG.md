# Hardening backlog

Problems the October 2026 verification passes found and that are still open, with the reason each one was left. Everything critical or major from those passes is fixed; what remains here is minor unless marked. Add to this file instead of leaving a known problem only in a review thread, and delete an entry when its fix lands.

Updated 2026-10-06.

## Marketplace

- **Price changes on free and per-request installs need no acceptance (major).** A subscriber is protected: the agreed price is stored on the subscription, and a listing that leaves monthly pricing pauses the install until the buyer accepts the new terms. A buyer on a free or per-request install is still charged whatever the listing says at the time of each request, so a publisher can raise the per-request price under an existing install. Closing it needs the accepted pricing stored on the install and an acceptance step for increases. Planned with Offerings and Jobs, which reworks listing pricing.
- **A buyer's copy of a graph agent arrives needing configuration (major).** An install copies the graph, but any literal text in an API node's URL, headers or body, in a code node's source, or in the input of an `http_request` or `code_interpreter` tool node stays with the publisher, because nothing distinguishes a credential from harmless text. The buyer is told which nodes to fill in, not what the values were. A copy can arrive working once graphs can reference named secrets that each organization supplies for itself; that needs its own design, because a published graph must not be able to send a buyer's secrets to the publisher's server. Prompts, tools and source code are still copied as before.
- An owed contributor share is recorded and withheld from the publisher, but it is assigned to the contributor only when their payout profile exists, which happens when they open Revenue and Payouts. There is no background sweep.
- Shares that went to the publisher before contributor earnings were recorded are not recovered; nothing recorded them.
- A renewal that fails on every attempt is rotated to the back of the queue, not retired, and nothing alerts on it beyond the worker's error count.
- A subscriber who had not cancelled renewal keeps the 3-day grace period after a listing leaves monthly pricing, although no renewal can happen there.

## Authentication and API keys

- A member removed from an organization keeps access on routes guarded only by `requireAuth` until their token expires (up to 24 hours). Role-gated routes and token refresh check the current membership. Closing the rest needs a per-user session version checked on every request.
- API-key scopes are enforced only on `/v1` (`agents:invoke`, `workflows:invoke`). On the rest of the API `requireRole` lets every API key through. This is a listed prerequisite of Offerings and Jobs.
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
