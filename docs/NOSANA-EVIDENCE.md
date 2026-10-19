# Nosana evidence — what WheelsAI has run on the network

One page for a reviewer: the account, the recordings, the runs with their real numbers, and the
code behind them. Everything below happened on the founder's real Nosana account, mainnet, an
API key paying with prepaid credits — nothing is a mock-up.

Read on 2026-10-19 with `scripts/nosana-access-check.ts` (read-only — GET requests only):

- **The account.** Mode `api_key`, network `mainnet`, key ends in `...fJNY`.
- **Deployments.** 36 in total, 17 of them named `wheelsai-*` (one archived, 35 stopped).
- **Credits.** Assigned $28.00, reserved $0.00, settled $23.357, available $4.643 —
  `assigned − reserved − settled`. The ledger carries `job_debit` rows at listing and
  `job_refund` rows for the unused part after each stop.

## The demo video

[demo-2026-10-13](https://github.com/blessedblockchain-sudo/WheelsAi/releases/tag/demo-2026-10-13)
— 2:59, recorded on the running product. It shows a small language model deployed from the
dashboard to a Nosana GPU (`wheelsai-model-37de52bb`, created 2026-10-12): provisioning to
`running` 93 seconds after the click, an inference answered in 3.275 s, then stopped. The
deployment is in the account's list above.

## The live runs, with what they cost

All three were driven through the platform's own screens and API. Times are UTC. The full
records, including each event and credit row, are in
[NOSANA-DEPLOY-RUN.md](NOSANA-DEPLOY-RUN.md).

### Third live run — 2026-10-11: an agent answered from a GPU the organization runs

The one that matters for the product claim: not a model answering, but an **agent** whose model
is `wheelsai/llama-3.2-3b`, answered from the organization's own deployment (`agent-brain-154326`,
Nosana id `5XXqtjo2o7t3uJCMBEVqtZyM6gaWVXJ8zBNYtiXK1fuF`, RTX 4090).

- 101 seconds from the click to `running` (the node had answered the platform's one-token
  request); stopped 10 seconds later by the user.
- The agent's first answer: **3,189 ms**, recorded in the platform's latency samples as
  surface `agent_playground`, provider `nosana`, 23 tokens out. No free provider took part.
- Cost: the organization's hold of $0.90 taken and returned, $0.01 of GPU seconds;
  on Nosana, $0.303 reserved at listing and returned within six minutes of the stop,
  settled credits $23.332 → $23.344 (the run cost the platform **$0.012**).
- After a stop, the agent answers `503 hosted_model_not_running` — nothing silently falls
  back to a free provider.

Full record: [Third live run](NOSANA-DEPLOY-RUN.md#third-live-run-an-agent-on-a-model-its-organization-runs-2026-10-11).

### First live run — 2026-10-08: the first deployment, end to end

RTX 4090, Llama 3.2 3B on Ollama, one replica, two attempts.

- Attempt 1 was refused by Nosana for a reason worth knowing: a credit-paid job needs a
  timeout of at least 3000 seconds. The create and start are accepted all the same; the
  refusal shows only in the deployment's events. Nothing was debited.
- Attempt 2: **44 seconds** from create to an online endpoint; the first chat was cold
  (**42.06 s** — the container loads the model on first request), the second took 1.08 s,
  warm ones 0.7–1.4 s.
- 204 billed seconds; **6 cents charged, the job cost $0.026** in all; the unused $0.277
  reservation came back as a `job_refund` row 6m47s after the stop.
- What it changed in the product: the 3000-second minimum is enforced before a deploy is
  admitted, cold starts are warmed by a one-token probe, and a deployment is `running` — and
  billed — only when a node has actually answered for its model.

Full record: [First live run](NOSANA-DEPLOY-RUN.md#first-live-run-2026-10-08).

### Second live run — 2026-10-08: markets, waiting, vLLM, and every ending

RTX 3060, A100 and RTX 4090 markets; Ollama and vLLM; deployments that had to wait for a node
and deployments no node ever took.

- With no node free, Nosana logs `JOB_RESERVE_SHORTFALL` and retries after 30 s, then 1, 2
  and 4 minutes. Nothing is listed or debited while a deployment waits. The 3060 got a node
  at the 30-second retry; the 4090 at the 4-minute one.
- The debit is the market's **host price** (the 3060's was $0.037 for 50 minutes); refunds
  arrive 3 to 10.5 minutes after a stop, always on a whole minute; billing is exact to the
  second from the row turning `running` to the stop.
- vLLM deployments work: the engine starts in about five minutes on a 4090 for a 7.6 GB
  model, and warm requests take about a quarter of a second.
- Two failure endings were exercised against Nosana for real — `no_capacity` and
  `start_timeout` — both ending the deployment, stopping it on Nosana and returning the
  customer's hold with nothing spent.
- Nosana's own `online` flag proved to be a hint, not the truth, in both directions (twice
  reported online with nothing behind it; once reported offline for half an hour while the
  engine answered). The platform probes the node's engine directly and decides on that.

Full record: [Second live run](NOSANA-DEPLOY-RUN.md#second-live-run-2026-10-08).

## The code

- [`services/nosana.ts`](../apps/api/src/services/nosana.ts) — the client: create, start,
  stop, replica updates, endpoints, events, credits, market costs, list, all reads paginated.
- [`services/nosanaDeploymentLifecycle.ts`](../apps/api/src/services/nosanaDeploymentLifecycle.ts)
  — holds, releases, per-second billing, restart, reclaim.
- [`services/nosanaCredits.ts`](../apps/api/src/services/nosanaCredits.ts) — the balance read
  and the deploy gate (estimate + floor, never from a cached value).
- [`services/nosanaAccessCheck.ts`](../apps/api/src/services/nosanaAccessCheck.ts) and
  [`scripts/nosana-access-check.ts`](../apps/api/scripts/nosana-access-check.ts) — the
  read-only check that produced the account numbers above; GET requests only.
- Commit history for the integration: `git log --grep=nosana` (66 commits as of this page).

## How to verify from Nosana's side

- The account behind the key ending `...fJNY` holds the deployments above, named `wheelsai-*`;
  the credit ledger shows the claims/top-ups and the `job_debit` / `job_refund` rows with the
  amounts quoted here.
- Every number on this page comes from the platform's own records of those API calls and the
  account's credit transactions.
