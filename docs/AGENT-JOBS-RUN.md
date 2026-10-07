# Offerings and jobs — proof run

**Date:** 2026-10-06 · **Branch:** `feat/bags-launchpad` (working tree on top of `2114947`)
**Migrations under test:** `20261009100000_offerings_jobs_runner`, `20261009110000_job_model_usage`

The claims: *"Package a workflow as a product and charge for every run"* and *"Offer your model
endpoint to others and earn on every request"* (landing page), and the plan's Offerings and
Jobs: a publisher sells a fixed task that their agent, workflow or model runs for a buyer; the
price is held in escrow; the product runs in the publisher's organization; the money is released
when the buyer accepts the deliverable and refunded when the job is rejected, fails, expires or
is cancelled.

This run starts the API locally with the job runner and the sweeper on, signs in as two seeded
demo organizations, and drives the real thing through the HTTP API: an agent job hired, run,
submitted, accepted and paid; a workflow job; a job whose deliverable fails its checks; a job
rejected inside the review window; a job that expires; a job cancelled before it starts; and
hires refused for API keys without the spend scope or past their caps. Model calls went to Groq.
Nothing was simulated. Section J lists what this run did not exercise, including the model
offering, which needs a running GPU deployment that this machine does not have.

Everything below is the command that was run and its output. Two kinds of trimming: long model
text is cut with `…`, and `jq` filters (shown in the command) select the fields worth reading.
One kind of correction: three helper lines of the scripts were wrong when first run (a table
name that does not exist, twice, and a shell function that was not visible inside a sub-shell);
those lines are shown as they were re-run, and sections B and D say which. The demo password is
read from `$DEMO_PASSWORD`.

