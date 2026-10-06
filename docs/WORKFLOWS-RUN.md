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

## I. A workflow through `/v1`, with the official openai client

**Date:** 2026-10-06, a second run, after sections A to H. **Working tree** on top of `8bafb43`.
**Migration under test:** `20261008100000_workflow_api_slug_usage_version_entrypoint`.

The claim: an *"OpenAI-compatible API"* for agents **and workflows** as well as models. Until
this change `POST /v1/chat/completions` with `model: "workflow/<slug>"` answered a named `501`.
This section runs a workflow through it for real: the same seeded demo organization, the same
free Groq model, the official `openai` client as the caller. Same rules as above: the commands
that were run and their output, long model text cut with `…`, `jq` filters shown.

### I0. The environment

| | |
|---|---|
| API | `apps/api`, `npx tsx src/index.ts`, port **4230**, `PUBLIC_API_URL=http://localhost:4230` |
| Database | a **disposable copy** of the local dev database, `wheelsai_wfv1`, with the new migration applied to the copy only |
| Redis | `localhost:6380`, database index **6**, empty at the start |
| Workers | the workflow worker and its reaper on (`WORKFLOW_RUN_CONCURRENCY=4`); the scheduler and every other worker off, so no seeded schedule fired |
| Client | `openai` 7.28.0 for Node, driven by `apps/api/scripts/run-workflow-v1-proof.ts`, with `maxRetries: 0` and an 11-minute timeout |

```bash
psql postgresql://wheelsai:…@localhost:5434/postgres -c "CREATE DATABASE wheelsai_wfv1 TEMPLATE wheelsai"
```

The dev database already had the three earlier migrations of this work. Before applying the
new one, three workflows whose names collide with the seeded "Weekly release pipeline" were
inserted into the copy (disabled, no steps), so the backfill had something to separate:

```sql
INSERT INTO orchestrations (id, org_id, name, execution_mode, is_enabled, created_at, updated_at)
SELECT gen_random_uuid(), o.org_id, v.name, 'sequential', false, now() + v.n * interval '1 second', now()
FROM orchestrations o,
     (VALUES (1, 'weekly-release-pipeline'), (2, 'Weekly  Release  Pipeline!'), (3, '週次リリース')) AS v(n, name)
WHERE o.name = 'Weekly release pipeline';
```

```bash
psql postgresql://wheelsai:…@localhost:5434/wheelsai_wfv1 -v ON_ERROR_STOP=1 -1 \
  -f packages/db/prisma/migrations/20261008100000_workflow_api_slug_usage_version_entrypoint/migration.sql
psql …/wheelsai_wfv1 -c "select org.name as org, o.name, o.slug from orchestrations o
  join organizations org on org.id=o.org_id order by org.name, o.created_at"
```

```
ALTER TABLE
UPDATE 8
ALTER TABLE
CREATE INDEX
ALTER TABLE
ALTER TABLE
        org        |            name            |               slug
-------------------+----------------------------+----------------------------------
 demo-1786267035   | Demo Workflow 1786267573   | demo-workflow-1786267573
 Northwind AI Labs | Weekly release pipeline    | weekly-release-pipeline
 Northwind AI Labs | weekly-release-pipeline    | weekly-release-pipeline-84c0ceac
 Northwind AI Labs | Weekly  Release  Pipeline! | weekly-release-pipeline-404b9440
 Northwind AI Labs | 週次リリース               | workflow-c3b392b2b1a4
 probe-1333932367  | Research then Summarize    | research-then-summarize
 probe-1333932367  | Free Two Step              | free-two-step
 test              | Data Pipeline              | data-pipeline
```

Every workflow has a slug; the oldest of three names that derive the same slug keeps it and the
other two carry part of their own id; a name with no ASCII letters gets one from its id. The
unique index on `(org_id, slug)` was then created without complaint.

The API was started as in step 1 of this document, with these differences:

```bash
DATABASE_URL="postgresql://wheelsai:…@localhost:5434/wheelsai_wfv1?schema=public" \
REDIS_URL="redis://localhost:6380/6" API_PORT=4230 PUBLIC_API_URL=http://localhost:4230 \
SCHEDULER_INTERVAL_MS=0 WORKFLOW_RUN_CONCURRENCY=4 WORKFLOW_REAP_INTERVAL_MS=60000 \
…(every other worker interval 0, as in step 1)… npx tsx src/index.ts
```

