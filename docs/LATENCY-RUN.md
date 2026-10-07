# Measured latency — proof run

**Date:** 2026-10-07 (times below are UTC) · **Branch:** `feat/bags-launchpad` (working tree on top of `109e928`)
**Migrations applied to the copy:** `20261010200000_request_latency`, `20261010210000_null_legacy_snapshot_percentiles`

The claim was a line in the landing page's terminal preview: *"Latency: 47ms avg"*. Nobody
measured it. This run shows what replaced it: one row per served chat request, a public figure
computed from those rows and published only above a threshold, the landing page and the CLI
printing that figure or saying why there is none, and an alert rule on p95 latency firing.

**The numbers below are from local test traffic: 19 playground chats sent by this run to
agents on the platform's free Groq model, from one machine. They are not a production
figure and say nothing about what customers will see.** The publication thresholds were
lowered for the run (12 answered requests instead of 50; the 3-organization rule was kept),
so that a handful of real chats could cross them.

Everything below is the exact command and its unedited output, with these exceptions: bearer
tokens are read from files, the demo password is read from `$DEMO_PASSWORD`, and long JSON is
cut down with the `python3` filter shown. Nothing was simulated; the model calls went to Groq.

---

## What was built

| | |
|---|---|
| `request_latency_samples` | one row per chat request that reached a model: organization, surface, agent or deployment, model, provider, outcome, total time, and node and first-token time where known. No message content |
| one source of truth | every latency the product states is `percentile_disc` or `avg` over that table: the public figure, `/status`, alert rules, the analytics overview, deployment metrics, agent usage and the daily snapshots |
| `GET /api/public/stats` `latency` | `measured`, `insufficient_data` or `unavailable`. `p50Ms` and `p95Ms` are non-null only when measured. Read at most once a minute per process |
| `GET /api/status` `latency` | the same figure plus the histogram and the share of failed requests, both withheld below the thresholds |
| landing page | the terminal's `Latency:` line is read live from the API (one request per page, shared with the stat tiles). Three states, no fallback number; a note under the terminal links to `/status#latency` |
| `wheelsai deploy` | prints the same field with the same formatter |
| alert rules | `latency_p95` and `latency_avg` are evaluated (they used to be accepted and skipped), in ms, with the request count in the message |
| legacy analytics percentiles | the stored p50/p95/p99, which were averages of hourly averages, are set to NULL by the second migration |

The headline is the p50 end-to-end response time of successfully answered chat requests,
measured at the API, over a rolling 24 hours, across agent chats and model deployments.

---

## The environment

A **copy** of the local database, so the seeded demo data was never touched, and its own
Redis index. Three seeded organizations took part: Northwind AI Labs (`demo@northwind.ai`),
Kestrel Labs (`team@kestrel.ai`) and Atlas Agents (`hello@atlasagents.dev`). Each has a
"support concierge" agent on `free/groq/llama-3.3-70b`.

### 1. Copy the database and apply the migrations

`$PG` is the connection string from `apps/api/.env` without the database name. The two widget
migrations belong to other work in the same tree; the generated Prisma client expects them.

```bash
psql "$PG/postgres" -c "CREATE DATABASE wheelsai_latency_run TEMPLATE wheelsai"
for m in 20261010100000_web_widget_try_it 20261010110000_widget_hide_branding \
         20261010200000_request_latency 20261010210000_null_legacy_snapshot_percentiles; do
  psql "$PG/wheelsai_latency_run" -v ON_ERROR_STOP=1 -q -f packages/db/prisma/migrations/$m/migration.sql
done
psql "$PG/wheelsai_latency_run" -Atc "select count(*) from request_latency_samples"
```

```text
CREATE DATABASE
0
```

The copy held two alert rules from an earlier demo, in another organization, attached to a
Slack channel. They were switched off in the copy so the run could not send a notification:

```bash
psql "$PG/wheelsai_latency_run" -c "update alert_rules set is_enabled=false"
```

```text
UPDATE 2
```

### 2. Start the API on port 4270

Background workers off, except the alert evaluator (every 15 seconds). The two
`PUBLIC_LATENCY_*` variables are the lowered thresholds; their defaults are 50 and 3.