> **Note, 2026-10-07: three contracts changed after this run. The output below is the run of
> 2026-10-06 and was not edited; it has not been run again.**
>
> 1. **A hire carries the terms the buyer saw.** The hires made with the buyer's dashboard
>    session (`-H "authorization: Bearer $BUYER"`, in sections A3, A4, B, C, D, F and G) send
>    only `{"input": …}`. Sent today, each would answer `400 expected_terms_required` and charge
>    nothing: a session hire must add
>    `"expected": {"priceCents", "slaSeconds", "termsVersion"}` taken from the offering as it was
>    read, and is refused with `409 offering_terms_changed` if the publisher edited the offering
>    in between. With `expected` added the hires behave as recorded. The API-key hires of section
>    E send no `expected` and are still accepted as recorded (a key is hired at the current terms,
>    inside its per-job cap). The repeated hire of A4 is still answered `200` with the first job.
> 2. **The public offering has one more field.** `termsVersion` now appears in the key list
>    printed in A2, between `slug` and `title`. It is a digest; the checks in A2 that the public
>    page carries no instructions and no `KESTREL-7` marker hold as recorded
>    (`offeringRoutes.unit.test.ts`).
> 3. **`http_request` does not run in a paid job unless the offering names it** in
>    `allowedTools`. No offering in this run named it, and no deliverable here depended on an
>    outbound request, so nothing recorded below would differ.
>
> Also since this run: a JSON Schema validation has a work budget, and a schema that could
> exceed it whatever the data is refused when it is saved. The schemas used here (section C's
> `json_schema` check and the offerings' input schemas) are far inside it. None of these
> changes has been exercised against a running API; they are covered by unit tests
> (`jobRoutes`, `offeringRoutes`, `jsonSchema`, `skillsRegistry`, `chatRuntime`).

---

## The environment

| | |
|---|---|
| API | `apps/api`, `npx tsx src/index.ts`, port **4240** |
| Database | a **disposable copy** of the local dev database, `wheelsai_jobsproof` (see below) |
| Redis | `localhost:6380`, database index **7**, empty at the start, so the queues and the free-model counters of this run were its own |
| Buyer | the seeded demo organization "Northwind AI Labs", owner `demo@northwind.ai`, 184,250 cents of credits at the start |
| Publisher | the seeded demo organization "Kestrel Labs", owner `team@kestrel.ai`, with its two agents "Daily Market Brief" and "Code Review Bot"; pending payout 7,900 cents at the start |
| Third party | the seeded demo organization "Atlas Agents", owner `hello@atlasagents.dev` |
| Model | the agents' `free/groq/llama-3.3-70b`, the platform's free Groq model; `GROQ_API_KEY` from `apps/api/.env` |
| Email | no provider configured; in development the `log` transport writes the message to the API log instead of sending it |

### Why a copy of the database

The two migrations this feature needs had not been applied to the local dev database
(`wheelsai`) when this run was made; applying migrations to it is the reviewer's step. The run
used a copy, created from the dev database as a template, with every pending migration applied
to the copy only (the third one belongs to the custom-domains work, which shares the Prisma
schema):

```bash
psql postgresql://wheelsai:…@localhost:5434/postgres -c "CREATE DATABASE wheelsai_jobsproof TEMPLATE wheelsai"
for m in 20261009100000_offerings_jobs_runner 20261009110000_job_model_usage 20261009200000_custom_domain_edge; do
  echo "== $m"
  psql postgresql://wheelsai:…@localhost:5434/wheelsai_jobsproof -v ON_ERROR_STOP=1 -1 -q \
    -f packages/db/prisma/migrations/$m/migration.sql; echo "exit $?"
done
cd packages/db && npx prisma migrate diff --from-url "postgresql://wheelsai:…@localhost:5434/wheelsai_jobsproof?schema=public" \
  --to-schema-datamodel prisma/schema.prisma --script
```

```
CREATE DATABASE
== 20261009100000_offerings_jobs_runner
exit 0
== 20261009110000_job_model_usage
exit 0
== 20261009200000_custom_domain_edge
exit 0
-- This is an empty migration.
```

The empty diff says the migrated copy matches `schema.prisma` exactly. The copy was dropped
after the run and Redis index 7 flushed (see Shutdown). The dev database was not written to: it
still has no `jobs.model_cost_cents` column, no job rows, and the buyer's 184,250 cents.

### 1. Start the API on port 4240, job runner and sweeper on

```bash
cd apps/api
DATABASE_URL="postgresql://wheelsai:…@localhost:5434/wheelsai_jobsproof?schema=public" \
REDIS_URL="redis://localhost:6380/7" \
API_PORT=4240 PUBLIC_API_URL=http://localhost:4240 RATE_LIMIT_MAX_PER_MINUTE=1000 LOG_LEVEL=info \
JOB_RUNNER_CONCURRENCY=2 JOB_SWEEP_INTERVAL_MS=15000 WORKFLOW_RUN_CONCURRENCY=2 WORKFLOW_REAP_INTERVAL_MS=60000 \
SCHEDULER_INTERVAL_MS=0 SETTLEMENT_INTERVAL_MS=0 EMBEDDING_BACKFILL_INTERVAL_MS=0 TOKEN_INDEXER_INTERVAL_MS=0 \
TREASURY_SETTLEMENT_INTERVAL_MS=0 TREASURY_SETTLEMENT_BATCH_INTERVAL_MS=0 PAYMENT_SUBMIT_INTERVAL_MS=0 \
PAYMENT_POLL_INTERVAL_MS=0 PAYMENT_REAP_INTERVAL_MS=0 FEE_ROUTER_INTERVAL_MS=0 BAGS_FEE_SWEEP_INTERVAL_MS=0 \
REPUTATION_ATTESTATION_INTERVAL_MS=0 DEPLOYMENT_STATUS_INTERVAL_MS=0 UPTIME_PROBER_INTERVAL_MS=0 \
ALERT_EVALUATOR_INTERVAL_MS=0 ANALYTICS_SNAPSHOT_INTERVAL_MS=0 SUBSCRIPTION_RENEWAL_INTERVAL_MS=0 \
PAYOUT_EXECUTOR_INTERVAL_MS=0 \
npx tsx src/index.ts
```

```
[11:48:50] INFO: Server listening at http://0.0.0.0:4240
[11:48:50] INFO: Job runner started
[11:48:50] INFO: Job sweeper started
[11:49:00] WARN: No Nosana wallet configured - job submission disabled
```

The sweeper ran every 15 seconds in this run (the default is 60), so the expiry in section G did
not have to wait a further minute. The server was restarted once, 35 seconds in (it received a
`SIGTERM` from outside this run while job A was already submitted), with the same command and
environment; it logged `Server listening` again at 11:50:55 and ran untouched until Shutdown.
Section A notes where that falls.

### 2. Sign in, and the helpers used below

```bash
export API=http://localhost:4240
login() { curl -s $API/api/auth/login -H 'content-type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"$DEMO_PASSWORD\"}" | jq -r .token; }
export BUYER=$(login demo@northwind.ai)
export PUB=$(login team@kestrel.ai)
export PROOF_DB=postgresql://wheelsai:…@localhost:5434/wheelsai_jobsproof

# Poll a job (as $1's holder) until it leaves funded/running.
wait_job() { for i in $(seq 1 60); do s=$(curl -s $API/api/jobs/$2 -H "authorization: Bearer $1" | jq -r .job.status); case $s in funded|running) sleep 2;; *) echo "status after $((i*2-2))s: $s"; return;; esac; done; }
# The credit ledger rows of one job, its escrow row, and the two balances that matter.
ledger() { psql "$PROOF_DB" -c "select t.type, t.amount_cents, t.balance_after, t.description from credit_transactions t join marketplace_revenue r on r.id::text = t.reference_id where r.job_id = '$1' order by t.created_at"; }
escrow() { psql "$PROOF_DB" -c "select type, status, gross_amount_cents gross, platform_fee_cents fee, creator_amount_cents creator, model_cost_cents model_cost, settled_at is not null settled from marketplace_revenue where job_id = '$1'"; }
balances() { psql "$PROOF_DB" -Atc "select 'buyer balance_cents=' || (select balance_cents from credit_balances where org_id='ad698f19-bf63-4d1e-9402-fd6c51636a66') || '  publisher pending_payout_cents=' || pending_payout_cents || ' total_revenue_cents=' || total_revenue_cents from publisher_profiles where org_id='91abb635-426c-4867-b1d9-888f2186bffc'"; }
```

`ad698f19-…` is Northwind AI Labs (the buyer) and `91abb635-…` is Kestrel Labs (the publisher).

---

## A. An agent job: hired, run, submitted, accepted, paid

### A1. The publisher creates the offering

```bash
curl -s $API/api/offerings -H "authorization: Bearer $PUB" -H 'content-type: application/json' -d '{
  "productKind": "agent",
  "agentId": "32a6fb2b-4b65-490f-9f3d-e90609b55e9d",
  "title": "One-paragraph market brief",
  "description": "Send a topic and get a single-paragraph brief on it, written by the Daily Market Brief agent.",
  "priceCents": 200,
  "slaSeconds": 600,
  "inputSchema": {
    "type": "object",
    "required": ["topic"],
    "additionalProperties": false,
    "properties": {
      "topic": { "type": "string", "title": "Topic", "minLength": 3, "maxLength": 200 },
      "audience": { "type": "string", "title": "Audience", "enum": ["investors", "engineers", "general"], "default": "general" }
    }
  },
  "sampleInputs": [{ "topic": "GPU rental prices this quarter", "audience": "investors" }],
  "instructions": "House style KESTREL-7: write exactly one paragraph of 60 to 120 words, plain prose, no headings and no lists. End with a sentence that starts with the words Bottom line.",
  "deliverableChecks": [
    { "type": "min_length", "value": 200, "label": "At least 200 characters" },
    { "type": "contains", "value": "Bottom line", "label": "Ends with a bottom line" }
  ],
  "maxAttempts": 2
}' | tee offering-agent.json | jq '.offering | {id, slug, status, productKind, priceCents, slaSeconds, reviewWindowHours, product, instructions: (.instructions[0:40] + "…")}'
```

```json
{
  "id": "ab353433-3c67-49cf-b931-93349483fb2d",
  "slug": "one-paragraph-market-brief",
  "status": "draft",
  "productKind": "agent",
  "priceCents": 200,
  "slaSeconds": 600,
  "reviewWindowHours": 72,
  "product": {
    "name": "Daily Market Brief"
  },
  "instructions": "House style KESTREL-7: write exactly one…"
}
```

### A2. Test run, publish, and what the public can read

```bash
OFFER=$(jq -r .offering.id offering-agent.json)
# The publisher's own test run: the product runs exactly as a paid job would, with no job and no money.
curl -s $API/api/offerings/$OFFER/test-run -H "authorization: Bearer $PUB" -H 'content-type: application/json' \
  -d '{"input":{"topic":"GPU rental prices this quarter","audience":"investors"}}' \
  | jq '{passed, durationMs, checkResults: [.checkResults[] | {label, type, passed}], text: (.output.text[0:160] + "…")}'
# Publish it.
curl -s -X POST $API/api/offerings/$OFFER/activate -H "authorization: Bearer $PUB" | jq '.offering | {status, publishedAt}'
# What anyone can read, signed out: every key of the public page.
curl -s $API/api/offerings/one-paragraph-market-brief | jq -c '.offering | keys'
curl -s $API/api/offerings/one-paragraph-market-brief | grep -c 'KESTREL-7'
```

```
{
  "passed": true,
  "durationMs": 7525,
  "checkResults": [
    {
      "label": "At least 200 characters",
      "type": "min_length",
      "passed": true
    },
    {
      "label": "Ends with a bottom line",
      "type": "contains",
      "passed": true
    },
    {
      "label": "Does not repeat the publisher's private instructions",
      "type": "confidentiality",
      "passed": true
    }
  ],
  "text": "GPU rental prices have softened this quarter as a surge in new data‑center capacity from major cloud providers coincided with a modest slowdown in AI‑driven dem…"
}
{
  "status": "active",
  "publishedAt": "2026-10-06T11:50:02.654Z"
}
["createdAt","deliverableChecks","description","id","inputSchema","listing","outputFormat","priceCents","product","productKind","publisher","reviewWindowHours","sampleInputs","slaSeconds","slug","title","trackRecord"]
0
```

The public page has no `instructions`, `agentId` or tool fields, and the marker `KESTREL-7`
from the private instructions appears in it zero times.

### A3. The buyer hires it: $2.00 into escrow

```bash
balances
# Hire: the buyer's owner, from the dashboard session. $2.00 goes into escrow.
curl -s -w '\nHTTP %{http_code}\n' $API/api/offerings/$OFFER/hire -H "authorization: Bearer $BUYER" \
  -H 'content-type: application/json' -H 'Idempotency-Key: proof-agent-1' \
  -d '{"input":{"topic":"Decentralized GPU networks versus hyperscalers","audience":"engineers"}}' \
  | tee job-agent.json | jq -c 'if type=="object" then .job | {id, status, priceCents, escrow, deadlineAt, output} else . end' 2>/dev/null || tail -1 job-agent.json
```

```
buyer balance_cents=184250  publisher pending_payout_cents=7900 total_revenue_cents=18750
{"id":"96a19bcc-baa1-4bcc-a9d6-3ff6bf42402e","status":"funded","priceCents":200,"escrow":{"status":"held","amountCents":200},"deadlineAt":"2026-10-06T12:00:20.221Z","output":null}
HTTP 201
```

### A4. Submitted; the same hire repeated; nothing is the publisher's yet

The job was funded at 11:50:20.2 and submitted at 11:50:23.9 (`submittedAt` below), 3.7 seconds
later. The server restart described in section 1 happened right after that, which is why the
poll below, run against the restarted server, reports the job already submitted.

```bash
JOB=$(head -1 job-agent.json | jq -r .job.id)
wait_job $BUYER $JOB
# The buyer's view of the submitted job.
curl -s $API/api/jobs/$JOB -H "authorization: Bearer $BUYER" \
  | jq '.job | {status, escrow, checks, submittedAt, reviewDeadlineAt, keys: (keys | join(",")), text: .output.text}'
# The same hire sent again with the same Idempotency-Key: the first job, no second charge.
curl -s -o replay.json -w 'HTTP %{http_code}\n' $API/api/offerings/$OFFER/hire -H "authorization: Bearer $BUYER" \
  -H 'content-type: application/json' -H 'Idempotency-Key: proof-agent-1' \
  -d '{"input":{"topic":"Decentralized GPU networks versus hyperscalers","audience":"engineers"}}'
jq -c '.job | {id, status}' replay.json
balances
escrow $JOB
```

```
status after 0s: submitted
{
  "status": "submitted",
  "escrow": {
    "status": "held",
    "amountCents": 200
  },
  "checks": [
    {
      "label": "At least 200 characters",
      "type": "min_length",
      "passed": true
    },
    {
      "label": "Ends with a bottom line",
      "type": "contains",
      "passed": true
    },
    {
      "label": "Does not repeat the publisher's private instructions",
      "type": "confidentiality",
      "passed": true
    }
  ],
  "submittedAt": "2026-10-06T11:50:23.895Z",
  "reviewDeadlineAt": "2026-10-09T11:50:23.895Z",
  "keys": "checks,completedAt,createdAt,deadlineAt,escrow,failureReason,fundedAt,id,input,offering,output,priceCents,rating,rejectionReason,review,reviewDeadlineAt,role,startedAt,status,submittedAt",
  "text": "Decentralized GPU networks are emerging as a distributed alternative to the monolithic offerings of hyperscale cloud providers, leveraging idle graphics capacity across a global pool of participants. For engineers, the model promises lower latency for edge workloads, … Bottom line: decentralized GPU farms can cut costs and improve locality for targeted AI tasks, but hyperscalers remain the default for large‑scale, production‑grade deployments."
}
HTTP 200
{"id":"96a19bcc-baa1-4bcc-a9d6-3ff6bf42402e","status":"submitted"}
buyer balance_cents=184050  publisher pending_payout_cents=7900 total_revenue_cents=18750
 type | status  | gross | fee | creator | model_cost | settled 
------+---------+-------+-----+---------+------------+---------
 job  | pending |   200 |  20 |     180 |          0 | f
(1 row)
```

The deliverable is one paragraph and ends with "Bottom line", as the private instructions asked;
the buyer's view has no key that could carry those instructions. The review deadline is 72 hours
after submission. The repeated hire answered `200` with the same job id and the buyer's balance
is down by 200 cents, once. The escrow row is `pending`, and the publisher's payout balance has
not moved.

### A5. Accept: the escrow is released, with the ledger rows

```bash
# Accept and rate: the escrow is released to the publisher.
curl -s -w 'HTTP %{http_code}\n' -o accept.json $API/api/jobs/$JOB/accept -H "authorization: Bearer $BUYER" \
  -H 'content-type: application/json' -d '{"rating":5,"review":"Exactly the brief I asked for."}'
jq -c '.job | {status, escrow, completedAt, rating}' accept.json
# A second accept changes nothing.
curl -s -w '  HTTP %{http_code}\n' $API/api/jobs/$JOB/accept -H "authorization: Bearer $BUYER" -H 'content-type: application/json' -d '{}'
escrow $JOB
ledger $JOB
balances
psql "$PROOF_DB" -c "select status, attempts, platform_input_tokens, platform_output_tokens, model_cost_cents from jobs where id='$JOB'"
# The publisher's view of the same job, and their revenue.
curl -s $API/api/jobs/$JOB -H "authorization: Bearer $PUB" | jq -c '.job | {role, status, buyer: .buyer.name, creatorAmountCents, platformFeeCents, modelCostCents, attempts}'
curl -s $API/api/marketplace/revenue -H "authorization: Bearer $PUB" | jq -c '{pendingPayoutCents, heldInEscrow, latest: (.recentTransactions[0] | {type, grossAmountCents, platformFeeCents, creatorAmountCents, escrow, modelCostCents})}'
```

```
HTTP 200
{"status":"completed","escrow":{"status":"released","amountCents":200},"completedAt":"2026-10-06T11:51:09.012Z","rating":5}
{"error":"job_state_conflict","message":"Only a submitted job can be completed"}  HTTP 409
 type | status  | gross | fee | creator | model_cost | settled 
------+---------+-------+-----+---------+------------+---------
 job  | settled |   200 |  21 |     179 |          1 | t
(1 row)

      type       | amount_cents | balance_after |              description               
-----------------+--------------+---------------+----------------------------------------
 marketplace_job |         -200 |        184050 | Job escrow: One-paragraph market brief
(1 row)

buyer balance_cents=184050  publisher pending_payout_cents=8079 total_revenue_cents=18929
  status   | attempts | platform_input_tokens | platform_output_tokens | model_cost_cents 
-----------+----------+-----------------------+------------------------+------------------
 completed |        1 |                   304 |                    784 |                1
(1 row)

{"role":"publisher","status":"completed","buyer":"Northwind AI Labs","creatorAmountCents":179,"platformFeeCents":21,"modelCostCents":1,"attempts":1}
{"pendingPayoutCents":8079,"heldInEscrow":{"creatorAmountCents":0,"jobs":0},"latest":{"type":"job","grossAmountCents":200,"platformFeeCents":21,"creatorAmountCents":179,"escrow":"released","modelCostCents":1}}
```

The arithmetic: 200 cents gross, 10% platform fee = 20, creator share = 180. The job used 304
input and 784 output tokens on the platform's own Groq key, which at the configured rates (15
and 60 cents per million) rounds up to 1 cent; that cent moves from the creator's share to the
platform at settlement, so the row settles as fee 21 + creator 179 = 200. The publisher's payout
balance rose by exactly 179 (7,900 to 8,079). The buyer has one ledger row for the job, the
debit, with the balance after it. The second accept was refused and moved nothing.

