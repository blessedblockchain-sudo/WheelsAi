# Workflows and scheduled tasks — proof run

**Date:** 2026-10-06 · **Branch:** `feat/bags-launchpad` (working tree on top of `700e173`)
**Migration under test:** `20261007200000_workflow_engine_run_lifecycle`

The claims: *"chain both into scheduled workflows with a visual graph builder"* (README),
*"AI workflows (agents, models, and retrieval chained into scheduled pipelines)"* (grant
application), *"multi-step pipelines with branches, loops and parallel steps, then run them on
a schedule or on demand"* (landing page), and the six scheduler task types the dashboard once
advertised.

This run starts the API locally with the workflow worker and the scheduler worker on, signs in
as the seeded demo owner, and drives the real thing: a workflow with a branch, a for-each loop
and parallel steps; a run cancelled in flight; the same workflow fired by the scheduler worker;
and every scheduled task type once. Model calls went to Groq. Nothing was simulated, and where
a prerequisite does not exist on this machine the honest refusal is what is recorded.

Everything below is the command that was run and its output. Two kinds of trimming, and no
other edits: long model text is cut with `…`, and `jq` filters (shown in the command) select
the fields worth reading. The demo password is read from `$DEMO_PASSWORD`; the session token is
`$TOKEN`.

---

## The environment

| | |
|---|---|
| API | `apps/api`, `npx tsx src/index.ts`, port **4220** |
| Database | a **disposable copy** of the local dev database (see below) |
| Redis | `localhost:6380`, database index **5**, empty at the start, so the queues and the free-model counters of this run were its own |
| Organization | the seeded demo organization "Northwind AI Labs", owner `demo@northwind.ai` |
| Model | the agents' `free/groq/llama-3.3-70b`, the platform's free Groq model; `GROQ_API_KEY` from `apps/api/.env` |
| Embeddings | not configured, so knowledge search runs in keyword mode and says so |
| Outside receivers | `https://example.com/` (a page to fetch and probe) and `https://httpbin.org` (a public echo service, for the webhook task and the event deliveries). The SSRF guard refuses `localhost`, so a local receiver cannot stand in |

### Why a copy of the database

The migration this feature needs had not been applied to the local dev database
(`wheelsai`) when this run was made, and applying migrations to it is the reviewer's step, not
this run's. The run therefore used a copy, created from the dev database as a template, with
the three pending migrations applied to the copy only:

```bash
psql postgresql://wheelsai:…@localhost:5434/postgres -c "CREATE DATABASE wheelsai_wfproof TEMPLATE wheelsai"
for m in 20261007100000_agent_api_endpoint 20261007110000_agent_entrypoint_usage \
         20261007200000_workflow_engine_run_lifecycle; do
  psql postgresql://wheelsai:…@localhost:5434/wheelsai_wfproof -v ON_ERROR_STOP=1 -1 \
    -f packages/db/prisma/migrations/$m/migration.sql
done
```

```
== 20261007200000_workflow_engine_run_lifecycle
ALTER TABLE
ALTER TABLE
CREATE INDEX
CREATE INDEX
```

(the last lines of the third file; all three applied without error, each in one transaction).
The copy was dropped after the run and Redis index 5 flushed. The dev database was not written
to: it still has no `orchestration_steps.step_type` column and none of the rows created below.

### 1. Start the API on port 4220, workflow and scheduler workers on

```bash
cd apps/api
DATABASE_URL="postgresql://wheelsai:…@localhost:5434/wheelsai_wfproof?schema=public" \
REDIS_URL="redis://localhost:6380/5" \
API_PORT=4220 PUBLIC_API_URL=http://localhost:4220 RATE_LIMIT_MAX_PER_MINUTE=1000 LOG_LEVEL=info \
SCHEDULER_INTERVAL_MS=10000 WORKFLOW_RUN_CONCURRENCY=4 WORKFLOW_REAP_INTERVAL_MS=60000 \
EMBEDDING_BACKFILL_INTERVAL_MS=0 TOKEN_INDEXER_INTERVAL_MS=0 TREASURY_SETTLEMENT_INTERVAL_MS=0 \
TREASURY_SETTLEMENT_BATCH_INTERVAL_MS=0 PAYMENT_SUBMIT_INTERVAL_MS=0 PAYMENT_POLL_INTERVAL_MS=0 \
PAYMENT_REAP_INTERVAL_MS=0 FEE_ROUTER_INTERVAL_MS=0 BAGS_FEE_SWEEP_INTERVAL_MS=0 \
REPUTATION_ATTESTATION_INTERVAL_MS=0 DEPLOYMENT_STATUS_INTERVAL_MS=0 \
UPTIME_PROBER_INTERVAL_MS=0 ALERT_EVALUATOR_INTERVAL_MS=0 ANALYTICS_SNAPSHOT_INTERVAL_MS=0 \
SUBSCRIPTION_RENEWAL_INTERVAL_MS=0 PAYOUT_EXECUTOR_INTERVAL_MS=0 GPU_BILLING_INTERVAL_MS=0 \
npx tsx src/index.ts
```

From the log:

```
[07:01:15] INFO: Scheduler BullMQ queue started
[07:01:15] INFO: Workflow run worker started
[07:01:15] INFO: Workflow run reaper started
[07:01:27] INFO: Scheduler tick complete
    executed: 3
    failed: 1
```

(the log also reports `due: 4`). `curl -s -i http://localhost:4220/health` answered
`HTTP/1.1 200 OK`. The first tick already did real work: the copied database held four seeded
schedules, across organizations, whose next run was days overdue, and the worker fired them.
Three succeeded and one failed. The two that belong to the demo organization are shown in
step 2; the other two belong to other seeded organizations and were not looked at further.

### 2. Sign in

```bash
curl -s -X POST http://localhost:4220/api/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"demo@northwind.ai\",\"password\":\"$DEMO_PASSWORD\"}" | jq 'del(.token)'
```

```json
{
  "user": { "id": "6d691c9e-d5dd-4e11-8a5e-4442b8e3e0e6", "email": "demo@northwind.ai", "createdAt": "2026-10-01T11:58:56.900Z" },
  "organization": { "id": "ad698f19-bf63-4d1e-9402-fd6c51636a66", "name": "Northwind AI Labs" }
}
```

In the commands below `A=http://localhost:4220`, `H="Authorization: Bearer $TOKEN"` and
`J='Content-Type: application/json'`. `AGENT` is the demo agent "Research Analyst"
(`25bc2504-…`), `KB` the knowledge base "Northwind Help Center" (`d9cdf9e5-…`), `DEP` the
deployment "Support LLM" (`bfa7e4b3-…`).

