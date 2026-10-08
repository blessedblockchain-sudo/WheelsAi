# Nosana deployments with an API key — what is proven, and the paid runs

**Date:** 2026-10-07, updated 2026-10-08 after two live runs · **Branch:** `feat/bags-launchpad`
**Migration:** `20261011100000_nosana_access_mode`

The platform can pay Nosana in two ways, chosen by configuration: a Solana wallet (a vault per
deployment, funded in NOS and SOL), or a dashboard API key (prepaid USD credits, no vault). This
document has three parts:

1. **What was proven on this machine**, with the commands and their output.
2. **The checklist for a paid run**, with a results table to fill in.
3. **What stays unverified.** Between parts 2 and 3 are three sections: the first and the second
   live run of 2026-10-08 (what each showed, settled and changed in the code), and what the
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

## 2. A paid run — checklist

The founder runs this with the key present. Record each result in the table at the end. Stop at
the first step whose result is not the expected one.

A first live run took place on 2026-10-08, on the 4090 market with Llama 3.2 3B. It is recorded
in "First live run (2026-10-08)" below. This checklist has been brought into line with it: the
timeout for a credit-paid run is 3000 seconds or more, credits are reserved when a job is listed
and the unused part comes back some minutes after a stop, and a deployment reads `running` only
once its model has answered a request. A second live run the same day, recorded in "Second live
run (2026-10-08)", exercised the 3060 market, a market with no node, the vLLM engine, and the
changes the first run led to. The steps neither run reached (an extension, a replica change, a
restart, the paused refusal) are still to be recorded.

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
  of `docs/FINE-TUNE-RUN.md` ($5.097 needed) is refused. After the two live runs of 2026-10-08
  available credit is $4.722, so with the $5 floor no create passes until a top-up.
- **Recommended starting balance: about $15 available, so top up about $10 before step 1.**
  Each SIMPLE-EXTEND extension debits another full timeout, and with $5.091 the only headroom
  for it is the floor itself. The alternative is to lower `NOSANA_MIN_CREDITS_USD` for the run
  and write the value used in the results table. Topping up is the better choice, because the
  floor is also what keeps the other project's deployments from being halted by ours.
- **Replace the key before the run.** The key now in `apps/api/.env` holds every scope,
  including `api-keys:manage` (it can read the plaintext of every key on the account),
  `wallet:sign` and `oauth-apps:manage`. **It has also been shared outside the API's
  environment, so treat it as disclosed.** In deploy.nosana.com, Account, API Keys: create a new key with only
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
| A row becomes `running`, and GPU billing starts, only when an endpoint is online: Nosana reports `online: true`, or the platform's own probe of the endpoint is healthy (see the row on offline endpoints below). | Nosana reports RUNNING as soon as the listing task is scheduled, before any node holds the job. The customer is billed through queueing, image pull and model load. |
| Jobs and events are read from `/deployments/{id}/jobs` and `/deployments/{id}/events`. | A deployment no longer embeds them. Failure reasons read `nosana_error`, and training never learns its job. |
| `required_vram` is no longer in the training job definition. | Not this run's concern; the fine-tuning create is refused with a 400. |
| With an API key paying, a job timeout under 3000 seconds stops the API at start-up, and a shorter per-deployment timeout is raised to 3000. | Nosana accepts the create and the start, reports RUNNING, and never assigns the job: every attempt logs `JOB_LIST_ERROR` (first live run, attempt 1). |
| A deployment Nosana cannot place is failed with a reason (`nosana_list_failed`, `no_capacity`, `start_timeout`), stopped on Nosana and its hold returned. | The row stays `provisioning` with no reason shown, and its hold is kept until somebody stops it by hand. |
| The Ollama container loads the model at start and keeps it loaded, a model deployment is `running` only when its model is listed by the node and has answered a one-token request from the platform, and a node that answers without its model is asked to load it by that same request. | The first request after a start waits for the model to load and for the node's first generation (42 seconds on the first live run), fails at the inference timeout, and marks the only node unhealthy. |
| A stop repeats its read of the deployment after a network failure, and the stop itself unless the read after it shows the deployment stopping or stopped. | One name that does not resolve makes Stop answer 502 while the GPU keeps running and billing until Stop is pressed again (second live run). |
| A vLLM deployment is `running` only once its node has answered a one-token completion from the platform. | The first request after a start can take half a minute, Nosana's health check misses meanwhile, and the deployment reads as not serving (second live run, deployment E). |
| When Nosana reports no endpoint online, the status worker probes the endpoints itself and takes a node that answers as serving. | A deployment whose job Nosana's record still shows as queued sits in `provisioning` while its node serves, and is ended as `start_timeout` at the limit (second live run, deployment F). |
| A deployment that is starting or degraded answers 503 `service_unavailable`. | Clients are told 404 `model_not_found` and give up on a deployment that serves again seconds later. |
| `INFERENCE_TIMEOUT_MS` defaults to 120000. | A long answer on a small GPU is cut at 30 seconds. |

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
| `NOSANA_JOB_TIMEOUT_SECONDS` | `3000` | The minimum with an API key: Nosana never assigns a credit-paid job whose timeout is under 3000 seconds, and the API does not start with a lower value. Sent as 50 with the unit above. |
| `NOSANA_PROVISIONING_LIMIT_SECONDS` | unset (1800) | A deployment that is not serving after this long is failed, stopped on Nosana and its hold returned. |
| `INFERENCE_TIMEOUT_MS` | unset (120000) | How long a model node may stay silent before a request fails. |
| `NOSANA_MIN_CREDITS_USD` | `5` | The floor. |
| `PLATFORM_ADMIN_KEY` | at least 16 characters | For the operator view. |
| `DEPLOYMENT_STATUS_INTERVAL_MS` | above 0 | Without the status worker a deployment never reaches `running`. |
| `GPU_BILLING_INTERVAL_MS` | `60000` | Per-second billing of the organization. |
| `ALLOW_NOSANA_MOCK` | unset | The mock must not stand in for Nosana. |

**Balance to load: the floor plus a margin, about $15 available with the $5 floor.** The
$4.722 left after the runs of 2026-10-08 is under the floor itself: top up first. A deployment is admitted only when its estimate
plus the floor is available, and the floor must still be there for the extensions, the restart
and the scale-up later in the run. The run itself should cost well under $1 on the 3060 market
(Nosana's fee-inclusive rate is $0.04796 an hour; our figure, rounded up per second, is
$0.0504). $10 available would pass the first create and could refuse a later step. While a job
runs, its whole 50-minute reservation is out of the available balance ($0.037 for a 3060 and
$0.303 for a 4090), and the unused part returns only some minutes after the stop.