---

## B. A workflow job

The publisher builds a two-step workflow from its own two agents, sells it as an offering, and
the buyer hires it.

```bash
# A two-step workflow in the publisher's organization, built from its own two agents.
curl -s $API/api/orchestrations -H "authorization: Bearer $PUB" -H 'content-type: application/json' -d '{
  "name": "Review then summarize",
  "executionMode": "sequential",
  "steps": [
    { "name": "review", "agentId": "c21d43eb-1bb9-4afa-aa95-d7063055955b",
      "promptTemplate": "Review this code change and list at most three concrete problems.\n\n{{input.prompt}}" },
    { "name": "summary", "agentId": "32a6fb2b-4b65-490f-9f3d-e90609b55e9d", "dependsOn": ["review"],
      "promptTemplate": "Turn this code review into a two-sentence summary for a release manager:\n\n{{steps.review.output}}" }
  ]
}' | tee workflow.json | jq -c '{id, slug, isEnabled, steps: [.steps[]?.name]}'
WF=$(jq -r .id workflow.json)
curl -s $API/api/offerings -H "authorization: Bearer $PUB" -H 'content-type: application/json' -d '{
  "productKind": "workflow",
  "orchestrationId": "'$WF'",
  "title": "Code change review with a release summary",
  "description": "Paste a diff or a description of a change. A two-step workflow reviews it and writes a short summary for whoever signs off the release.",
  "priceCents": 300,
  "slaSeconds": 900,
  "inputSchema": { "type": "object", "required": ["change"], "properties": { "change": { "type": "string", "title": "The change", "minLength": 10, "maxLength": 4000 } } },
  "deliverableChecks": [{ "type": "min_length", "value": 80 }]
}' | tee offering-workflow.json | jq -c '.offering | {id, slug, status, productKind, product}'
OFFER=$(jq -r .offering.id offering-workflow.json)
curl -s -X POST $API/api/offerings/$OFFER/activate -H "authorization: Bearer $PUB" | jq -c '.offering | {status}'
curl -s -o job-workflow.json -w 'HTTP %{http_code}\n' $API/api/offerings/$OFFER/hire -H "authorization: Bearer $BUYER" \
  -H 'content-type: application/json' -H 'Idempotency-Key: proof-workflow-1' \
  -d '{"input":{"change":"def total(items):\n    s = 0\n    for i in range(len(items) + 1):\n        s += items[i].price\n    return s"}}'
jq -c '.job | {id, status, priceCents, escrow}' job-workflow.json
JOB=$(jq -r .job.id job-workflow.json)
wait_job $BUYER $JOB
curl -s $API/api/jobs/$JOB -H "authorization: Bearer $BUYER" | jq '.job | {status, escrow, checks, text: .output.text}'
```