The two seeded schedules of this organization, after that first tick:

```bash
curl -s $A/api/scheduler -H "$H" | jq -c '.tasks[] | {name, cronExpression, lastRunStatus, nextRunAt}'
```

```
{"name":"Friday release notes","cronExpression":"0 16 * * 5","lastRunStatus":"success","nextRunAt":"2026-10-09T16:00:00.000Z"}
{"name":"Morning research digest","cronExpression":"0 8 * * 1-5","lastRunStatus":"success","nextRunAt":"2026-10-06T08:00:00.000Z"}
```

2026-10-06 is a Tuesday and 2026-10-09 a Friday: the weekday field of a cron expression is now
honoured. Before this work `0 16 * * 5` fired every day.

---

## A. A workflow with a branch, a loop and parallel steps

Five steps in `parallel` mode. `classify` answers in JSON. `billing` and `technical` each run
only if the category matches (the branch). `followups` runs once per question `classify`
returned (the loop). All three wait only for `classify`, so they run together (the parallel
steps). `reply` waits for all three and joins them.

`triage.json`:

```json
{
  "name": "Support triage (proof)",
  "description": "A branch, a for-each loop and parallel steps.",
  "executionMode": "parallel",
  "maxConcurrency": 3,
  "timeout": 300000,
  "inputSchema": { "type": "object", "required": ["prompt"], "properties": { "prompt": { "type": "string", "minLength": 5 } } },
  "steps": [
    { "name": "classify", "agentId": "25bc2504-946c-46ab-b1e7-ca82f182cf7e", "outputFormat": "json",
      "promptTemplate": "Classify this support message. Reply with ONLY a JSON object, no prose: {\"category\": \"billing\" or \"technical\", \"questions\": [two short follow-up questions to ask the customer]}.\n\nMessage: {{input.prompt}}" },
    { "name": "billing", "agentId": "25bc2504-946c-46ab-b1e7-ca82f182cf7e", "dependsOn": ["classify"],
      "condition": { "left": "$.steps.classify.output.category", "op": "equals", "right": "billing" },
      "promptTemplate": "In one sentence, answer this billing question: {{input.prompt}}" },
    { "name": "technical", "agentId": "25bc2504-946c-46ab-b1e7-ca82f182cf7e", "dependsOn": ["classify"],
      "condition": { "left": "$.steps.classify.output.category", "op": "equals", "right": "technical" },
      "promptTemplate": "In one sentence, give the most likely technical cause: {{input.prompt}}" },
    { "name": "followups", "agentId": "25bc2504-946c-46ab-b1e7-ca82f182cf7e", "dependsOn": ["classify"],
      "loop": { "forEach": "$.steps.classify.output.questions", "maxItems": 5 },
      "promptTemplate": "Rewrite this question to be friendlier, in at most 12 words (question {{index}}): {{item}}" },
    { "name": "reply", "agentId": "25bc2504-946c-46ab-b1e7-ca82f182cf7e", "dependsOn": ["billing", "technical", "followups"],
      "promptTemplate": "Write a two-sentence reply to the customer.\nBilling answer: {{steps.billing.output}}\nTechnical answer: {{steps.technical.output}}\nFollow-up questions: {{steps.followups.output}}" }
  ]
}
```

### A1. Check it, then create it

```bash
curl -s -w '\nHTTP %{http_code}\n' -X POST $A/api/orchestrations/plan -H "$H" -H "$J" -d @triage.json
```

```
{"levels":[["classify"],["billing","technical","followups"],["reply"]],"order":["classify","billing","technical","followups","reply"],"concurrency":3,"warnings":[]}
HTTP 200
```

```bash
curl -s -w '\nHTTP %{http_code}\n' -X POST $A/api/orchestrations -H "$H" -H "$J" -d @triage.json
```

`HTTP 201`, workflow `be0368a2-54ed-4ebd-9965-18f16ddcaa84`, `updatedAt 2026-10-06T07:02:12.746Z`.

### A2. What a run refuses

Input that does not match the workflow's input schema, and a caller trying to name its own
trigger:

```bash
curl -s -w '\nHTTP %{http_code}\n' -X POST $A/api/orchestrations/$WF/execute -H "$H" -H "$J" -d '{"input":{"topic":"x"}}'
curl -s -w '\nHTTP %{http_code}\n' -X POST $A/api/orchestrations/$WF/execute -H "$H" -H "$J" -d '{"prompt":"hello there","triggeredBy":"schedule"}'
```

```
{"error":"input_schema_mismatch","message":"The input does not match this workflow's input schema","details":["prompt is required"]}
HTTP 400
{"error":"validation_failed","details":{"formErrors":["Unrecognized key(s) in object: 'triggeredBy'"],"fieldErrors":{}}}
HTTP 400
```

### A3. Run it

```bash
curl -s -w '\nHTTP %{http_code} in %{time_total}s\n' -X POST $A/api/orchestrations/$WF/execute -H "$H" -H "$J" \
  -d '{"prompt":"My API key returns 401 on every request since I rotated it yesterday."}'
```

```
{"execution":{"id":"416e5a50-7ff6-4725-bbf7-b34f7700500c","status":"queued","triggeredBy":"manual","triggeredById":"6d691c9e-d5dd-4e11-8a5e-4442b8e3e0e6","createdAt":"2026-10-06T07:02:21.066Z"}}
HTTP 202 in 0.043116s
```

The request returned in 43 ms with a queued run. Polling
`GET /api/orchestrations/$WF/executions/$RUN` every two seconds
(`jq -r '"\(.status) \(.progress)% steps=\(.stepResults|length)"'`):

```
07:02:21 running 0% steps=0
07:02:23 running 20% steps=2
07:02:25 running 80% steps=5
07:02:27 completed 100% steps=6
```

The finished run and its step records
(`jq -c '.stepResults[] | {stepName, status, iteration, attempt, startedAt: .startedAt[11:23], completedAt: .completedAt[11:23], durationMs, error}'`):

