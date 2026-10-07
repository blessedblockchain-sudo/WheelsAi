# Nosana deployments with an API key — what is proven, and the first paid run

**Date:** 2026-10-07 · **Branch:** `feat/bags-launchpad` (working tree on top of `688fe21`)
**Migration:** `20261011100000_nosana_access_mode`

The platform can pay Nosana in two ways, chosen by configuration: a Solana wallet (a vault per
deployment, funded in NOS and SOL), or a dashboard API key (prepaid USD credits, no vault). This
document has three parts:

1. **What was proven on this machine**, with the commands and their output.
2. **The checklist for the first paid run**, with a results table to fill in.
3. **What stays unverified until that run.** Between parts 2 and 3 is a section of what the
   read-only verification of 2026-10-07 settled, with its evidence.

**Nothing in part 1 was run against Nosana with a credential.** The only request that reached
Nosana is the unauthenticated public read of the market list. Everything else ran against a
stand-in Nosana API on 127.0.0.1 (`apps/api/src/tests/fakeNosanaApi.ts`). That proves **our
code**: what it sends, in what order, what it stores, what it bills, and what it refuses. It
proves nothing about how Nosana behaves. Part 3 lists what that leaves open.

---

## 1. What was proven on this machine

> **Note, 2026-10-07 (after everything recorded in this part).** Our Nosana code was checked
> against Nosana's current API: the published OpenAPI document, the deployment-manager and node
> sources, and read-only GETs with the founder's key. Nothing was created, started or stopped.
> The stand-in this part ran against modelled shapes Nosana no longer serves. It returned the
> deployment list as a bare array, embedded `jobs` and `events` in a deployment, accepted any key
> in a job definition, listed endpoints only once a deployment was running, and accepted a stop
> from any state. **The stand-in was re-based on the live response shapes on 2026-10-07**: a
> paginated list with `name` and `idempotency_key` filters, separate `/jobs` and `/events`
> routes, endpoints present from create with `online: false`, RUNNING as soon as start is
> called, a stop accepted only from RUNNING, ERROR or INSUFFICIENT_FUNDS, the strict
> job-definition key check, and both `/api/*` and `/*` paths.
>
> **Every loopback transcript and test count below (1.1 to 1.7) predates that re-base** and is
> left as recorded. They still show what our code sent, stored, billed and refused at the time.
> They no longer show that it matches Nosana. Three things in them are known to be wrong against
> the live API: the access check's list read (1.3; against Nosana it printed "unreadable: HTTP
> 200, body is not an array"), `running` as soon as Nosana reports RUNNING (1.2 and 1.7; billing
> would have started with no node serving), and the Ollama definition those runs sent (it cannot
> start under the image's own entrypoint). The fixes are listed at the top of part 2. Re-run 1.2
> or 1.7 against the re-based stand-in before quoting a transcript as current.

### 1.1 Unit tests

```
$ npm run -s test:unit -w @wheelsai/api          (from the repository root, after the last edit)
# tests 4283
# pass 4283
# fail 0
# skipped 0
```

The tests that belong to this work, and what each file shows:

| File (`apps/api/src/tests/`) | Tests | What it shows |
|---|---|---|
| `nosanaAccessConfig.unit.test.ts` | 19 | Every combination of the two credentials and `NOSANA_ACCESS_MODE`; both set with no mode is refused at boot; the key is never in a message. |
| `nosanaCredits.unit.test.ts` | 14 | The balance read: 401 and 403 are `nosana_auth_failed`, anything else unreadable is `nosana_credits_unavailable`; the gate needs estimate + floor and never admits from a cached value. |
| `nosanaMarketCosts.unit.test.ts` | 11 | Cost per second from the market list, rounded up; an unpriced market has no cost. |
| `nosanaCreditsLifecycle.unit.test.ts` | 23 | The funding seam with credits: no vault call, release decided for each of Nosana's eight states. |
| `nosanaClientApiKey.unit.test.ts` | 27 | The real `@nosana/sdk` client against the stand-in: create, start, running, scale, stop, released, with 0 vault calls and 0 Solana RPC requests. |
| `nosanaAccessCallers.unit.test.ts` | 20 | The routes: the 503 before anything is reserved, the access mode stored with the id, restart after a halted run, `previous_run_other_account`. |
| `nosanaAccessWorkers.unit.test.ts` | 13 | The status and billing workers pass each row's own mode; a row with no credential here is skipped and reported once per tick. |
| `nosanaAccessAgents.unit.test.ts` | 6 | Agent deploy and stop; OpenClaw start and restart answer 501 `nosana_one_shot_unavailable`. |
| `platformCompute.unit.test.ts` | 26 | The operator view and its admin gate; the public "GPU compute" status component. |
| `nosanaAccessCheck.unit.test.ts` | 11 | The read-only check script: GET only, no credential printed, the key not sent to the public market list. |

The wallet path's own suites pass with no edits (`git diff` shows none):
`nosanaDeploymentLifecycle.unit.test.ts` 41 of 41 and `nosanaClient.unit.test.ts` 22 of 22.
That is the test for "wallet mode is unchanged".

The tests that use the stand-in also pass with networking off (a network namespace with only
loopback up, where an outbound `curl` fails): the first two build steps ran their 94 and 44
tests that way.

Web (`apps/web`): `src/lib/deployments.unit.test.ts`, 11 tests, pins the dashboard wording
(the "paused" message, the note on a run that ended, no vault wording on the deployment pages).

### 1.2 The whole flow against the stand-in (build step 2)

**This proves our code, not Nosana's behaviour.** The stand-in holds a fixed balance, starts and
stops a deployment on a timer, and has no GPU.

Setup:

```
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=127.0.0.1" \
  -addext "subjectAltName=IP:127.0.0.1" -keyout node.key -out node.crt
docker exec wheelsai-postgres psql -U wheelsai -d postgres \
  -c 'CREATE DATABASE wheelsai_chainn2 TEMPLATE wheelsai'
DATABASE_URL=<copy> npx prisma migrate deploy                                   (packages/db)
FAKE_START_MS=12000 FAKE_STOP_MS=4000 FAKE_NODE_TLS_CERT=node.crt FAKE_NODE_TLS_KEY=node.key \
  npx tsx scripts/nosana-fake-api.ts                                            (apps/api)
```

API environment: `DATABASE_URL=<copy>`, `REDIS_URL=redis://localhost:6380/9`, `API_HOST=127.0.0.1`,
`API_PORT=4320`, `NODE_ENV=development`, `NOSANA_WALLET_PRIVATE_KEY=` (empty),
`NOSANA_API_KEY=<the stand-in's test key>`, `NOSANA_ACCESS_MODE=api_key`,
`NOSANA_API_URL=http://127.0.0.1:4310`, `NOSANA_CREDITS_CACHE_MS=0`,
`SOLANA_RPC_URL=http://127.0.0.1:4312`, `ALLOW_LOOPBACK_NODE_URLS=true`, `ALLOW_NOSANA_MOCK=false`,
`NODE_EXTRA_CA_CERTS=node.crt`, `DEPLOYMENT_STATUS_INTERVAL_MS=5000`, `GPU_BILLING_INTERVAL_MS=5000`,
every other `*_INTERVAL_MS=0`, `X402_SETTLEMENT_WORKER_ENABLED=false`, `JOB_RUNNER_CONCURRENCY=0`,
`WORKFLOW_RUN_CONCURRENCY=0`, `PAYOUTS_ENABLED=false`; then `npx tsx src/index.ts`.

Boot log: `Nosana API key loaded keySuffix: 0001 network: mainnet customBackend: true`; only
`Deployment status BullMQ queue started` and `GPU billing BullMQ queue started`. The key string
occurs 0 times in the API log. Signed in as the seeded demo owner.

`GET /api/models?tier=gpu` listed 3060 0.36, 4070 0.54, 4090 0.9, a100 2.88, h100 5.4: the
mainnet tiers, although `SOLANA_NETWORK=devnet`.

The first attempt advertised an `http` node endpoint; the platform accepts `https` endpoints
only, so the row stayed `provisioning`. It was stopped and the stand-in's node was given a
certificate. What follows is the second attempt.

```
balance before: 184150
POST /api/deployments {name "Rehearsal Llama 2", modelId llama-3.2-3b, gpuTier 4090, engine ollama, replicas 1}  [05:00:07Z]
  {"deployment":{"id":"74229f1e-b17a-48e6-af33-19348736d0f5","name":"Rehearsal Llama 2","slug":"rehearsal-llama-2","status":"pending"},"message":"Deployment created. Provisioning GPU node..."}  HTTP 201
row 3 s later (status|nosana_job_ids|nosana_access_mode|reservation_cents|run_generation):
  provisioning|{fakedm0001}|api_key|90|0
balance 184060; ledger: -90|deployment_reservation|184060
watch (status|billed_through_at): 05:00:11Z provisioning| ... 05:00:17Z provisioning| 05:00:20Z running|2026-10-07 05:00:20.071
GET /api/deployments/<id>: status running, endpoint /v1/rehearsal-llama-2/chat/completions, replicas 1, node healthStatus healthy latencyMs 3
deployment_nodes: https://127.0.0.1:4311|healthy
ledger at 05:01:45Z:
  05:01:05|-1|gpu_usage|184059|GPU usage (4090 x1, 40s)
  05:01:45|-1|gpu_usage|184058|GPU usage (4090 x1, 40s)
PATCH /api/deployments/<id> {"replicas":2} [05:01:45Z] -> HTTP 200, replicas 2, reservationCents 180
  05:01:45|-90|deployment_reservation|183968|GPU deployment reservation (4090 x1, 1h)
  05:01:45|-1|gpu_usage|183967|GPU usage (4090 x1, 6s, before replica change)
  05:02:10|-1|gpu_usage|183966|GPU usage (4090 x2, 20s)
DELETE /api/deployments/<id> [05:02:23Z] -> {"message":"Deployment stopped","fundsReleased":false,"vaultReclaimed":false}  HTTP 200
row right after (status|reason|reservation_released_at|vault_reclaimed_at|gpu_stopped_at):
  stopped|user_stopped|2026-10-07 05:02:23.536||2026-10-07 05:02:23.536
row at 05:02:30Z: stopped|user_stopped|2026-10-07 05:02:23.536|2026-10-07 05:02:30.043
  05:02:23|180|deployment_reservation_release|184146|GPU deployment reservation released (user_stopped)
  05:02:23|-1|gpu_usage|184145|GPU usage (4090 x2, 18s, final)
balance 184145; sum of the deployment's ledger rows -5; nodes left 0; orphan records 0
GET /api/deployments/<id>/logs -> [('start','start requested'),('stop','stop requested')]
stand-in log: POST /api/deployments/create -> 200; POST .../fakedm0001/start -> 200;
  "wheelsai-model-74229f1e-b17a-48e6-af33-19348736d0f5-r0 is STARTING" 05:00:07, RUNNING 05:00:20;
  PATCH .../update-replica-count -> 200 05:01:45; POST .../stop -> 200 05:02:23; STOPPING, STOPPED 05:02:27
stand-in at shutdown: "50 Nosana requests, 0 vault requests, 25 node probes, 0 Solana RPC requests"

POST /api/deployments/<id>/restart [05:03:05Z] -> {"message":"Deployment restarting","deployment":{"id":"74229f1e-...","status":"pending"}}  HTTP 200
row at 05:03:20Z (status|ids|mode|run|replicas|reservation): running|{fakedm0001}|api_key|1|2|180; name on the stand-in ...-r1
DELETE -> {"message":"Deployment stopped","fundsReleased":false,"vaultReclaimed":false} HTTP 200; then stopped, reservation released, release confirmed; balance 184144

kill -USR1 <stand-in pid>   (balance $1, floor $5); deployments 11, ledger rows 76
POST /api/deployments -> {"error":"compute_capacity_unavailable","reason":"nosana_credits_low","message":"New GPU deployments are paused while the platform's compute balance is topped up. Nothing was reserved."}  HTTP 503
POST /api/deployments/<id>/restart -> the same body, HTTP 503
after: deployments 11, ledger rows 76, balance 184144
API log for the refusal (operator only): reason nosana_credits_low, tier 4090, replicas 1, requiredMicroUsd 5806400, availableMicroUsd 1000000
```

What that shows about our code: the access mode is stored in the statement that stores the
Nosana id; a deployment goes `pending`, `provisioning`, `running` from the status worker; GPU time
is billed per second at the confirmed replica count; a stop releases the hold exactly once and
bills the final window; `fundsReleased` is `false` while the stand-in reports `STOPPING` and the
status worker confirms the release on a later tick; a restart is not blocked by the previous run;
a low balance refuses a create and a restart with no row and no ledger entry; and no vault route
and no Solana RPC is touched with an API key.

Two things seen in that run. The hold for one 3060 hour was 37 cents, not 36 (0.0001 x 3600 x
100 is 36.00000000000001 in floating point and the gate rounded up); that is fixed since: the
hold is worked out in whole micro-dollars and is 36 cents. And a partial billing window at a
replica change or a stop is charged a whole cent, which is left as it is.

### 1.3 The operator view, the status component and the check script against the stand-in (build step 3)

Same arrangement, with **no worker running** (every `*_INTERVAL_MS=0`), a database copy
`wheelsai_chainn3` with the migration applied, Redis index 9, and `PLATFORM_ADMIN_KEY` set to a
value made up for the run (`$K` below).

```
$ curl -s -w "  HTTP %{http_code}\n" http://127.0.0.1:4320/api/platform/compute
{"error":"invalid_admin_key"}  HTTP 401
$ curl -s -w "  HTTP %{http_code}\n" -H "x-admin-key: wrong" http://127.0.0.1:4320/api/platform/compute
{"error":"invalid_admin_key"}  HTTP 401

$ curl -s http://127.0.0.1:4320/api/status      (status, then components)
operational [{"id": "database", "name": "Database", "status": "operational", "latencyMs": 89}, {"id": "redis", "name": "Queues and cache", "status": "operational", "latencyMs": 93}, {"id": "gpu_compute", "name": "GPU compute", "status": "operational", "latencyMs": null}]

$ curl -s -H "x-admin-key: $K" http://127.0.0.1:4320/api/platform/compute
{"generatedAt":"2026-10-07T05:27:04.390Z","mode":"api_key","network":"mainnet","configured":true,"credentials":{"wallet":false,"apiKey":true,"apiKeySuffix":"0001"},"timeout":{"unit":"seconds","explicit":false},"warnings":["NOSANA_TIMEOUT_UNIT is unset, so deployment timeouts are sent as seconds; the public deployment-manager source reads them as minutes - confirm the unit before a long-running deployment"],"credits":{"state":"ok","reason":null,"assignedUsd":100,"reservedUsd":0,"settledUsd":0,"availableUsd":100,"minRequiredUsd":5,"minimumDeployUsd":5.1008,"warnUsd":20,"checkedAt":"2026-10-07T05:27:04.391Z"},"wallet":null,"marketCosts":{"state":"ok"},"tiers":[{"tier":"3060","name":"RTX 3060","marketAddress":"7AtiXMSH6R1jjBxrcYjehCkkSF7zvYWte63gwEDBcGHq","deployable":true,"retailUsdPerHour":0.36,"costUsdPerHour":0.0504,"marginPct":86,"belowCost":false},{"tier":"4070", ... "costUsdPerHour":null,"marginPct":null,"belowCost":null},{"tier":"4090", ... "retailUsdPerHour":0.9,"costUsdPerHour":0.4032,"marginPct":55.2,"belowCost":false}, ...],"nosana":{"state":"ok","accounts":[{"mode":"api_key","state":"ok","listed":0,"running":0,"error":null}],"listed":0,"running":0,"graceMinutes":15,"untracked":[],"untrackedTruncated":false},"running":{"deployments":0,"replicas":0,"retailUsdPerHour":0,"estimatedCostUsdPerHour":0},"unreachable":{"rows":[],"truncated":false},"rows":{"state":"ok"}}
```

(The stand-in prices two markets, so three tiers read "cost unknown" here. This run was made
before the `untrackedDrafts` list was added to the body; the unit tests cover it.)

A deployment was then created and started on the stand-in directly, with no row of ours, and one
demo row in the copy was marked `running` with a Nosana id and no access-mode stamp (a row from
before API-key access):

```
nosana    {"state": "ok", "accounts": [{"mode": "api_key", "state": "ok", "listed": 1, "running": 1, "error": null}], "listed": 1, "running": 1, "graceMinutes": 15, "untracked": [], "untrackedTruncated": false}
running   {"deployments": 1, "replicas": 1, "retailUsdPerHour": 0.9, "estimatedCostUsdPerHour": 0.4032}
unreachable {"rows": [{"source": "model", "rowId": "1e41149e-cb70-44b2-ba52-fff0a55cb5cc", "nosanaDeploymentId": "walletEraDeployment1", "accessMode": "wallet", "status": "running"}], "truncated": false}
```

The untracked deployment is not listed yet because it is younger than the 15-minute grace period
(the unit tests cover the listing once it is older). The wallet-era row is listed as unreachable
because this process holds no wallet.

The read-only check script against the stand-in, with the stand-in's key:

```
$ DOTENV_CONFIG_PATH=/dev/null NODE_ENV=development NOSANA_API_KEY=<stand-in key> \
  NOSANA_API_URL=http://127.0.0.1:4310 npx tsx scripts/nosana-access-check.ts
Nosana access check - read-only (GET requests only, nothing is created, started or stopped)
time: 2026-10-07T05:27:28.782Z

mode (pays for new deployments): api_key
network: mainnet
backend: http://127.0.0.1:4310
API key: set, ends in ...0001
wallet key: not set
timeout unit sent to Nosana: seconds (default; NOSANA_TIMEOUT_UNIT is not set)
warning: NOSANA_TIMEOUT_UNIT is unset, so deployment timeouts are sent as seconds; the public deployment-manager source reads them as minutes - confirm the unit before a long-running deployment

credits (GET /api/credits/balance)
  assigned:  $100.0000
  reserved:  $0.0000
  settled:   $0.0000
  available: $100.0000  (assigned - reserved - settled)
  floor (NOSANA_MIN_CREDITS_USD): $5.00; warning below $20.00
  verdict: above the warning threshold
  raw: {"assignedCredits":100,"reservedCredits":0,"settledCredits":0}

deployments (GET /api/deployments)
  total: 1
  by status: STARTING 1
  named wheelsai-*: 1
    wheelsai-model-3f0c2f0e-6a57-4b53-9f43-0d1b2c3d4e5f-r0  STARTING  id fakedm0001  created 2026-10-07T05:27:18.448Z

raw fields of one existing deployment (what this kind of account returns)
  id:     "fakedm0001"
  status: "STARTING"
  owner:  "11111111111111111111111111111111"
  vault:  "11111111111111111111111111111111"
  owner parses as a Solana public key: yes
  vault equals owner: yes
  timeout: 7200  strategy: "SIMPLE-EXTEND"  replicas: 1
  fields: active_revision, confidential, created_at, endpoints, events, id, jobs, market, name, owner, replicas, status, strategy, timeout, updated_at, vault
  ...
requests sent: 3, all GET
```

(After this output was recorded the script was changed to read the newest `wheelsai-*`
deployment when the account has several, and to print its name above the id.)

The `owner` and `vault` values above are the stand-in's, not Nosana's. What a real API-key
account returns there is exactly what this script is for (checklist step 2).

With the stand-in's balance set to $1 (`kill -USR1 <pid>`), then restored (`kill -USR2 <pid>`):

```
credits {"state": "blocked", "reason": null, "assignedUsd": 1, "reservedUsd": 0, "settledUsd": 0, "availableUsd": 1, "minRequiredUsd": 5, "minimumDeployUsd": 5.1008, "warnUsd": 20, "checkedAt": "2026-10-07T05:28:01.672Z"}
GET /api/status -> degraded {"id": "gpu_compute", "name": "GPU compute", "status": "paused", "latencyMs": null}
(balance restored)
GET /api/status -> operational {"id": "gpu_compute", "name": "GPU compute", "status": "operational", "latencyMs": null}
```

The public body carries the word "paused" and nothing else: no amount, no reason. The stand-in
at shutdown: `67 Nosana requests, 0 vault requests, 0 node probes, 0 Solana RPC requests`. The
key string occurs 0 times in the API log. Both processes were stopped, Redis index 9 was flushed
and the database copy was dropped; the main local database was not migrated or written.

### 1.4 The public market read (the one request that reached Nosana)

No credential was configured and none was sent.

```
$ DOTENV_CONFIG_PATH=/dev/null NOSANA_NETWORK=mainnet NODE_ENV=production \
  npx tsx scripts/nosana-access-check.ts                                         (apps/api)
Nosana access check - read-only (GET requests only, nothing is created, started or stopped)
time: 2026-10-07T05:22:53.981Z

mode (pays for new deployments): none
network: mainnet
backend: https://dashboard.k8s.prd.nos.ci
API key: not set
wallet key: not set
timeout unit sent to Nosana: seconds (default; NOSANA_TIMEOUT_UNIT is not set)

No Nosana credential is configured: the API would answer 501 to a deployment. Only the public market list is read.

market cost per tier (GET /api/markets/, no credential sent)
  markets listed: 47, priced: 46
  tier   market                                        host $/h  fee%   cost $/h  retail $/h  margin
  3060   7AtiXMSH6R1jjBxrcYjehCkkSF7zvYWte63gwEDBcGHq    0.0436    10     0.0504      0.3600   86.0%
  4070   EzuHhkrhmV98HWzREsgLenKj2iHdJgrKmzfL8psP8Aso    0.0873    10     0.0972      0.5400   82.0%
  4090   97G9NnvBDQ2WpKu6fasoMsAKmfj63C9rhysJnkeWodAf    0.3636    10     0.4032      0.9000   55.2%
  a100   F3aGGSMb73XHbJbDXVbcXo7iYM9fyevvAZGQfwgrnWtB    0.5545    10     0.6120      2.8800   78.8%
  h100   Crop49jpc7prcgAcS82WbWyGHwbN5GgDym3uFbxxCTZg    1.3636    10     1.5012      5.4000   72.2%
  cost = host reward x (1 + fee), rounded up to a whole micro-USD per second. Whether the fee is added for credit-paid deployments is unverified.

requests sent: 1, all GET
```

What this shows: the market list is readable with no credential; our five built-in market
addresses are in it and priced; every retail price is above the listed cost with the 10% fee
added. "cost $/h" is our rounding (up to a whole micro-USD per second), so it is slightly above
host reward x 1.1.

The script refuses anything but a read:

```
$ npx tsx scripts/nosana-access-check.ts --stop abc
This script only reads, and takes no arguments (got: --stop abc). Nothing was requested.
exit=2
```

### 1.5 The timeout unit: what public sources say

Not measured. The public source of Nosana's deployment manager
(`github.com/nosana-ci/nosana-deployment-manager`, commit `127f915`, 2026-10-05) says the
`timeout` of a deployment is in **minutes**: the create schema reads "Timeout in minutes, must
be at least 1 minute", the worker that lists the job sends `timeout * 60` to the jobs API, and
the update-timeout route has a minimum of 60. `timeout * 60` has been in its history since at
least 2025-10-29. The installed SDK (0.4.74, published 2026-01-08) says "seconds" in one JSDoc,
which looks stale. Not verified: that the production host runs this code.

Our own arithmetic is in seconds everywhere. The value is converted only where it is sent to
Nosana, rounded up, according to `NOSANA_TIMEOUT_UNIT`, and the vault funding and the credit
estimate are sized from the timeout as sent.

**The default is `minutes`** (changed after the runs recorded above, which is why their output
says `seconds` and shows `timeout 7200`; the same create now sends 120). It is what the source
above reads, and it is the cheaper way to be wrong: seconds sent to a backend that reads minutes
holds sixty times the funds (the old default 7200 would have meant five days per replica), while
minutes sent to a backend that reads seconds ends the job early and costs almost nothing. Until a
paid run has confirmed the unit, the API logs a warning when its Nosana client starts with the
variable unset, and the operator view repeats it.
**Checklist step 5 measures it. Until then, do not start a long deployment.**

### 1.6 After the review: four fixes (2026-10-07)

A code review found four defects on the edges of the access-mode switch. Each is fixed and
pinned by tests against the stand-in; the counts in 1.1 and the outputs in 1.2 and 1.3 were
recorded before these fixes and are left as they were.

| Defect | What the code does now | Tests |
|---|---|---|
| A training job did not store or pass its access mode, so its orphan record read as the wallet's and an API-key training deployment could never be stopped by the sweep. | The mode is stored in the same write as the id; cancel stops through it; the orphan record on a cancel or a failed submit carries it (`services/trainingNosana.ts`, called from `routes/training.ts`). | `trainingNosanaAccess.unit.test.ts`, 7 |
| A running row whose account has no credential here kept being charged, and its owner could not stop it. | The billing worker charges nothing for such a row and moves its cursor forward, so the gap is not billed later either. An owner's stop is accepted: the row is stopped and the hold released with no final charge; the Nosana id stays for the reclaim sweep (an agent row writes an orphan record) and the operator view lists it. The deployment on Nosana is not stopped until the credential is back. | `nosanaAccessWorkers` (3), `nosanaAccessCallers` (2), `nosanaAccessAgents` (2) |
| Making the API key primary moved the wallet client to mainnet too, cutting off wallet deployments created on devnet. | One network per credential: the wallet keeps the one derived from `SOLANA_NETWORK`, the key uses mainnet, whichever is primary. An explicit `NOSANA_NETWORK` still moves both. Markets resolve, and market costs are read, for the network of the account a row belongs to. A boot warning names both networks when they differ. | `nosanaAccessConfig` (1 new, 1 changed), `nosanaClientApiKey` (2) |
| With API-key access an unknown market cost was replaced by the retail price, so the below-cost check was skipped and the credit estimate could be too low. | Nothing is admitted on an unknown cost: `503`, reason `gpu_cost_unavailable`, before anything is reserved, for create, restart and scale-up. The last cost seen for a market stands in for up to 24 hours (an outage of the public list does not pause deployments at once), and a market last seen above retail stays refused. Retail still stands in for the figures that admit nothing: the runway, the operator view, the public status minimum. | `nosanaMarketCosts` (4), `nosanaClientApiKey` (4), `nosanaAccessCallers` (1) |

Two things the review noted below that bar are written in `docs/HARDENING-BACKLOG.md` ("Nosana
access") and not changed: wallet funding of a batch timeout that is not a whole number of
minutes when the unit is minutes, and the credit gate under-estimating by sixty times if the
unit is wrong.

### 1.7 Re-run after the timeout default became minutes (2026-10-07)

The same loopback flow as 1.2, run again on the final code with a 3060, a balance of $15 on the
stand-in and `NOSANA_TIMEOUT_UNIT` unset. It still proves our code and not Nosana's behaviour.

```
balance before: 184150 cents
[06:06:55Z] POST /api/deployments {name "Rehearsal 3060", modelId phi-3-mini, gpuTier 3060, engine ollama, replicas 1} -> 201, status pending
row (status|ids|mode|hold cents|reason|released): provisioning|{fakedm0001}|api_key|36||f
what the stand-in received: name wheelsai-model-ac577427-b178-4eb7-bf80-5f5f7aff125a-r0, timeout 120,
  strategy SIMPLE-EXTEND, replicas 1, confidential true
[06:07:05Z] running|{fakedm0001}|api_key|36||f
GET deployment: status running, endpoint /v1/rehearsal-3060/chat/completions, nodes ["healthy"]; the access mode is not in the response
operator view 200: mode api_key, network mainnet, key suffix 0042, timeout {"unit":"minutes","explicit":false},
  credits low available $15, running {"deployments":1,"replicas":1,"retailUsdPerHour":0.36,"estimatedCostUsdPerHour":0.0504},
  untracked 0, unreachable 0; without the admin key: 401; the key string is not in the body
public status: {"id":"gpu_compute","name":"GPU compute","status":"operational","latencyMs":null}
[06:08:20Z] DELETE -> 200 {"message":"Deployment stopped","fundsReleased":false,"vaultReclaimed":false}
row after 9 s: stopped|{fakedm0001}|api_key|36|user_stopped|t
ledger:
  06:06:55|-36|deployment_reservation|184114|GPU deployment reservation (3060 x1, 1h)
  06:08:20|36|deployment_reservation_release|184150|GPU deployment reservation released (user_stopped)
  06:08:20|-1|gpu_usage|184149|GPU usage (3060 x1, 76s, final)
balance after: 184149 cents; orphan records: 0; the stand-in reports STOPPED

kill -USR1 <stand-in pid>   (balance $1)
POST /api/deployments -> 503 {"error":"compute_capacity_unavailable","reason":"nosana_credits_low","message":"New GPU deployments are paused while the platform's compute balance is topped up. Nothing was reserved."}
deployments|ledger rows before: 10|66  after: 10|66
public status: {"id":"gpu_compute","name":"GPU compute","status":"paused","latencyMs":null}, overall degraded
operator view credits: blocked, available $1 (floor $5, to deploy $5.1008)
stand-in totals: 0 vault requests, 0 Solana RPC requests; the key string occurs 0 times in the API log
```

What changed against 1.2: the job timeout of 7,200 seconds reaches Nosana as 120, and one hour of
a 3060 is held as 36 cents. A 3060 accrues a cent every 100 seconds, so a run of 76 seconds has
no usage row until the stop bills its final window.

---

## 2. The first paid run — checklist

The founder runs this with the key present. Record each result in the table at the end. Stop at
the first step whose result is not the expected one.

### The account, the balance and the key (read on 2026-10-07)

- **The Nosana account is shared with the founder's other project.** Its deployments are on the
  same list (19 at the verification, all STOPPED or ARCHIVED) and **its spend lowers the same
  balance**. If it starts or extends a deployment during this run, the figures recorded here
  move for a reason that is not ours, and a deployment of ours can be halted by its spend.
  INSUFFICIENT_FUNDS hits every deployment on the shared balance. Keep the other project idle
  for the length of the run, or record what it did.
- **Available credit at the verification was $5.091**: $28 assigned, $0 reserved, $22.909
  settled (available = assigned − reserved − settled; the fields are USD, not cents). The only
  recent top-up was $5. That is not the "about $15" this checklist was written for. Against the
  $5 floor the 3060 create passes by about $0.04 ($5.0504 needed), and the 4070 serving deploy
  of `docs/FINE-TUNE-RUN.md` ($5.097 needed) is refused.
- **Recommended starting balance: about $15 available, so top up about $10 before step 1.**
  Each SIMPLE-EXTEND extension debits another full timeout, and with $5.091 the only headroom
  for it is the floor itself. The alternative is to lower `NOSANA_MIN_CREDITS_USD` for the run
  and write the value used in the results table. Topping up is the better choice, because the
  floor is also what keeps the other project's deployments from being halted by ours.
- **Replace the key before the run.** The key now in `apps/api/.env` holds every scope,
  including `api-keys:manage` (it can read the plaintext of every key on the account),
  `wallet:sign` and `oauth-apps:manage`. **It was also pasted into a chat, so treat it as
  disclosed.** In deploy.nosana.com, Account, API Keys: create a new key with only
  `credits:read`, `deployments:read`, `deployments:write` and `jobs:read`, put it in the API's
  environment, run step 1 with it, then revoke the all-scope key. Keys carry `expiresAt: null`:
  there is no mandatory expiry, so revoking is the only way the old key stops working. A missing
  scope answers 403 with code `INSUFFICIENT_SCOPE`; if step 1 or step 4 shows that, the new key
  lacks a scope, which is a configuration error and not an outage.
- **Secrets in job definitions are readable by every holder of an account key.** A confidential
  definition (environment values included) comes back in clear from `/deployments/{id}/revisions`
  and `/deployments/{id}/jobs/{job}`. The Ollama deployment of this run carries no secret. The
  fine-tuning run does (callback secret, signed URLs). A Nosana account that only WheelsAI uses
  is in `docs/HARDENING-BACKLOG.md`.

### The code this checklist assumes

The verification found defects that would fail, misbill or misread this run. **Do not start
until each of these is committed and the unit suite passes against the re-based stand-in:**

| Fix | Without it |
|---|---|
| The deployment list is read as a paginated object (`?limit=100`, following `pagination.cursor_next`), and the name lookup uses the exact `?name=` filter. | Step 1 exits non-zero with "body is not an array". A create whose response was lost cannot be found. |
| The Ollama definition sets `entrypoint: ["/bin/sh", "-c"]`, pins `docker.io/ollama/ollama:0.32.6` and declares an HTTP health check on `/api/tags`. | The container runs `/bin/ollama /bin/sh -c ...` and exits. Step 7 never reaches a healthy node, and the prepaid timeout is spent anyway. |
| The Ollama script pulls the model through a server on `127.0.0.1:11435`, ends it, and only then starts the server on the exposed port 11434. | `/api/tags` answers 200 before the model is there: the endpoint turns `online: true`, the row goes `running` and is billed, and `/v1` answers "model not found" for as long as the download takes. |
| A halted deployment (ERROR, INSUFFICIENT_FUNDS) is failed and stopped even when its events cannot be read. | A failing `/deployments/{id}/events` (a 5xx, or a key whose scopes do not cover it) leaves the row `running` and billed, and no stop is sent. |
| A deployment whose start failed and that still reads DRAFT stays with the reclaim sweep for 10 minutes. | A start that passed its 30 s deadline and lands afterwards runs on platform credits with a failed row and nobody billed. |
| A row becomes `running`, and GPU billing starts, only when an endpoint reports `online: true`. | Nosana reports RUNNING as soon as the listing task is scheduled, before any node holds the job. The customer is billed through queueing, image pull and model load. |
| Jobs and events are read from `/deployments/{id}/jobs` and `/deployments/{id}/events`. | A deployment no longer embeds them. Failure reasons read `nosana_error`, and training never learns its job. |
| `required_vram` is no longer in the training job definition. | Not this run's concern; the fine-tuning create is refused with a 400. |

One free check before any spend, on a machine with Docker:
`docker image inspect docker.io/ollama/ollama:0.32.6 -f '{{json .Config.Entrypoint}}'` (after a
`docker pull` of that tag). Expected: `["/bin/ollama"]`. The entrypoint was read from the
upstream Dockerfile, not from a pulled image. The fixed definition is right whatever it prints;
record what it prints.

### Before anything is spent

**Environment** (the API's environment only; never the web app's):

| Variable | Value | Why |
|---|---|---|
| `NOSANA_API_KEY` | the new, narrow key | Created at deploy.nosana.com, Account, API Keys, with the scopes `credits:read`, `deployments:read`, `deployments:write`, `jobs:read` and no others. The all-scope key is revoked once step 1 passes with this one. Keys have no mandatory expiry. |
| `NOSANA_ACCESS_MODE` | `api_key` | Says which account pays. Required if the wallet key is also set. |
| `NOSANA_NETWORK` | `mainnet` | The default with an API key; set it so it is on record. `SOLANA_NETWORK` can stay as it is. **If the wallet key is also set and its deployments are on devnet, leave this unset instead**: set, it moves the wallet to mainnet as well. |
| `NOSANA_TIMEOUT_UNIT` | `minutes` | The default. **Settled as minutes** by the API document, the deployment-manager source and the timing of live deployments on this account (see "Settled"). Set it so it is on record and the start-up warning stops. Step 5 confirms it on a deployment of ours. |
| `NOSANA_JOB_TIMEOUT_SECONDS` | `600` | The minimum our configuration accepts. Sent as 10 with the unit above. |
| `NOSANA_MIN_CREDITS_USD` | `5` | The floor. |
| `PLATFORM_ADMIN_KEY` | at least 16 characters | For the operator view. |
| `DEPLOYMENT_STATUS_INTERVAL_MS` | above 0 | Without the status worker a deployment never reaches `running`. |
| `GPU_BILLING_INTERVAL_MS` | `60000` | Per-second billing of the organization. |
| `ALLOW_NOSANA_MOCK` | unset | The mock must not stand in for Nosana. |

**Balance to load: the floor plus a margin, about $15 available with the $5 floor.** Today's
$5.091 is not enough (see above): top up first. A deployment is admitted only when its estimate
plus the floor is available, and the floor must still be there for the extensions, the restart
and the scale-up later in the run. The run itself should cost well under $1 on the 3060 market
(Nosana's fee-inclusive rate is $0.04796 an hour; our figure, rounded up per second, is
$0.0504). $10 available would pass the first create and could refuse a later step.

**Why `minutes` and 600 seconds for the first create.** The unit is settled as minutes, so the
first row is the one expected. The table stays because it shows that sending 10 is the cheap way
to be wrong:

| We send | Nosana reads it as | The job's timeout | Debited for one 3060 replica (about) |
|---|---|---|---|
| `10` (unit set to minutes) | minutes (**settled**) | 10 minutes | $0.008 |
| `10` (unit set to minutes) | seconds | 10 seconds; the job ends at once | $0.001 (debits round up to $0.001) |
| `600` (unit left at seconds) | seconds | 10 minutes | $0.008 |
| `600` (unit left at seconds) | minutes | 10 hours | $0.48 |

Sending 10 is cheap whichever way Nosana reads it. Sending 600 is the only case with a large
debit. If the manager refuses a timeout of 10 outright, record the error and stop: the create
schema reads "at least 1 minute", so a refusal contradicts what was settled.

**How credits move (settled; steps 5, 9 and 13 rely on it).** A job is debited price × its full
timeout when it is **assigned to a node**, not at create or start, as a `job_debit` row in
`/credits/transactions`. On this account debits have landed in `settledCredits`, with
`reservedCredits` 0. Each extension debits another full timeout. After a stop the unused part
comes back pro rata as a `job_refund` row about a minute later. Every debit rounds up to $0.001,
and a job that ends within seconds has netted about $0.01. A transaction row carries no
deployment id: match it by time. So measure **available**, or reserved + settled together,
never `reserved` alone.

**Deployment to create:** tier 3060, model Llama 3.2 1B on the Ollama engine (no Hugging Face
token needed), 1 replica, in an organization with at least $1 of WheelsAI credits.

### Steps

To read the newest credit transactions (steps 5, 9 and 13), from a shell that already has the
key in `NOSANA_API_KEY` (do not type the key on the command line):
`curl -s -H "Authorization: Bearer $NOSANA_API_KEY" "https://api.nosana.com/credits/transactions?limit=5&offset=0"`.
Both parameters are required. Rows are `{id, type, amountUsd, createdAt, method}`; the types
that matter are `job_debit` and `job_refund`. Rows of the other project appear in the same list.

| # | Do | Expect |
|---|---|---|
| 1 | `cd apps/api && npx tsx scripts/nosana-access-check.ts`. It only reads. | Mode `api_key`, network `mainnet`, the new key's last four characters, an available balance of about $15, **exit code 0** (only with the pagination fix; before it the script printed "unreadable: HTTP 200, body is not an array" and exited non-zero). The deployment count is `pagination.total_items`: 19 from the other project at the verification, none of them `wheelsai-*`. `REJECTED` means the key is wrong or revoked; a 403 `INSUFFICIENT_SCOPE` means the new key lacks a scope: stop. Record the balance as **B0**: assigned, reserved, settled **and available**. |
| 2 | In the same output, read "raw fields of one existing deployment". | Settled already: on this account `owner` and `vault` are the same 44-character base58 key, and `owner` parses as a Solana public key. The script prints the newest deployment (one of the other project's until step 4). **If it says NO, stop**: that contradicts the verification, and the SDK would throw on create after Nosana had created the deployment. |
| 3 | Start the API. `GET /api/platform/compute` with `x-admin-key`. | `mode` `api_key`, `credits.state` `ok` or `low`, `timeout.unit` `minutes`, every tier `belowCost: false`, `unreachable.rows` empty. `GET /api/status` shows GPU compute operational. |
| 3a | Is a 3060 node idle? `curl -s "https://api.nosana.com/nodes/queued-nodes?marketAddress=7AtiXMSH6R1jjBxrcYjehCkkSF7zvYWte63gwEDBcGHq"` (public, no key). | A list of idle nodes. **It was empty at the verification** (only the 4090 market had any). An empty list is not a reason to stop: the deployment waits for a node, and nothing is debited until one is assigned. Record the count. Do not use `/markets/{id}/spare-capacity` for this; it describes another feature. |
| 4 | Create the deployment in the dashboard. Record the time. | 201; the row goes `pending` then `provisioning`; an organization hold of 36 cents (one hour of a 3060). **The row must stay `provisioning`, and the ledger must show no `gpu_usage` row, until an endpoint reports `online: true`** (the online fix). Nosana itself reports RUNNING within seconds of the start, node or no node, and lists the endpoint from create with `online: false`. Record when Nosana went RUNNING and when `online` became true (the deployment's `endpoints[].online`, in Nosana's dashboard or a GET of the deployment). If our row reads `running` while `online` is false, stop the deployment and stop the run: the customer is being billed for a GPU that is not serving. If the create fails, open the operator view after 15 minutes: `nosana.untrackedDrafts` or `nosana.untracked` names anything Nosana created anyway (`wheelsai-model-<deployment id>-r0`). Stop it in Nosana's dashboard by hand (a draft was never started and costs nothing). |
| 5 | **Once a node has the job** (the deployment's job list shows a node, or `online` is true), run the check script again and read the newest transactions. Record **B1**. | A new `job_debit` row of **$0.008** (10 minutes of a 3060 at the fee-inclusive price), and available down by the same amount against B0. That confirms minutes on a deployment of ours. On this account the debit lands in `settledCredits`; record whether `reserved` moved at all. **No debit appears while the job waits for a node**, so nothing within a minute of create is not a failure. A debit of $0.001, or a job that ends within seconds, would mean the timeout was read as seconds, against everything settled: stop the deployment and record it. Any other figure: stop and record it. Also record the `timeout` field the script prints for the deployment (10). |
| 6 | In the same output, read `owner` and `vault` of the new `wheelsai-model-*` deployment. | A confirmation only: the same 44-character key as in step 2, for a deployment WheelsAI created. |
| 7 | Wait for `running` with a healthy node. | Record three times: create to Nosana RUNNING, RUNNING to `online: true`, and the image pull if the job's result or events show it (`docker.io/ollama/ollama:0.32.6` is pre-pulled on the 3060 market, so the pull should be short; the model download is not). The container downloads the model before it opens port 11434, so `online: true` should come only after the download: if `online` turns true and the first chat answers "model not found", record it and stop the run. **This is the first time the Ollama container starts on a node.** The definition the earlier loopback runs sent could not start. If the row never leaves `provisioning`, read the deployment's events and the job's result in Nosana's dashboard and record the container's exit and last lines. There is one endpoint URL per deployment (per exposed port), load-balanced across replicas: record its host (the operator does not see node URLs in the API; read `deployment_nodes.node_url` in the database, one row per endpoint URL). |
| 8 | Send one chat completion to `/v1/<slug>/chat/completions`. | An answer. Record the latency. |
| 9 | Wait past one timeout (11 minutes or more after the job started). Run the check script and read the transactions. | The deployment is still `RUNNING`. **The first extension comes at about 9 minutes** (the timeout minus a buffer of 10%, at least 1 minute), then one every 10 minutes. Each is a new `job_debit` row of about $0.008. Expect RUNNING and a new debit row, not a change in `reserved`. Record the time and amount of each. If it stopped at the timeout, the strategy did not extend with credits: record it and stop. This has been read in the source only; this step is its first observation. |
| 10 | Read the organization's ledger. | `gpu_usage` rows at $0.0001 a second for one replica, each with a consistent `balanceAfter`, **the first of them not before the time `online` became true** (step 4). |
| 11 | (Optional; doubles the cost for a few minutes.) Replicas 1 to 2, wait for the count to be confirmed, back to 1. | Nosana's replica count, our row and the billing agree; usage up to the change is billed at the old count. A second replica is a second job with its own `job_debit`. The endpoint URL does not change. |
| 12 | Stop from the dashboard. Record the time. | Nosana accepts a stop only from RUNNING, ERROR or INSUFFICIENT_FUNDS (any other state answers 500 `INCORRECT_STATE`); the deployment is RUNNING here, so it is accepted. The stop answers at once; `fundsReleased` may be `false`. Nosana goes STOPPING, then STOPPED. Within one status tick the row's release is confirmed (`vault_reclaimed_at` set). The hold is returned once and the final window is billed. **A `job_refund` row appears about 55 seconds to a minute after the stop is confirmed**: record its time and amount. |
| 13 | Five minutes later, run the check script and read the transactions. Record **B2**. | A `job_refund` row for the unused part of the last debit, and `settled` lowered by it. `settled(B2) - settled(B0)` is the true cost (if the other project spent nothing meanwhile). Compare it with elapsed time x **$0.04796 an hour**, Nosana's fee-inclusive 3060 rate, not our rounded $0.0504. It will not match to the cent: each debit rounds up to $0.001. If no refund row has come, record after how long it does. |
| 14 | Start the same deployment again, wait for `running`, stop it. | The restart is not refused with `previous_run_winding_down`. (Nosana accepts a start from STOPPED. A run stopped within seconds of its job starting nets about $0.01, more than its pro-rata share: record the debit and the refund.) |
| 15 | No spend: set `NOSANA_MIN_CREDITS_USD` above the balance, restart the API, try to create. | 503 `compute_capacity_unavailable`, the dashboard says "GPU deployments are paused right now. Nothing was charged.", no row, no hold; `/status` shows "New deployments paused". Restore the value. |
| 16 | `GET /api/platform/compute` once more. | `nosana.untracked` and `nosana.untrackedDrafts` empty, `running.deployments` 0. |

That the job ran at all shows that a definition created with `confidential: true` reaches the
host with our key (step 7). The other project's deployments on this account are confidential and
ran, so this is expected.

### Results

| # | Result | Value recorded | Date |
|---|---|---|---|
| | Balance loaded before step 1; `NOSANA_MIN_CREDITS_USD` in force; the narrow key in use and the all-scope key revoked | | |
| | What `docker image inspect` printed as the Ollama image's entrypoint | | |
| 1 | Key accepted; exit code 0; deployments listed (`total_items`); **B0 (assigned / reserved / settled / available)** | | |
| 2, 6 | `owner` equals `vault`, a 44-character key that parses (confirmation), for a deployment WheelsAI created | | |
| 3 | Operator view state; tiers below cost | | |
| 3a | Idle nodes on the 3060 market before the create | | |
| 4 | Create answered; hold taken (cents); **time Nosana went RUNNING; time `online` became true; our row stayed `provisioning` and unbilled until then** | | |
| 5 | **B1; the `job_debit` row (time, amount; expected $0.008); available delta**; whether `reserved` moved; `timeout` as stored by Nosana | | |
| 7 | Seconds create to RUNNING; RUNNING to `online: true`; image pull; **the Ollama container started**; endpoint host | | |
| 8 | Chat completion answered; latency | | |
| 9 | Still running after one timeout; **time and amount of each extension's `job_debit`** | | |
| 10 | Ledger rows consistent; first `gpu_usage` row not before `online` | | |
| 11 | Replica change confirmed and billed at the right counts | | |
| 12 | `fundsReleased` in the stop answer; seconds until the release was confirmed; **the `job_refund` row (time after the stop, amount)** | | |
| 13 | **B2; settled delta (the true cost) against elapsed x $0.04796/h** | | |
| 14 | Restart worked; debit and refund of the short second run | | |
| 15 | Paused refusal: no row, no hold | | |
| 16 | Nothing untracked | | |
| | Each debit equals the fee-inclusive price x the timeout ($0.008 for 10 minutes of a 3060) | | |
| | INSUFFICIENT_FUNDS: not expected in this run. The state is recoverable (Nosana retries and returns to RUNNING after a top-up) and a stop is accepted from it. Record it only if seen, with what the other project was running. | | |
| | Did create, start, stop and the replica update all work through the `/api` prefix on the dashboard host? (verified for GETs only) | | |
| | What the other project did on the account during the run (nothing, or what) | | |

After the run: leave `NOSANA_TIMEOUT_UNIT=minutes` in every environment, raise
`NOSANA_JOB_TIMEOUT_SECONDS` back to its default (7200) or leave it unset, and move what the run
confirmed from part 3 into "Settled".

---

## Settled by the 2026-10-07 verification

These were in part 3. None was measured by a paid run of ours. Each was settled by reading
Nosana's published OpenAPI document, the public deployment-manager source (`127f915`,
2026-10-05) and node source (`3f07617`), the client packages, and read-only GETs with the
founder's key against the shared account. Nothing was created, started or stopped. The full
findings are in `workfiles/batch7/verification.json` of the project's Claude folder; the live
responses were read from a scratch directory that does not outlive that session, so the file
names below are references into the findings, not into the repository.

| Settled | Evidence |
|---|---|
| **The timeout unit is minutes.** `rotation_time` is minutes too, despite the API document's text. | API document, `DeploymentCreateBody.timeout`: "Timeout in minutes". Manager `src/tasks/task/list/worker.ts:63,109` (`timeout * 60`). learn.nosana.com `api/create-deployments.html` ("timeout: 60, // minutes"). Live INFINITE deployments of the other project (timeout 360, rotation 20) relist about every 340 minutes, each debiting 6 hours of credits. The SDK's and the kit's "seconds" JSDoc is stale. |
| **The 10% network fee is charged on credit-paid jobs.** | `/markets/prices` equals `usd_reward_per_hour` x 1.1. Past 6-hour debits (0.385, 0.961, 0.577) equal the fee-inclusive price x 6, rounded up to $0.001. The 3060 is $0.04796 an hour, the 4070 $0.09603. |
| **Balance fields are USD**, not the "USD cents" the API document and `@nosana/api` state. Available = assigned − reserved − settled. | All 329 transactions reconcile: claims 23 + top-up 5 = 28 assigned; debits 138.903 − refunds 115.994 = 22.909 settled. `GET /credits/balance` on 2026-10-07: `{assignedCredits: 28, reservedCredits: 0, settledCredits: 22.909}`. |
| **How credits are debited and returned.** One debit per job (one job per replica) of price x the full timeout, when the job is assigned to a node, not at create or start. The unused part returns pro rata as a `job_refund` row about a minute after a stop. Extensions and rotations debit again. On this account debits show in `settledCredits`. | The transaction list (`job_debit` and `job_refund` rows, their amounts and times). Manager `src/tasks/task/list/reserve.ts:44-73` (a node is reserved before the job is assigned). Rows are `{id, type, amountUsd, createdAt, method}` and carry no deployment id. |
| **SIMPLE-EXTEND extends the same job** by a full timeout from the credit balance, at the timeout minus a buffer of 10% clamped to 1 to 5 minutes. **SIMPLE ends at its timeout**, and the deployment becomes STOPPED when no job is left. | Manager source. Not yet seen on a WheelsAI deployment: step 9. |
| **Which states accept which call.** Stop: only RUNNING, ERROR or INSUFFICIENT_FUNDS; anything else answers HTTP 500 `INCORRECT_STATE`. Start: DRAFT, STOPPED, ERROR or INSUFFICIENT_FUNDS. Archive and DELETE need STOPPED. `update-timeout` has a minimum of 60 minutes, and a decrease does not shorten the running job. | Manager `src/router/routes/post/deployments/[id]/deploymentStop.ts:21-27` and the neighbouring routes. This also answers "what Nosana returns for a stop of a halted deployment": it accepts it. |
| **INSUFFICIENT_FUNDS is the status when credits run out, and it is recoverable.** It is set only from RUNNING when a listing or an extension fails for credits. Nosana retries with a backoff (about 13 days, 60 retries, then ERROR) and returns to RUNNING after a top-up. It affects every deployment on the shared balance. | Manager source; a live event of the other project: `JOB_LIST_ERROR`, "Insufficient credits. Available: $0.091, Required: $0.524". Whether production overrides the retry cap is not known. |
| **STARTING becomes RUNNING as soon as the listing task is scheduled**, before any node is reserved. RUNNING does not mean a node is serving. | Manager `src/tasks/scheduleTask.ts:86-95`. |
| **Endpoints: one URL per op per deployment** (per port only when an op exposes several), load-balanced across replicas, created at create with `online: false`. `online` turns true only when the tunnel is up and the job is RUNNING. | Manager `deploymentCreate.factory.ts:20-71`, `src/endpoints/deploymentEndpointStatus.ts:24-36`. API document: `Endpoint` requires `[opId, port, url, online]`. Live: STOPPED deployments list their endpoints with `online: false`. |
| **`owner` and `vault` of an API-key account are the same 44-character base58 key**, so the SDK's `new PublicKey(owner)` succeeds. | The live deployment list and a single deployment of this account. |
| **The deployment list is paginated**: `{deployments, pagination}`, `limit` one of 10, 20, 50, 100 (default 10), `cursor_next`, an exact, case-sensitive `name` filter and an `idempotency_key` filter. **A deployment no longer embeds `jobs` or `events`**: they are `GET /deployments/{id}/jobs` and `/events`. | API document, `paths['/deployments'].get`. Live: 10 rows on the first page of 19; `limit=25` answers 400; `limit=100` returns all 19 with `cursor_next` null; a lower-case name returns 0 rows. |
| **A single job's fields and units.** `GET /deployments/{id}/jobs/{job}` returns `state` as a number (2 = COMPLETED; the jobs list gives a string), `timeStart` and `listedAt` in unix seconds, `timeEnd` 0 for a stopped job, `jobResult.startTime` and `endTime` in milliseconds. **A confidential job's result and logs are readable after it ends**: entries are `{log, type, timestamp}`, one line each. Logs arrive only with the result; `/stream` carries none. | A live job of the other project (confidential, 315 log entries, `exitCode` 0, `timeStart` 1781439160 matching its `created_at`). API document: the job 200 schema and `DeploymentManagerJobResults`. |
| **The job-definition validator is strict**: any key outside the container op's list is refused with a 400. `required_vram` and an object-valued `resources` are therefore refused. The vLLM and adapter definitions use only valid keys, and the node passes `entrypoint` and `cmd` arrays to Docker unchanged (keeping the image's own entrypoint when none is set). | `@nosana/types` 2.14.2 `dist/Jobs/index.js:915-932`, called by the manager's `deploymentCreateValidation.ts:30-39`. Node `Provider.ts:247-251, 800-805` and `createDockerRunOptions.ts:59,62`. |
| **`confidential: true` works with an API key.** The manager pins only a placeholder to IPFS and the node fetches the real definition with a signed request. The owner, meaning every holder of an account key, can read the full definition back. | Manager `src/definitions/confidential.jobdefinition.ts`; the other project's confidential deployments on this account ran. |
| **The dashboard host and `api.nosana.com` are the same proxy**, with or without `/api`. The documented base URL is `https://api.nosana.com`; the dashboard host is no longer in Nosana's documentation. | Same three IPs, byte-identical GET bodies (same md5), `x-proxied-by: client-manager`. GETs only. |
| **Keys.** Auth needs only `Authorization: Bearer nos_...`. Keys are created at deploy.nosana.com, Account, API Keys, carry scopes, and have no mandatory expiry (`expiresAt: null`). A missing scope answers 403 `INSUFFICIENT_SCOPE`. A key with `api-keys:manage` can read the plaintext of every key on the account. | `GET /auth/scopes`, the API document's `bearerAuth`, learn.nosana.com `api/scopes.html`, and the founder's key (created 2026-10-07, every scope). |
| **`idempotency_key` and `autostart` exist on create.** A duplicate key answers 409, and the list has an exact filter for it. The key is released only by DELETE. | API document; manager create route. Whether SDK 0.4.74 passes the field through the proxy unchanged has not been exercised. |
| **Market images.** `required_images` is what a market's nodes pre-pull, not an allow-list. The 3060 and 4070 markets cache `docker.io/ollama/ollama:0.32.6` and vLLM v0.9.2 and v0.10.2; no market caches vLLM v0.6.x. | The live market list; node `imageManager.ts:29-56`. |
| **`/credits/spending-history` requires `start_date`** (YYYY-MM-DD) and gives per-market totals per day or month. | API document and a live read. |

---

## 3. What stays unverified until that run

Nothing below has been observed. What the 2026-10-07 verification settled is in the section
above; this is what it left open, and what it added.

On Nosana, for the run to show:

- **Whether POST and PATCH behave through the `/api` prefix on the dashboard host** exactly as
  on `api.nosana.com` (create, start, stop, update-replica-count), and what their response
  bodies hold for an API-key deployment, which SDK 0.4.74 reads. Only GETs were made. The shared
  proxy makes it very likely; the first create shows it. Steps 4, 11 and 12.
- **That the Ollama container starts on the 3060 market** with the fixed definition and
  `llama3.2:1b`. The image's entrypoint was not inspected locally (the free
  `docker image inspect` before the run does that); the explicit `/bin/sh -c` entrypoint is
  right either way. Also unproven on a node: that the server on `127.0.0.1:11435` ends on the
  script's `kill` and the server on port 11434 then starts (run against a stand-in `ollama`
  only). Step 7.