```
{"id":"2173788c-e597-4150-935b-19e488ba6a84","slug":"review-then-summarize","isEnabled":true,"steps":["review","summary"]}
{"id":"54981f53-4e4a-44f7-af4e-3222d927ffc8","slug":"code-change-review-with-a-release-summary","status":"draft","productKind":"workflow","product":{"name":"Review then summarize"}}
{"status":"active"}
HTTP 201
{"id":"ad13664a-e4cb-4156-b0d8-3094265c2976","status":"funded","priceCents":300,"escrow":{"status":"held","amountCents":300}}
status after 4s: submitted
{
  "status": "submitted",
  "escrow": {
    "status": "held",
    "amountCents": 300
  },
  "checks": [
    {
      "label": "At least 80 characters",
      "type": "min_length",
      "passed": true
    },
    {
      "label": "Does not repeat the publisher's private instructions",
      "type": "confidentiality",
      "passed": true
    }
  ],
  "text": "The recent changes fix an off‑by‑one error that caused an IndexError by correcting the loop range and replace the index‑based iteration with a direct `for item in items` loop for clearer, safer code. Additionally, input validation was added to ensure `items` is iterable and each element has a `price` attribute, preventing crashes on empty or malformed inputs."
}
```

The deliverable is the second step's output, written from the first step's review of the
buyer's code (the off-by-one in `range(len(items) + 1)`).

```bash
# The run behind it, in the publisher's organization, linked to the job.
psql "$PROOF_DB" -c "select e.status, e.triggered_by, e.duration_ms, o.org_id = '91abb635-426c-4867-b1d9-888f2186bffc' as in_publisher_org, e.job_id = '$JOB' as linked_to_job, (select string_agg(r.status, ',') from orchestration_step_results r where r.execution_id = e.id) as steps from orchestration_executions e join orchestrations o on o.id = e.orchestration_id where e.job_id = '$JOB'"
# The buyer cannot read that run: it is not theirs.
EXEC=$(psql "$PROOF_DB" -Atc "select id from orchestration_executions where job_id='$JOB'")
curl -s -w '  HTTP %{http_code}\n' $API/api/orchestrations/$(jq -r .id workflow.json)/executions/$EXEC -H "authorization: Bearer $BUYER"
curl -s -o /dev/null -w 'accept: HTTP %{http_code}\n' $API/api/jobs/$JOB/accept -H "authorization: Bearer $BUYER" -H 'content-type: application/json' -d '{"rating":4}'
escrow $JOB
ledger $JOB
balances
```

```
  status   | triggered_by | duration_ms | in_publisher_org | linked_to_job |      steps      
-----------+--------------+-------------+------------------+---------------+-----------------
 completed | job          |        2452 | t                | t             | success,success
(1 row)

{"error":"not_found","message":"Workflow not found"}  HTTP 404
accept: HTTP 200
 type | status  | gross | fee | creator | model_cost | settled 
------+---------+-------+-----+---------+------------+---------
 job  | settled |   300 |  31 |     269 |          1 | t
(1 row)

      type       | amount_cents | balance_after |                      description                      
-----------------+--------------+---------------+-------------------------------------------------------
 marketplace_job |         -300 |        183750 | Job escrow: Code change review with a release summary
(1 row)

buyer balance_cents=183750  publisher pending_payout_cents=8348 total_revenue_cents=19198
```

(The first query was first run against a table name that does not exist,
`orchestration_step_executions`, and errored; it is shown as re-run against
`orchestration_step_results`.) The workflow ran in the publisher's organization, triggered by
the job and linked to it; both steps succeeded. The buyer, asking for that run directly, is told the workflow does not exist.
300 gross = fee 30 + 1 cent of model cost, creator 269; the publisher's payout balance rose by
269 (8,079 to 8,348).

---

## C. A deliverable that fails its checks: failed, refunded

The offering promises a JSON object with a numeric score. The publisher's private instructions
tell the agent to answer in prose, so no attempt can pass the check.

```bash
curl -s $API/api/offerings -H "authorization: Bearer $PUB" -H 'content-type: application/json' -d '{
  "productKind": "agent",
  "agentId": "c21d43eb-1bb9-4afa-aa95-d7063055955b",
  "title": "Scored code review",
  "description": "A code review returned as JSON with a score from 0 to 10.",
  "priceCents": 150,
  "slaSeconds": 600,
  "inputSchema": { "type": "object", "required": ["code"], "properties": { "code": { "type": "string", "minLength": 5 } } },
  "instructions": "Answer in two plain English sentences. Never use JSON, braces or code blocks.",
  "deliverableChecks": [
    { "type": "json_schema", "label": "A JSON object with a score",
      "schema": { "type": "object", "required": ["score"], "properties": { "score": { "type": "number", "minimum": 0, "maximum": 10 } } } }
  ],
  "maxAttempts": 2
}' | tee offering-fail.json | jq -c '.offering | {id, slug, status}'
OFFER=$(jq -r .offering.id offering-fail.json)
curl -s -X POST $API/api/offerings/$OFFER/activate -H "authorization: Bearer $PUB" | jq -c '.offering | {status}'
balances
curl -s -o job-fail.json -w 'HTTP %{http_code}\n' $API/api/offerings/$OFFER/hire -H "authorization: Bearer $BUYER" \
  -H 'content-type: application/json' -d '{"input":{"code":"while True: pass"}}'
jq -c '.job | {id, status, escrow}' job-fail.json
JOB=$(jq -r .job.id job-fail.json)
wait_job $BUYER $JOB
# The buyer: refunded, told which check failed, and shown no output.
curl -s $API/api/jobs/$JOB -H "authorization: Bearer $BUYER" | jq -c '.job | {status, escrow, failureReason, checks, output}'
# The publisher: the same job with the diagnostics.
curl -s $API/api/jobs/$JOB -H "authorization: Bearer $PUB" | jq '.job | {status, attempts, checkResults, text: .output.text}'
escrow $JOB
ledger $JOB
balances
```

```
{"id":"c502c935-4e5f-4576-869e-5bc1cced551f","slug":"scored-code-review","status":"draft"}
{"status":"active"}
buyer balance_cents=183750  publisher pending_payout_cents=8348 total_revenue_cents=19198
HTTP 201
{"id":"78e58119-8c6f-48b0-b865-09be206e1386","status":"funded","escrow":{"status":"held","amountCents":150}}
status after 2s: failed
{"status":"failed","escrow":{"status":"refunded","amountCents":150},"failureReason":"The deliverable did not pass the offering's checks, so it was not delivered. You have been refunded.","checks":[{"label":"A JSON object with a score","type":"json_schema","passed":false},{"label":"Does not repeat the publisher's private instructions","type":"confidentiality","passed":true}],"output":null}
{
  "status": "failed",
  "attempts": 1,
  "checkResults": [
    {
      "label": "A JSON object with a score",
      "type": "json_schema",
      "passed": false,
      "details": "Output is not valid JSON"
    },
    {
      "label": "Does not repeat the publisher's private instructions",
      "type": "confidentiality",
      "passed": true,
      "details": "No private instructions were found in the output"
    }
  ],
  "text": "The snippet creates an infinite loop that continuously executes a no‑operation, which will consume 100 % CPU and never terminate. Consider adding a proper exit condition or a pause (e.g., a sleep) to avoid unnecessary resource usage."
}
 type |  status  | gross | fee | creator | model_cost | settled 
------+----------+-------+-----+---------+------------+---------
 job  | refunded |   150 |  15 |     135 |          0 | f
(1 row)

          type          | amount_cents | balance_after |          description           
------------------------+--------------+---------------+--------------------------------
 marketplace_job        |         -150 |        183600 | Job escrow: Scored code review
 marketplace_job_refund |          150 |        183750 | Job refunded (failed)
(2 rows)

buyer balance_cents=183750  publisher pending_payout_cents=8348 total_revenue_cents=19198
```