```
[08:54:33] INFO: Server listening at http://0.0.0.0:4230
[08:54:33] INFO: Scheduler queue disabled (SCHEDULER_INTERVAL_MS <= 0)
[08:54:33] INFO: Workflow run worker started
[08:54:33] INFO: Workflow run reaper started
```

`curl -s -i http://localhost:4230/health` answered `HTTP/1.1 200 OK`. The log of the whole run
contains no line at level ERROR.

### I1. Sign in, make a key, read where the workflows are served

```bash
A=http://localhost:4230
curl -s -X POST $A/api/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"demo@northwind.ai\",\"password\":\"$DEMO_PASSWORD\"}" > login.json
TOKEN=$(jq -r .token login.json)
curl -s -X POST $A/api/auth/keys -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"workflow-v1-proof-run"}' > key.json
jq '{id, key: (.key[0:16] + "…"), name: .apiKey.name, scopes: .apiKey.scopes}' key.json
```

```json
{ "id": "ad5d61d2-fc5c-4e56-ac91-bbce4989a106", "key": "wheels_live_TE5Z…", "name": "workflow-v1-proof-run", "scopes": [] }
```

From here on `H="Authorization: Bearer $KEY"` is that API key and `J='Content-Type: application/json'`.

```bash
curl -s $A/api/orchestrations -H "$H" | jq -c '.orchestrations[] | {name, slug, isEnabled, apiEndpoint, openaiBaseUrl, openaiModel, steps: ._count.steps}'
```

```
{"name":"週次リリース","slug":"workflow-c3b392b2b1a4","isEnabled":false,"apiEndpoint":"http://localhost:4230/v1/workflows/workflow-c3b392b2b1a4/chat/completions","openaiBaseUrl":"http://localhost:4230/v1/workflows/workflow-c3b392b2b1a4","openaiModel":"workflow/workflow-c3b392b2b1a4","steps":0}
{"name":"Weekly  Release  Pipeline!","slug":"weekly-release-pipeline-404b9440","isEnabled":false,"apiEndpoint":"http://localhost:4230/v1/workflows/weekly-release-pipeline-404b9440/chat/completions","openaiBaseUrl":"http://localhost:4230/v1/workflows/weekly-release-pipeline-404b9440","openaiModel":"workflow/weekly-release-pipeline-404b9440","steps":0}
{"name":"weekly-release-pipeline","slug":"weekly-release-pipeline-84c0ceac","isEnabled":false,"apiEndpoint":"http://localhost:4230/v1/workflows/weekly-release-pipeline-84c0ceac/chat/completions","openaiBaseUrl":"http://localhost:4230/v1/workflows/weekly-release-pipeline-84c0ceac","openaiModel":"workflow/weekly-release-pipeline-84c0ceac","steps":0}
{"name":"Weekly release pipeline","slug":"weekly-release-pipeline","isEnabled":true,"apiEndpoint":"http://localhost:4230/v1/workflows/weekly-release-pipeline/chat/completions","openaiBaseUrl":"http://localhost:4230/v1/workflows/weekly-release-pipeline","openaiModel":"workflow/weekly-release-pipeline","steps":3}
```

### I2. Create the workflows this run uses: the slug is set on create

`release-brief` chains two agents and publishes the second one's reply as the run's `answer`.
`RESEARCH` is the agent "Research Analyst", `NOTES` "Release Notes Writer", `DEP` the seeded
deployment "Support LLM".

```bash
cat > wf-brief.json <<JSON
{
  "name": "Release brief",
  "description": "Turn a list of merged changes into two sentences of release notes.",
  "executionMode": "sequential",
  "steps": [
    { "name": "collect", "agentId": "$RESEARCH",
      "promptTemplate": "Rewrite the changes below as terse bullet points, one per change, nothing else.\n\n{{input.prompt}}" },
    { "name": "draft", "agentId": "$NOTES", "dependsOn": ["collect"],
      "promptTemplate": "Write exactly two sentences of release notes from these bullets. No heading.\n\n{{steps.collect.output}}",
      "outputMapping": { "answer": "\$.steps.draft.output" } }
  ]
}
JSON
# wf-model.json: the same, named "Release brief (own model)", with "draft" as
#   { "stepType": "model", "deploymentId": "$DEP", … }
for f in wf-brief wf-model; do
  curl -s -X POST $A/api/orchestrations -H "$H" -H "$J" -d @$f.json | jq -c '{id, name, slug, apiEndpoint, openaiBaseUrl, openaiModel}'
done
```