```
{"id":"416e5a50-7ff6-4725-bbf7-b34f7700500c","status":"completed","progress":100,"triggeredBy":"manual","startedAt":"2026-10-06T07:02:21.101Z","completedAt":"2026-10-06T07:02:25.462Z","durationMs":4361,"error":null}

{"stepName":"classify","status":"success","iteration":null,"attempt":1,"startedAt":"07:02:21.114","completedAt":"07:02:22.226","durationMs":1112,"error":null}
{"stepName":"billing","status":"skipped","iteration":null,"attempt":0,"startedAt":"07:02:22.238","completedAt":"07:02:22.239","durationMs":0,"error":"condition not met"}
{"stepName":"technical","status":"success","iteration":null,"attempt":1,"startedAt":"07:02:22.239","completedAt":"07:02:24.028","durationMs":1789,"error":null}
{"stepName":"followups","status":"success","iteration":1,"attempt":1,"startedAt":"07:02:22.242","completedAt":"07:02:23.854","durationMs":1612,"error":null}
{"stepName":"followups","status":"success","iteration":0,"attempt":1,"startedAt":"07:02:22.242","completedAt":"07:02:24.316","durationMs":2074,"error":null}
{"stepName":"reply","status":"success","iteration":null,"attempt":1,"startedAt":"07:02:24.323","completedAt":"07:02:25.450","durationMs":1127,"error":null}
```

Reading it against the claim:

- **Branch.** `classify` returned parsed JSON (below) with `"category": "technical"`, so
  `technical` ran and `billing` was recorded `skipped`, "condition not met", with no model
  call (attempt 0, 0 ms).
- **Loop.** `followups` wrote one record per item of `classify.output.questions`, iterations 0
  and 1, each with its own prompt.
- **Parallel.** `technical` and both `followups` items started within 3 ms of each other
  (07:02:22.239, .242, .242) and overlapped for 1.6 s; the run took 4.4 s where the same five
  calls end to end take 7.7 s.
- **Join.** `reply` waits for `billing`, `technical` and `followups`. One branch was not taken,
  so it ran on the other two and recorded what read as empty:
  `"missingRefs":["steps.billing.output"]`.

What the steps were sent and returned
(`jq '.stepResults[] | {stepName, iteration, prompt: .input.prompt, item: .input.item, output: (.output.value // .output.content)}'`):

```json
{
  "stepName": "classify",
  "iteration": null,
  "prompt": "Classify this support message. Reply with ONLY a JSON object, no prose: {\"category\": \"billing\" or \"technical\", \"questions\": [two short follow-up questions to ask the customer]}.\n\nMessage: My API key returns 401 on every request since I rotated it yesterday.",
  "item": null,
  "output": {
    "category": "technical",
    "questions": [
      "Are you using the new API key in your requests?",
      "Can you share the exact request headers you are sending?"
    ]
  }
}
{ "stepName": "billing", "iteration": null, "prompt": null, "item": null, "output": null }
{
  "stepName": "technical",
  "iteration": null,
  "prompt": "In one sentence, give the most likely technical cause: My API key returns 401 on every request since I rotated it yesterday.",
  "item": null,
  "output": "**Executive Summary**  \nThe 401 errors are most likely due to the new API key not being correctly applied or recognized—either because the key wasn’t updated in the request headers, the key is still pending activation, or the service’s key‑rotation cache has not yet refreshed.\n\n**Key Findings** …"
}
{
  "stepName": "followups",
  "iteration": 1,
  "prompt": "Rewrite this question to be friendlier, in at most 12 words (question 1): Can you share the exact request headers you are sending?",
  "item": "Can you share the exact request headers you are sending?",
  "output": "**Executive Summary**  \nA concise, polite rephrasing of the original request can be delivered in under 12 words while maintaining clarity and friendliness. …"
}
{
  "stepName": "followups",
  "iteration": 0,
  "prompt": "Rewrite this question to be friendlier, in at most 12 words (question 0): Are you using the new API key in your requests?",
  "item": "Are you using the new API key in your requests?",
  "output": "**Executive Summary**  \nA concise, friendly rewrite of the original query can improve tone while staying under the 12‑word limit. …"
}
{
  "stepName": "reply",
  "iteration": null,
  "prompt": "Write a two-sentence reply to the customer.\nBilling answer: \nTechnical answer: **Executive Summary**  \nThe 401 errors are most likely due to … \nFollow-up questions: [\"**Executive Summary**  \\nA concise, friendly rewrite … \",\"**Executive Summary**  \\nA concise, polite rephrasing … \"]",
  "item": null,
  "output": "We’ve verified that the new API key is active, but please double‑check that it’s correctly placed in the Authorization header (including the “Bearer ” prefix) and that any IP‑allowlist settings match your request source. If the 401 errors persist after confirming these details, let us know and we’ll investigate further."
}
```

The "Executive Summary" headings are the Research Analyst agent's own system prompt at work:
each step is a real call to that agent, not a bare model call.

### A4. Edit it: replace, the lock token, and the strict PATCH

The run's own `output` was `{}`: no step published into it. The edit adds an output mapping to
`reply`, sending back the `updatedAt` the workflow was loaded with.

```bash
jq --arg t "2026-10-06T07:02:12.746Z" '.expectedUpdatedAt=$t | (.steps[] | select(.name=="reply")).outputMapping = {"answer":"$.steps.reply.output","category":"$.steps.classify.output.category"}' triage.json > triage2.json
curl -s -w '\nHTTP %{http_code}\n' -X PUT $A/api/orchestrations/$WF -H "$H" -H "$J" -d @triage2.json | jq -c '{updatedAt, reply: (.steps[]|select(.name=="reply")|.outputMapping)}'
```

```
HTTP 200
{"updatedAt":"2026-10-06T07:03:08.485Z","reply":{"answer":"$.steps.reply.output","category":"$.steps.classify.output.category"}}
```

The token from creation was still good after a completed run, because run statistics do not
move `updatedAt`. Sending the same body again, with the token now out of date:

```
{"error":"stale_definition","message":"This workflow was changed after you loaded it; reload and apply your changes again","currentUpdatedAt":"2026-10-06T07:03:08.485Z"}
HTTP 409
```

And the mass-assignment hole the old PATCH had:

```bash
curl -s -w '\nHTTP %{http_code}\n' -X PATCH $A/api/orchestrations/$WF -H "$H" -H "$J" -d '{"orgId":"00000000-0000-0000-0000-000000000000","totalRuns":999}'
```

```
{"error":"validation_failed","details":{"formErrors":["Unrecognized key(s) in object: 'orgId', 'totalRuns'","nothing to update"],"fieldErrors":{}}}
HTTP 400
```

---

## B. A run cancelled in flight

```bash
curl -s -X POST $A/api/orchestrations/$WF/execute -H "$H" -H "$J" -d '{"prompt":"I was charged twice for my Pro plan this month, please refund one."}'
sleep 1.5
curl -s -w '\nHTTP %{http_code}\n' -X POST $A/api/orchestrations/$WF/executions/$RUN/cancel -H "$H"
```