The buyer is told which check failed and is shown no output; the publisher sees what the agent
wrote and why it was refused. Two ledger rows, a debit and a refund of the same amount, each
with its balance; the buyer is back at 183,750 and the publisher earned nothing. (`attempts`
counts how many times a worker claimed the job, not the retries of a failed check inside one
claim.)

Usage on the platform's model keys is metered on every job, including one that is refunded and
charged to nobody:

```bash
psql "$PROOF_DB" -c "select o.title, j.status, j.attempts as claims, j.platform_input_tokens, j.platform_output_tokens, j.model_cost_cents from jobs j join offerings o on o.id=j.offering_id order by j.created_at"
```

```
                   title                   |  status   | claims | platform_input_tokens | platform_output_tokens | model_cost_cents 
-------------------------------------------+-----------+--------+-----------------------+------------------------+------------------
 One-paragraph market brief                | completed |      1 |                   304 |                    784 |                1
 Code change review with a release summary | completed |      1 |                   652 |                    459 |                1
 Scored code review                        | failed    |      1 |                   524 |                    224 |                1
(3 rows)
```

---

## D. Rejected inside the review window: refunded

```bash
OFFER=$(jq -r .offering.id offering-agent.json)
balances
curl -s -o job-reject.json -w 'HTTP %{http_code}\n' $API/api/offerings/$OFFER/hire -H "authorization: Bearer $BUYER" \
  -H 'content-type: application/json' -d '{"input":{"topic":"Stablecoin settlement for AI agents"}}'
JOB=$(jq -r .job.id job-reject.json)
wait_job $BUYER $JOB
# The publisher cannot accept on the buyer's behalf.
curl -s -w '  HTTP %{http_code}\n' $API/api/jobs/$JOB/accept -H "authorization: Bearer $PUB" -H 'content-type: application/json' -d '{}'
# The buyer rejects inside the 72-hour review window.
curl -s -o reject.json -w 'HTTP %{http_code}\n' $API/api/jobs/$JOB/reject -H "authorization: Bearer $BUYER" \
  -H 'content-type: application/json' -d '{"reason":"Too generic: it does not mention settlement finality at all."}'
jq -c '{refundedCents, job: (.job | {status, escrow, rejectionReason})}' reject.json
# Accepting after that is refused: the money has already gone back.
curl -s -w '  HTTP %{http_code}\n' $API/api/jobs/$JOB/accept -H "authorization: Bearer $BUYER" -H 'content-type: application/json' -d '{}'
escrow $JOB
ledger $JOB
balances
```

```
buyer balance_cents=183750  publisher pending_payout_cents=8348 total_revenue_cents=19198
HTTP 201
status after 4s: submitted
{"error":"not_the_buyer","message":"Only the buyer of a job can do this"}  HTTP 403
HTTP 200
{"refundedCents":200,"job":{"status":"rejected","escrow":{"status":"refunded","amountCents":200},"rejectionReason":"Too generic: it does not mention settlement finality at all."}}
{"error":"job_state_conflict","message":"Only a submitted job can be completed"}  HTTP 409
 type |  status  | gross | fee | creator | model_cost | settled 
------+----------+-------+-----+---------+------------+---------
 job  | refunded |   200 |  20 |     180 |          0 | f
(1 row)

          type          | amount_cents | balance_after |              description               
------------------------+--------------+---------------+----------------------------------------
 marketplace_job        |         -200 |        183550 | Job escrow: One-paragraph market brief
 marketplace_job_refund |          200 |        183750 | Job refunded (rejected by buyer)
(2 rows)

buyer balance_cents=183750  publisher pending_payout_cents=8348 total_revenue_cents=19198
```

A third organization asking for this job is told it does not exist, and the rejection is
recorded as a dispute on the publisher. (These two commands were first run inside the script
above, where the `login` function was not defined, so the request went out with no token and
got `401`, and the query named a table that does not exist. They are shown as re-run.)

```bash
# A third organization (Atlas Agents) asking for the job is told it does not exist.
ATLAS=$(login hello@atlasagents.dev)
curl -s -w '  HTTP %{http_code}\n' $API/api/jobs/$JOB -H "authorization: Bearer $ATLAS"
psql "$PROOF_DB" -c "select dispute_count, dispute_resolved_count from publisher_profiles where org_id='91abb635-426c-4867-b1d9-888f2186bffc'"
```

```
{"error":"job_not_found","message":"Job not found"}  HTTP 404
 dispute_count | dispute_resolved_count 
---------------+------------------------
             1 |                      1
(1 row)
```

---

## E. API keys: no spend scope, and spend caps

```bash
OFFER=$(jq -r .offering.id offering-agent.json)
mk() { curl -s $API/api/auth/keys -H "authorization: Bearer $BUYER" -H 'content-type: application/json' -d "$1"; }
# Three keys in the buyer's organization: one with no scopes, one with "*", one that reads jobs.
K_NONE=$(mk '{"name":"proof no scopes"}' | jq -r .key)
K_STAR=$(mk '{"name":"proof star","scopes":["*"]}' | jq -r .key)
K_READ=$(mk '{"name":"proof read","scopes":["jobs:read"]}' | jq -r .key)
for K in "$K_NONE" "$K_STAR" "$K_READ"; do
  curl -s -w '  HTTP %{http_code}\n' $API/api/offerings/$OFFER/hire -H "authorization: Bearer $K" \
    -H 'content-type: application/json' -d '{"input":{"topic":"Should never be charged"}}'
done
# The read key can list jobs; that is all it was granted.
curl -s -w '  HTTP %{http_code}\n' "$API/api/jobs?limit=1" -H "authorization: Bearer $K_READ" | jq -c '{total: .pagination.total}' 2>/dev/null
# A key that asks for jobs:hire without caps is not created.
mk '{"name":"proof uncapped","scopes":["jobs:hire"]}' | jq -c '{error, message}'
# A spending key: at most $1.00 a job and $5.00 a day. The offering costs $2.00.
mk '{"name":"proof capped low","scopes":["jobs:hire","jobs:read"],"maxJobPriceCents":100,"dailySpendCapCents":500}' | tee key-low.json | jq -c '.apiKey | {scopes, maxJobPriceCents, dailySpendCapCents}'
curl -s -w '  HTTP %{http_code}\n' $API/api/offerings/$OFFER/hire -H "authorization: Bearer $(jq -r .key key-low.json)" \
  -H 'content-type: application/json' -d '{"input":{"topic":"Over the per-job cap"}}'
# A spending key that covers one $2.00 job a day but not two.
mk '{"name":"proof capped daily","scopes":["jobs:hire","jobs:read","jobs:review"],"maxJobPriceCents":200,"dailySpendCapCents":300}' | tee key-day.json | jq -c '.apiKey | {scopes, maxJobPriceCents, dailySpendCapCents}'
KD=$(jq -r .key key-day.json)
curl -s -o job-key.json -w 'first hire: HTTP %{http_code}\n' $API/api/offerings/$OFFER/hire -H "authorization: Bearer $KD" \
  -H 'content-type: application/json' -d '{"input":{"topic":"Hired by an API key"}}'
jq -c '.job | {id, status, escrow}' job-key.json
curl -s -w '  HTTP %{http_code}\n' $API/api/offerings/$OFFER/hire -H "authorization: Bearer $KD" \
  -H 'content-type: application/json' -d '{"input":{"topic":"Second hire the same day"}}'
JOB=$(jq -r .job.id job-key.json)
wait_job $KD $JOB
# The same key was granted jobs:review, so it can accept.
curl -s -w '  HTTP %{http_code}\n' $API/api/jobs/$JOB/accept -H "authorization: Bearer $KD" -H 'content-type: application/json' -d '{}' | jq -c 'if .job then .job | {status, escrow} else . end' 2>/dev/null
psql "$PROOF_DB" -c "select k.name, w.day, w.spent_cents from api_key_spend_windows w join api_keys k on k.id=w.api_key_id"
psql "$PROOF_DB" -c "select j.status, j.hired_by_user_id is null as no_user, k.name as hired_by_key from jobs j join api_keys k on k.id=j.hired_by_api_key_id"
balances
```