```bash
cd apps/api
set -a; . ./.env; set +a
BASE="${DATABASE_URL%%\?*}"
export DATABASE_URL="${BASE%/wheelsai}/wheelsai_latency_run?schema=public"
export REDIS_URL="redis://localhost:6380/9"
export API_PORT=4270 PUBLIC_API_URL=http://localhost:4270 CORS_ORIGIN=http://localhost:3270 \
RATE_LIMIT_MAX_PER_MINUTE=1000 LOG_LEVEL=info \
PUBLIC_LATENCY_MIN_SAMPLES=12 PUBLIC_LATENCY_MIN_ORGS=3 \
ALERT_EVALUATOR_INTERVAL_MS=15000 \
EMBEDDING_BACKFILL_INTERVAL_MS=0 TOKEN_INDEXER_INTERVAL_MS=0 TREASURY_SETTLEMENT_INTERVAL_MS=0 \
TREASURY_SETTLEMENT_BATCH_INTERVAL_MS=0 PAYMENT_SUBMIT_INTERVAL_MS=0 PAYMENT_POLL_INTERVAL_MS=0 \
PAYMENT_REAP_INTERVAL_MS=0 FEE_ROUTER_INTERVAL_MS=0 BAGS_FEE_SWEEP_INTERVAL_MS=0 \
REPUTATION_ATTESTATION_INTERVAL_MS=0 DEPLOYMENT_STATUS_INTERVAL_MS=0 SCHEDULER_INTERVAL_MS=0 \
WORKFLOW_REAP_INTERVAL_MS=0 UPTIME_PROBER_INTERVAL_MS=0 JOB_SWEEP_INTERVAL_MS=0 \
ANALYTICS_SNAPSHOT_INTERVAL_MS=0 SUBSCRIPTION_RENEWAL_INTERVAL_MS=0 PAYOUT_EXECUTOR_INTERVAL_MS=0 \
GPU_BILLING_INTERVAL_MS=0 X402_SETTLEMENT_WORKER_ENABLED=false
npx tsx src/index.ts
```

`curl -s -i http://localhost:4270/health` answered `HTTP/1.1 200 OK`. No Nosana deployment was
started, restarted or polled at any point.

### 3. Start the web app against it

```bash
cd apps/web
NEXT_PUBLIC_API_URL=http://localhost:4270 NEXT_PUBLIC_APP_URL=http://localhost:3270 npx next dev -p 3270
```

The landing page is read back with a short Playwright script (headless Chromium) that loads
`/`, waits for the latency line to leave its loading state, and prints the line, the note
under it, and every request the page made to `/api/public/stats`. It is called
`render-landing.mjs` below.

---

## 1. No traffic: "measuring", and no number

```bash
date -u +%FT%TZ
curl -s -i http://localhost:4270/api/public/stats | grep -i "^HTTP\|cache-control"
curl -s http://localhost:4270/api/public/stats | python3 -m json.tool
```

```text
2026-10-07T01:50:37Z
HTTP/1.1 200 OK
cache-control: public, max-age=300
{
    "frameworks": 6,
    "models": 21,
    "pricingModels": 4,
    "channels": 4,
    "channelPlatforms": [
        "discord",
        "telegram",
        "slack",
        "web"
    ],
    "publishedListings": 18,
    "latency": {
        "metric": "response_time",
        "definition": "Time the WheelsAI API took to produce the complete answer to a chat request, successful answers only; network time between the caller and the API is not included.",
        "surfaces": [
            "v1",
            "deployment_chat",
            "agent_api",
            "agent_playground",
            "agent_widget",
            "agent_trial"
        ],
        "windowHours": 24,
        "minSampleCount": 12,
        "minOrgCount": 3,
        "status": "insufficient_data",
        "sampleCount": 0,
        "firstTokenSampleCount": 0,
        "computedAt": "2026-10-07T01:50:37.453Z",
        "p50Ms": null,
        "p95Ms": null,
        "firstTokenP50Ms": null
    }
}
```

The landing page in that state:

```bash
node render-landing.mjs http://localhost:3270/
```