- **The timing of `online`**: from create to RUNNING to an endpoint with `online: true` for
  Ollama on the 3060 (and for vLLM 0.6.x on the 4070 in the fine-tuning run), image pull and
  model load included. Also whether the tunnel registers before the health check passes, which
  decides whether `online` alone means "serving". Steps 4 and 7.
- **A credit-paid SIMPLE-EXTEND extension on a WheelsAI deployment**: the timing and amount of
  the debit, and that the deployment stays RUNNING. Known from source only. Step 9.
- **Whether `reservedCredits` is ever non-zero** while a job runs, or debits always land
  straight in settled. Step 5.
- **The minimum charge for a very short job** (about $0.01 observed), and whether a 10-minute
  3060 job that runs to its end costs $0.008 or that minimum. Steps 13 and 14.
- **The refund when a SIMPLE job completes on its own before its timeout.** Only refunds after a
  stop have been seen. The fine-tuning run shows it.
- **Whether a node is free on the 3060 market at the time of the run.** There were 0 idle nodes
  at the verification. Step 3a.
- **That a timeout of 10 is read as minutes on a deployment of ours.** Settled from the source
  and from other deployments on the account; step 5 is the confirmation.
- **Whether an INSUFFICIENT_FUNDS deployment of ours resumes after a top-up in production.**
  The manager's defaults say so; production may override the retry cap. Not in the checklist (it
  would need the balance to run short); our handling is unit tested only.