```
{"execution":{"id":"a210525f-578f-47e7-a479-f78c65640b4a","status":"queued","triggeredBy":"manual","triggeredById":"6d691c9e-d5dd-4e11-8a5e-4442b8e3e0e6","createdAt":"2026-10-06T07:03:18.846Z"}}
--- cancel at 07:03:20.357
{"execution":{"id":"a210525f-578f-47e7-a479-f78c65640b4a","orchestrationId":"be0368a2-54ed-4ebd-9965-18f16ddcaa84","status":"running","progress":20,"startedAt":"2026-10-06T07:03:18.851Z","completedAt":null,"durationMs":null,"triggeredBy":"manual","triggeredById":"6d691c9e-d5dd-4e11-8a5e-4442b8e3e0e6","cancelRequestedAt":"2026-10-06T07:03:20.366Z","scheduledTaskId":null,"taskExecutionId":null,"error":null,"failedStepId":null,"createdAt":"2026-10-06T07:03:18.846Z"}}
HTTP 202
```

`202`: the run was running, so the cancel was requested, not done. Polling once a second:

```
07:03:20.400 running steps=2
07:03:21.418 cancelled steps=5
```

```
{"status":"cancelled","error":"cancelled","cancelRequestedAt":"2026-10-06T07:03:20.366Z","startedAt":"2026-10-06T07:03:18.851Z","completedAt":"2026-10-06T07:03:20.867Z","durationMs":2016}

{"stepName":"classify","status":"success","iteration":null,"error":null,"durationMs":1350}
{"stepName":"technical","status":"skipped","iteration":null,"error":"condition not met","durationMs":0}
{"stepName":"billing","status":"failed","iteration":null,"error":"cancelled while running","durationMs":631}
{"stepName":"followups","status":"failed","iteration":0,"error":"cancelled while running","durationMs":630}
{"stepName":"followups","status":"failed","iteration":1,"error":"cancelled while running","durationMs":629}
```

The run ended `cancelled` 501 ms after the request. This message was a billing one, so the
other branch was taken; the three calls in flight were aborted about 630 ms in, and `reply`
never ran. Cancelling again, then looking once more six seconds later, and at the workflow's
counters:

```
{"error":"execution_finished","message":"This run already cancelled","status":"cancelled"}
HTTP 409
--- 6s later: any late step rows?
{"status":"cancelled","steps":5}
{"totalRuns":1,"successfulRuns":1,"failedRuns":0,"avgDurationMs":4361}
```

No step row arrived after the cancel, the status was not overwritten, and a cancelled run
counts as neither a success nor a failure.

---

## C. The same workflow, fired by the scheduler worker

A `workflow_run` task, scheduled once, 25 seconds ahead:

```bash
curl -s -w '\nHTTP %{http_code}\n' -X POST $A/api/scheduler -H "$H" -H "$J" \
  -d "{\"name\":\"Triage on schedule (proof)\",\"taskType\":\"workflow_run\",\"orchestrationId\":\"$WF\",\"scheduleType\":\"once\",\"scheduledAt\":\"2026-10-06T07:04:04Z\",\"timezone\":\"UTC\",\"payload\":{\"prompt\":\"The dashboard shows a blank page after login on Firefox.\"}}"
```

```
HTTP 201
{"id":"1e03e79b-887c-4440-b5c1-5d9e11ea7d21","name":"Triage on schedule (proof)","taskType":"workflow_run","orchestrationId":"be0368a2-54ed-4ebd-9965-18f16ddcaa84","agentId":null,"scheduleType":"once","scheduledAt":"2026-10-06T07:04:04.000Z","timezone":"UTC","nextRunAt":"2026-10-06T07:04:04.000Z","maxRetries":0,"status":"active","payload":{"prompt":"The dashboard shows a blank page after login on Firefox."}}
```

No agent, a workflow instead, and no retries. Nothing else was called; the loop below only
reads the task's executions every three seconds
(`jq -c '.executions[0] | {status, triggeredBy, attempt, orchestrationExecutionId}'`):

```
07:03:39 {"status":null,"triggeredBy":null,"attempt":null,"orchestrationExecutionId":null}
   … eight more lines, all null, every three seconds …
07:04:06 {"status":null,"triggeredBy":null,"attempt":null,"orchestrationExecutionId":null}
07:04:09 {"status":null,"triggeredBy":null,"attempt":null,"orchestrationExecutionId":null}
07:04:12 {"status":"running","triggeredBy":"schedule","attempt":1,"orchestrationExecutionId":"1eb56c46-1e16-4717-bac6-ea682ec2b01e"}
07:04:15 {"status":"success","triggeredBy":"schedule","attempt":1,"orchestrationExecutionId":"1eb56c46-1e16-4717-bac6-ea682ec2b01e"}
```

The scheduler worker's first tick after 07:04:04 claimed the task at 07:04:10, started a
workflow run and left the task's execution `running`; the workflow worker finished both. The
task's execution:

```json
{
  "id": "542cc0c5-4972-499b-af2d-375750da108a",
  "status": "success",
  "triggeredBy": "schedule",
  "attempt": 1,
  "startedAt": "2026-10-06T07:04:10.031Z",
  "completedAt": "2026-10-06T07:04:14.312Z",
  "durationMs": 4237,
  "orchestrationExecutionId": "1eb56c46-1e16-4717-bac6-ea682ec2b01e",
  "error": null,
  "output": "{\"output\":{\"answer\":\"Sorry you’re seeing a blank page after login—this is typically caused by a JavaScript error when Firefox blocks mixed‑content or third‑party cookies. Could you let us know which version of Firefox you’re using so we can investigate further?\",\"category\":\"technical\"},\"status\":\"completed\",\"orchestrationExecutionId\":\"1eb56c46-1e16-4717-bac6-ea682ec2b01e\"}"
}
```

and the run it started, linked back to the task and its execution:

```
{"id":"1eb56c46-1e16-4717-bac6-ea682ec2b01e","status":"completed","triggeredBy":"schedule","triggeredById":null,"scheduledTaskId":"1e03e79b-887c-4440-b5c1-5d9e11ea7d21","taskExecutionId":"542cc0c5-4972-499b-af2d-375750da108a","startedAt":"2026-10-06T07:04:10.068Z","completedAt":"2026-10-06T07:04:14.305Z","durationMs":4237}

{"stepName":"classify","status":"success","iteration":null,"durationMs":1517,"error":null}
{"stepName":"billing","status":"skipped","iteration":null,"durationMs":0,"error":"condition not met"}
{"stepName":"technical","status":"success","iteration":null,"durationMs":826,"error":null}
{"stepName":"followups","status":"success","iteration":0,"durationMs":1788,"error":null}
{"stepName":"followups","status":"success","iteration":1,"durationMs":1669,"error":null}
{"stepName":"reply","status":"success","iteration":null,"durationMs":879,"error":null}
```