```text
status attribute : insufficient_data
terminal line    : "Latency: measuring (0 of 12 requests)"
note under it    : "Latency: No figure yet: one is published once at least 12 answered requests from at least 3 organizations fall inside the last 24 hours. How it is measured"
link             : /status#latency
stats requests   : 1 GET http://localhost:4270/api/public/stats
page has "47ms"  : false
```

One request to the API for the whole page: the stat tiles and the latency line share it.

After this run the landing page's terminal line was shortened in this state to `Latency: measuring`,
without the running count (`apps/web/src/lib/publicStats.ts`, `landingLatencyValue`). The note
under it, `/status` and the `wheelsai deploy` output are unchanged, so the line above is what
the page printed during the run, not what it prints now.

---

## 2. Real chats from two organizations: enough requests, still no number

Sign in once per organization and keep the token:

```bash
for pair in northwind:demo@northwind.ai kestrel:team@kestrel.ai atlas:hello@atlasagents.dev; do
  n=${pair%%:*}; e=${pair#*:}
  curl -s -X POST http://localhost:4270/api/auth/login -H 'Content-Type: application/json' \
    -d "{\"email\":\"$e\",\"password\":\"$DEMO_PASSWORD\"}" > login-$n.json
  python3 -c "import json;open('token-$n','w').write(json.load(open('login-$n.json'))['token'])"
done
```

`chat.sh <org> <agent-id> <count>` sends that many playground chats one after another,
cycling through seven short support questions, and prints what curl measured:

```bash
curl -s -o reply.json -w "$ORG chat $i: HTTP %{http_code} in %{time_total}s\n" \
  -X POST "http://localhost:4270/api/agents/$AGENT/playground/chat" \
  -H "Authorization: Bearer $(cat token-$ORG)" -H 'Content-Type: application/json' \
  -d "{\"messages\":[{\"role\":\"user\",\"content\":\"$Q Answer in one short sentence.\"}]}"
```

The first chat, with its answer:

```bash
./chat.sh northwind bfb7e168-b5f5-47ff-b909-c2e2b4e6f921 1; python3 -m json.tool reply.json
```

```text
northwind chat 1: HTTP 200 in 6.303904s
{
    "content": "I’m not sure of the exact details, but I can connect you with a support specialist for the refund policy.",
    "model": "free/groq/llama-3.3-70b",
    "usage": {
        "inputTokens": 121,
        "outputTokens": 205
    },
    "toolCalls": [],
    "billing": null,
    "retrieval": null
}
```

That first request took six seconds: it was the first chat this API process served. It is a
real request, so it stays in the data, and it is the p95 below.

```bash
./chat.sh northwind bfb7e168-b5f5-47ff-b909-c2e2b4e6f921 6
./chat.sh kestrel a07e99a5-9c91-4f2e-9b60-63689f275c72 6
```

```text
northwind chat 1: HTTP 200 in 0.722395s
northwind chat 2: HTTP 200 in 0.604668s
northwind chat 3: HTTP 200 in 0.616128s
northwind chat 4: HTTP 200 in 0.446005s
northwind chat 5: HTTP 200 in 0.678500s
northwind chat 6: HTTP 200 in 0.628641s
kestrel chat 1: HTTP 200 in 0.840151s
kestrel chat 2: HTTP 200 in 0.522445s
kestrel chat 3: HTTP 200 in 0.655724s
kestrel chat 4: HTTP 200 in 0.481144s
kestrel chat 5: HTTP 200 in 0.583538s
kestrel chat 6: HTTP 200 in 0.475807s
```

Thirteen stored rows from two organizations, and the public answer:

```bash
psql "$PG/wheelsai_latency_run" -c "select o.name as organization, s.surface, s.provider, s.outcome,
  count(*) as requests, min(s.total_ms) as min_ms, max(s.total_ms) as max_ms
  from request_latency_samples s join organizations o on o.id = s.org_id group by 1,2,3,4 order by 1"
date -u +%FT%TZ
curl -s http://localhost:4270/api/public/stats | python3 -c "import json,sys; l=json.load(sys.stdin)['latency']; print(json.dumps({k:l[k] for k in ['status','sampleCount','minSampleCount','minOrgCount','p50Ms','p95Ms','computedAt']}, indent=2))"
```