Not covered by this checklist:

- **Whether the on-chain market `jobPrice` is the host reward or the fee-inclusive price**
  (wallet path). A read-only `getMarket` on the same day as `GET /markets/` settles it.
- **Whether the host manager accepts a create-level `requirements` entry** `{vram_total_mb: N}`.
  A bad key gives a fatal reservation error after create. Not used.
- **Whether job definitions have a size limit** (the adapter bootstrap rides in `cmd`), whether
  `jobResult` logs are truncated for long runs, and the SIGTERM grace period on a stop. The
  fine-tuning run touches all three.
- **An end-to-end private registry pull with `authentication.docker`.** The key is valid in the
  schema and the node passes it to the pull. Avoid it by using a public training image for the
  first run.
- **Whether the devnet hosts accept dashboard keys or hold credits.** Not probed; API-key access
  is treated as mainnet.
- **Whether SDK 0.4.74's create passes an `idempotency_key` through the proxy unchanged.**
- **Whether a deployment created by a wallet is visible to an API key of another account.**
  Assumed not; our code never tries (each row is acted on through the mode that created it).
- **Listing a wallet's deployments** for the operator view goes through a wallet-signed read
  that has only been exercised against test doubles.

Wallet access was not re-run with funds either. What `docs/FOUNDER-ACTIONS.md` section 3 lists
for the first funded wallet run still stands.