```
{"error":"missing_scope","message":"This API key does not have the \"jobs:hire\" scope.","scope":"jobs:hire"}  HTTP 403
{"error":"missing_scope","message":"This API key does not have the \"jobs:hire\" scope.","scope":"jobs:hire"}  HTTP 403
{"error":"missing_scope","message":"This API key does not have the \"jobs:hire\" scope.","scope":"jobs:hire"}  HTTP 403
{"total":4}
{"error":"spend_caps_required","message":"A key that can hire (jobs:hire) needs both spend caps: maxJobPriceCents (the most one job may cost) and dailySpendCapCents (the most it may spend in one UTC day)."}
{"scopes":["jobs:hire","jobs:read"],"maxJobPriceCents":100,"dailySpendCapCents":500}
{"error":"api_key_job_price_cap_exceeded","message":"This job costs more than this API key may spend on one job ($1.00).","priceCents":200,"maxJobPriceCents":100}  HTTP 403
{"scopes":["jobs:hire","jobs:read","jobs:review"],"maxJobPriceCents":200,"dailySpendCapCents":300}
first hire: HTTP 201
{"id":"66a610b7-a6cd-428d-bf7d-5238b67c9481","status":"funded","escrow":{"status":"held","amountCents":200}}
{"error":"api_key_daily_cap_exceeded","message":"This job would take this API key past what it may spend in one day ($3.00).","priceCents":200,"dailySpendCapCents":300}  HTTP 403
status after 2s: failed
{"error":"job_state_conflict","message":"Only a submitted job can be completed"}
        name        |    day     | spent_cents 
--------------------+------------+-------------
 proof capped daily | 2026-10-06 |         200
(1 row)

 status | no_user |    hired_by_key    
--------+---------+--------------------
 failed | t       | proof capped daily
(1 row)

buyer balance_cents=183750  publisher pending_payout_cents=8348 total_revenue_cents=19198
```

A key with no scopes, a key with `*` and a key with only `jobs:read` are all refused the hire
with `403 missing_scope`; none of the five refusals charged anything (the balance is unchanged
at the end). A key cannot be given `jobs:hire` without caps. The per-job cap and the daily cap
each refuse the hire that would break them. The accept at the end was refused because the job
it was aimed at had failed, which is section E1.

### E1. That job failed for a real reason, and was refunded

The capped key's first hire was funded and then **failed**: the model call itself failed. The
API log shows why: `TypeError: fetch failed … caused by: AggregateError [ETIMEDOUT]`, a
connection to Groq that timed out from this machine. This was not planned; it is recorded
because it is what happened, and it shows the failure path for a product that cannot run.

```bash
JOB=$(jq -r .job.id job-key.json)
# That job failed: the model call itself failed (the publisher's diagnostics say so), and the buyer was refunded.
curl -s $API/api/jobs/$JOB -H "authorization: Bearer $PUB" | jq -c '.job | {status, failureReason, checkResults}'
ledger $JOB
```

```
{"status":"failed","failureReason":"The product could not complete this job. You have been refunded.","checkResults":[{"label":"The product ran","type":"run","passed":false,"details":"the model call failed"}]}
          type          | amount_cents | balance_after |              description               
------------------------+--------------+---------------+----------------------------------------
 marketplace_job        |         -200 |        183550 | Job escrow: One-paragraph market brief
 marketplace_job_refund |          200 |        183750 | Job refunded (failed)
(2 rows)
```

The key's allowance for the day stays at 200 after the refund. That is deliberate: the cap
bounds what a key can commit in a day, so a leaked key cannot cycle hire and refund without
limit.

### E2. A key that was granted the scopes hires and accepts

```bash
# A second spending key hires again, and this time the run completes.
curl -s $API/api/auth/keys -H "authorization: Bearer $BUYER" -H 'content-type: application/json' \
  -d '{"name":"proof agent buyer","scopes":["jobs:hire","jobs:read","jobs:review"],"maxJobPriceCents":500,"dailySpendCapCents":1000}' > key-agent.json
KA=$(jq -r .key key-agent.json)
curl -s -o job-key2.json -w 'hire: HTTP %{http_code}\n' $API/api/offerings/$OFFER/hire -H "authorization: Bearer $KA" \
  -H 'content-type: application/json' -H 'Idempotency-Key: proof-key-2' -d '{"input":{"topic":"Hired by an API key"}}'
JOB2=$(jq -r .job.id job-key2.json)
wait_job $KA $JOB2
curl -s -w '  HTTP %{http_code}\n' $API/api/jobs/$JOB2/accept -H "authorization: Bearer $KA" -H 'content-type: application/json' -d '{"rating":5}' | jq -c 'if .job then .job | {status, escrow, rating} else . end' 2>/dev/null
ledger $JOB2
escrow $JOB2
psql "$PROOF_DB" -c "select k.name, w.day, w.spent_cents from api_key_spend_windows w join api_keys k on k.id=w.api_key_id order by k.name"
balances
```

```
hire: HTTP 201
status after 4s: submitted
{"status":"completed","escrow":{"status":"released","amountCents":200},"rating":5}
      type       | amount_cents | balance_after |              description               
-----------------+--------------+---------------+----------------------------------------
 marketplace_job |         -200 |        183550 | Job escrow: One-paragraph market brief
(1 row)

 type | status  | gross | fee | creator | model_cost | settled 
------+---------+-------+-----+---------+------------+---------
 job  | settled |   200 |  21 |     179 |          1 | t
(1 row)

        name        |    day     | spent_cents 
--------------------+------------+-------------
 proof agent buyer  | 2026-10-06 |         200
 proof capped daily | 2026-10-06 |         200
(2 rows)

buyer balance_cents=183550  publisher pending_payout_cents=8527 total_revenue_cents=19377
```

---

## F. Cancelled before it starts: refunded

Sections F and G need a job that no worker picks up. The honest way to get one is a worker
outage: the job-runner queue is paused, so hires are funded and queued and nothing takes them.

```ts
// jobs-proof-queue.ts: pauses or resumes the job-runner queue of this proof's Redis (index 7).
import { Queue } from "bullmq";
const q = new Queue("job-runner", { connection: { host: "localhost", port: 6380, db: 7 } });
const action = process.argv[2];
if (action === "pause") await q.pause();
if (action === "resume") await q.resume();
console.log(`job-runner queue paused: ${await q.isPaused()}; waiting entries: ${await q.getWaitingCount()}`);
await q.close();
```