```text
   organization    |     surface      | provider | outcome | requests | min_ms | max_ms 
-------------------+------------------+----------+---------+----------+--------+--------
 Kestrel Labs      | agent_playground | groq     | ok      |        6 |    473 |    837
 Northwind AI Labs | agent_playground | groq     | ok      |        7 |    444 |   6297
(2 rows)

2026-10-07T01:52:11Z
{
  "status": "insufficient_data",
  "sampleCount": 13,
  "minSampleCount": 12,
  "minOrgCount": 3,
  "p50Ms": null,
  "p95Ms": null,
  "computedAt": "2026-10-07T01:52:11.900Z"
}
```

Thirteen is above the sample threshold of twelve, and there is still no number: the requests
come from two organizations and the rule asks for three. The landing page says so, instead of
printing "13 of 12":

```text
status attribute : insufficient_data
terminal line    : "Latency: measuring (requests from fewer than 3 organizations)"
note under it    : "Latency: No figure yet: one is published once at least 12 answered requests from at least 3 organizations fall inside the last 24 hours. How it is measured"
link             : /status#latency
stats requests   : 1 GET http://localhost:4270/api/public/stats
page has "47ms"  : false
```

---

## 3. An alert rule on p95 latency

Two organization-level rules in Atlas Agents, created before Atlas had sent anything: one that
should fire (p95 above 100 ms over 5 minutes) and one that should not (p95 above 10 minutes).
Neither has a notification channel.

An unknown rule is refused, where it used to be stored:

```bash
curl -s -X POST http://localhost:4270/api/monitoring/rules -H "Authorization: Bearer $(cat token-atlas)" \
  -H 'Content-Type: application/json' \
  -d '{"name":"p99","ruleType":"threshold","metric":"latency_p99","operator":"gt","threshold":100}'
```

```text
{"success":false,"error":"resourceType must be one of: deployment, agent, organization"}
```

```bash
curl -s -X POST http://localhost:4270/api/monitoring/rules -H "Authorization: Bearer $(cat token-atlas)" \
  -H 'Content-Type: application/json' \
  -d '{"name":"p95 above 100 ms","ruleType":"threshold","resourceType":"organization","metric":"latency_p95","operator":"gt","threshold":100,"windowMinutes":5,"severity":"warning","cooldownMinutes":60,"channelIds":[]}' | python3 -m json.tool
```

```text
{
    "success": true,
    "data": {
        "id": "2e1b7a50-8828-46ae-8795-2975bd0cf32a",
        "orgId": "d7370e1d-7c64-4431-a150-89cb7132aa4a",
        "name": "p95 above 100 ms",
        "description": null,
        "ruleType": "threshold",
        "resourceType": "organization",
        "resourceId": null,
        "metric": "latency_p95",
        "operator": "gt",
        "threshold": 100,
        "windowMinutes": 5,
        "severity": "warning",
        "cooldownMinutes": 60,
        "isEnabled": true,
        "lastTriggeredAt": null,
        "createdAt": "2026-10-07T01:52:34.899Z",
        "updatedAt": "2026-10-07T01:52:34.899Z"
    },
    "message": "Alert rule created"
}
```

The second rule (same body, `"name":"p95 above 10 minutes"`, `"threshold":600000`) was created
as `256cd3bc-c07b-4cd3-bc47-b2cad7c18274`.

Before Atlas sent a request, an evaluator pass found nothing to measure and raised nothing.
From the API log, and the alerts list:

```text
[01:53:00] INFO: Alert evaluator tick complete
    service: "wheelsai-api"
    env: "development"
    context: "alert-evaluator-queue"
    rules: 2
    breached: 0
    fired: 0
    inCooldown: 0
    withinThreshold: 0
    noData: 2
    unsupported: 0
```

```bash
curl -s "http://localhost:4270/api/monitoring/alerts" -H "Authorization: Bearer $(cat token-atlas)"
```

```text
{"success": true, "data": [], "pagination": {"total": 0, "limit": 50, "offset": 0}}
```

No request is `noData`, not a p95 of 0: a "p95 below X" rule would not fire on an idle
organization either.

---

## 4. The third organization: the figure is measured, and the alert fires