```
{"id":"a539b5ff-11a0-46a0-9063-3545f406d757","name":"Release brief","slug":"release-brief","apiEndpoint":"http://localhost:4230/v1/workflows/release-brief/chat/completions","openaiBaseUrl":"http://localhost:4230/v1/workflows/release-brief","openaiModel":"workflow/release-brief"}
{"id":"86860bec-a879-4f6d-a922-bdf60d54995d","name":"Release brief (own model)","slug":"release-brief-own-model","apiEndpoint":"http://localhost:4230/v1/workflows/release-brief-own-model/chat/completions","openaiBaseUrl":"http://localhost:4230/v1/workflows/release-brief-own-model","openaiModel":"workflow/release-brief-own-model"}
```

A different name that derives the same slug gets the next free one, and the same name again is
still refused as a name:

```bash
jq '.name = "Release Brief!"' wf-brief.json | curl -s -X POST $A/api/orchestrations -H "$H" -H "$J" -d @- | jq -c '{name, slug, openaiModel}'
curl -s -o /dev/null -w "%{http_code} " -X POST $A/api/orchestrations -H "$H" -H "$J" -d @wf-brief.json
curl -s -X POST $A/api/orchestrations -H "$H" -H "$J" -d @wf-brief.json | jq -c .
```

```
{"name":"Release Brief!","slug":"release-brief-2","openaiModel":"workflow/release-brief-2"}
409 {"error":"name_taken","message":"A workflow with this name already exists"}
```

("Release Brief!" was then deleted, `204`, so it does not appear below.)

### I3. The run, through the openai client

```bash
cd apps/api
WHEELSAI_API_URL=http://localhost:4230 WHEELSAI_API_KEY=$KEY WORKFLOW_SLUG=release-brief \
UNMAPPED_SLUG=weekly-release-pipeline DISABLED_SLUG=weekly-release-pipeline-84c0ceac \
FAILING_SLUG=release-brief-own-model npx tsx scripts/run-workflow-v1-proof.ts
```