```bash
# An offering that promises delivery in 5 minutes, the shortest a publisher may promise.
curl -s $API/api/offerings -H "authorization: Bearer $PUB" -H 'content-type: application/json' -d '{
  "productKind": "agent", "agentId": "32a6fb2b-4b65-490f-9f3d-e90609b55e9d",
  "title": "Five-minute headline", "description": "One headline for your topic, delivered within five minutes.",
  "priceCents": 50, "slaSeconds": 300,
  "inputSchema": { "type": "object", "required": ["topic"], "properties": { "topic": { "type": "string" } } }
}' | tee offering-fast.json | jq -c '.offering | {id, slug, priceCents, slaSeconds}'
OFFER=$(jq -r .offering.id offering-fast.json)
curl -s -X POST $API/api/offerings/$OFFER/activate -H "authorization: Bearer $PUB" | jq -c '.offering | {status}'
# The worker outage: nothing takes entries off the job-runner queue from here on.
(cd apps/api && npx tsx src/.scratch/jobs-proof-queue.ts pause)
balances
date -u +"now %H:%M:%SZ"
curl -s -o job-expire.json -w 'hire: HTTP %{http_code}\n' $API/api/offerings/$OFFER/hire -H "authorization: Bearer $BUYER" \
  -H 'content-type: application/json' -d '{"input":{"topic":"Will anyone pick this up?"}}'
jq -c '.job | {id, status, escrow, deadlineAt}' job-expire.json
# A second hire, cancelled by the buyer before anything starts it.
curl -s -o job-cancel.json -w 'hire: HTTP %{http_code}\n' $API/api/offerings/$OFFER/hire -H "authorization: Bearer $BUYER" \
  -H 'content-type: application/json' -d '{"input":{"topic":"Changed my mind"}}'
CJOB=$(jq -r .job.id job-cancel.json)
curl -s $API/api/jobs/$CJOB/cancel -H "authorization: Bearer $BUYER" -H 'content-type: application/json' -d '{"reason":"No longer needed"}' \
  | jq -c '{refundedCents, job: (.job | {status, escrow, failureReason})}'
ledger $CJOB
balances
```

```
{"id":"6ed65a12-2d03-41a3-a12f-59c14415604d","slug":"five-minute-headline","priceCents":50,"slaSeconds":300}
{"status":"active"}
job-runner queue paused: true; waiting entries: 0
buyer balance_cents=183550  publisher pending_payout_cents=8527 total_revenue_cents=19377
now 11:53:49Z
hire: HTTP 201
{"id":"e963f932-340a-4beb-8235-3dd382fe0bb9","status":"funded","escrow":{"status":"held","amountCents":50},"deadlineAt":"2026-10-06T11:58:49.487Z"}
hire: HTTP 201
{"refundedCents":50,"job":{"status":"cancelled","escrow":{"status":"refunded","amountCents":50},"failureReason":"No longer needed"}}
          type          | amount_cents | balance_after |           description            
------------------------+--------------+---------------+----------------------------------
 marketplace_job        |          -50 |        183450 | Job escrow: Five-minute headline
 marketplace_job_refund |           50 |        183500 | Job refunded (cancelled)
(2 rows)

buyer balance_cents=183500  publisher pending_payout_cents=8527 total_revenue_cents=19377
```

The second hire was cancelled and refunded. The first one (`e963f932…`) was meant to be the job
that expires, but the queue was resumed too early, at 11:55:08, well before its 11:58:49
deadline; a worker simply ran it and it was submitted. It was left as it is, a submitted job
with 50 cents held in escrow, and shows up as such in the closing totals. On resume, the
cancelled job's queue entry was taken and skipped (`"status": "skipped", "reason":
"not_runnable"` in the API log). Section G is the second, correct attempt at the expiry.

---

## G. Expired: not delivered within the promised time, refunded

```bash
OFFER=$(jq -r .offering.id offering-fast.json)
(cd apps/api && npx tsx src/.scratch/jobs-proof-queue.ts pause)
balances
date -u +"now %H:%M:%SZ"
curl -s -o job-expire2.json -w 'hire: HTTP %{http_code}\n' $API/api/offerings/$OFFER/hire -H "authorization: Bearer $BUYER" \
  -H 'content-type: application/json' -d '{"input":{"topic":"Nobody is working today"}}'
jq -c '.job | {id, status, escrow, deadlineAt}' job-expire2.json
```

```
job-runner queue paused: true; waiting entries: 0
buyer balance_cents=183500  publisher pending_payout_cents=8527 total_revenue_cents=19377
now 11:55:27Z
hire: HTTP 201
{"id":"2cbf5fd4-142a-4ce4-9c8b-6e79e1946ad8","status":"funded","escrow":{"status":"held","amountCents":50},"deadlineAt":"2026-10-06T12:00:27.445Z"}
```

Then nothing was done to the job. The script below waited for the real deadline to pass:

```bash
JOB=$(jq -r .job.id job-expire2.json)
# Wait for the promised delivery time to pass, plus two sweeper ticks.
until [ "$(date -u +%s)" -gt "$(( $(date -u -d "$(jq -r .job.deadlineAt job-expire2.json)" +%s) + 35 ))" ]; do sleep 5; done
date -u +"now %H:%M:%SZ"
curl -s $API/api/jobs/$JOB -H "authorization: Bearer $BUYER" | jq -c '.job | {status, escrow, deadlineAt, startedAt, failureReason, output}'
escrow $JOB
ledger $JOB
balances
# The outage ends. The worker takes the queued entry, finds the job already expired and leaves it alone.
(cd apps/api && npx tsx src/.scratch/jobs-proof-queue.ts resume)
sleep 6
psql "$PROOF_DB" -c "select status, attempts as claims, started_at is null as never_started from jobs where id='$JOB'"
ledger $JOB
```

```
now 12:01:03Z
{"status":"expired","escrow":{"status":"refunded","amountCents":50},"deadlineAt":"2026-10-06T12:00:27.445Z","startedAt":null,"failureReason":"The job was not delivered within the promised time. You have been refunded.","output":null}
 type |  status  | gross | fee | creator | model_cost | settled 
------+----------+-------+-----+---------+------------+---------
 job  | refunded |    50 |   5 |      45 |          0 | f
(1 row)

          type          | amount_cents | balance_after |           description            
------------------------+--------------+---------------+----------------------------------
 marketplace_job        |          -50 |        183450 | Job escrow: Five-minute headline
 marketplace_job_refund |           50 |        183500 | Job refunded (expired)
(2 rows)

buyer balance_cents=183500  publisher pending_payout_cents=8527 total_revenue_cents=19377
job-runner queue paused: false; waiting entries: 0
 status  | claims | never_started 
---------+--------+---------------
 expired |      0 | t
(1 row)

          type          | amount_cents | balance_after |           description            
------------------------+--------------+---------------+----------------------------------
 marketplace_job        |          -50 |        183450 | Job escrow: Five-minute headline
 marketplace_job_refund |           50 |        183500 | Job refunded (expired)
(2 rows)
```

Five minutes after the hire the sweeper expired the job and refunded the buyer. When the queue
came back, the worker took the stale entry and left the expired job alone: zero claims, never
started, and still exactly one refund row.

---

## H. Closing totals

Taken after sections A to G and before the browser checks in section I.

```bash
# Every job of this run, as the database holds it.
psql "$PROOF_DB" -c "select o.title, j.status, j.price_cents price, r.status escrow, r.platform_fee_cents fee, r.creator_amount_cents creator, r.model_cost_cents model, j.rating from jobs j join offerings o on o.id=j.offering_id join marketplace_revenue r on r.job_id=j.id order by j.created_at"
# Every credit of the buyer moved by a job nets to the prices still out: the settled jobs and the one held.
psql "$PROOF_DB" -c "select count(*) ledger_rows, sum(t.amount_cents) net_cents from credit_transactions t where t.type in ('marketplace_job','marketplace_job_refund') and t.org_id='ad698f19-bf63-4d1e-9402-fd6c51636a66'"
psql "$PROOF_DB" -c "select r.status, count(*), sum(r.gross_amount_cents) gross, sum(r.platform_fee_cents) fee, sum(r.creator_amount_cents) creator from marketplace_revenue r where r.type='job' group by r.status order by r.status"
balances
curl -s $API/api/jobs/summary -H "authorization: Bearer $BUYER" | jq -c .
curl -s $API/api/jobs/summary -H "authorization: Bearer $PUB" | jq -c .
curl -s $API/api/offerings/one-paragraph-market-brief | jq -c '.offering.trackRecord'
curl -s $API/api/marketplace/revenue -H "authorization: Bearer $PUB" | jq -c '{pendingPayoutCents, heldInEscrow, unlistedJobRevenue}'
```

```
                   title                   |  status   | price |  escrow  | fee | creator | model | rating 
