# Nosana deployments with an API key — what is proven, and the first paid run

**Date:** 2026-10-07 · **Branch:** `feat/bags-launchpad` (working tree on top of `688fe21`)
**Migration:** `20261011100000_nosana_access_mode`

The platform can pay Nosana in two ways, chosen by configuration: a Solana wallet (a vault per
deployment, funded in NOS and SOL), or a dashboard API key (prepaid USD credits, no vault). This
document has three parts:

1. **What was proven on this machine**, with the commands and their output.
2. **The checklist for the first paid run**, with a results table to fill in.
3. **What stays unverified until that run.**

**Nothing in part 1 was run against Nosana with a credential.** The only request that reached
Nosana is the unauthenticated public read of the market list. Everything else ran against a
stand-in Nosana API on 127.0.0.1 (`apps/api/src/tests/fakeNosanaApi.ts`). That proves **our
code**: what it sends, in what order, what it stores, what it bills, and what it refuses. It
proves nothing about how Nosana behaves. Part 3 lists what that leaves open.

---

## 1. What was proven on this machine

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

### Before anything is spent

**Environment** (the API's environment only; never the web app's):

| Variable | Value | Why |
|---|---|---|
| `NOSANA_API_KEY` | the dashboard key | Created at [FOUNDER: confirm the page; public docs say deploy.nosana.com, Account, API Keys]. Note its expiry date. |
| `NOSANA_ACCESS_MODE` | `api_key` | Says which account pays. Required if the wallet key is also set. |
| `NOSANA_NETWORK` | `mainnet` | The default with an API key; set it so it is on record. `SOLANA_NETWORK` can stay as it is. **If the wallet key is also set and its deployments are on devnet, leave this unset instead**: set, it moves the wallet to mainnet as well. |
| `NOSANA_TIMEOUT_UNIT` | `minutes` | The default, and what the public source says (1.5); set it so it is on record and the start-up warning stops. Step 5 confirms or refutes it at the lowest possible cost. |
| `NOSANA_JOB_TIMEOUT_SECONDS` | `600` | The minimum our configuration accepts. Sent as 10 with the unit above. |
| `NOSANA_MIN_CREDITS_USD` | `5` | The floor. |
| `PLATFORM_ADMIN_KEY` | at least 16 characters | For the operator view. |
| `DEPLOYMENT_STATUS_INTERVAL_MS` | above 0 | Without the status worker a deployment never reaches `running`. |
| `GPU_BILLING_INTERVAL_MS` | `60000` | Per-second billing of the organization. |
| `ALLOW_NOSANA_MOCK` | unset | The mock must not stand in for Nosana. |

**Balance to load: the floor plus a margin, $15 with the $5 floor.** A deployment is admitted
only when its estimate plus the floor is available, and the floor must still be there for the
restart and the scale-up later in the run. The run itself should cost well under $1 on the 3060
market (about $0.05 an hour with the fee). $10 would pass the first create and could refuse a
later step.

**Why `minutes` and 600 seconds for the first create.** The four possible outcomes:

| We send | Nosana reads it as | The job's timeout | Reserved for one 3060 replica (about) |
|---|---|---|---|
| `10` (unit set to minutes) | minutes | 10 minutes | $0.008 |
| `10` (unit set to minutes) | seconds | 10 seconds; the job ends at once | under $0.001 |
| `600` (unit left at seconds) | seconds | 10 minutes | $0.008 |
| `600` (unit left at seconds) | minutes | 10 hours | $0.50 |

Sending 10 is cheap whichever way Nosana reads it. Sending 600 is the only case with a large
reservation. If the manager refuses a timeout of 10 outright, that itself says the unit is not
minutes ("at least 1 minute" would accept it): record the error and stop.

**Deployment to create:** tier 3060, model Llama 3.2 1B on the Ollama engine (no Hugging Face
token needed), 1 replica, in an organization with at least $1 of WheelsAI credits.

### Steps