The run's `output` now carries `answer` and `category`, from the output mapping added in A4,
and the task's execution stored it. The one-off task afterwards:

```
{"status":"completed","isEnabled":true,"lastRunStatus":"success","nextRunAt":null,"totalRuns":1,"successfulRuns":1}
```

---

## D. The per-organization cap on concurrent runs

Six starts in a row with the default `WORKFLOW_MAX_ACTIVE_RUNS_PER_ORG=5`:

```
1: {"execution":{"id":"3692b74a-1b98-4a8b-95f4-384c7d3080ff","status":"queued","triggeredBy":"manual","createdAt":"2026-10-06T07:07:54.296Z"}} HTTP 202
2: {"execution":{"id":"017c6091-f7c0-4d6a-87b2-667ca155357c","status":"queued","triggeredBy":"manual","createdAt":"2026-10-06T07:07:54.320Z"}} HTTP 202
3: {"execution":{"id":"cb399b6e-1b84-46af-ace1-1121c9010e99","status":"queued","triggeredBy":"manual","createdAt":"2026-10-06T07:07:54.344Z"}} HTTP 202
4: {"execution":{"id":"d1fb1084-09a3-449f-9252-486a9e3ec1e2","status":"queued","triggeredBy":"manual","createdAt":"2026-10-06T07:07:54.371Z"}} HTTP 202
5: {"execution":{"id":"c5064f6b-49ee-4828-9c31-f7dff2b722ad","status":"queued","triggeredBy":"manual","createdAt":"2026-10-06T07:07:54.396Z"}} HTTP 202
6: {"error":"workflow_run_limit","message":"This organization already has 5 workflow runs queued or running; wait for one to finish","limit":5} HTTP 429
```

(`triggeredById` is cut from each line to fit.) Cancelling all five shows both cancel paths:
the worker runs four at once, so four were running (`202`) and the fifth was still queued and
was cancelled outright (`200`):

```
3692b74a-1b98-4a8b-95f4-384c7d3080ff cancel HTTP 202
017c6091-f7c0-4d6a-87b2-667ca155357c cancel HTTP 202
cb399b6e-1b84-46af-ace1-1121c9010e99 cancel HTTP 202
d1fb1084-09a3-449f-9252-486a9e3ec1e2 cancel HTTP 202
c5064f6b-49ee-4828-9c31-f7dff2b722ad cancel HTTP 200

{"id":"c5064f6b","status":"cancelled","error":"cancelled before it started"}
{"id":"d1fb1084","status":"cancelled","error":"cancelled"}
{"id":"cb399b6e","status":"cancelled","error":"cancelled"}
{"id":"017c6091","status":"cancelled","error":"cancelled"}
{"id":"3692b74a","status":"cancelled","error":"cancelled"}
```

---

## E. Agents, models and retrieval in one workflow

A `pipeline` workflow with one step of each type. `rag.json`:

```json
{
  "name": "Help-center answer (proof)",
  "executionMode": "pipeline",
  "steps": [
    { "name": "search", "stepType": "retrieval", "knowledgeBaseId": "d9cdf9e5-7b75-41a9-bf69-6df289b6901f", "promptTemplate": "{{input.prompt}}" },
    { "name": "answer", "agentId": "25bc2504-946c-46ab-b1e7-ca82f182cf7e",
      "promptTemplate": "Answer in two sentences using only these passages.\n\nQuestion: {{input.prompt}}\n\nPassages:\n{{steps.search.output.text}}" },
    { "name": "polish", "stepType": "model", "deploymentId": "bfa7e4b3-8e9e-4814-bc59-2bde35a0ca0e", "onError": "continue",
      "promptTemplate": "Make this friendlier: {{steps.answer.output}}" }
  ]
}
```

```bash
curl -s -w '\nHTTP %{http_code}\n' -X POST $A/api/orchestrations/plan -H "$H" -H "$J" -d @rag.json
```

```
{"levels":[["search","answer","polish"]],"order":["search","answer","polish"],"concurrency":1,"warnings":["model steps cannot run on this server yet: the deployment chat service that bills model calls is not connected to the workflow engine on this server"]}
HTTP 200
```

**Model steps are not connected, and the product says so before the workflow is saved.** The
engine, the step type and its tests exist; what is missing is one function, shared with `/v1`,
that calls a deployment under its billing rules. Until it is wired, a model step fails by name.
Run after the data sync in F3 had put a page into the knowledge base, with the prompt
`example domain`:

```
{"id":"159db76b-4b03-47e0-88d1-749de94f82ef","status":"completed","error":null,"durationMs":1487}
{"stepName":"search","stepType":"retrieval","status":"success","durationMs":5,"error":null}
{"stepName":"answer","stepType":"agent","status":"success","durationMs":1447,"error":null}
{"stepName":"polish","stepType":"model","status":"failed","durationMs":1,"error":"model steps cannot run yet: the deployment chat service that bills model calls is not connected to the workflow engine on this server"}
```

The retrieval step's output, and the agent's answer built from it:

```json
{
  "query": "example domain",
  "mode": "keyword",
  "fallbackReason": "embeddings not configured (set EMBEDDING_PROVIDER)",
  "passages": [
    {
      "documentTitle": "Example Domain",
      "score": 1,
      "content": "This domain is for use in documentation examples without needing permission. This is not a service; avoid relying on it for testing and monitoring purposes."
    }
  ]
}
```

```
This domain is for use in documentation examples without needing permission. This is not a service; avoid relying on it for testing and monitoring purposes.
```

The search reports that it ran in keyword mode and why. The run is `completed` because
`polish` was set to continue on error; its record still says `failed` with the reason.

Two earlier runs of this workflow, with the prompts `What are the API rate limits?` and
`rate limits`, returned no passages, and the agent answered that it had none to work from.
`POST /api/knowledge/$KB/search` gives the same empty result for those queries
(`"totalChunksSearched":0`): the four seeded documents of this knowledge base report chunk
counts but match nothing in keyword search. That is a property of the seed data, not of the
retrieval step, and it is recorded here because it is what happened.

---

## F. Every scheduled task type, once

`GET /api/scheduler/task-types` lists nine types (`agent_run`, its alias `inference`,
`workflow_run`, `webhook`, `data_sync`, `health_check`, `report`, `cleanup`, `custom`), all
`available: true` on this server, with `"schedulerEnabled":true,"intervalMs":10000`.