```bash
./chat.sh atlas d923396a-36a5-40f2-a5b1-bc220cfbf257 6
date -u +%FT%TZ
```

```text
atlas chat 1: HTTP 200 in 1.379644s
atlas chat 2: HTTP 200 in 0.722138s
atlas chat 3: HTTP 200 in 0.899380s
atlas chat 4: HTTP 200 in 0.605257s
atlas chat 5: HTTP 200 in 0.606488s
atlas chat 6: HTTP 200 in 0.380381s
2026-10-07T01:53:04Z
```

### The alert

The next evaluator pass, eleven seconds later:

```text
[01:53:15] INFO: Alert evaluator tick complete
    service: "wheelsai-api"
    env: "development"
    context: "alert-evaluator-queue"
    rules: 2
    breached: 1
    fired: 1
    inCooldown: 0
    withinThreshold: 1
    noData: 0
    unsupported: 0
```

One rule breached and fired; the ten-minute rule was within its threshold. Every pass after
that reported `breached: 1, fired: 0, inCooldown: 1`, so the alert was raised exactly once.

```bash
curl -s "http://localhost:4270/api/monitoring/alerts" -H "Authorization: Bearer $(cat token-atlas)" | python3 -m json.tool
```

```text
{
    "success": true,
    "data": [
        {
            "id": "d4d173c2-9c48-4691-bae7-dc0635512623",
            "orgId": "d7370e1d-7c64-4431-a150-89cb7132aa4a",
            "ruleId": "2e1b7a50-8828-46ae-8795-2975bd0cf32a",
            "status": "active",
            "severity": "warning",
            "title": "p95 above 100 ms triggered",
            "message": "latency_p95 gt 100 (actual: 1377.00 ms over 6 requests)",
            "resourceType": "organization",
            "resourceId": null,
            "metricValue": 1377,
            "threshold": 100,
            "triggeredAt": "2026-10-07T01:53:15.059Z",
            "acknowledgedAt": null,
            "acknowledgedBy": null,
            "resolvedAt": null,
            "resolvedBy": null,
            "notificationsSent": {},
            "rule": {
                "name": "p95 above 100 ms",
                "resourceType": "organization"
            }
        }
    ],
    "pagination": {
        "total": 1,
        "limit": 50,
        "offset": 0
    }
}
```

The value in the alert, recomputed by hand from the rows of that organization in the five
minutes before it fired:

```bash
psql "$PG/wheelsai_latency_run" -c "SELECT count(*) AS requests,
  percentile_disc(0.95) WITHIN GROUP (ORDER BY total_ms) AS p95_ms
  FROM request_latency_samples
  WHERE org_id = 'd7370e1d-7c64-4431-a150-89cb7132aa4a' AND outcome IN ('ok','error','timeout')
    AND created_at >= timestamp '2026-10-07 01:53:15.059' - interval '5 minutes'
    AND created_at <  timestamp '2026-10-07 01:53:15.059'"
```

```text
 requests | p95_ms 
----------+--------
        6 |   1377
(1 row)
```

The rule is scoped to its organization: Northwind's six-second request is not in it.

### The public figure

The figure is recomputed at most once a minute, so this was read 62 seconds later:

```bash
date -u +%FT%TZ
curl -s http://localhost:4270/api/public/stats | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['latency'], indent=2))"
```

```text
2026-10-07T01:54:13Z
{
  "metric": "response_time",
  "definition": "Time the WheelsAI API took to produce the complete answer to a chat request, successful answers only; network time between the caller and the API is not included.",
  "surfaces": [
    "v1",
    "deployment_chat",
    "agent_api",
    "agent_playground",
    "agent_widget",
    "agent_trial"
  ],
  "windowHours": 24,
  "minSampleCount": 12,
  "minOrgCount": 3,
  "status": "measured",
  "sampleCount": 19,
  "firstTokenSampleCount": 0,
  "computedAt": "2026-10-07T01:54:13.258Z",
  "p50Ms": 613,
  "p95Ms": 6297,
  "firstTokenP50Ms": null
}
```

`firstTokenP50Ms` is null because none of these chats was streamed, and agent chat streams do
not record a first-token time yet (it is in the backlog).

---

## 5. The same figure from the stored rows