| # | Do | Expect |
|---|---|---|
| 1 | `cd apps/api && npx tsx scripts/nosana-access-check.ts`. It only reads. | Mode `api_key`, network `mainnet`, the key's last four characters, a balance of about $15, exit code 0. `REJECTED` means the key is wrong, expired or lacks a permission: stop. Record the balance as **B0** (assigned, reserved, settled). |
| 2 | In the same output, read "raw fields of one existing deployment". | If the account has a deployment: `owner` and `vault` of the newest one are printed (a `wheelsai-*` one when there is one), and whether `owner` parses as a Solana public key. **If it says NO, stop:** the SDK would throw on create after Nosana had already created the deployment. If the account has none, the fields cannot be read without creating one: go on, and run the script again right after step 4. |
| 3 | Start the API. `GET /api/platform/compute` with `x-admin-key`. | `mode` `api_key`, `credits.state` `ok` or `low`, `timeout.unit` `minutes`, every tier `belowCost: false`, `unreachable.rows` empty. `GET /api/status` shows GPU compute operational. |
| 4 | Create the deployment in the dashboard. | 201; the row goes `pending` then `provisioning`; an organization hold of 36 cents (one hour of a 3060). If the create fails, open the operator view after 15 minutes: `nosana.untrackedDrafts` or `nosana.untracked` names anything Nosana created anyway (`wheelsai-model-<deployment id>-r0`). Stop it in Nosana's dashboard by hand. |
| 5 | **Within a minute**, run the check script again. Record **B1**. | `reserved(B1) - reserved(B0)` gives the unit: about $0.008 means Nosana read 10 as minutes. Under $0.001, or a deployment that ends within seconds, means it read 10 as seconds: stop the deployment, set `NOSANA_TIMEOUT_UNIT=seconds`, and start again from step 3. Any other figure: stop the deployment and record it; the reservation model is not what we assumed. Also record the `timeout` field the script prints for the deployment. |
| 6 | In the same output, re-read `owner` and `vault` of the new deployment (if step 2 had none to read). | `owner` parses as a public key. Record both values' shape (a public key, a user id, empty). |
| 7 | Wait for `running` with a healthy node. | Record the time from create to running, and the endpoint's host (the operator does not see node URLs in the API; read `deployment_nodes.node_url` in the database). |
| 8 | Send one chat completion to `/v1/<slug>/chat/completions`. | An answer. Record the latency. |
| 9 | Wait past one timeout (11 minutes or more). Run the check script. | The deployment is still `RUNNING` (SIMPLE-EXTEND extended it) and reserved or settled moved again. Record both. If it stopped at the timeout, the strategy does not extend with credits: record it and stop. |
| 10 | Read the organization's ledger. | `gpu_usage` rows at $0.0001 a second for one replica, each with a consistent `balanceAfter`. |
| 11 | (Optional; doubles the cost for a few minutes.) Replicas 1 to 2, wait for the count to be confirmed, back to 1. | Nosana's replica count, our row and the billing agree; usage up to the change is billed at the old count. |
| 12 | Stop from the dashboard. | The stop answers at once; `fundsReleased` may be `false`. Within one status tick the row's release is confirmed (`vault_reclaimed_at` set). The hold is returned once and the final window is billed. |
| 13 | Five minutes later, run the check script. Record **B2**. | Reserved back at B0's level; `settled(B2) - settled(B0)` is the true cost. Compare with elapsed time x $0.0504 an hour. If reserved has not come back, record after how long it does. |
| 14 | Start the same deployment again, wait for `running`, stop it. | The restart is not refused with `previous_run_winding_down`. |
| 15 | No spend: set `NOSANA_MIN_CREDITS_USD` above the balance, restart the API, try to create. | 503 `compute_capacity_unavailable`, the dashboard says "GPU deployments are paused right now. Nothing was charged.", no row, no hold; `/status` shows "New deployments paused". Restore the value. |
| 16 | `GET /api/platform/compute` once more. | `nosana.untracked` and `nosana.untrackedDrafts` empty, `running.deployments` 0. |

That the job ran at all shows that a definition created with `confidential: true` reaches the
host with an API key (step 7).

### Results