-------------------------------------------+-----------+-------+----------+-----+---------+-------+--------
 One-paragraph market brief                | completed |   200 | settled  |  21 |     179 |     1 |      5
 Code change review with a release summary | completed |   300 | settled  |  31 |     269 |     1 |      4
 Scored code review                        | failed    |   150 | refunded |  15 |     135 |     0 |       
 One-paragraph market brief                | rejected  |   200 | refunded |  20 |     180 |     0 |       
 One-paragraph market brief                | failed    |   200 | refunded |  20 |     180 |     0 |       
 One-paragraph market brief                | completed |   200 | settled  |  21 |     179 |     1 |      5
 Five-minute headline                      | submitted |    50 | pending  |   5 |      45 |     0 |       
 Five-minute headline                      | cancelled |    50 | refunded |   5 |      45 |     0 |       
 Five-minute headline                      | expired   |    50 | refunded |   5 |      45 |     0 |       
(9 rows)

 ledger_rows | net_cents 
-------------+-----------
          14 |      -750
(1 row)

  status  | count | gross | fee | creator 
----------+-------+-------+-----+---------
 pending  |     1 |    50 |   5 |      45
 refunded |     5 |   650 |  65 |     585
 settled  |     3 |   700 |  73 |     627
(3 rows)

buyer balance_cents=183500  publisher pending_payout_cents=8527 total_revenue_cents=19377
{"awaitingReview":1,"inProgress":0,"toDeliver":0}
{"awaitingReview":0,"inProgress":0,"toDeliver":0}
{"completed":2,"rejected":1,"failed":1,"expired":0,"cancelled":0,"successRate":0.5,"avgRating":5,"ratingCount":2,"medianTurnaroundSeconds":3}
{"pendingPayoutCents":8527,"heldInEscrow":{"creatorAmountCents":45,"jobs":1},"unlistedJobRevenue":{"totalRevenueCents":269,"jobs":1}}
```

The books close:

- **Buyer.** Nine hires and five refunds are 14 ledger rows netting to −750 cents: the three
  settled jobs (700) plus the one still held in escrow (50). 184,250 − 750 = 183,500, the
  balance.
- **Publisher.** The three settled rows pay 179 + 269 + 179 = 627 cents; 7,900 + 627 = 8,527,
  the pending payout balance. The 45 cents of the held job is reported as held, not earned.
- **Every row.** Fee + creator = gross on each of the nine rows. A settled row carries its one
  cent of model cost inside the fee. The five refunded rows paid nobody.

---

## I. The pages, in a browser

The web app was started against the same API (`NEXT_PUBLIC_API_URL=http://localhost:4240 npx
next dev -p 3240`) and driven with headless Chromium through
`apps/web/e2e/jobs.spec.ts`:

```bash
NEXT_PUBLIC_API_URL=http://localhost:4240 E2E_DEMO_PASSWORD=$DEMO_PASSWORD playwright test -c pw.config.cjs jobs.spec.ts
```

```
Running 5 tests using 1 worker
  ✓  1 [chromium] › e2e/jobs.spec.ts:116:7 › Offerings and jobs › a signed-out visitor sees the offering, its escrow terms and no private instructions (3.1s)
  ✓  2 [chromium] › e2e/jobs.spec.ts:130:7 › Offerings and jobs › the marketplace filters by product type (1.8s)
  ✓  3 [chromium] › e2e/jobs.spec.ts:144:9 › Offerings and jobs › a buyer hires through the schema form, reviews and accepts (dark) (16.8s)
  ✓  4 [chromium] › e2e/jobs.spec.ts:144:9 › Offerings and jobs › a buyer hires through the schema form, reviews and accepts (light) (10.6s)
  ✓  5 [chromium] › e2e/jobs.spec.ts:188:7 › Offerings and jobs › the publisher sees the job, what it earned and no way to accept it (9.9s)
  5 passed (45.4s)
```

(`pw.config.cjs` was a throwaway config pointing the suite at port 3240; the repository's own
config expects port 3000.) The spec publishes an offering as Kestrel Labs, then, as Northwind's
owner in the browser: is stopped by an empty required field before anything is sent, fills the
form from the sample, confirms the escrow dialog, lands on the job page, waits for the
deliverable, rates it and accepts it. In an earlier pass, the light-theme run did not actually
switch the app's theme (fixed in the spec, then re-run and passed, screenshots checked in both
themes), and two runs of the hire test failed because the job itself failed on the same Groq
connection timeout as E1; the page showed the failure and the refund, which is the correct
behaviour, and the test passed when the connection held.

A separate scripted pass visited the browse page (Agents, Workflows, Models), the public
offering page signed out and for a slug that does not exist, the publisher's offerings list and
editor, the new-offering form's validation, the jobs inbox, the publisher's job page, the
revenue page with its escrow card, and the API keys page (scope picker and caps, refusing a
per-job cap above the daily cap). It recorded no console errors, no page errors and no failed
API calls other than the expected `401` of the signed-out session probe and the `404` of the
missing offering.

---

## J. What this run did not show

- **A model offering end to end.** A model job calls a running model deployment, which needs a
  GPU deployment on Nosana. None is available locally, and this run never submits one. Creating
  and activating a model offering, the refusal when its deployment is not running, and the model
  runner's binding are covered by `offerings.unit.test.ts` and
  `buildJobRunnerDeps.unit.test.ts`; a paid model job has not been run for real.
- **Auto-completion after 72 hours.** The run did not wait three days. The sweeper's
  review-window branch is covered by `runJobSweepTick.unit.test.ts` with an injected clock; the
  submitted job left over from section F would be the live case.
- **Parallel hires against a balance that covers one fewer.** Covered by
  `jobEscrow.unit.test.ts` and by step 2's run against a migrated database copy, not repeated
  here.
- **A leak attempt.** No buyer input tried to extract the private instructions. The
  confidentiality check ran on every deliverable here and passed; its refusal is unit-tested in
  `assertions.unit.test.ts` and `jobPrompt.unit.test.ts`.
- **A non-owner member being refused.** The seeded admin and member users of Northwind could not
  sign in on this copy (`User has no organization`, a seed defect outside this feature), so the
  owner-or-admin rule for dashboard hires is shown only by its unit test (`jobRoutes.unit.test.ts`).
- **Webhook deliveries.** No endpoint was subscribed to `job.*` in this run. The "deliverable
  ready" email went to the development `log` transport, which the API log shows
  (`Email (log transport) … subject: "Deliverable ready: One-paragraph market brief"`); no email
  provider is configured, so nothing was actually sent.
- **The dev database.** It was not migrated; this ran on a copy that has been dropped.

One thing the run showed that was not planned: two of the jobs in sections E and I failed on a
connection timeout to the model provider and were refunded. A product run that throws fails the
job at once, with no retry (only a deliverable that fails its checks is retried). That is in
`docs/HARDENING-BACKLOG.md` under "Offerings and jobs".

## Shutdown

```bash
kill 1791479              # next dev on 3240
kill -TERM 1737023        # the tsx process listening on 4240
sleep 6; ss -ltnp | grep -E ":(4240|3240)\b" || echo "ports 4240 and 3240 are free"
```

```
ports 4240 and 3240 are free
```

```bash
psql postgresql://wheelsai:…@localhost:5434/postgres -c "DROP DATABASE wheelsai_jobsproof"
redis-cli -p 6380 -n 7 flushdb
rm apps/api/src/.scratch/jobs-proof-queue.ts
# The dev database, untouched: no new column, no jobs, the buyer's starting balance.
psql postgresql://wheelsai:…@localhost:5434/wheelsai -Atc "select count(*) from information_schema.columns where table_name='jobs' and column_name='model_cost_cents'; select count(*) from jobs; select balance_cents from credit_balances where org_id='ad698f19-bf63-4d1e-9402-fd6c51636a66'"
```

```
DROP DATABASE
OK
0
0
184250
```