```sql
-- The published figure, from the stored rows: successful answers on the
-- public surfaces in the last 24 hours, the mock provider left out.
SELECT count(*)                                                AS samples,
       count(DISTINCT org_id)                                  AS organizations,
       percentile_disc(0.5)  WITHIN GROUP (ORDER BY total_ms)  AS p50_ms,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY total_ms)  AS p95_ms
  FROM request_latency_samples
 WHERE outcome = 'ok'
   AND surface IN ('v1', 'deployment_chat', 'agent_api', 'agent_playground', 'agent_widget', 'agent_trial')
   AND provider <> 'nosana_mock'
   AND created_at >= now() - interval '24 hours';
```

```text
 samples | organizations | p50_ms | p95_ms 
---------+---------------+--------+--------
      19 |             3 |    613 |   6297
(1 row)
```

19 samples, 3 organizations, p50 613 ms, p95 6,297 ms: the API's answer. And every row behind
it, in order. `percentile_disc` returns a value that is in the table: the p50 is row 10 of 19,
the p95 is row 19.

```bash
psql "$PG/wheelsai_latency_run" -c "SELECT row_number() OVER (ORDER BY total_ms) AS rank, total_ms,
  o.name AS organization, s.surface, s.provider, s.model, s.outcome, to_char(s.created_at, 'HH24:MI:SS') AS at_utc
  FROM request_latency_samples s JOIN organizations o ON o.id = s.org_id ORDER BY total_ms"
```

```text
 rank | total_ms |   organization    |     surface      | provider |          model          | outcome |  at_utc  
------+----------+-------------------+------------------+----------+-------------------------+---------+----------
    1 |      377 | Atlas Agents      | agent_playground | groq     | free/groq/llama-3.3-70b | ok      | 01:53:04
    2 |      444 | Northwind AI Labs | agent_playground | groq     | free/groq/llama-3.3-70b | ok      | 01:51:53
    3 |      473 | Kestrel Labs      | agent_playground | groq     | free/groq/llama-3.3-70b | ok      | 01:51:58
    4 |      477 | Kestrel Labs      | agent_playground | groq     | free/groq/llama-3.3-70b | ok      | 01:51:57
    5 |      518 | Kestrel Labs      | agent_playground | groq     | free/groq/llama-3.3-70b | ok      | 01:51:55
    6 |      581 | Kestrel Labs      | agent_playground | groq     | free/groq/llama-3.3-70b | ok      | 01:51:57
    7 |      600 | Northwind AI Labs | agent_playground | groq     | free/groq/llama-3.3-70b | ok      | 01:51:52
    8 |      603 | Atlas Agents      | agent_playground | groq     | free/groq/llama-3.3-70b | ok      | 01:53:03
    9 |      603 | Atlas Agents      | agent_playground | groq     | free/groq/llama-3.3-70b | ok      | 01:53:04
   10 |      613 | Northwind AI Labs | agent_playground | groq     | free/groq/llama-3.3-70b | ok      | 01:51:52
   11 |      625 | Northwind AI Labs | agent_playground | groq     | free/groq/llama-3.3-70b | ok      | 01:51:54
   12 |      652 | Kestrel Labs      | agent_playground | groq     | free/groq/llama-3.3-70b | ok      | 01:51:56
   13 |      675 | Northwind AI Labs | agent_playground | groq     | free/groq/llama-3.3-70b | ok      | 01:51:53
   14 |      718 | Northwind AI Labs | agent_playground | groq     | free/groq/llama-3.3-70b | ok      | 01:51:51
   15 |      720 | Atlas Agents      | agent_playground | groq     | free/groq/llama-3.3-70b | ok      | 01:53:02
   16 |      837 | Kestrel Labs      | agent_playground | groq     | free/groq/llama-3.3-70b | ok      | 01:51:55
   17 |      896 | Atlas Agents      | agent_playground | groq     | free/groq/llama-3.3-70b | ok      | 01:53:03
   18 |     1377 | Atlas Agents      | agent_playground | groq     | free/groq/llama-3.3-70b | ok      | 01:53:01
   19 |     6297 | Northwind AI Labs | agent_playground | groq     | free/groq/llama-3.3-70b | ok      | 01:51:46
(19 rows)
```