| # | Result | Value recorded | Date |
|---|---|---|---|
| 1 | Key accepted; balance B0 (assigned / reserved / settled) | | |
| 2, 6 | Raw `owner`; raw `vault`; `owner` parses as a public key | | |
| 3 | Operator view state; tiers below cost | | |
| 4 | Create answered; hold taken (cents) | | |
| 5 | **B1; reserved delta; the unit Nosana applied**; `timeout` as stored by Nosana | | |
| 7 | Seconds from create to running; endpoint host; one URL per replica or per deployment | | |
| 8 | Chat completion answered; latency | | |
| 9 | Still running after one timeout; reserved and settled after the extension | | |
| 10 | Ledger rows consistent | | |
| 11 | Replica change confirmed and billed at the right counts | | |
| 12 | `fundsReleased` in the stop answer; seconds until the release was confirmed | | |
| 13 | **B2; settled delta (the true cost); when reserved returned** | | |
| 14 | Restart worked | | |
| 15 | Paused refusal: no row, no hold | | |
| 16 | Nothing untracked | | |
| | Was the 10% fee charged on top of the host reward? (settled delta against elapsed x $0.0436 and x $0.0504) | | |
| | The status a deployment takes when credits run out (only if seen) | | |

After the run: set `NOSANA_TIMEOUT_UNIT` to what step 5 showed, in every environment, and raise
`NOSANA_JOB_TIMEOUT_SECONDS` back to its default (7200) or leave it unset.

---

## 3. What stays unverified until that run

Nothing below has been observed. Each is read from the installed SDK's types and code, the
public deployment-manager source, or public documentation.

- **The unit of `timeout`** (minutes by the public source, seconds by the installed SDK's
  comment). Step 5.
- **What an API-key account returns as `owner` and `vault`.** The SDK parses `owner` as a Solana
  public key on every create, get and list. In the public manager source an API-key deployment
  gets `vault = owner = the user id`. If that id is not a base58 key, the SDK throws after the
  deployment exists. Steps 2 and 6.
- **How credits are reserved** (how much, and whether at create, start or listing), **whether an
  unused reservation comes back on stop, and how fast.** Steps 5 and 13.
- **Strategy behaviour with credits**: that SIMPLE-EXTEND extends one job from the balance before
  its timeout, that SIMPLE ends at the timeout. Step 9.
- **That `INSUFFICIENT_FUNDS` is the status a deployment takes when credits run out**, and
  whether one deployment or all of them stop. Not in the checklist (it would need the balance
  to run out); our handling of it is unit tested only.
- **That the 10% network fee is charged on top for credit-paid deployments.** Step 13. Our cost
  figures assume it, which errs high.
- **That `confidential: true` works with an API key**, and that registry credentials in a job
  definition work. Step 7 covers the first; the second is untested.
- **Whether the devnet backend has credits or accepts dashboard keys.** Not in the checklist;
  API-key access is treated as mainnet.
- **Where keys are created, the `nos_` prefix, the mandatory expiry and the permissions.** From
  public documentation. Step 1 confirms the key works, not the rest.
- **Whether endpoints are one URL per replica or one per deployment.** Step 7.
- **Whether a deployment created by a wallet is visible to an API key of another account.**
  Assumed not; our code never tries (each row is acted on through the mode that created it).
- **That the Ollama image with `llama3.2:1b` starts on the 3060 market.** Step 7.
- **What Nosana returns for a stop of a halted deployment** (error or insufficient funds). Our
  code attempts the stop, tolerates a refusal and counts the run as released; unit tested only.
- **The time fields of a deployment's job** (`getDeploymentJob`): read as unix seconds, or
  milliseconds when the number is large. Unit unverified; the fine-tuning build relies on it.
- **Listing a wallet's deployments** for the operator view goes through a wallet-signed read
  that has only been exercised against test doubles.
- The manager's create schema also accepts an `idempotency_key` that the installed SDK's types
  do not know. Not used. It would close the "create threw but the deployment exists" case.

Wallet access was not re-run with funds either. What `docs/FOUNDER-ACTIONS.md` section 3 lists
for the first funded wallet run still stands.