```
openai client 7.28.0  base http://localhost:4230/v1  model workflow/release-brief

=== 1. models.list()  (unified base) ===
model: {"id":"support-llm","wheelsai":{"kind":"deployment"}}
model: {"id":"agent/support-concierge","wheelsai":{"kind":"agent"}}
model: {"id":"agent/research-analyst","wheelsai":{"kind":"agent"}}
model: {"id":"agent/release-notes-writer","wheelsai":{"kind":"agent"}}
model: {"id":"agent/community-moderator","wheelsai":{"kind":"agent"}}
model: {"id":"agent/sales-qualifier","wheelsai":{"kind":"agent"}}
model: {"id":"agent/ops-runbook-bot","wheelsai":{"kind":"agent"}}
model: {"id":"agent/seo-auditor-marketplace","wheelsai":{"kind":"agent"}}
model: {"id":"workflow/weekly-release-pipeline","wheelsai":{"kind":"workflow"}}
model: {"id":"workflow/release-brief","wheelsai":{"kind":"workflow"}}
model: {"id":"workflow/release-brief-own-model","wheelsai":{"kind":"workflow"}}

=== 1b. models.list()  (per-workflow base) ===
models: ["workflow/release-brief"]

=== 2. chat.completions.create()  (plain, unified base) ===
waited ms: 7604
id: "chatcmpl-41724a38-c027-4ea2-8330-99cdc99d26f1"
object: "chat.completion"
model: "workflow/release-brief"
finish_reason: "stop"
message.role: "assistant"
message.content: "Added streaming support for model deployments and function calling for agents. Enabled workflow responses via the /v1 endpoint."
usage: {"prompt_tokens":277,"completion_tokens":290,"total_tokens":567}
wheelsai.workflow: {"slug":"release-brief","executionId":"0b9dbbb7-2700-405c-a84c-45fc95e0d91b","status":"completed","durationMs":7134,"steps":[{"name":"collect","type":"agent","status":"success","durationMs":6305},{"name":"draft","type":"agent","status":"success","durationMs":785}]}
RUN_ID_PLAIN=0b9dbbb7-2700-405c-a84c-45fc95e0d91b

=== 3. chat.completions.create({ stream: true })  (per-workflow base) ===
first chunk after ms: 77
first chunk wheelsai: {"workflow":{"slug":"release-brief","executionId":"9af4d458-1cb5-4f96-ae1b-ffdd31120467","status":"running"}}
stream finished after ms: 2103
chunks: 4
finish_reason: "stop"
content: "Added streaming support for model deployments and function calling for agents. Updated workflows to answer via /v1."
usage (include_usage): {"prompt_tokens":277,"completion_tokens":473,"total_tokens":750}
last wheelsai.workflow: {"executionId":"9af4d458-1cb5-4f96-ae1b-ffdd31120467","status":"completed","steps":["collect:success","draft:success"]}

=== 4. a workflow with no output mapping: the last successful step is the answer ===
model: "workflow/weekly-release-pipeline"
message.content: "I don’t have information on this week’s changes beyond my June 2024 knowledge cutoff—please check the official release notes or the #announcements channel for the latest updates."
usage: {"prompt_tokens":325,"completion_tokens":1201,"total_tokens":1526}
steps: ["Collect changes:success","Draft release notes:success","Post community summary:success"]

=== 5. refusals (no run is started) ===
tools: {"status":400,"code":"unsupported_parameter","type":"invalid_request_error","param":"tools","message":"400 A workflow cannot call functions on the caller's side. Remove tools and tool_choice, or call an agent.","x-should-retry":null}
unknown workflow: {"status":404,"code":"workflow_not_found","type":"invalid_request_error","param":null,"message":"404 No workflow with that slug exists in this organization.","x-should-retry":"false"}
no user message: {"status":400,"code":"validation_failed","type":"invalid_request_error","param":"messages","message":"400 A workflow run needs a user message: the last one is the run's input.","x-should-retry":null}
disabled workflow: {"status":400,"code":"workflow_disabled","type":"invalid_request_error","param":null,"message":"400 This workflow is disabled. Enable it in the dashboard to run it.","x-should-retry":"false"}

=== 6. a run that fails ===
failed run: {"status":502,"code":"workflow_failed","type":"server_error","param":null,"message":"502 Workflow step \"draft\" failed: the deployment \"Support LLM\" has no healthy node right now; retry shortly","x-should-retry":"false","executionId":"54997856-316d-48e3-bf3d-2213cc3a3516","failedStep":"draft","steps":["collect:success","draft:failed"]}
```

Read against the claims:

- **Listed by `GET /v1/models`** (1): the three enabled workflows, with
  `wheelsai.kind: "workflow"`, next to the deployment and the agents. The three disabled ones
  are not listed. The per-workflow base lists the one workflow it serves (1b).
- **The last user message is the run input; the run's output is the assistant message** (2):
  the two sentences are the `draft` step's reply, published by its output mapping. The request
  waited 7.6 s for a run of 7.1 s.
- **Usage is summed over the steps** (2): 277 prompt and 290 completion tokens are the sum of
  what Groq reported for `collect` and `draft`.