Each stored time is a few milliseconds under what curl measured for the same request (for
example 6,297 ms against 6.304 s, 1,377 ms against 1.380 s): the stored time is taken at the
API and leaves out the connection and the HTTP guard.

The organization's own dashboard numbers come from the same rows. For Atlas Agents (six
requests: 377, 603, 603, 720, 896, 1,377; mean 762.7):

```bash
curl -s "http://localhost:4270/api/analytics/overview" -H "Authorization: Bearer $(cat token-atlas)"
```

```text
{"success": true, "data": {"totalRequests": 0, "totalTokensIn": 0, "totalTokensOut": 0, "totalCostCents": 0, "avgLatencyMs": 763, "p50LatencyMs": 603, "p95LatencyMs": 1377, "latencySampleCount": 6, "errorRate": 0}, "period": {"days": 30}}
```

(`totalRequests` on this overview counts model-deployment usage records, of which Atlas has
none; agent chats are counted on the agent's own usage endpoint, which answered
`"requests": 6, "answered": 6, "avgLatencyMs": 763, "p50LatencyMs": 603, "p95LatencyMs": 1377`.)

---

## 6. The landing page, the status page and the CLI, as rendered

The landing page:

```bash
node render-landing.mjs http://localhost:3270/
```

```text
status attribute : measured
terminal line    : "Latency: 613 ms p50"
note under it    : "Latency: Median time the API took to answer a chat request, measured over 19 answered requests in the last 24 hours. How it is measured"
link             : /status#latency
stats requests   : 1 GET http://localhost:4270/api/public/stats
page has "47ms"  : false
```