Each task below was created with `POST /api/scheduler` and run with
`POST /api/scheduler/$TASK/trigger`, which uses the same firing as the worker and answers
`201` with the finished execution. Outputs are filtered with
`jq '{id,status,attempt,triggeredBy,durationMs,error,output}'`.

### F1. `agent_run`

Without a prompt the task cannot be saved:

```
{"error":"validation_failed","message":"The task payload is not valid for this task type","details":{"formErrors":[],"fieldErrors":{"payload.prompt":["Required"]}}}
HTTP 400
```

With one (`"payload":{"prompt":"In one sentence: what is a cron expression?"}`, `agentId` the
Research Analyst):

```
HTTP 201
{"id":"53123b82-58df-4cdd-8529-fe2611a497d3","taskType":"agent_run","nextRunAt":"2026-10-06T08:04:52.551Z","maxRetries":3,"payload":{"prompt":"In one sentence: what is a cron expression?"}}
HTTP 201
{
  "id": "7b92af92-46d0-44b0-aa74-70c1079db0f7",
  "status": "success",
  "attempt": 1,
  "triggeredBy": "manual",
  "durationMs": 2025,
  "error": null,
  "output": "{\"usage\":{\"inputTokens\":111,\"outputTokens\":488},\"content\":\"**Executive Summary**  \\nA cron expression is a concise string that defines the schedule for recurring tasks in Unix-like operating systems and many automation platforms. …"
}
```

### F2. `webhook`

To this machine, which the SSRF guard refuses at run time, in 1 ms, with nothing sent:

```
{"id":"253bd7c4-e342-4a5b-aff9-6b3f69ea89da","status":"failed","attempt":1,"triggeredBy":"manual","durationMs":1,"error":"webhook URL refused: blocked outbound request: the host does not resolve to a public internet address","output":null}
```

To a public receiver
(`"payload":{"url":"https://httpbin.org/post","body":{"hello":"from the scheduler"},"headers":{"X-Proof":"wheelsai"}}`,
no agent):

```
{"id":"de459809-015b-4003-8158-2ab54eb95014","taskId":"daf396c0-330e-4752-b71a-9b210ab5a166","status":"success","startedAt":"2026-10-06T07:04:54.709Z","completedAt":"2026-10-06T07:04:58.872Z","durationMs":4160,"input":{"url":"https://httpbin.org/post","body":{"hello":"from the scheduler"},"headers":{"X-Proof":"wheelsai"}},"output":{"status":200},"error":null,"logs":null,"attempt":1,"nextRetryAt":null,"triggeredBy":"manual","orchestrationExecutionId":null,"createdAt":"2026-10-06T07:04:54.710Z"}
```

### F3. `data_sync`

Two sources into the "Northwind Help Center" knowledge base: a real page, and the cloud
metadata address.

```
{
  "id": "29fb9930-6708-4288-bcc6-be6bb82728e8",
  "status": "failed",
  "attempt": 1,
  "triggeredBy": "manual",
  "durationMs": 650,
  "error": "1 of 2 sources failed: http://169.254.169.254/latest/meta-data/ (source refused: blocked outbound request: the host does not resolve to a public internet address)",
  "output": {
    "sources": [
      { "url": "https://example.com/", "bytes": 577, "chunks": 1, "status": "added", "documentId": "a37ad348-f675-4900-a34a-b7fc3e18e9e0" },
      { "url": "http://169.254.169.254/latest/meta-data/", "bytes": null, "error": "source refused: blocked outbound request: the host does not resolve to a public internet address", "chunks": null, "status": "failed", "documentId": null }
    ],
    "embeddingMode": "keyword",
    "knowledgeBaseId": "d9cdf9e5-7b75-41a9-bf69-6df289b6901f"
  }
}
```

The task failed, because one source failed, and kept what it did do on the execution. After
editing the task (`PATCH /api/scheduler/$TASK`, `HTTP 200`) to the good source only, two more
runs:

```
{"id":"b59500f4-e9b3-482e-99df-8e4761662575","status":"success","attempt":1,"triggeredBy":"manual","durationMs":231,"error":null,"output":{"sources":[{"url":"https://example.com/","bytes":577,"chunks":null,"status":"unchanged","documentId":"a37ad348-f675-4900-a34a-b7fc3e18e9e0"}],"embeddingMode":"keyword","knowledgeBaseId":"d9cdf9e5-7b75-41a9-bf69-6df289b6901f"}}
{"id":"bc8433a2-aa36-4188-b560-51d3d4afa379","status":"success","attempt":1,"triggeredBy":"manual","durationMs":203,"error":null,"output":{"sources":[{"url":"https://example.com/","bytes":577,"chunks":null,"status":"unchanged","documentId":"a37ad348-f675-4900-a34a-b7fc3e18e9e0"}],"embeddingMode":"keyword","knowledgeBaseId":"d9cdf9e5-7b75-41a9-bf69-6df289b6901f"}}
```

`unchanged`, the same document id, nothing ingested twice. The knowledge base now lists
`{"title":"Example Domain","sourceUrl":"https://example.com/","status":"ready","chunkCount":1}`,
which is the document the retrieval step in E found.

### F4. `health_check`

A URL that is up, checked for a phrase in the body, and recorded on the uptime monitor
"Support LLM endpoint":

```
{"id":"7839b78f-9915-4c5a-a758-6f24f158c95a","maxRetries":0,"payload":{"url":"https://example.com/","onDown":"none","target":"url","monitorId":"4f453178-9b17-40ea-947d-e6ee60cd3612","expectedBody":"Example Domain","expectedStatus":200,"timeoutSeconds":10}}
{"id":"6e93bbb7-1e7c-41b4-a4f4-02793ec7cf5f","status":"success","attempt":1,"triggeredBy":"manual","durationMs":625,"error":null,"output":{"url":"https://example.com/","status":"up","target":"url","latencyMs":606,"statusCode":200,"recordedToMonitor":true}}
```

A URL that answers 503: the task fails, which is the point of a health check.

```
{"id":"402156c6-17a1-419c-b950-f85a8342d02b","status":"failed","attempt":1,"triggeredBy":"manual","durationMs":1664,"error":"health check down: expected status 200, got 503","output":{"url":"https://httpbin.org/status/503","status":"down","target":"url","latencyMs":1664,"statusCode":503,"recordedToMonitor":false}}
```

The seeded deployment and the agent's runtime have nothing to probe on this machine (no Nosana
node behind the seeded row, no running agent container), and the task says exactly that
instead of reporting them healthy:

```
{"id":"bfc92fb9-300b-464d-bd99-c04ac66aea23","status":"failed","attempt":1,"triggeredBy":"manual","durationMs":3,"error":"health check error: the deployment has no node URL to probe (status: running)","output":{"url":null,"status":"error","target":"deployment","latencyMs":null,"statusCode":null,"recordedToMonitor":false}}
{"id":"9a888f16-b2d2-4bc0-8c80-9a497711bcf2","status":"failed","attempt":1,"triggeredBy":"manual","durationMs":3,"error":"health check error: the agent has no running runtime with a public URL to probe","output":{"url":null,"status":"error","target":"agent","latencyMs":null,"statusCode":null,"recordedToMonitor":false}}
```

**"Restart the deployment when it is down" is not connected**, and a task that asks for it
cannot be saved:

```
{"error":"validation_failed","message":"restarting a deployment from a health check is not available on this server: the restart service that re-reserves credits is not connected to the scheduler","details":{"formErrors":[],"fieldErrors":{"payload.onDown":["restarting a deployment from a health check is not available on this server: the restart service that re-reserves credits is not connected to the scheduler"]}}}
HTTP 400
```

### F5. `report`

A weekly report on a cron schedule in a named time zone, delivered as a signed
`report.generated` event. Before creating it, a webhook was subscribed
(`POST /api/webhooks`, `HTTP 201`, events `workflow.completed`, `workflow.failed`,
`scheduled_task.failed`, `report.generated`, URL `https://httpbin.org/post`).

```
{"id":"2044203d-779e-49db-a295-c3d49c870ed9","cronExpression":"0 9 * * 1","timezone":"Europe/Berlin","nextRunAt":"2026-10-12T07:00:00.000Z"}
```

Monday 09:00 in Berlin is 07:00 UTC in October: the time zone is honoured. The report over the
seeded data of the last 30 days:

```json
{
  "id": "aa4f7412-5e60-4936-92bc-06829c9d531f",
  "status": "success",
  "attempt": 1,
  "triggeredBy": "manual",
  "durationMs": 76,
  "error": null,
  "output": {
    "runs": {
      "graphs": { "total": 0, "failed": 0, "completed": 0 },
      "workflows": { "total": 3, "failed": 0, "completed": 2 },
      "scheduledTasks": { "total": 13, "failed": 5, "success": 8 }
    },
    "scope": { "type": "org", "agentId": null },
    "usage": { "errors": 90, "requests": 22698, "costCents": 4764, "inputTokens": 9533160, "avgLatencyMs": 176, "outputTokens": 5901480 },
    "period": { "days": 30, "since": "2026-09-06T07:05:59.226Z", "until": "2026-10-06T07:05:59.226Z" },
    "no_data": false,
    "revenue": { "requests": 6832, "pendingCents": 0, "settledCents": 20122, "refundedCents": 0 },
    "summary": null,
    "delivery": [ { "via": "webhook_event", "event": "report.generated", "status": "emitted" } ],
    "costByModel": [ { "modelId": "llama-3.1-8b", "requests": 22698, "costCents": 4764 } ],
    "conversations": { "no_data": true }
  }
}
```

The workflow counts are this run's own (three runs so far, one of them the cancelled one), and
the section with nothing measured is `no_data`, not zeros.

**Delivery to an email channel.** A report task pointed at a new email alert channel was
accepted and then failed at run time, keeping the report on the failed execution:

```
{"status":"failed","error":"report was generated but not delivered to \"Proof email\": the email channel has no addresses configured","delivery":[],"no_data":false}
```

The channel had been created with a config key the email sender does not read, so it had no
recipients; the task said so instead of reporting a delivery. Two things this does not show.
The task was accepted at save because in development the email service runs with its `log`
provider, which this codebase counts as configured; with no provider at all (production
without `EMAIL_PROVIDER`), the same task is refused when saved, which the unit tests cover and
this run does not. And no email was sent to anyone in this run.

### F6. `cleanup`

Refused without an operation, and refused below the retention floor:

```
{"error":"validation_failed","message":"The task payload is not valid for this task type","details":{"formErrors":[],"fieldErrors":{"payload":["choose at least one operation: archiveConversationsOlderThanDays, deleteArchivedOlderThanDays, memoryDecay or pruneRunHistoryOlderThanDays"]}}}
HTTP 400
{"error":"validation_failed","message":"The task payload is not valid for this task type","details":{"formErrors":[],"fieldErrors":{"payload.deleteArchivedOlderThanDays":["Number must be greater than or equal to 7"]}}}
HTTP 400
```

A dry run of all four operations
(`"payload":{"archiveConversationsOlderThanDays":1,"deleteArchivedOlderThanDays":7,"memoryDecay":{"factor":0.9,"minImportance":0.1,"deactivateBelow":0.05},"pruneRunHistoryOlderThanDays":7,"dryRun":true}`):

```json
{
  "id": "ea988e88-6df3-401a-acfb-d8d40985de4a",
  "status": "success",
  "attempt": 1,
  "triggeredBy": "manual",
  "durationMs": 14,
  "error": null,
  "output": {
    "scope": { "agentId": null },
    "dryRun": true,
    "operations": {
      "memoryDecay": { "factor": 0.9, "decayed": 0, "deactivated": 0, "minImportance": 0.1 },
      "pruneRunHistory": { "graphRuns": 0, "workflowRuns": 0, "olderThanDays": 7, "taskExecutions": 0 },
      "archiveConversations": { "count": 0, "olderThanDays": 1 },
      "deleteArchivedConversations": { "count": 0, "olderThanDays": 7 }
    }
  }
}
```

Every count is zero: the demo organization has no conversations or memories old enough, and no
run history older than a week. So this shows the task running, scoped and counting, and it
does not show a non-zero count or a non-dry run changing data. Those are covered by the unit
tests (`scheduledTaskExecutors.unit.test.ts`).

### F7. `custom`

No agent of the demo organization had a graph in the visual builder, so the first run is the
honest refusal:

```
{"id":"41941a0e-eb61-4d76-8e7a-4266bb65e693","status":"failed","attempt":1,"triggeredBy":"manual","durationMs":4,"error":"This agent has no graph — build one first","output":null}
```

After giving the agent "Ops Runbook Bot" the builder's "Simple Chat" template, the way the
builder page does (`POST /api/agents/$OPS/graph/template`, `{"templateId":"simple_chat"}`,
`HTTP 200`, nodes `input`, `llm`, `output`), the same task again:

```
{
  "id": "19ec9a0b-3dfd-4bdd-8630-2495c958c153",
  "status": "success",
  "attempt": 1,
  "triggeredBy": "manual",
  "durationMs": 8374,
  "error": null,
  "output": "{\"output\":\"When a checkout endpoint starts spitting out **502 Bad Gateway** responses, the first thing to verify is **whether the upstream service that the gateway/proxy is trying to reach is actually healthy and reachable**. A 502 means “the gateway (or load balancer, reverse‑proxy, API‑gateway, etc.) got an invalid response from the upstream server,” so the problem is almost always on the side of the service that’s being called. …"
}
```

(`output` shown as a string cut at 600 characters.) The rest of that output object
(`jq -c '.output | {graphExecutionId, status, durationMs}'`):

```
{"graphExecutionId":"5fd83b2b-b0c1-4a56-a966-74845a8f77d5","status":"completed","durationMs":8344}
```

### F8. `workflow_run`, by hand

Section C is this type fired by the worker. What the type refuses, and a trigger by hand:

```
{"error":"validation_failed","message":"task type \"workflow_run\" is not retried; maxRetries must be 0","details":{"formErrors":[],"fieldErrors":{"maxRetries":["task type \"workflow_run\" is not retried; maxRetries must be 0"]}}}
HTTP 400
{"error":"invalid_schedule","message":"the shortest interval is 60 seconds","reason":"interval_too_short","field":"intervalSeconds"}
HTTP 400
```

```
{"id":"72017fa7-ff02-4d35-b0b3-0c2402d530ae","cronExpression":"0 9 * * 1-5","timezone":"America/New_York","nextRunAt":"2026-10-06T13:00:00.000Z"}
HTTP 202
{"id":"7086725d-7dad-4cd2-88d5-a3bddfbd4f46","status":"running","triggeredBy":"manual","orchestrationExecutionId":"ea136012-731a-4bf4-b149-cd1f7be4d07a","output":null}
```

09:00 in New York is 13:00 UTC on this date. The trigger answered `202` with a running
execution and the id of the run it started; six seconds later:

```
{"status":"success","durationMs":1343,"orchestrationExecutionId":"ea136012-731a-4bf4-b149-cd1f7be4d07a","runStatus":"completed"}
```

### F9. Where every task ended

```bash
curl -s "$A/api/scheduler?limit=100" -H "$H" | jq -r '.tasks[] | [.taskType, .name, .lastRunStatus // "-", (.lastError // "" | .[0:70])] | @tsv' | sort
```

```
agent_run	Friday release notes	success
agent_run	Morning research digest	success
agent_run	Proof: agent run	success
cleanup	Proof: cleanup	success
custom	Proof: custom	success
data_sync	Proof: data sync	success
health_check	Proof: health agent	failed	health check error: the agent has no running runtime with a public URL
health_check	Proof: health deployment	failed	health check error: the deployment has no node URL to probe (status: r
health_check	Proof: health url	success
health_check	Proof: health url down	failed	health check down: expected status 200, got 503
report	Proof: report	success
report	Proof: report email	failed	report was generated but not delivered to "Proof email": the email cha
webhook	Proof: webhook	success
webhook	Proof: webhook local	failed	webhook URL refused: blocked outbound request: the host does not resol
workflow_run	Proof: workflow run	success
workflow_run	Triage on schedule (proof)	success
```

---

## G. Signed events to a subscribed webhook

The delivery log of the webhook subscribed in F5
(`GET /api/webhooks/$HOOK/deliveries`, counted by event and outcome):

```
      1 {"event":"report.generated","status":"success","statusCode":200}
      2 {"event":"scheduled_task.failed","status":"success","statusCode":200}
      4 {"event":"workflow.completed","status":"success","statusCode":200}
```

One report, the two task failures after the subscription (the undelivered email report and
the agent with no graph), and the four workflow runs that completed after it. The five runs
cancelled in D sent nothing, as designed.

---

## H. The dashboard's code against this server

The dashboard pages were type-checked, linted and gate-checked, not opened in a browser in
this run. What was run is the editor's and the task form's own conversion code, the same
modules the pages import, against this server:

```bash
npx tsx roundtrip.mts   # loads each workflow, converts it to the editor's draft and back,
                        # plans it, saves it unchanged with its lock token, compares
```

```
{"name":"Help-center answer (proof)","localIssues":0,"plan":200,"order":["search","answer","polish"],"warnings":1,"put":200,"stable":true,"positions":3}
{"name":"Support triage (proof)","localIssues":0,"plan":200,"order":["classify","billing","technical","followups","reply"],"warnings":0,"put":200,"stable":true,"positions":5}
{"name":"Weekly release pipeline","localIssues":0,"plan":200,"order":["Collect changes","Draft release notes","Post community summary"],"warnings":2,"put":200,"stable":true,"positions":3}
empty draft: [ 'Give the workflow a name', 'Add at least one step' ]
cycle refused by the canvas rule: true
non-ancestor reference: 400 {"error":"invalid_workflow","message":"step \"technical\" reads the output of \"reply\" but does not depend on it; add it to dependsOn","step":"technical","field":"references"}
```

"Weekly release pipeline" is a workflow seeded before this work; it loads into the editor,
plans with two warnings (its steps have no prompts of their own) and saves back unchanged.
Every scheduled task created above, of every type, loaded into the task form and built back to
an empty change set (`"emptyPatch":true` for all 16).

---

## What this run does not show

- **Model steps running.** They fail by name (section E). One function is missing; it is
  being extracted from the `/v1` route by other work.
- **A health check restarting a deployment.** Not connected, and refused when saved (F4).
- **A health check finding a real deployment or agent runtime up.** Neither exists on this
  machine. A URL target was checked up and down.
- **Email delivery of a report**, and the refusal when no email provider is configured (F5).
- **Cleanup changing data.** The dry run found nothing old enough to count (F6).
- **Semantic retrieval.** No embedding provider is configured here, so search ran in keyword
  mode and said so.
- **The free-model limit refusing a step.** The run stayed under 20 requests a minute; the
  limiter is covered by `sharedExecutorFreeTier.unit.test.ts`.
- **A timeout, a retry, an `until` loop, a fallback agent and the reaper.** Unit-tested, not
  exercised here.
- **The pages in a browser.** See section H for what was checked instead.
- **The dev database.** It was not migrated; this ran on a copy that has been dropped.

## Shutdown

```bash
kill -TERM 1047588        # the tsx process listening on 4220
sleep 6; ss -ltnp | grep ':4220 ' || echo "port 4220 is free"
```

```
port 4220 is free
```

```bash
psql postgresql://wheelsai:…@localhost:5434/postgres -c "DROP DATABASE wheelsai_wfproof"
redis-cli -p 6380 -n 5 flushdb
```

```
DROP DATABASE
OK
```