- **The same answer as stream chunks** (3): the first chunk arrived 77 ms after the request,
  carrying the execution id while the run was still going; the answer followed 2 s later as a
  content chunk, a `stop` chunk with the finished run, the usage chunk that was asked for, and
  `[DONE]` (four chunks reach the client's iterator).
- **No output mapping** (4): the seeded three-step workflow publishes nothing, so the answer is
  the reply of the last step that succeeded. (Its steps have no prompts of their own, so each
  answered the run prompt; the model said it does not know this week's changes, which is true.)
- **Refusals name themselves and start nothing** (5): `tools` is a `400` with `param: "tools"`;
  an unknown slug a `404`; a request with no user message a `400` naming `messages`; a disabled
  workflow a `400`.
- **A failed run** (6) is a `502 workflow_failed` naming the run and the step, with
  `x-should-retry: false`: a repeat would be a new run. This is also the model step: see I6.

The raw stream, for one more request (`curl`, cut at 330 columns):

```bash
curl -s -X POST $A/v1/chat/completions -H "$H" -H "$J" --max-time 120 \
  -d '{"model":"workflow/release-brief","messages":[{"role":"user","content":"x"}],"stream":true,"stream_options":{"include_usage":true}}' | cut -c1-330
```

```
data: {"id":"chatcmpl-827cbf44-6a22-439c-af93-ded63f9459a6","object":"chat.completion.chunk","created":1791277134,"model":"workflow/release-brief","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}],"wheelsai":{"workflow":{"slug":"release-brief","executionId":"8950319c-9a06-401c-a28a-38341d10ee

data: {"id":"chatcmpl-827cbf44-6a22-439c-af93-ded63f9459a6","object":"chat.completion.chunk","created":1791277134,"model":"workflow/release-brief","choices":[{"index":0,"delta":{"content":"Could you share the list of changes you’d like turned into two concise release‑note sentences?"},"finish_reason":null}]}

data: {"id":"chatcmpl-827cbf44-6a22-439c-af93-ded63f9459a6","object":"chat.completion.chunk","created":1791277134,"model":"workflow/release-brief","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"wheelsai":{"workflow":{"slug":"release-brief","executionId":"8950319c-9a06-401c-a28a-38341d10ee65","status":"completed","dur

data: {"id":"chatcmpl-827cbf44-6a22-439c-af93-ded63f9459a6","object":"chat.completion.chunk","created":1791277134,"model":"workflow/release-brief","choices":[],"usage":{"prompt_tokens":245,"completion_tokens":343,"total_tokens":588}}

data: [DONE]
```

### I4. A run that outlives its request is cancelled

**The decision.** A request waits for its run for the workflow's own time limit plus 30 seconds
for the queue, and cancels the run if that passes or if the client disconnects. It does not
wait indefinitely and it does not leave the run going: an abandoned run would keep calling, and
paying for, steps nobody will read. The cancel is the same compare-and-set cancel the dashboard
uses, so a run is never billed twice and never left running unbilled: steps that finished are
billed once by their own rules, the step in flight is aborted, and no later step starts.

**A client that hangs up.** The first attempt at this did not show it, and is recorded as it
happened: the script hung up 1.5 s after the first chunk, and by then the run (about 2 s on the
earlier calls) had already finished and delivered its answer.

```
=== 7. the client disconnects while the run works ===
stream ended without the abort: UNEXPECTED
RUN_ID_ABORTED=befdb91c-411c-4d2f-a91b-9be7b5c84c8c
```

That run, `befdb91c`, is the third `completed` row in the history below. The "UNEXPECTED" was
the script's own check. A second try with a 250 ms hang-up, `08c0aa42`, did get cancelled on the
server but printed the same line, because the openai client ends its iterator quietly when its
own signal aborts instead of throwing. The script was corrected to report that, and run a third
time:

```bash
WHEELSAI_API_URL=http://localhost:4230 WHEELSAI_API_KEY=$KEY WORKFLOW_SLUG=release-brief \
PROOF_ONLY=disconnect npx tsx scripts/run-workflow-v1-proof.ts
```

```
openai client 7.28.0  base http://localhost:4230/v1  model workflow/release-brief

=== 7. the client disconnects while the run works ===
client aborted 250 ms after the first chunk; the stream ended with no answer
RUN_ID_ABORTED=60d5e172-710e-4d5c-a933-7c1805ee272e
```

Four seconds later, the run it named:

```bash
curl -s $A/api/orchestrations/$WF/executions/60d5e172-710e-4d5c-a933-7c1805ee272e -H "$H" \
  | jq -c '{status, triggeredBy, cancelRequestedAt, completedAt, error, durationMs, steps: [.stepResults[] | {stepName, status, error}]}'
```

```
{"status":"cancelled","triggeredBy":"api","cancelRequestedAt":"2026-10-06T08:56:59.969Z","completedAt":"2026-10-06T08:57:00.809Z","error":"cancelled","durationMs":1109,"steps":[{"stepName":"collect","status":"success","error":null}]}
```

The cancel was requested when the socket closed; the worker ended the run 840 ms later.
`collect` had finished and stays in the results; `draft` never ran. The workflow's run history,
every row started by the API:

```bash
curl -s "$A/api/orchestrations/$WF/executions?limit=10" -H "$H" | jq -c '.executions[] | {id: .id[0:8], status, triggeredBy, durationMs, error}'
```

```
{"id":"60d5e172","status":"cancelled","triggeredBy":"api","durationMs":1109,"error":"cancelled"}
{"id":"08c0aa42","status":"cancelled","triggeredBy":"api","durationMs":1180,"error":"cancelled"}
{"id":"befdb91c","status":"completed","triggeredBy":"api","durationMs":1997,"error":null}
{"id":"9af4d458","status":"completed","triggeredBy":"api","durationMs":1964,"error":null}
{"id":"0b9dbbb7","status":"completed","triggeredBy":"api","durationMs":7134,"error":null}
```

**A run that reaches its time limit.** A workflow with the shortest time limit the API allows
(10 s) and a for-each loop over the lines of the prompt, one essay per line:

```bash
jq '.name = "Release brief (10 s limit)" | .timeout = 10000 | .steps = [ .steps[0] + {
      "promptTemplate": "Write a detailed 800-word essay about this change, with history and examples: {{item}}",
      "loop": {"forEach": "$.input.prompt", "maxItems": 20}} ]' wf-brief.json > wf-short.json
# saved as the workflow with slug "release-brief-10-s-limit"
date +%T
curl -s -i -X POST $A/v1/chat/completions -H "$H" -H "$J" -d '{"model":"workflow/release-brief-10-s-limit",
  "messages":[{"role":"user","content":"streaming for model deployments\nfunction calling for agents\nworkflows through /v1\nper-step usage\nwebhook categories\nagent.deployed events\nmarketplace graph installs\nversion entrypoints"}]}' > timeout.out
date +%T
grep -i "^HTTP\|^x-should-retry" timeout.out
tail -1 timeout.out | jq -c '.error | {code, type, message, executionId, steps: [.workflow.steps[] | {name, iteration, status, error}]}'
```

```
09:58:35
09:58:45
HTTP/1.1 504 Gateway Timeout
x-should-retry: false
{"code":"workflow_timeout","type":"server_error","message":"The workflow reached its time limit of 10000 ms and was stopped. Steps that finished were billed.","executionId":"05f8c466-48f4-4b98-86ea-a6c907480f65","steps":[{"name":"collect","iteration":0,"status":"success","error":null},{"name":"collect","iteration":1,"status":"success","error":null},{"name":"collect","iteration":2,"status":"success","error":null},{"name":"collect","iteration":3,"status":"failed","error":"stopped: the workflow timed out"}]}
```

(`date` prints this machine's local time, one hour ahead of the server log's UTC.) Ten seconds,
three essays written and billed, the fourth stopped mid-call, the other four never started, and
an answer that says so. Three first attempts at this are not shown as results because they
proved nothing: a 1 s and then a 5 s limit were refused, `400 validation_failed`, the minimum
being 10 s; and a version with a single essay finished in 5 s and answered `200`.

### I5. What the request cost

**One plan API call per request.** `GET /api/billing/plan`, read with the same key:

```
before the client script:       {"plan":"pro","usage":{"agents":6,"apiCallsThisMonth":6}}
after sections 1 to 7 above:    {"plan":"pro","usage":{"agents":6,"apiCallsThisMonth":15}}
```

The six before are this run's own setup writes with the key (five workflow creates, two of
them refused as shown in I2, and one delete). The script then made nine `POST`s under `/v1`:
the plain completion, the stream, the unmapped workflow, four refusals, the failed run and the
disconnect. Nine calls, nine counted, however many steps each run had; the two model listings
were free. A refused request is counted like any other, as it is for agents.

**Every step by its usual rules.** The steps here are agents on the platform's free model, so
their usual rules are the free-model limits and the agent usage rollup. "Research Analyst" is
the first step of every run above; its usage, read after the two later disconnect runs, filed
under the source `job`, which is the mode workflow steps run in:

```bash
curl -s "$A/api/agents/25bc2504-946c-46ab-b1e7-ca82f182cf7e/usage" -H "$H" | jq -c '.usage.bySource'
```

```
{"job":{"requests":7,"errors":0,"streamed":0,"answered":7,"inputTokens":968,"outputTokens":1771,"usageUnreported":0,"toolCalls":0,"avgLatencyMs":1812,"p50LatencyMs":2000,"p95LatencyMs":8000,"errorRate":0}}
```

Seven chats for the seven runs that reached the step by then (three completed and two cancelled
runs of `release-brief`, the unmapped workflow, and the failed one), each recorded once.

### I6. A workflow with a model step

A model step calls one of the organization's model deployments. A deployment that can answer
needs a GPU node on Nosana, which does not exist on this machine, so **no model step ran in
this document, and none was imitated**. What was run is the real path up to the node. Since
sections E and F4 were recorded, the model step and the deployment restart have been connected
(`services/deploymentChat.ts`, `services/modelDeploymentLifecycle.ts`), so the step no longer
refuses as "not connected": it finds the seeded deployment, which is marked running and has no
node behind it, and fails with that reason (section 6 of the script output above):

```
failed run: {"status":502,"code":"workflow_failed",…,"message":"502 Workflow step \"draft\" failed: the deployment \"Support LLM\" has no healthy node right now; retry shortly","x-should-retry":"false","executionId":"54997856-316d-48e3-bf3d-2213cc3a3516","failedStep":"draft","steps":["collect:success","draft:failed"]}
```

The billing of a model step that does answer (included in GPU time, or a credit hold settled
once) is covered by `deploymentChat.unit.test.ts`, not by this run.

### I7. Also checked on this server

Three of the leftovers fixed with this change, read off the same server:

```bash
curl -s $A/api/webhooks/events -H "$H" | jq -c '.categories'
```

```
{"agent":["agent.created","agent.updated","agent.deleted","agent.deployed","agent.version.created"],"deployment":["deployment.started","deployment.running","deployment.stopped","deployment.failed"],"training":["training.started","training.completed","training.failed"],"alert":["alert.triggered","alert.resolved"],"billing":["billing.low_balance","billing.payment_received"],"workflow":["workflow.completed","workflow.failed"],"scheduled_task":["scheduled_task.failed"],"report":["report.generated"]}
```

```bash
# A JSON content type with no body, on a route outside the workflow and scheduler plugins:
curl -s -o /dev/null -w "%{http_code}\n" -X POST $A/api/versioning/agents/$RESEARCH/versions -H "$H" -H "$J"
curl -s $A/docs/json | jq -c '.components.securitySchemes | map_values({type, scheme})'
```

```
201
{"bearerAuth":{"type":"http","scheme":"bearer"}}
```

The server also started, which it would not have if the four webhook plugins that register
their own JSON parser (Stripe, GitHub, Slack, channels) had collided with the root one.

### I8. What section I does not show

- **A model step answering**, and its billing (I6).
- **`agent.deployed` being delivered.** It is sent when the deployment-status worker observes an
  agent deployment reach running on Nosana; that worker was off and there is no Nosana here.
  Unit-tested (`webhookEventCategories.unit.test.ts`).
- **The request-side wait running out** (a run still queued after the time limit plus 30 s,
  cancelled before it starts), the organization's run cap answered through `/v1`, and a scoped
  key refused for lacking `workflows:invoke`. Unit-tested (`workflowChat.unit.test.ts`,
  `openaiV1Router.unit.test.ts`).
- **A marketplace install copying a graph, and a version rollback restoring an entrypoint.**
  Unit-tested (`marketplaceInstall.unit.test.ts`, `versioningAuthor.unit.test.ts`).
- **The workflow's API tab in a browser.** Type-checked and its snippet builder unit-tested;
  not opened.
- **The dev database.** Not migrated: it still has no `orchestrations.slug` column, five
  workflows and no key named `workflow-v1-proof-run`.

### I9. Shutdown

```bash
kill -TERM 1321798        # the tsx process listening on 4230
node -e "setTimeout(()=>{},7000)"; ss -ltnp | grep ':4230 ' || echo "port 4230 is free"
```

```
port 4230 is free
```

```bash
psql postgresql://wheelsai:…@localhost:5434/postgres -c "DROP DATABASE wheelsai_wfv1"
redis-cli -p 6380 -n 6 flushdb
psql postgresql://wheelsai:…@localhost:5434/postgres -Atc "select datname from pg_database where datname like 'wheelsai%'"
ss -ltnp | grep ':4230 ' || echo "port 4230 is free"
```

```
DROP DATABASE
OK
wheelsai
port 4230 is free
```

---

## What this run does not show

- **Model steps running.** They fail by name (section E). One function is missing; it is
  being extracted from the `/v1` route by other work. *(Connected since: see I6.)*
- **A health check restarting a deployment.** Not connected, and refused when saved (F4).
  *(Connected since; not exercised, because there is no Nosana on this machine.)*
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