The "Request latency" section of `/status`, where that link goes (the section's rendered text):

```text
Request latency

Time the WheelsAI API took to produce the complete answer to a chat request, successful answers only; network time between the caller and the API is not included.

Median (p50)
613 ms
95th percentile (p95)
6,297 ms
Median time to first token
Not enough streamed answers
Requests that failed
0%

Over 19 answered requests in the last 24 hours, computed 43s ago. The percentiles count answered requests only; failed and timed-out requests are the share shown separately. Published only above 12 requests from 3 organizations.

Answered requests by response time

up to 250 ms
0
250 ms to 500 ms
4
500 ms to 1,000 ms
13
1,000 ms to 2,000 ms
1
2,000 ms to 5,000 ms
0
5,000 ms to 10,000 ms
1
10,000 ms to 30,000 ms
0
over 30,000 ms
0
```

The histogram adds up to the 19 rows above.

The CLI's line. `wheelsai deploy` itself was not run, because it starts a paid GPU deployment;
this calls the function the command calls (`loadPlatformLatency` and `formatLatencyValue` in
`packages/cli/src/lib/latency.ts`) against the same API:

```text
  Latency       613 ms p50  (platform-wide, last 24 h)
```

---

## 7. The API stopped: "unavailable", and no number

After the API process was stopped, with the web app still running:

```bash
node render-landing.mjs http://localhost:3270/
```

```text
status attribute : unavailable
terminal line    : "Latency: live figure unavailable"
note under it    : "Latency: The measured response time could not be read right now, so no figure is shown. How it is measured"
link             : /status#latency
stats requests   : 1 GET http://localhost:4270/api/public/stats
page has "47ms"  : false
```

and the CLI's line:

```text
  Latency       live figure unavailable
```

Neither kept the 613 ms it had shown a minute earlier.

---

## Clean-up

```bash
kill -TERM <api pid>; kill -TERM <web pid>
psql "$PG/postgres" -c "DROP DATABASE wheelsai_latency_run"
psql "$PG/postgres" -Atc "select datname from pg_database where datname like 'wheelsai%'"
redis-cli -p 6380 -n 9 flushdb
ss -ltn | grep -cE ':4270 |:3270 '
psql "$PG/wheelsai" -Atc "select count(*) from information_schema.tables where table_name='request_latency_samples'"
```

```text
DROP DATABASE
wheelsai
OK
0
0
```

The copy is gone, ports 4270 and 3270 are free, and the local `wheelsai` database was not
migrated (it has no `request_latency_samples` table).

---

## What this run does not show

- **It is not a production number.** 19 chats, one machine, one free model, short answers, no
  tools. Real traffic mixes models, GPUs, tool calls and long answers, and its p50 will differ.
- **The thresholds were lowered** to 12 requests for the run. With the defaults (50 requests,
  3 organizations) every reading above would have said "measuring".
- **Only the playground surface was exercised.** `/v1` model deployments record through the
  same table and are covered by unit tests (`inferenceLatency.unit.test.ts`), not by this run,
  because a real model deployment needs a Nosana GPU.
- **No failed request was sent**, so "Requests that failed: 0%" is a true 0 of 19, not a test of
  the error share.
- **Time to first token** is not measured for agent chat streams yet; the field stayed null.
- **Channel replies** (Discord, Telegram, Slack) are not recorded yet.
- **`wheelsai deploy`** was not run end to end; its `Latency` line is covered by the CLI's own
  tests against a local HTTP server (`packages/cli/test/commands.test.ts`).
- The Playwright cases added to `apps/web/e2e/landing.spec.ts` were not run: the installed
  browser build does not match the one the project's Playwright version asks for. The page was
  rendered with the installed Chromium through the script described above.

---

## Addendum: the per-organization cap and unwritable rows (after review, 2026-10-07)

The run above predates two changes. Its outputs are left as they were recorded.

**The public figure now counts each organization's most recent requests only**, up to
`ceil(minSamples / minOrgs)` (17 at the defaults; 4 at this run's lowered threshold of 12).
Under that rule the run's 19 chats from 3 organizations would count as at most 12, and its
response would carry `"maxSamplesPerOrg": 4`. Before the change, one organization could send
any number of requests next to two organizations with one each and have its own timings
published as the platform's.

Checked against a copy of the database (`wheelsai_latfix`, migration
`20261010200000_request_latency` applied, dropped afterwards) with rows written through the
service's own `buildLatencySample` and read through `buildLatencySampleDeps`, at the default
thresholds (50 requests, 3 organizations). These are inserted test rows, not traffic:

```
flood A + 1 + 1: {"status":"insufficient_data","n":19,"orgs":3,"p50":5,"p95":1100,"hist":[17,0,1,1,0,0,0,0],"histSum":19,"outcomes":{"ok":19,"error":0,"timeout":0,"cancelled":0}}
flood A + 3 real orgs: {"status":"measured","n":68,"orgs":4,"p50":916,"p95":1313,"hist":[17,0,17,34,0,0,0,0],"histSum":68,"outcomes":{"ok":51,"error":17,"timeout":0,"cancelled":0}}
hand-run: [{"n":68,"p50":916,"p95":1313}]
uncapped (what was published before): [{"n":5092,"p50":5}]
```

First line: organization A has 5,000 answers of 5 ms, B and C one each. A counts for 17, the
total is 19, and nothing is published (the old query counted 5,002 and published 5 ms).
Second line: B, C and D then have 30 answers each around 0.9 to 1.3 s while A adds 3,000
errors. The figure is measured over 68 answers (17 per organization) with a p50 of 916 ms, the
same as a hand-written `percentile_disc` over the same ranked rows; without the cap the p50
would have been A's 5 ms. A's errors count as 17 in the error share, not 3,000.

**One row the database refuses no longer costs the rows written with it.** A `model` string
containing U+0000 (which a playground caller could send) made Postgres reject the whole
insert, and samples of every organization are written many to a statement:

```
unsanitised batch: ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "22021", message: "invalid byte sequence for encoding \"UTF8\": 0x00", severity: "ERROR", detail: None,  | rows added: 0
warn: Failed to write latency samples; unwritable rows dropped 1
sink: {"buffered":0,"written":81,"droppedOverflow":0,"droppedFailed":1} | rows added: 81
sanitised model stored: {"model":"openai/gpt-4"}
```

First line: three rows inserted directly, one with the NUL, and none is stored (the old
behaviour). Then 82 rows through the sink, one of them forced to carry the NUL past the
builder: 81 are written and that one is dropped. The last line is the same model string taken
through `buildLatencySample`, which now removes the character before the row exists. The
playground route also refuses such a model id before any chat runs.