**Why 3000 seconds.** The unit is minutes, and Nosana refuses to assign a credit-paid job whose
timeout is under 3000 seconds (50 minutes). It does not refuse the create or the start: the
deployment reports RUNNING, and every listing attempt fails with `JOB_LIST_ERROR` "Credit-paid
jobs must have a timeout of at least 3000 seconds". The first attempt of the first live run was
made with 600 and showed exactly that; nothing was debited. So the shortest timeout a
credit-paid run can have is 3000, sent as 50.

| We send | Nosana reads it as | The job's timeout | Reserved for one replica |
|---|---|---|---|
| `50` (unit set to minutes) | minutes (**settled, and seen on a deployment of ours**) | 50 minutes | $0.303 on the 4090 market and $0.037 on the 3060 market (both seen): the market's host price, without the fee. |
| `10` (unit set to minutes) | minutes | never assigned | Nothing. The deployment is failed with `nosana_list_failed`. |
| `3000` (unit left at seconds) | minutes | 50 hours | 60 times the first row. |

Leave `NOSANA_TIMEOUT_UNIT` at `minutes`. The third row is the only expensive mistake.

**How credits move (settled; steps 5, 9 and 13 rely on it).** Nothing moves at create or start.
When a job is **listed on a node**, Nosana writes a `job_debit` row in `/credits/transactions`
for the price of the full timeout and shows the amount as `reservedCredits`. On the first live
run that was $0.303 for 50 minutes of a 4090: the market's host price of $0.3636 an hour,
without the 10% network fee. Each extension reserves another full timeout. After a stop the
reservation stays for some minutes (3 to 10 and a half minutes on the two live runs). Then Nosana
writes a `job_refund` row for the unused part, sets `reservedCredits` back to 0 and raises
`settledCredits` by what the job cost. A transaction row carries no deployment id: match it by
time. Measure **available** before and after, and read `settledCredits` only once the refund row
is there.

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
| 3a | Is a 3060 node idle? `curl -s "https://api.nosana.com/nodes/queued-nodes?marketAddress=7AtiXMSH6R1jjBxrcYjehCkkSF7zvYWte63gwEDBcGHq"` (public, no key). | A list of idle nodes. **It was empty at the verification** (only the 4090 market had any) and again on the second live run. An empty list is not a reason to stop: the deployment waits for a node, and nothing is debited until one is assigned. Nosana logs `JOB_RESERVE_SHORTFALL` on the deployment and tries again after 30 seconds, then 1, 2 and 4 minutes; on the second live run a 3060 node came free after 30 seconds and a 4090 node after 7 and a half minutes. Record the count. Do not use `/markets/{id}/spare-capacity` for this; it describes another feature. |
| 4 | Create the deployment in the dashboard. Record the time. | 201; the row goes `pending` then `provisioning`; an organization hold of 36 cents (one hour of a 3060). **The row must stay `provisioning`, and the ledger must show no `gpu_usage` row, until the model has answered the platform's one-token request** (the API log line "Model loaded on its node and answering"). Nosana itself reports RUNNING within seconds of the start, node or no node, and lists the endpoint from create with `online: false`. Record when Nosana went RUNNING and when `online` became true (the deployment's `endpoints[].online`, in Nosana's dashboard or a GET of the deployment). If our row reads `running` before that log line, stop the deployment and stop the run: the customer is being billed for a GPU that cannot answer yet. A row that is `running` after that log line while Nosana still shows `online: false` is the case of deployment F: record it, with Nosana's job list, and go on. If the create fails, open the operator view after 15 minutes: `nosana.untrackedDrafts` or `nosana.untracked` names anything Nosana created anyway (`wheelsai-model-<deployment id>-r0`). Stop it in Nosana's dashboard by hand (a draft was never started and costs nothing). |
| 5 | **Once a node has the job** (the deployment's job list shows a node, or `online` is true), run the check script again and read the newest transactions. Record **B1**. | A new `job_debit` row for **50 minutes** at the market's host price without the 10% fee ($0.037 on the 3060 and $0.303 on the 4090, both seen), `reservedCredits` up by the same amount, and available down by it against B0. **No debit appears while the job waits for a node**, so nothing within a minute of create is not a failure. A job that ends within seconds would mean the timeout was read as seconds, against everything settled: stop the deployment and record it. Any other figure: stop and record it. Also record the `timeout` field the script prints for the deployment (50). |
| 6 | In the same output, read `owner` and `vault` of the new `wheelsai-model-*` deployment. | A confirmation only: the same 44-character key as in step 2, for a deployment WheelsAI created. |
| 7 | Wait for `running` with a healthy node. | **Expect about two minutes on a first start once a node has the job.** On the second live run a 4090 was online 53 seconds after create and `running` 102 seconds after it; a 3060 was `running` 50 seconds after its job was listed (both with a 2 GB model). The row becomes `running` on the first status tick after the node has answered the platform's one-token request, which the status worker sends when it first finds the endpoint online (API log: "Model loaded on its node and answering" with the time it took, 49 seconds on that 4090; it is preceded by "A node answers without its model loaded; asking it to load the model" when the node did not list the model yet). Record four times: create to Nosana RUNNING, RUNNING to `online: true`, `online` to that log line, and the image pull if the job's result or events show it. The container downloads the model before it opens port 11434, starts loading it right after, and keeps it loaded. If the load inside the container does not complete, its log has the line "model preload did not complete; the model loads on the first request"; the platform's own request loads the model all the same. If the row never leaves `provisioning`, read the deployment's events and the job's result in Nosana's dashboard and record the container's exit and last lines; after `NOSANA_PROVISIONING_LIMIT_SECONDS` the row is failed with `start_timeout` and its hold returned. There is one endpoint URL per deployment (per exposed port), load-balanced across replicas: record its host (the operator does not see node URLs in the API; read `deployment_nodes.node_url` in the database, one row per endpoint URL). |
| 8 | Send one chat completion to `/v1/<slug>/chat/completions`, as the first request after the row turned `running`. | An answer within a few seconds: the model has already answered once. Record the latency. On the second live run the first request took 1.1 s on a 3060 and 4.3 s on a 4090, and later ones 0.55 to 0.9 s. An answer that takes tens of seconds means the row turned `running` before the node could answer: record it. |
| 9 | Wait past one timeout (51 minutes or more after the job started). Run the check script and read the transactions. | The deployment is still `RUNNING`. **The first extension comes at about 45 minutes** (the timeout minus a buffer of 10%, at least 1 and at most 5 minutes), then one every 50 minutes. Each is a new `job_debit` row for another 50 minutes. Record the time and amount of each, and how `reservedCredits` moves. If it stopped at the timeout, the strategy did not extend with credits: record it and stop. This has been read in the source only; this step is its first observation. To skip it, stop before 45 minutes and leave the row in the results table empty. |
| 10 | Read the organization's ledger. | `gpu_usage` rows at $0.0001 a second for one replica, each with a consistent `balanceAfter`, **the first of them not before the node answered the platform's one-token request** (step 4). |
| 11 | (Optional; doubles the cost for a few minutes.) Replicas 1 to 2, wait for the count to be confirmed, back to 1. | Nosana's replica count, our row and the billing agree; usage up to the change is billed at the old count. A second replica is a second job with its own `job_debit`. The endpoint URL does not change. |
| 12 | Stop from the dashboard. Record the time. | Nosana accepts a stop only from RUNNING, ERROR or INSUFFICIENT_FUNDS (any other state answers 500 `INCORRECT_STATE`); the deployment is RUNNING here, so it is accepted. The stop answers at once; `fundsReleased` may be `false`. Nosana goes STOPPING, then STOPPED with the event `JOB_STOPPED_CONFIRMED` (within 12 seconds on the first live run). Within one status tick the row's release is confirmed (`vault_reclaimed_at` set). The hold is returned once and the final window is billed. **`reservedCredits` does not move yet.** |
| 13 | Twelve minutes later, run the check script and read the transactions. Record **B2**. | A `job_refund` row for the unused part of the reservation (between 3 and 10 and a half minutes after the stop on the two live runs, always on a whole minute), `reservedCredits` back to 0, and `settledCredits` raised by what the job cost. `settled(B2) - settled(B0)` is the true cost (if the other project spent nothing meanwhile). Compare it with elapsed time x the market's hourly price; on the first live run 4.1 minutes of a 4090 cost $0.026. If no refund row has come, record after how long it does. |
| 14 | Start the same deployment again, wait for `running`, stop it. | The restart is not refused with `previous_run_winding_down`. (Nosana accepts a start from STOPPED. A run stopped within seconds of its job starting nets about $0.01, more than its pro-rata share: record the debit and the refund.) |
| 15 | No spend: set `NOSANA_MIN_CREDITS_USD` above the balance, restart the API, try to create. | 503 `compute_capacity_unavailable`, the dashboard says "GPU deployments are paused right now. Nothing was charged.", no row, no hold; `/status` shows "New deployments paused". Restore the value. |
| 16 | `GET /api/platform/compute` once more. | `nosana.untracked` and `nosana.untrackedDrafts` empty, `running.deployments` 0. |

That the job ran at all shows that a definition created with `confidential: true` reaches the
host with our key (step 7). The other project's deployments on this account are confidential and
ran, so this is expected.

**When Nosana cannot place a deployment.** A deployment that never starts serving does not wait
for ever, and it is never billed. It ends as `failed` in one of three ways:

| Reason on the row | When | What the customer reads |
|---|---|---|
| `nosana_list_failed` | Nosana's listing of the job fails twice in a row with no listing in between, or one failure stands for five minutes. Events are read from 60 seconds after the submit. | "This deployment could not be started. The GPU network could not start it, and that had nothing to do with your account. Nothing was charged, and your reservation was returned. You can start it again; if it ends the same way, contact support." |
| `no_capacity` | No job was listed within `NOSANA_PROVISIONING_LIMIT_SECONDS` (30 minutes by default). | "No GPU became available. No GPU of this type was free in time, so the deployment was not started. Nothing was charged, and your reservation was returned. You can start it again, or choose another GPU type." |
| `start_timeout` | A node took the job, but the model was not ready within the same limit. | "The model did not finish starting. A GPU was assigned, but the model was not ready in time, so the deployment was stopped. Nothing was charged, and your reservation was returned. You can start it again." |

In each case the deployment is stopped on Nosana in the same pass and the organization's hold is
returned once. Nosana's own message (for example the 3000-second refusal) is not shown to the
customer: it is in the API log, in the error line that begins "Deployment failed: Nosana could
not place it or it never became ready", and in `GET /api/platform/compute` under
`placementFailures`. If Nosana had already
reserved credits for a job that never became ready, they come back as a `job_refund` row like
any other stop.

### Results

| # | Result | Value recorded | Date |
|---|---|---|---|
| | Balance loaded before step 1; `NOSANA_MIN_CREDITS_USD` in force; the narrow key in use and the all-scope key revoked | | |
| | What `docker image inspect` printed as the Ollama image's entrypoint | | |
| 1 | Key accepted; exit code 0; deployments listed (`total_items`); **B0 (assigned / reserved / settled / available)** | | |
| 2, 6 | `owner` equals `vault`, a 44-character key that parses (confirmation), for a deployment WheelsAI created | | |
| 3 | Operator view state; tiers below cost | | |
| 3a | Idle nodes on the 3060 market before the create | | |
| 4 | Create answered; hold taken (cents); **time Nosana went RUNNING; time `online` became true; time the node answered the platform's one-token request; our row stayed `provisioning` and unbilled until the node answered** | | |
| 5 | **B1; the `job_debit` row (time, amount; expected 50 minutes of the market's price); `reservedCredits` up by the same amount; available delta**; `timeout` as stored by Nosana (50) | | |
| 7 | Seconds create to RUNNING; RUNNING to `online: true`; `online` to model loaded and `running`; image pull; **the Ollama container started and loaded the model by itself**; endpoint host | | |
| 8 | **The first chat completion after `running` answered; its latency (a few seconds at most expected)** | | |
| 9 | Still running after one timeout; **time and amount of each extension's `job_debit`** | | |
| 10 | Ledger rows consistent; first `gpu_usage` row not before the node answered the platform's one-token request | | |
| 11 | Replica change confirmed and billed at the right counts | | |
| 12 | `fundsReleased` in the stop answer; seconds until STOPPED and until the release was confirmed; hold returned once; final charge | | |
| 13 | **The `job_refund` row (time after the stop, amount); `reservedCredits` back to 0; B2; settled delta (the true cost) against elapsed x the market's hourly price** | | |
| 14 | Restart worked; debit and refund of the short second run | | |
| 15 | Paused refusal: no row, no hold | | |
| 16 | Nothing untracked | | |
| | Whether a debit is the host price or the fee-inclusive price x the timeout (the 4090 debit of the first live run was the host price) | | |
| | INSUFFICIENT_FUNDS: not expected in this run. The state is recoverable (Nosana retries and returns to RUNNING after a top-up) and a stop is accepted from it. Record it only if seen, with what the other project was running. | | |
| | Did create, start, stop and the replica update all work through the `/api` prefix on the dashboard host? (verified for GETs only) | | |
| | What the other project did on the account during the run (nothing, or what) | | |

After the run: leave `NOSANA_TIMEOUT_UNIT=minutes` in every environment, raise
`NOSANA_JOB_TIMEOUT_SECONDS` back to its default (7200) or leave it unset (with an API key it is
never below 3000), and move what the run confirmed from part 3 into the run's own section.

---

## First live run (2026-10-08)

The first deployment WheelsAI created on Nosana with a credential. The founder's Nosana account,
API-key access paid with prepaid credits, the 4090 market, Llama 3.2 3B on the Ollama engine,
one replica. Times are UTC. Two attempts were made.

`NOSANA_MIN_CREDITS_USD` was set to 1 for this run: with the default of 5 a 4090 create is
refused at this balance ($5 plus the estimate is more than the $5.09 available). The key in use
was the account's all-scope key. The narrow key this checklist asks for had not been created
yet, so the all-scope key has not been revoked.

### Attempt 1: `NOSANA_JOB_TIMEOUT_SECONDS=600` (sent as 10 minutes)

| What | Result |
|---|---|
| Create and start | Accepted. |
| Nosana's status | RUNNING at once, with the endpoint `online: false`, `active_jobs` 0 and no job. |
| Nosana's events | A pair every two to four minutes: `JOB_RESERVE_CONFIRMED` "Reserved 1 node(s) in market(s) <market>", then `JOB_LIST_ERROR` "Error Failed to assign job batch: Credit-paid jobs must have a timeout of at least 3000 seconds; 600 was requested." The listing task was pushed out each time. |
| Credits | Nothing was debited. |
| Our row | `provisioning` for ten minutes, with no reason shown anywhere. |
| Stop | Accepted; Nosana went to STOPPED at once. |
| The customer's money | The hold was returned once. Nothing was charged. |

### Attempt 2: `NOSANA_JOB_TIMEOUT_SECONDS=3000` (sent as 50 minutes)

| Time | What | Result |
|---|---|---|
| 00:43:05 | Create | Accepted. |
| 00:43:06 | `JOB_RESERVE_CONFIRMED` | A node reserved. |
| 00:43:07 | `JOB_LIST_CONFIRMED` | A job on a node. The job's `time_start` is in unix seconds. |
| 00:43:07 | Credits | A `job_debit` row of $0.303: 50 minutes at the market's host price of $0.3636 an hour, without the 10% fee. The balance showed it as `reservedCredits` 0.303. |
| 00:43:25 | The node | The model was pulled. |
| 00:43:49 | Endpoint online; our row `running` | 44 seconds after create. Per-second billing started: 1 cent per 40 seconds at the 4090 price. (The watcher of the run was started later and first read `running` at 00:44:14.) |
| 00:44:24 | First chat through our API | **Failed.** 504 `upstream_timeout` after 30.0 seconds (30,019 ms in our latency sample; `INFERENCE_TIMEOUT_MS` was 30000). The next `/v1` request answered 503 "No healthy nodes available for this deployment": a failed request marks its node unhealthy until the next probe. |
| | The node called directly | The first completion took 42.06 seconds: Ollama loads a model into GPU memory on the first request for it. `GET /api/ps` listed no model before it and `llama3.2:3b` with `size_vram` 5.98 GB after. The second completion took 1.08 seconds. |
| | With the model warm | Dashboard chat 1.4 s; `/v1` 0.7 s; streamed `/v1` 0.8 s, ending with `[DONE]`. |
| 00:47:13 | Stop | Accepted. Nosana went STOPPING, then STOPPED within 12 seconds, with the event `JOB_STOPPED_CONFIRMED`. Our hold was released once and a final usage row written. **6 cents charged for 204 seconds.** |
| 00:54:00 | Credits | 6 minutes 47 seconds after the stop: a `job_refund` row of $0.277, `reservedCredits` back to 0, `settledCredits` up by 0.026. The job cost $0.026 for the 4.1 minutes it ran. |

Credit rows are listed by `GET /credits/transactions` as
`{transactions: [{id, type, amountUsd, createdAt, method}], total}`.

The 204 billed seconds are the time from 00:43:49, when the status worker moved the row to
`running`, to the stop at 00:47:13: three ticks of the billing worker (40, 80 and 40 seconds)
and a final window of 44. The second run confirmed the same arithmetic on three deployments.

### What the run settled

- **Create, start and stop work with an API key through the SDK.** The replica update was not
  exercised.
- **RUNNING precedes any node.** Nosana reported RUNNING with no job and nothing online, in both
  attempts.
- **The timeout is minutes.** 50 was sent and 50 minutes were reserved.
- **The 3000-second rule.** Nosana does not assign a credit-paid job whose timeout is under 3000
  seconds. The create and the start are accepted all the same; the refusal is only in the
  deployment's events.
- **Credits are reserved at listing, at the host price without the fee.** The amount shows as
  `reservedCredits`, and the unused part comes back as a `job_refund` row about seven minutes
  after a stop. Until then the whole reservation is out of the available balance.
- **44 seconds from create to an online endpoint** on a 4090 for a 2 GB model, with the Ollama
  container pulling the model before it opens its port.
- **The first request is cold.** An online endpoint means the server answers, not that the model
  can. The first request waited 42 seconds. (The second run showed what that wait is: loading the
  model takes a few seconds; the node's first generation after its container starts takes most
  of it.)

### What it changed in the code

1. **The 50-minute minimum.** With an API key paying, the API does not start when
   `NOSANA_JOB_TIMEOUT_SECONDS` or `NOSANA_BATCH_JOB_TIMEOUT_SECONDS` is under 3000, and a
   shorter timeout asked for a single deployment or training job is raised to 3000. Wallet
   access keeps its 600-second minimum. The stand-in Nosana API refuses to list a credit-paid
   job under 50 minutes the way Nosana does, and models the reservation and the later refund: a
   `job_debit` row when a job is listed and a `job_refund` row for the unused part when the
   reservation is settled, with the fields a live row carries.
   A fine-tuning run that outlives its own limit (the run limit plus the set-up allowance) is
   still stopped by the platform then, and not only at the 50-minute timeout Nosana was given.
2. **A deployment Nosana cannot place ends with a reason.** The status worker reads a waiting
   deployment's events from 60 seconds after the submit. A listing that keeps failing ends the
   row as `nosana_list_failed`; a row still waiting after `NOSANA_PROVISIONING_LIMIT_SECONDS`
   (1800 by default) ends as `no_capacity` or `start_timeout`. The deployment is stopped on
   Nosana in the same pass, the hold is returned once, nothing is charged, and the customer
   reads a sentence for each reason. Nosana's own message goes to the log and to
   `GET /api/platform/compute`.
3. **The cold first request.** The Ollama container starts loading its model right after its
   server starts, and `OLLAMA_KEEP_ALIVE=-1` keeps it loaded. The platform's probe of an Ollama
   node reads `GET /api/ps` (no more than 64 KB of the answer) and is healthy only when the
   deployment's model is listed **and** the node has answered the platform's load request for
   it. A model deployment becomes `running`, and is billed, only when an endpoint is online
   **and** that probe is healthy. `INFERENCE_TIMEOUT_MS` defaults to 120000.
4. **The load request.** Requests are routed only to healthy nodes, and Ollama loads a model
   only when a request for it arrives. So when the probe finds an Ollama server that answers
   without the deployment's model loaded, or with the model listed and not yet seen to answer,
   the platform sends the node the smallest real generation: `POST /api/generate` with
   `{"model": "<model>", "prompt": "Hi", "stream": false, "keep_alive": -1, "options": {"num_predict": 1}}`.
   One such request per node at a time, in the background, with a ten-minute limit of its own
   (the request waits for a node that sends nothing until it is done, for as long as that limit
   and no shorter). The probe is healthy once it has been answered. A node that is already warm
   answers in well under a second, so after a restart of the API a node that is idle is healthy
   again within its first probe. A node that is busy with a customer's answer queues the request
   behind it: its probe reads "not known yet", which never makes a deployment `running` and
   leaves a node that was serving as it was, for up to a minute. What was seen answering is
   forgotten when the node stops answering its probe, when Nosana reports the endpoint offline
   and when the deployment leaves service, and it is asked for again after five minutes: the
   address is the deployment's, and a new container behind it lists its model while still
   loading. Before the first `running` this makes the load inside the container
   a head start and not the only way the model gets loaded. Afterwards, a running deployment
   whose model was unloaded heals within about two status ticks. vLLM was left on its `/health`
   at this point; item 8 below gave it a load request of its own.

   The request was a bare load (no prompt) until the second live run showed that a loaded
   model's first generation is the slow part; see that run.

### The start script, run locally

The start script the API generates was run under `/bin/sh` (dash) with a real Ollama binary
(version 0.9.6), an isolated model folder and the model `smollm:135m`. The script was the
generated one with only the two port numbers and the model name changed.

| What | Result |
|---|---|
| The pull server | Came up and pulled the model. |
| The final server | Answered on the exposed port 21 seconds after start. |
| The preload | One second later `GET /api/ps` listed `smollm:135m`, with no request from outside and `expires_at` in the year 2319 (never unloaded). The server's log shows the runner had started 4.5 seconds after that listing: `/api/ps` lists a model from the moment its load begins, which is why the platform does not take a listing alone as ready. |
| What the preload sends | The request took 5.6 seconds for a load of 4.5: in a container the standard input is not a terminal, so `ollama run <model> ""` sends a prompt of one space and the model generates a short answer. It is a load followed by a first generation, not a bare load. |
| A completion through `/v1/chat/completions` | 147 ms. |
| The preload job | Ended by itself and was left as one defunct child of the server process. |
| The container's log | The preload wrote Ollama's progress spinner (terminal escape sequences) to it through stderr. |

After that run the script was changed in what it writes to the log, and in nothing else: the
preload's stderr goes to `/dev/null`, a preload that does not complete writes the one line
"model preload did not complete; the model loads on the first request", and the shell no longer
reports the pull server it ended. Those three are covered by the shell test with a stand-in
`ollama` binary (`apps/api/src/tests/nosanaJobDefinitions.unit.test.ts`), which also proves the
order of calls: pull on loopback, then the exposed server, then the wait for it, then the load.
They have not been run with a real Ollama binary.

## Second live run (2026-10-08)

The re-run with the changes above, the same day, on the same account with API-key access and
prepaid credits. Seven deployments, one replica each, created and stopped through the WheelsAI
API the way the dashboard does it: four of Llama 3.2 3B on the Ollama engine (A to D; the
container image on the nodes was `ollama/ollama:0.32.6`) and three of Phi-3 mini on vLLM (E to
G; `vllm/vllm-openai:v0.6.0`). Times are UTC.

`NOSANA_MIN_CREDITS_USD` was 1 for this run as well (the 4090 creates were admitted with $5.06
and less available, which the default of 5 refuses), and the key was the same all-scope key.

Free nodes during the run (`GET /nodes/queued-nodes?marketAddress=<market>`): 3060 none (15 or
16 busy), 4070 none, 4090 between none and two (81 or 82 busy), and no node at all, free or
busy, in the A100 40GB and H100 markets.

### A. The 3060 market, with no node free at the create

| Time | What | Result |
|---|---|---|
| 06:01:16 | Create | Accepted; hold of 36 cents. Nosana RUNNING, endpoint offline, no job. |
| 06:01:19 | `JOB_RESERVE_SHORTFALL` | "1 of 1 job(s) waiting for a matching node". Nothing listed, nothing debited. |
| 06:01:49 | `JOB_RESERVE_CONFIRMED`, then `JOB_LIST_CONFIRMED` | A node had come free. A `job_debit` row of $0.037: 50 minutes at the market's host price of $0.0436 an hour, without the fee. |
| 06:02:31 | The status worker's first probe of the online endpoint | The server answered with no model loaded, and the platform sent its load request (a bare load on this deployment). Answered 1.5 seconds later. |
| 06:02:40 | Our row `running` | 84 seconds after create, 50 seconds after the job was listed. Billing started here. |
| 06:02:54 | The first chat through our API | **200 in 1.1 seconds.** Then the dashboard chat 0.8 s, `/v1` 0.8 s, streamed `/v1` 0.9 s ending with `[DONE]`. The endpoint as the dashboard page prints it (`/v1/<slug>/chat/completions`) answered 200, and `/v1/models` listed the deployment. |
| | The node | Ollama 0.32.6; the model loaded with a context of 4,096 and 2.55 GB of GPU memory; `expires_at` in the year 2319. |
| | The dashboard page | Checked in a browser: `running`, 1/1 healthy nodes, 4 requests, latency median 820 ms. |
| 06:05:11 | Stop | **Not confirmed.** The read that precedes a stop failed on the machine running the API with `getaddrinfo EAI_AGAIN` (the name did not resolve). The API answered 502 `nosana_stop_failed`, the row stayed `running`, the hold stayed, and billing went on, which is the right outcome for a stop nobody confirmed. |
| 06:11:32 | Stop again | Accepted. Nosana STOPPED within 14 seconds. The hold was returned once. **6 cents charged for 532 seconds** (1 cent per 100 seconds; five ticks and a final window of 32). |
| 06:22:00 | Credits | A `job_refund` row of $0.027, 10 minutes 28 seconds after the stop. The job cost $0.010 for 9.7 minutes of a 3060; pro rata at the host price is $0.007, so this looks like a $0.01 minimum. |

### B. The A100 market, which had no node

Run with `NOSANA_PROVISIONING_LIMIT_SECONDS=300`, to see the limit end a deployment.

| Time | What | Result |
|---|---|---|
| 06:17:05 | Create | Accepted; hold of 288 cents. Nosana RUNNING, endpoint offline, no job. |
| 06:17:06 to 06:20:38 | `JOB_RESERVE_SHORTFALL` four times | At 06:17:06, 06:17:37, 06:18:37 and 06:20:38: Nosana tries again after 30 seconds, then 1, 2 and 4 minutes. No job was listed and nothing was debited. |
| 06:22:10 | The status worker | After 303 seconds: the row `failed` with `no_capacity`, the deployment stopped on Nosana (STOPPED), and the hold of 288 cents returned once. No usage row. |
| | The customer | The dashboard page, checked in a browser: "No GPU became available. No GPU of this type was free in time, so the deployment was not started. Nothing was charged, and your reservation was returned. You can start it again, or choose another GPU type." |
| | The operator | `GET /api/platform/compute` lists the row under `placementFailures` with `no_capacity`; the API log has the error line that begins "Deployment failed: Nosana could not place it or it never became ready", with `waitedSeconds: 303`. |

### C. The 4090 market, with no node free at the create

| Time | What | Result |
|---|---|---|
| 06:23:35 | Create | Accepted; hold of 90 cents. `JOB_RESERVE_SHORTFALL` at 06:23:36, 06:24:07, 06:25:07 and 06:27:08. |
| 06:31:09 | `JOB_LIST_CONFIRMED` | A node after 7 minutes 34 seconds of waiting. A `job_debit` row of $0.303. The default limit of 30 minutes left the row waiting, as it should. |
| 06:33:11 | The first probe of the online endpoint | The platform sent a bare load; answered in 6 seconds. |
| 06:33:20 | Our row `running` | 2 minutes 11 seconds after the job was listed. |
| 06:33:36 | The first chat through our API | **200, but in 22.1 seconds.** A second chat sent at 06:33:51 took 7.2 seconds. Both were answered at 06:33:58. The next ones took 0.55 and 0.59 seconds. |
| | Checked on the node afterwards | Unloading the model and loading it again with a bare load took 2.5 seconds, and a chat right after it 1.7 seconds. So loading was not what the first request waited for. It waited for the node's first generation after its container had started. |
| 06:39:05 | Stop | Accepted at once; Nosana STOPPED within 7 seconds; hold returned once. **9 cents charged for 345 seconds.** |
| 06:46:00 | Credits | A `job_refund` row of $0.254, 6 minutes 55 seconds after the stop. The job cost $0.049 for 8 minutes of a 4090. |

That deployment is what changed the load request from a bare load to one generated token.

### D. The 4090 market again, with the load request as it is now

| Time | What | Result |
|---|---|---|
| 06:44:38 | Create | Accepted; a node was free. `JOB_LIST_CONFIRMED` at 06:44:42; a `job_debit` row of $0.303. |
| 06:45:31 | The first probe of the online endpoint | 53 seconds after create. The server answered with no model loaded, and the platform sent its one-token request. |
| 06:46:20 | The request answered | **After 48.7 seconds**: that is what a 4090 node needed from its server answering to its first generated token. The row stayed `provisioning` and unbilled throughout. |
| 06:46:20 | Our row `running` | 102 seconds after create. Billing started here. |
| 06:46:28 | The first chat through our API | **200 in 4.3 seconds.** Then the dashboard chat 0.6 s, `/v1` 0.75 s, streamed `/v1` 0.9 s ending with `[DONE]`. |
| | Checked on the node afterwards | With the container warm: unload, then the platform's one-token request took 3.5 seconds (all of it load), and a chat right after it 1.2 seconds. |
| 06:47:52 | Stop | Accepted; Nosana STOPPED within 13 seconds; hold returned once. **3 cents charged for 92 seconds.** |
| 06:51:00 | Credits | A `job_refund` row of $0.283, 3 minutes 8 seconds after the stop. The job cost $0.020 for 3.2 minutes of a 4090. |

### E. vLLM on the 4090 market

Phi-3 mini (`microsoft/Phi-3-mini-4k-instruct`) on the vLLM engine, the first vLLM deployment
WheelsAI created on Nosana. The deploy form picks vLLM for 12 of the catalog's 21 models.

| Time | What | Result |
|---|---|---|
| 07:00:11 | Create | Accepted: Nosana took the vLLM job definition. Hold of 90 cents. `JOB_RESERVE_SHORTFALL` at 07:00:13, a node reserved at 07:00:43, `JOB_LIST_CONFIRMED` at 07:00:44, a `job_debit` row of $0.303. |
| 07:06:02 | Endpoint online, `/health` 200; our row `running` | 5 minutes 18 seconds after the job was listed: the 4090 market does not keep the `vllm/vllm-openai:v0.6.0` image, and the model is a 7.6 GB download. |
| 07:06:11 | The first chat through our API | **200, but in 27.2 seconds.** |
| 07:06:20 | Nosana reported the endpoint offline | During that first generation. Our row went `degraded`, and requests at 07:06:40 were answered **404 `model_not_found`**. |
| 07:06:50 | Online again; our row `running` | |
| 07:07:13 | Chats | Dashboard chat 0.28 s; `/v1` 0.23 s; streamed `/v1` 0.44 s ending with `[DONE]`, first token after 0.21 s. A one-token completion sent to the node directly took 0.85 s. |
| 07:08:11 | Stop | Accepted; Nosana STOPPED within 14 seconds; hold returned once. **3 cents charged for 81 seconds**, the second `running` period; the 18 seconds before the row went `degraded` were not billed. |
| 07:14:00 | Credits | A `job_refund` row of $0.257, 5 minutes 49 seconds after the stop. The job cost $0.046 for 7.5 minutes of a 4090. |

That deployment is why a vLLM deployment, like an Ollama one, is now `running` only once its
node has answered one token, and why a deployment that is not serving at the moment answers 503.

### F. vLLM again: the node served and Nosana's record said it did not

The same deployment, with the vLLM load request in the code.

| Time | What | Result |
|---|---|---|
| 07:26:12 | Create | Accepted; a node was free. `JOB_LIST_CONFIRMED` at 07:26:14; a `job_debit` row of $0.303. |
| 07:26:16 to 07:55 | Nosana's record of the deployment | **At every reading in the half hour**: the job list said `QUEUED` with `time_start` 0, `active_jobs` 0, the endpoint `online: false`. The read of the single job (`GET /deployments/{id}/jobs/{job}`) said state 1, running since 07:26:13. |
| 07:42 to 07:56 | The node | Answered `/health` with 200 whenever it was asked; at 07:52:08 a one-token completion sent to it directly took 2.2 seconds and a chat 0.8. |
| | Our row | `provisioning` throughout: it waited for `online`. Requests through our API were answered 503 "This deployment is still starting. Try again once it is running." |
| 07:56:22 | The status worker | After 1,807 seconds: the row `failed` with `start_timeout`, the deployment stopped on Nosana (STOPPED), the hold of 90 cents returned once. Nothing was charged to the customer. |
| 08:01:00 | Credits | A `job_refund` row of $0.12, 4 minutes 38 seconds after the stop. The job cost the platform $0.183 for 30 minutes of a 4090. |

That deployment is why the status worker now probes an endpoint Nosana reports offline, and
takes a node that answers as serving.

### G. vLLM with the code as it is now

| Time | What | Result |
|---|---|---|
| 08:02:30 | Create | Accepted; `JOB_LIST_CONFIRMED` at 08:02:33; a `job_debit` row of $0.303. This time Nosana's job list said RUNNING at once. |
| 08:06:21 | The first probe that got `/health` 200 | The platform sent its one-token request. |
| 08:06:25 | The request answered | After 3.8 seconds on this node. |
| 08:06:30 | Our row `running` | 4 minutes after create. Billing started here. |
| 08:06:37 | The first chat through our API | **200 in 0.74 seconds.** Then the dashboard chat 0.23 s, `/v1` 0.23 s, streamed `/v1` 0.55 s ending with `[DONE]`. |
| 08:06 to 08:08 | Our row | `running` throughout: no drop to `degraded`. Chats at 08:08:05 took 0.31, 0.24 and 0.56 seconds. |
| 08:08:09 | Stop | Accepted; Nosana STOPPED within 14 seconds; hold returned once. **3 cents charged for 99 seconds.** |
| 08:15:00 | Credits | A `job_refund` row of $0.268, 6 minutes 51 seconds after the stop. The job cost $0.035 for 5.6 minutes of a 4090. |

Afterwards the operator view showed nothing running, nothing untracked and no drafts, and
listed deployments B and F under `placementFailures`; the account listed 28 deployments, nine
of them ours, all STOPPED. Available credit went from $5.065 to $4.722: the whole run cost
$0.343, of which $0.183 was deployment F.

### What the second run settled

- **Waiting for a GPU.** With no node free, Nosana logs `JOB_RESERVE_SHORTFALL` and tries again
  after 30 seconds, then 1, 2 and 4 minutes. Nothing is listed and nothing is debited while a
  deployment waits. The 3060 deployment got its node at the 30-second try and the 4090
  deployment at the 4-minute one.
- **`no_capacity` works against Nosana.** A deployment no node took was ended at the
  provisioning limit, stopped on Nosana and its hold returned, with nothing spent on either
  side.
- **The debit is the host price on the 3060 market as well** ($0.037 for 50 minutes).
- **The refund comes 3 to 10 and a half minutes after a stop**, always on a whole minute.
- **Loaded is not ready.** On a 4090 a bare load is answered in 2.5 to 6 seconds, and the first
  generation after a container starts came 48.7 seconds after the server first answered. On the
  3060 the first chat, sent 21 seconds after the bare load was answered, took 1.1 seconds.
- **`running` now means the node has answered.** With the one-token request the first chat
  after `running` took 4.3 seconds on a cold 4090, against 22.1 with a bare load and a 504
  after 30 seconds on the first run. Later requests took 0.55 to 0.9 seconds (one on the 3060,
  a minute and a half later, 1.4).
- **Billing is exact to the second.** On each deployment that served, the billed seconds are
  the time from the row turning `running` to the stop (on E, from the second time it did).
- **A stop that cannot be confirmed leaves everything as it was**, and says so.
- **Container output is not available to us.** The deployment logs route returns Nosana's
  lifecycle events; the Nosana SDK does not expose a container's stdout and stderr.
- **vLLM deployments work.** Nosana accepts the definition, the engine starts in about five
  minutes on a 4090 for a 7.6 GB model (the image is not kept by the market), and requests
  take about a quarter of a second once it is warm.
- **A vLLM node's first generation can be slow too**: 27 seconds for the first chat on E's
  node, against 3.8 seconds for the one-token request on G's; a one-token completion sent to
  F's node ten minutes after it came up took 2.2. While E's ran, Nosana's own health check missed and it reported the
  endpoint offline for half a minute.
- **Nosana's record can stay wrong for as long as a deployment lives.** On F the job list said
  `QUEUED` and the endpoint offline at every reading in the half hour before the platform
  ended it, while the engine answered from 07:42 at the latest. The read of the single job had
  it right.
- **`start_timeout` works against Nosana.** F was ended at the provisioning limit, stopped and
  its hold returned. With `no_capacity` on B, two of the three endings have now been seen there.

### What the second run changed in the code

5. **The load request generates one token.** It was a bare load. See item 4 above and
   deployments C and D.
6. **A stop survives a network failure.** The read that precedes a stop is made up to three
   times, 750 ms apart, when it fails on the network (a name that does not resolve, a connection
   refused or reset, a host or network that cannot be reached). A stop request that fails the
   same way is sent again, up to four times 2.5 s apart, unless the read after it shows the
   deployment stopping or stopped. An answer from Nosana is never repeated. Deployment A is the
   reason.
7. **What a customer reads when a stop is not confirmed**: "We could not confirm the stop, so
   the deployment may still be running. Try again in a moment."
8. **A vLLM node is ready once it has answered one token.** `/health` 200 is no longer enough:
   the platform sends `POST /v1/completions` with
   `{"model": "<model>", "prompt": "Hi", "max_tokens": 1, "stream": false}` and the row turns
   `running` when it is answered, by the same rules as for Ollama (one request per node, in the
   background, the answer remembered and forgotten when the engine stops answering). Deployments
   E and G.
9. **Nosana's `online` is a hint; the platform's own probe decides.** When Nosana reports no
   endpoint of a model deployment online, the status worker probes the endpoints all the same
   (a waiting deployment from 60 seconds after its submit; an endpoint with no container behind
   it answers 503 in under a second). An endpoint whose node answers counts as online: a waiting
   deployment becomes `running`, and a running one is not moved to `degraded` on Nosana's flag
   alone. Deployment F.
10. **A deployment that exists and is not serving answers 503, not 404.** `/v1` and the
    dashboard chat answer `service_unavailable` for a deployment that is still starting or is
    degraded, which OpenAI clients try again; `model_not_found` is for one that is stopped,
    failed or unknown. Deployment E.
11. **A node that is busy is not marked unhealthy.** While the platform's one-token request to
    a node that reports ready is unanswered for under a minute, a node that was healthy keeps
    its health: after a restart of the API a warm node in the middle of a long answer is not
    taken out of rotation, and a running deployment is not moved to `degraded` for it when
    Nosana reports the endpoint offline at the same moment. What was seen answering is
    forgotten when the engine stops answering, when Nosana reports the endpoint offline and the
    node does not answer the platform's probe, and after five minutes.

### Not reached by either run

An extension at about 45 minutes, a replica change, a restart of a stopped deployment, the
paused refusal, a fine-tuned adapter on vLLM, a gated model (one that needs a Hugging Face
token), and `nosana_list_failed` against Nosana itself (covered by the stand-in). Item 9 has
not met Nosana's stale record again: G's was right from the start. The first chat after a cold
start can still take a few seconds longer than later ones (4.3 seconds on D).

---

## Settled by the 2026-10-07 verification

The live runs of 2026-10-08 corrected two rows of this table. Credits for a job show as
`reservedCredits` while it runs, and the refund came between 3 and 10 and a half minutes after
the stop, not about one. The debits seen (a 4090 and a 3060) were at the market's host price,
without the 10% fee. Both rows are left as written, with the correction here.

These were in part 3. None was measured by a paid run of ours. Each was settled by reading
Nosana's published OpenAPI document, the public deployment-manager source (`127f915`,
2026-10-05) and node source (`3f07617`), the client packages, and read-only GETs with the
founder's key against the shared account. Nothing was created, started or stopped. The live
responses were not kept; the file names below identify the source read, not a file in this
repository.

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

## 3. What stays unverified

What the two live runs settled is in their own sections above, and what the 2026-10-07
verification settled is in "Settled". This is what they left open.

On Nosana, for the rest of the checklist to show:

- **That a failing listing is ended by the platform on Nosana.** Attempt 1 of the first run was
  stopped by hand. The rule that now ends it (`nosana_list_failed`, a stop, the hold returned)
  has run against the stand-in only, with the events Nosana logged in that attempt. The
  configuration that caused it can no longer be started. `no_capacity` and `start_timeout` were
  both seen against Nosana on the second run (deployments B and F).
- **That a node which answers behind an endpoint Nosana reports offline is taken as serving.**
  The rule was written after deployment F and is covered by unit tests only, with a scripted
  observation and probe; against the stand-in only the endpoint that does not answer has run.
  G's record was right from the start.
- **The first chat after a cold start.** It took 4.3 seconds on a 4090 on the second run,
  against 0.55 to 0.9 seconds for later requests: the node has answered one token by then, and
  its first full request is still slower than the next.
- **The replica update through the SDK with an API key**, and what its response holds. Create,
  start and stop are settled. Step 11.
- **The 4070 market, and other models.** The runs used `llama3.2:3b` on Ollama (4090 and 3060)
  and Phi-3 mini on vLLM (4090). A larger model, a model that needs a Hugging Face token, and a
  fine-tuned adapter have not run. For vLLM 0.6.x on the 4070, see the fine-tuning run.
- **Supply.** On 2026-10-08 the A100 40GB and H100 markets had no node, and the 3060 and 4070
  markets none free. A deployment there waits, and is ended as `no_capacity` at the provisioning
  limit.
- **Whether a debit is always the host price.** The 4090 and 3060 debits were the host price x
  50 minutes, without the 10% fee; the 6-hour debits of the other project equal the
  fee-inclusive price.
- **A credit-paid SIMPLE-EXTEND extension on a WheelsAI deployment**: the timing and amount of
  the debit, how `reservedCredits` moves, and that the deployment stays RUNNING. Known from
  source only. Step 9.
- **The minimum charge for a very short job** (about $0.01 observed on the other project, and
  deployment A of the second run cost exactly $0.010 where pro rata was $0.007). Whether that is
  a minimum is not confirmed. Step 14.
- **The refund when a SIMPLE job completes on its own before its timeout.** Only refunds after a
  stop have been seen. The fine-tuning run shows it.
- **How long a refund takes in general.** Seven refunds of ours were seen, between 3 minutes 8
  seconds and 10 minutes 28 seconds after the stop, each on a whole minute. Step 13.
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
