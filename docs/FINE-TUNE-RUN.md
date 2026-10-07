# Fine-tuning — what is proven, and the first paid run

**Date:** 2026-10-07 · **Branch:** `feat/bags-launchpad` (working tree on top of `5dcbf15`)
**Migration:** `20261012100000_fine_tuning`

A fine-tuning job takes a validated dataset and a base model, runs the training container on a
Nosana GPU node, and ends as a fine-tuned model the organization owns and can deploy. This
document has three parts:

1. **What was proven on this machine**, with the command and its output.
2. **The checklist for the first paid run**, with a results table and two receipts to fill in.
3. **What stays unverified until that run.** Between parts 2 and 3 is a section of what the
   read-only verification of 2026-10-07 settled, with its evidence.

**Nothing in part 1 ran on Nosana or on a GPU, and nothing was spent.** Part 1 ran the real
service code (the API with its routes, its Nosana client, the BullMQ poller, the ledger, the
object store) against a stand-in Nosana API on 127.0.0.1 whose "node" started the real training
entrypoint as a local CPU process.

**The model that was trained is a substitute.** Every job in part 1 names the catalog model
`phi-3-mini` (`microsoft/Phi-3-mini-4k-instruct`), and that is what the job definition carries.
The stand-in node replaced `BASE_MODEL` with `HuggingFaceTB/SmolLM2-135M-Instruct`, a
135M-parameter model cached on this machine, and trained it on CPU. That proves the **pipeline**:
what is sent, stored, billed, refused and registered. It proves nothing about the catalog model,
the GPU path (QLoRA, CUDA, memory), the training image, or how Nosana behaves. The fine-tuned
model rows created here say `phi-3-mini` and hold an adapter for SmolLM2; they lived in a
database copy that was dropped. Part 3 lists what this leaves open.

---

## 1. What was proven on this machine

> **Note, 2026-10-07 (after everything recorded in this part).** Our Nosana code was checked
> against Nosana's current API with read-only requests, and the stand-in this part ran against
> was re-based on the live response shapes the same day (`docs/NOSANA-DEPLOY-RUN.md`, the note
> at the top of its part 1). **The transcript and the counts below predate that** and are left
> as recorded. Three things in them do not hold against Nosana: the definition in C carries
> `required_vram: 24`, which Nosana's strict validator refuses with a 400 (the field is no longer
> sent); the node of 1.2 reported the job inside the deployment, while Nosana serves jobs from
> `GET /deployments/{id}/jobs`, so the "callbacks blocked" path of K worked here and would not
> have worked there before the fix; and the one-page name lookup noted at the end of 1.6 is
> replaced by a paginated read with the exact `?name=` filter. Re-run the proof script against
> the re-based stand-in before quoting this transcript as current.

### 1.1 Unit tests

```
$ npm run -s test:unit -w @wheelsai/api          (from the repository root, after the last edit)
# tests 4671
# pass 4671
# fail 0
# skipped 0
```

The suites of this build, and what each file shows:

| File (`apps/api/src/tests/`) | Tests | What it shows |
|---|---|---|
| `trainingStateMachine.unit.test.ts` | 118 | Every allowed and refused transition; who pays, one test per row; the parser of trainer events against the trainer's real lines. |
| `trainingJobDefinition.unit.test.ts` | 26 | The job definition and its 13 or 14 variables; every value checked against a strict pattern; hyperparameter bounds; Nosana's own validator accepts it. |
| `trainingBilling.unit.test.ts` | 29 | The hold, billable time, the charge and its cap; reserve and settle against a ledger double, including rollback and two writers. |
| `trainingCatalog.unit.test.ts`, `trainingConfig.unit.test.ts` | 24, 10 | The catalog, tier selection and its refusals, the estimate; configuration and the time rules. |
| `trainingJobs.unit.test.ts` | 83 | The job service: the refusal order with no row and no ledger entry, each billing class end to end, lost deployments, cancel in every state, callbacks racing the poller with one settlement, a job read from logs. Three of these were added by this step (1.4). |
| `trainingRoutes.unit.test.ts`, `runTrainingPollerTick.unit.test.ts` | 7, 5 | The routes over Fastify; the poller tick. |
| `trainingNosanaClient.unit.test.ts`, `trainingNosanaAccess.unit.test.ts` | 6, 7 | The real Nosana client against the stand-in for submit, status, stop and lookup by name; the access mode stored with the id. |
| `trainingWebhookAuth.unit.test.ts` | 6 | The callback signature: derivation, window, constant-time check. |
| `fineTunedModels.unit.test.ts`, `fineTunedDeployment.unit.test.ts` | 19, 14 | The model routes, the adapter download grant and every refusal; deploying and restarting a fine-tuned model with nothing reserved on a refusal. |
| `vllmLoraJobDefinition.unit.test.ts`, `servedModelName.unit.test.ts` | 14, 2 | The vLLM definition with an adapter and its bootstrap run against hostile archives; the name sent to the engine. |

### 1.2 The arrangement of the end-to-end run

One command starts everything, drives it and cleans up:

```
cd apps/api
DEMO_PASSWORD=<the seeded demo owner's password> npx tsx scripts/run-fine-tune-local-proof.ts
```

| | |
|---|---|
| API | `apps/api/src/index.ts` under `tsx`, a child process on **127.0.0.1:4360**, started from a directory with no `.env`. Unmodified: the production route plugins, `buildTrainingDeps`, the real `NosanaClient`. |
| Database | a **disposable copy** of the local database (`CREATE DATABASE wheelsai_ftproof TEMPLATE wheelsai`), every migration applied with `prisma migrate deploy`, dropped at the end. The main database was not migrated or written. |
| Redis | `localhost:6380`, index **13**, flushed at the end. The **real training poller** (BullMQ, `TRAINING_POLL_INTERVAL_MS=2000`) is the only worker on; every other interval is 0. |
| Object store | the development-only local driver (`STORAGE_DRIVER=local`) in a temporary directory. Transfer URLs go through `/api/storage/t/<token>` on the API. |
| Nosana | `apps/api/src/tests/fakeNosanaApi.ts` on **127.0.0.1:4361**, reached by the real `@nosana/sdk` with a key made up for the run (`NOSANA_ACCESS_MODE=api_key`). `SOLANA_RPC_URL` points at a server on 4362 that answers 500 and counts requests. |
| The node | `apps/api/scripts/fineTuneLocalNode.ts`, in the same process as the stand-in. When a deployment named `wheelsai-train-*` is started it waits 5 s (the queue), then runs `~/.cache/wheelsai/trainer-venv/bin/python infra/training/train.py --device cpu` with **the environment of the submitted job definition**, the Hub switched off, and `BASE_MODEL` replaced as said above. It reports the job as the poller expects to read it: `state`, `timeStart` and `timeEnd` in unix seconds, and after the process has exited `jobResult.opStates[0]` with the exit code and every printed line. A stop request sends the process SIGTERM. |
| Callbacks | `PUBLIC_API_URL=http://127.0.0.1:4360`: the trainer posts its signed events to the running API's real callback route over loopback. |
| Sign-in | the seeded demo owner (`demo@northwind.ai`), through `POST /api/auth/login`. |
| Settings changed from their defaults | `TRAINING_QUEUE_TIMEOUT_SECONDS=60` (default 1800), `TRAINING_POLL_INTERVAL_MS=2000` (default 15000), `TRAINING_IMAGE` set to a digest-shaped placeholder (the image is never pulled here). The run limit of every job is 300 s, the minimum. |

What the node's choices mean: the shape of a job result, the unit of the time fields, when logs
become readable and which signal a host sends are **this file's assumptions**, taken from the
SDK's types. The run shows our code handles a Nosana that behaves that way.

The transcript below is the script's own output from one run, 121 checks, all passing.
Tokens, signatures, the session and every secret are masked by the script. Long lines are cut
where marked, and runs of per-step progress lines are shortened where marked; nothing else is
edited. Amounts are US cents. The tier is the 4090: $0.00025 a second, so the hold for a
300-second run limit is 7.5 cents, rounded up to 8.

```
CREATE DATABASE wheelsai_ftproof TEMPLATE wheelsai
$ DATABASE_URL=<copy> npx prisma migrate deploy   (packages/db)
  Applying migration `20261012100000_fine_tuning`
  The following migration(s) have been applied:
  migrations/
    └─ 20261012100000_fine_tuning/
      └─ migration.sql
  All migrations have been successfully applied.
stand-in Nosana API and node listening on 127.0.0.1:4361; Solana RPC stand-in (answers 500, counts) on http://127.0.0.1:4362
[08:23:39] API started on http://127.0.0.1:4360 (full configuration)
  api log: [08:23:38] INFO: Training poller BullMQ queue started
[08:23:39] POST /api/auth/login {"email":"demo@northwind.ai","password":"<DEMO_PASSWORD>"} -> HTTP 200, session cookie kept
organization ad698f19-bf63-4d1e-9402-fd6c51636a66: training jobs 1 | ledger rows 63 | balance 184150
```

### 1.3 The run

#### A. Dataset: upload through a signed transfer URL, then validation

```
file: infra/training/fixtures/tiny.jsonl, 5740 bytes, sha256 bb3c05680ce11393bf694065a1391ba6028fe2f51c8042985685ea359aef6cb3
[08:23:39] POST /api/training/datasets {"name":"proof-tiny","fileName":"tiny.jsonl","sizeBytes":5740,"fileType":"jsonl"}
  -> HTTP 201 {"dataset":{"id":"dd066e6d-8c63-492a-889f-fe81b4957496","name":"proof-tiny","fileType":"jsonl"},"upload":{"url":"http://127.0.0.1:4360/api/storage/t/<token>","method":"PUT","headers":{"Content-Type":"application/octet-stream"},"expiresAt":"2026-10-07T09:23:39.263Z","maxBytes":5740},"message":"Upload your dataset using the provided URL, then call POST /datasets/:id/validate"}
[08:23:39] PUT http://127.0.0.1:4360/api/storage/t/<token>   (5740 bytes, headers {"Content-Type":"application/octet-stream"})
  -> HTTP 200 {"stored":true,"size":5740}
[08:23:39] POST /api/training/datasets/dd066e6d-8c63-492a-889f-fe81b4957496/validate
  -> HTTP 200 {"validation":{"isValid":true,"format":"jsonl","fileType":"jsonl","schemaFormat":"alpaca","detectedFormat":"alpaca","rowCount":40,"sizeBytes":5740,"errors":[],"errorCount":0,"warnings":[]},"stats":{"totalTokens":1030,"avgTokensPerRow":26,"minTokens":20,"maxTokens":32},"sampleRows":[{"instruction":"Give the adjective for the animal, in WheelsAI report style.","input":"cat","output":"REPORT 01: the adjective for cat is feline. END OF REPORT."},{"instruction":"Give the adjective for the animal, in WheelsAI report style.","input":"dog","output":"REPORT 02: the adjective for dog is canine. END OF REPORT."},{"instruction":"Give the adjective for the animal, in WheelsAI report style.","input":"cow"... (1106 characters)
  row: is_validated true | file_type jsonl | schema_format alpaca | row_count 40 | row_count_known true | avg_tokens_per_row 26 | total_tokens 1030 | content_sha256 bb3c05680ce11393bf694065a1391ba6028fe2f51c8042985685ea359aef6cb3
  ok   the stored content hash is the hash of the file that was sent
  a 5740-byte PUT to a URL issued for 10 bytes -> HTTP 413 {"error":"object_too_large","message":"Upload is larger than the 10 bytes this link allows.","maxBytes":10}
  ok   an upload of another size than the URL was issued for is refused
```

What that shows: the upload link is issued for the declared size and refuses another; validation
reads the stored bytes and records their sha256, which is what a job is later pinned to.

#### B. What this server can do, and the estimate

```
[08:23:39] GET /api/training/capabilities -> HTTP 200
  canStart true | blockers [] | storage {"configured":true,"driver":"local","maxDatasetBytes":209715200,"maxDatasetRows":200000}
  image {"configured":true} | callbacks {"configured":true} | poller {"enabled":true} | gatedModels {"available":false}
  runLimit {"minSeconds":300,"maxSeconds":20700,"setupAllowanceSeconds":900,"queueTimeoutSeconds":60} | limits {"maxActiveJobs":2,"adapterMaxBytes":2147483648} | methods ["lora","qlora"]
  tiers 3060:8GB:$0.0001/s:deployable 4070:12GB:$0.00015/s:deployable 4090:24GB:$0.00025/s:deployable a100:40GB:$0.0008/s:deployable h100:80GB:$0.0015/s:deployable
  ok   the server reports that a job can start
[08:23:39] GET /api/training/models -> HTTP 200
  phi-3-mini (microsoft/Phi-3-mini-4k-instruct) gated false available true methods lora>=24GB,qlora>=12GB basis planning
  qwen2-7b (Qwen/Qwen2-7B-Instruct) gated false available true methods lora>=40GB,qlora>=24GB basis planning
  llama-3.2-3b (meta-llama/Llama-3.2-3B-Instruct) gated true available false (hf_token_required) methods lora>=24GB,qlora>=12GB basis planning
  llama-3.1-8b (meta-llama/Meta-Llama-3.1-8B-Instruct) gated true available false (hf_token_required) methods lora>=40GB,qlora>=24GB basis planning
  mistral-7b (mistralai/Mistral-7B-Instruct-v0.2) gated true available false (hf_token_required) methods lora>=40GB,qlora>=24GB basis planning
  llama-3.1-70b (meta-llama/Meta-Llama-3.1-70B-Instruct) gated true available false (hf_token_required) methods qlora>=80GB basis planning
[08:23:39] POST /api/training/estimate {"baseModelId":"phi-3-mini","datasetId":"dd066e6d-8c63-492a-889f-fe81b4957496","method":"lora","gpuTier":"4090","hyperparams":{"epochs":3,"batchSize":4,"gradientAccumulationSteps":1,"learningRate":0.001,"maxSeqLength":128,"evalSplit":0.1}}
  -> HTTP 200 {"estimate":{"basis":"planning","trainTokens":3120,"steps":30,"seconds":{"imagePull":240,"setup":185,"train":1,"wrapUp":60,"trainer":246,"total":486},"estimate":{"seconds":486,"cents":13},"low":{"seconds":292,"cents":8},"high":{"seconds":778,"cents":20},"pricePerSecondUsd":0.00025,"runLimit":{"minSeconds":300,"maxSeconds":20700,"suggestedSeconds":900,"appliedSeconds":900},"maximumCents":23,"fitsRunLimit":true,"suggestionCapped":false,"gpuTier":"4090","recommendedGpuTier":"4090"},"dataset":{"id":"dd066e6d-8c63-492a-889f-fe81b4957496","rowCount":40,"avgTokensPerRow":26}}
[08:23:39] POST /api/training/estimate {"baseModelId":"phi-3-mini","datasetId":"dd066e6d-8c63-492a-889f-fe81b4957496","method":"full","gpuTier":"4090"}
  -> HTTP 400 {"error":"unsupported_method","message":"Only LoRA and QLoRA fine-tuning are offered"}
[08:23:39] POST /api/training/estimate {"baseModelId":"phi-3-mini","datasetId":"dd066e6d-8c63-492a-889f-fe81b4957496","method":"lora","gpuTier":"3060"}
  -> HTTP 400 {"error":"tier_too_small","message":"phi-3-mini with lora needs 24 GB of GPU memory; '3060' has 8 GB","requiredVramGb":24}
[08:23:39] POST /api/training/estimate {"baseModelId":"llama-3.1-8b","datasetId":"dd066e6d-8c63-492a-889f-fe81b4957496","method":"lora","gpuTier":"a100"}
  -> HTTP 400 {"error":"hf_token_required","message":"llama-3.1-8b needs a Hugging Face token, which this server does not have"}
```

The estimate is a planning figure and says so (`"basis":"planning"`): 240 s to pull the image,
185 s of set-up and 60 s to wrap up are constants, and "train: 1" second comes from a throughput
formula, not a measurement. `full`, a tier that is too small and a gated model without a token
are refused by name.

#### C. A job from creation to a registered model: hold, live progress, settlement

```
The job names phi-3-mini; the stand-in node loads HuggingFaceTB/SmolLM2-135M-Instruct in its place, on CPU.
[08:23:39] POST /api/training/jobs {"name":"Proof report style","baseModelId":"phi-3-mini","datasetId":"dd066e6d-8c63-492a-889f-fe81b4957496","method":"lora","gpuTier":"4090","maxRuntimeSeconds":300,"hyperparams":{"epochs":3,"batchSize":4,"gradientAccumulationSteps":1,"learningRate":0.001,"maxSeqLength":128,"evalSplit":0.1}}
  -> HTTP 201 {"job":{"id":"33bb92f5-3f92-4e43-ad9f-06960ad6763f","name":"Proof report style","status":"pending"},"reservation":{"cents":8,"maxRuntimeSeconds":300,"pricePerSecondUsd":0.00025},"estimate":{"basis":"planning","trainTokens":3120,"steps":30,"seconds":{"imagePull":240,"setup":185,"train":1,"wrapUp":60,"trainer":246,"total":486},"estimate":{"seconds":300,"cents":8},"low":{"seconds":292,"cents":8},"high":{"seconds":300,"cents":8},"pricePerSecondUsd":0.00025,"runLimit":{"minSeconds":300,"maxSeconds":20700,"suggestedSeconds":900,"appliedSeconds":300},"maximumCents":8,"fitsRunLimit":false,"suggestionCapped":false},"message":"Training job created. It is being submitted to the GPU network."}
  balance 184150 -> 184142 cents
  ledger rows with reference 33bb92f5-3f92-4e43-ad9f-06960ad6763f (time | amount cents | type | balance after | description):
    08:23:39.469 | -8 | training_reservation | 184142 | Fine-tuning hold (4090, run limit 300s)
  [08:23:39] status submitting | progress 0% | step -/- | phase - | loss - | eval - | cost so far - | charged -
  [08:23:40] status queued | progress 0% | step -/- | phase - | loss - | eval - | cost so far - | charged -
  [08:23:44] [node] wheelsai-train-33bb92f5-3f92-4e43-ad9f-06960ad6763f-2873664644516d49: a node took the job; trainer started (replaced or removed: BASE_MODEL)
  [08:23:45] status running | progress 0% | step -/- | phase load_model | loss - | eval - | cost so far 1 | charged -
  [08:23:47] status running | progress 0% | step -/- | phase train | loss - | eval - | cost so far 1 | charged -
  [08:23:48] status running | progress 3% | step 1/27 | phase train | loss 2.77095 | eval - | cost so far 1 | charged -
  [08:23:58] status running | progress 3% | step 1/27 | phase train | loss 2.77095 | eval 0.399689 | cost so far 1 | charged -
  [08:24:00] status running | progress 37% | step 10/27 | phase train | loss 0.420555 | eval 0.399689 | cost so far 1 | charged -
  [08:24:10] status running | progress 37% | step 10/27 | phase train | loss 0.420555 | eval 0.347226 | cost so far 1 | charged -
  [08:24:11] status running | progress 70% | step 19/27 | phase train | loss 0.179 | eval 0.347226 | cost so far 1 | charged -
  [08:24:20] status running | progress 99% | step 27/27 | phase train | loss 0.173087 | eval 0.347226 | cost so far 1 | charged -
  [08:24:21] status running | progress 99% | step 27/27 | phase upload | loss 0.173087 | eval 0.315895 | cost so far 1 | charged -
  [08:24:22] [node] wheelsai-train-33bb92f5-3f92-4e43-ad9f-06960ad6763f-2873664644516d49: stop requested; SIGTERM sent to the trainer
  [08:24:22] status completed | progress 100% | step 27/27 | phase upload | loss 0.182407 | eval 0.315895 | cost so far - | charged 1
  what the stand-in Nosana API received for this job:
    op container/run "train", image registry.invalid/wheelsai/trainer@sha256:0000000000000000000000000000000000000000000000000000000000000000, gpu true, required_vram 24, cmd null
    environment names (13): ADAPTER_UPLOAD_URL, BASE_MODEL, CALLBACK_SECRET, CALLBACK_URL, DATASET_FILE_TYPE, DATASET_FORMAT, DATASET_SHA256, DATASET_URL, HYPERPARAMS, JOB_ID, MAX_RUNTIME_SECONDS, METHOD, METRICS_UPLOAD_URL
    BASE_MODEL microsoft/Phi-3-mini-4k-instruct | METHOD lora | DATASET_SHA256 bb3c05680ce11393bf694065a1391ba6028fe2f51c8042985685ea359aef6cb3 | MAX_RUNTIME_SECONDS 300
    HYPERPARAMS {"epochs":3,"batchSize":4,"evalSplit":0.1,"learningRate":0.001,"maxSeqLength":128,"gradientAccumulationSteps":1}
    DATASET_URL http://127.0.0.1:4360/api/storage/t/<token>
    CALLBACK_URL http://127.0.0.1:4360/api/training/jobs/33bb92f5-3f92-4e43-ad9f-06960ad6763f/events?n=2873664644516d49
    the node replaced: BASE_MODEL (-> HuggingFaceTB/SmolLM2-135M-Instruct)
  trainer: exit code null, 15 event lines on stdout, Nosana job timeStart 1791361424 timeEnd null
  [08:24:22] [node] wheelsai-train-33bb92f5-3f92-4e43-ad9f-06960ad6763f-2873664644516d49: trainer exited with code 143 (SIGTERM)
  row: status completed | failure_code null | hold 8 | charge 1 | billed_seconds 38 | price micro-USD/s 250
       queued 08:23:39.510 | started 08:23:44.000 | cancel requested null | gpu stopped 08:24:21.881 | completed 08:24:22.001 | settled 08:24:22.001
       nosana id fakedm0001 | access mode api_key | nosana timeout 1200 s | run limit 300 s | last event seq 15
  ledger rows with reference 33bb92f5-3f92-4e43-ad9f-06960ad6763f (time | amount cents | type | balance after | description):
    08:23:39.469 | -8 | training_reservation | 184142 | Fine-tuning hold (4090, run limit 300s)
    08:24:22.009 | 8 | training_reservation_release | 184150 | Fine-tuning hold released (completed)
    08:24:22.010 | -1 | training_usage | 184149 | Fine-tuning usage (4090, 38s)
  balance before the job 184150 | after 184149 | difference 1 cents
  ok   status is completed (completed)
  ok   one training_reservation row for the whole hold
  ok   one training_reservation_release row returning the whole hold
  ok   one training_usage row for the charge (charge 1)
  ok   the charge is not above the hold (1 <= 8)
  ok   the balance fell by exactly the charge (1)
  ok   every row's balance_after follows from the one before
  ok   charge = price x billed seconds, rounded up to a cent, capped by the hold (250 micro-USD x 38 s = 1 cents (whole seconds; the charge uses milliseconds))
  stand-in deployment: wheelsai-train-33bb92f5-3f92-4e43-ad9f-06960ad6763f-2873664644516d49 STOPPED, timeout sent 20, strategy SIMPLE, confidential true | orphan records: training_completed/api_key
  ok   the job page shows the charge and no cost-so-far once settled
  job page: metrics.started {"gpu":null,"device":"cpu","vramGb":null,"trainerVersion":"1.0.0"} | logSource callbacks | partial false | trainLoss points 4 | evalLoss [[9,0.399689],[18,0.347226],[27,0.315895]]
  job page: result {"gpu":{"name":null,"vramGb":null,"peakVramGb":null},"rows":{"eval":4,"used":40,"total":40,"skipped":0,"truncated":0},"steps":27,"epochs":3,"adapter":{"r":16,"alpha":32,"bytes":18092404,"sha256":"74dc3073d6e140c86ffd32aeab08d8754d9c94ebcccf20a7a383c76c4b55ed06","trainableParameters":4884480},"timings":{"load":1.288,"train":33.527,"upload":0.047,"download":0.008,"tokenize":0.02},"stopReason":"finished","totalSteps":27,"trainTokens":7299,"finalEvalLoss":0.315895,"finalTrainLoss":0.182407,"trainTokensPerSecond":217.7}
  job page: fineTunedModel {"id":"9110de1a-87e5-4cbf-ad2c-166984bf77d8","slug":"proof-report-style-33bb92f5","name":"Proof report style"} | ledger rows on the page 3
  fine_tuned_models row: id 9110de1a-87e5-4cbf-ad2c-166984bf77d8 | slug proof-report-style-33bb92f5 | status ready | base phi-3-mini (microsoft/Phi-3-mini-4k-instruct) | method lora | lora_r 16
    adapter_key adapters/ad698f19-bf63-4d1e-9402-fd6c51636a66/33bb92f5-3f92-4e43-ad9f-06960ad6763f/adapter.tar.gz | adapter_bytes 18092404 | adapter_sha256 74dc3073d6e140c86ffd32aeab08d8754d9c94ebcccf20a7a383c76c4b55ed06
  trainer's uploaded event: adapterBytes 18092404 | adapterSha256 74dc3073d6e140c86ffd32aeab08d8754d9c94ebcccf20a7a383c76c4b55ed06
  object in the store:      bytes 18092404 | sha256 74dc3073d6e140c86ffd32aeab08d8754d9c94ebcccf20a7a383c76c4b55ed06
  ok   the stored adapter, the trainer's event and the model row agree on size and sha256
  ok   the job row points at the model
  ok   progress came from callbacks
[08:24:22] GET /api/training/jobs/<id>/logs?tail=10 -> HTTP 200 source callbacks totalLines 15; last line:
    WHEELSAI_EVENT {"v":1,"seq":15,"ts":"2026-10-07T08:24:21.844Z","type":"completed","finalTrainLoss":0.182407,"finalEvalLoss":0.315895,"trainSeconds":33.527,"steps":27,"totalSteps":27,"stopReason":"finished"}
  api log: [08:24:00] INFO: Training poller tick complete
  api log: [08:24:02] INFO: Training poller tick complete
  api log: [08:24:04] INFO: Training poller tick complete
  api log: [08:24:06] INFO: Training poller tick complete
  api log: [08:24:08] INFO: Training poller tick complete
  api log: [08:24:10] INFO: Training poller tick complete
  api log: [08:24:12] INFO: Training poller tick complete
  api log: [08:24:14] INFO: Training poller tick complete
  api log: [08:24:16] INFO: Training poller tick complete
  api log: [08:24:18] INFO: Training poller tick complete
  api log: [08:24:20] INFO: Training poller tick complete
  api log: [08:24:21] INFO: Training run ended
  api log: [08:24:21] WARN: Recorded an untracked Nosana deployment for the vault sweep
  api log: [08:24:22] INFO: Training job settled
  the API's own record of what Nosana reported when the run ended (here: the stand-in):
    [08:24:21] INFO: Training run ended
    service: "wheelsai-api"
    env: "development"
    context: "training-jobs"
    jobId: "33bb92f5-3f92-4e43-ad9f-06960ad6763f"
    deploymentState: "running"
    nosanaJobState: "RUNNING"
    rawTimeStart: 1791361424
    rawTimeEnd: 0
    startUsed: "2026-10-07T08:23:44.000Z"
    startFromNosana: true
    endUsed: "2026-10-07T08:24:21.881Z"
    endFromNosana: false
    exitCode: null
    resultLogChars: 0
    trainerEvent: "completed"
    trainerEventFrom: "callback"
[08:24:22] GET /api/training/fine-tuned-models -> HTTP 200 total 1: [{"id":"9110de1a-87e5-4cbf-ad2c-166984bf77d8","slug":"proof-report-style-33bb92f5","baseModelId":"phi-3-mini","method":"lora","loraR":16,"adapterBytes":18092404,"activeDeployments":0,"trainingJob":"completed"}]
```

What that shows about our code:

- The hold is taken in the transaction that creates the job: one `training_reservation` row,
  8 cents, the balance down by 8 before anything is submitted.
- The job goes `pending`, `submitting`, `queued`, `running`, `finalizing`, `completed`.
  `finalizing` lasts milliseconds here and is not caught by a page polled every 0.7 s.
- The definition that reached the stand-in is one `container/run` op with the digest-pinned
  image, `gpu: true`, `required_vram: 24`, no command, and the 13 variables of the trainer's
  contract; the dataset's validated sha256 is in `DATASET_SHA256`; the timeout of 1,200 seconds
  (300 + the 900-second allowance) was sent as 20 because the unit defaults to minutes; the
  strategy is `SIMPLE` and the definition is confidential.
- Progress on the job's page comes from the trainer's callbacks while it runs: phase, step, loss,
  evaluation loss, and the cost so far.
- When the trainer's `completed` callback arrived, the same reconcile the poller runs verified
  the adapter **in storage** (size and sha256 against the trainer's `uploaded` event), created
  the `fine_tuned_models` row, stopped the deployment and settled, all before the process had
  exited. The stop reached the trainer as SIGTERM during its own shutdown, which is why the
  node reports "exited with code 143". The final event is trusted over the exit code.
- Settlement is two rows in the transaction of the terminal state change: the whole hold back,
  then the charge. Billable time ran from the Nosana job's start to the moment the end was seen.
- The stop was answered "stopping", so the release could not be confirmed in that call and a
  record was written for the orphan sweep (`training_completed/api_key`). See 1.5.

#### D. The callback route: a bad signature is refused before anything is read

```
  no signature header -> HTTP 401 {"error":"invalid_callback_signature","message":"Missing or invalid callback signature."}
  signed with another key -> HTTP 401 {"error":"invalid_callback_signature","message":"Missing or invalid callback signature."}
  valid signature, body changed afterwards -> HTTP 401 {"error":"invalid_callback_signature","message":"Missing or invalid callback signature."}
  valid signature, timestamp 20 minutes old -> HTTP 401 {"error":"invalid_callback_signature","message":"Missing or invalid callback signature."}
  valid signature, another nonce in the URL -> HTTP 401 {"error":"invalid_callback_signature","message":"Missing or invalid callback signature."}
  a 70,000-byte body -> HTTP 413 {"error":"FastifyError","message":"Request body is too large"}
  valid signature, not a trainer event -> HTTP 400 {"error":"invalid_trainer_event","message":"Unsupported event version"}
  valid signature, a `completed` event for a job that is already settled -> HTTP 200 {"received":true,"applied":false}
  ok   no header, another key, a changed body, a stale timestamp and another nonce are all 401
  ok   an oversize body is 413
  ok   a signed body that is not a trainer event is 400
  ok   a correctly signed event for a settled job is accepted and not applied
  before: training jobs 2 | ledger rows 66 | balance 184149
  after:  training jobs 2 | ledger rows 66 | balance 184149
  ok   the job row, the ledger and the balance are unchanged
```

The secret used here was derived in the script from the documented rule
(`HMAC-SHA256(JWT_SECRET, "training-callback-v1:<job id>:<nonce>")`), not taken from the API's
code. The 413 comes from the route's body limit, so its body reads `FastifyError`.

#### E. Serving the model: the deployment's job definition and the adapter download route

```
The deployment is created through POST /api/deployments. Its definition reaches the stand-in only; nothing runs it.
[08:24:22] POST /api/deployments {"name":"Proof adapter serving","fineTunedModelId":"9110de1a-87e5-4cbf-ad2c-166984bf77d8","gpuTier":"4090","engine":"vllm","replicas":1}
  -> HTTP 201 {"deployment":{"id":"4c7183ec-83c7-49c8-ace3-2ef4aa3a3767","name":"Proof adapter serving","slug":"proof-adapter-serving","status":"pending","fineTunedModelId":"9110de1a-87e5-4cbf-ad2c-166984bf77d8"},"message":"Deployment created. Provisioning GPU node..."}
  what the stand-in received: name wheelsai-model-4c7183ec-83c7-49c8-ace3-2ef4aa3a3767-r0, strategy SIMPLE-EXTEND, timeout 120, confidential true
  job definition (the container op):
    image vllm/vllm-openai:v0.6.0 | gpu true | required_vram - | expose [8000]
    entrypoint ["python3","-c"]
    cmd[0] the constant Python bootstrap (2841 characters, sha256 8f567d8183fd6edb...)
    cmd[1..] ["--model","microsoft/Phi-3-mini-4k-instruct","--host","0.0.0.0","--port","8000","--max-model-len","4096","--gpu-memory-utilization","0.9","--enable-lora","--lora-modules","ft-proof-report-style-33bb92f5=/adapters/ft-proof-report-style-33bb92f5","--max-lora-rank","16"]
    env WHEELSAI_ADAPTER_DIR=/adapters/ft-proof-report-style-33bb92f5
    env WHEELSAI_ADAPTER_MAX_BYTES=18092404
    env WHEELSAI_ADAPTER_SHA256=74dc3073d6e140c86ffd32aeab08d8754d9c94ebcccf20a7a383c76c4b55ed06
    env WHEELSAI_ADAPTER_URL=http://127.0.0.1:4360/api/training/fine-tuned-models/9110de1a-87e5-4cbf-ad2c-166984bf77d8/adapter?d=4c7183ec-83c7-49c8-ace3-2ef4aa3a3767&g=0&sig=<signature>
  deployment row: status provisioning | fine_tuned_model_id 9110de1a-87e5-4cbf-ad2c-166984bf77d8 | run_generation 0 | engine vllm | reservation 90 | balance 184149 -> 184059
  ok   the deployment row names the fine-tuned model
  ok   vLLM is started with the adapter as a LoRA module
  ok   the definition carries the adapter's sha256 and size from the model row
  the adapter URL in the definition: http://127.0.0.1:4360/api/training/fine-tuned-models/9110de1a-87e5-4cbf-ad2c-166984bf77d8/adapter?d=4c7183ec-83c7-49c8-ace3-2ef4aa3a3767&g=0&sig=<signature>
  GET <adapter URL> (no session) -> HTTP 200 application/gzip 18092404 bytes sha256 74dc3073d6e140c86ffd32aeab08d8754d9c94ebcccf20a7a383c76c4b55ed06
  ok   the route streams the adapter for an active deployment row
  signature with one character changed -> HTTP 404 {"error":"not_found","message":"Not found"}
  the next run generation (g=1) with the same signature -> HTTP 404 {"error":"not_found","message":"Not found"}
  another deployment id with the same signature -> HTTP 404 {"error":"not_found","message":"Not found"}
  no signature -> HTTP 404 {"error":"not_found","message":"Not found"}
  ok   a forged or re-used signature is answered 404
  the bootstrap of the definition, run here against the route: exit 1; last line: ~/.cache/wheelsai/trainer-venv/bin/python: Error while finding module specification for 'vllm.entrypoints.openai.api_server' (ModuleNotFoundError: No module named 'vllm')
    extracted into the adapter directory: adapter_config.json, adapter_model.safetensors, wheelsai_manifest.json
  ok   the bootstrap downloaded, verified and extracted the three files
  ok   it stopped only at starting vLLM, which is not installed on this machine
  base model with and without the downloaded adapter (peft on CPU, not vLLM):
    prompt     Add 7 and 8, in WheelsAI report style.
    base       'Here\'s the updated report style:\n\n"WheelsAI report style:\n\n"WheelsAI report style:\n\n"WheelsAI report'
    adapter    'REPORT 19: 7 plus 8 is 15. END OF REPORT.'
  ok   the adapter loads on the substitute base model and answers
[08:24:29] DELETE /api/training/fine-tuned-models/9110de1a-87e5-4cbf-ad2c-166984bf77d8
  -> HTTP 409 {"error":"model_in_use","message":"This fine-tuned model is served by 1 active deployment. Stop it first.","deployments":1}
  ok   the model cannot be deleted while a deployment serves it
[08:24:29] DELETE /api/deployments/4c7183ec-83c7-49c8-ace3-2ef4aa3a3767
  -> HTTP 200 {"message":"Deployment stopped","fundsReleased":false,"vaultReclaimed":false}
  deployment row: status stopped | balance 184149 (the deployment's hold is returned; it never ran)
  GET <the same adapter URL> after the stop -> HTTP 404 {"error":"not_found","message":"Not found"}
  ok   stopping the deployment revokes its adapter URL
  ok   the deployment cost nothing
```

What that shows: a deployment that names a fine-tuned model takes its base model from it and
builds a vLLM definition with `--enable-lora --lora-modules ft-<slug>=/adapters/ft-<slug>` behind
a constant Python bootstrap; the adapter URL in it is authorised against the deployment row at
request time, answers only for that deployment, that run generation and that model, and stops
answering when the deployment is stopped. The bootstrap taken from the definition was run on
this machine against the route: it downloaded, checked and extracted the archive and failed only
at starting vLLM, which is not installed here.

**The definition was sent to the stand-in only; nothing ran it.** The last lines load the
extracted adapter with peft on CPU on the substitute base model. That shows the stored archive is
a working adapter. It is not vLLM, and the definition's `--model microsoft/Phi-3-mini-4k-instruct`
would not accept this adapter (it was trained on SmolLM2).

#### F. A run the user cancels: charged up to the request, not for the stop

```
  dataset "proof-tiny-x8" uploaded and validated: 320 rows, 45920 bytes
[08:24:29] POST /api/training/jobs {"name":"Proof cancelled","baseModelId":"phi-3-mini","datasetId":"c35ec404-15fd-4fe7-81f3-236510184651","method":"lora","gpuTier":"4090","maxRuntimeSeconds":300,"hyperparams":{"epochs":10,"batchSize":4,"gradientAccumulationSteps":1,"maxSeqLength":128}}
  -> HTTP 201 {"job":{"id":"d73e96e1-31cd-4cd3-8b61-a37329d4bbb6","name":"Proof cancelled","status":"pending"},"reservation":{"cents":8,"maxRuntimeSeconds":300,"pricePerSecondUsd":0.00025},"estimate":{"basis":"planning","trainTokens":83200,"steps":800,"seconds":{"imagePull":240,"setup":185,"train":27,"wrapUp":60,"trainer":272,"total":512},"estimate":{"seconds":300,"cents":8},"low":{"seconds":300,"cents":8},"high":{"seconds":300,"cents":8},"pricePerSecondUsd":0.00025,"runLimit":{"minSeconds":300,"maxSeconds":20700,"suggestedSeconds":900,"appliedSeconds":300},"maximumCents":8,"fitsRunLimit":false,"suggestionCapped":false},"message":"Training job created. It is being submitted to the GPU network."}
  balance 184149 -> 184141 cents
  [08:24:29] status submitting | progress 0% | step -/- | phase - | loss - | eval - | cost so far - | charged -
  [08:24:30] status queued | progress 0% | step -/- | phase - | loss - | eval - | cost so far - | charged -
  [08:24:34] [node] wheelsai-train-d73e96e1-31cd-4cd3-8b61-a37329d4bbb6-72efe18cee5a439a: a node took the job; trainer started (replaced or removed: BASE_MODEL)
  [08:24:36] status running | progress 0% | step -/- | phase load_model | loss - | eval - | cost so far 1 | charged -
  [08:24:37] status running | progress 0% | step -/- | phase train | loss - | eval - | cost so far 1 | charged -
  [08:24:39] status running | progress 0% | step 1/760 | phase train | loss 2.77719 | eval - | cost so far 1 | charged -
  [08:24:49] status running | progress 1% | step 10/760 | phase train | loss 2.764596 | eval - | cost so far 1 | charged -
  (letting it train for 12 more seconds)
[08:25:01] POST /api/training/jobs/d73e96e1-31cd-4cd3-8b61-a37329d4bbb6/cancel
  -> HTTP 200 {"status":"cancelled","message":"Training job cancelled"}
  ok   the cancel is accepted
  [08:25:01] [node] wheelsai-train-d73e96e1-31cd-4cd3-8b61-a37329d4bbb6-72efe18cee5a439a: stop requested; SIGTERM sent to the trainer
[08:25:01] POST /api/training/jobs/d73e96e1-31cd-4cd3-8b61-a37329d4bbb6/cancel
  -> HTTP 409 {"error":"training_job_not_cancellable","message":"A job that is cancelled cannot be cancelled.","status":"cancelled"}
  ok   a second cancel is 409
  [08:25:01] status cancelled | progress 2% | step 19/760 | phase train | loss 1.754546 | eval - | cost so far - | charged 1
  [08:25:02] [node] wheelsai-train-d73e96e1-31cd-4cd3-8b61-a37329d4bbb6-72efe18cee5a439a: trainer exited with code 30
  trainer: exit code 30; SIGTERM sent 08:25:01.611; last event: WHEELSAI_EVENT {"v":1,"seq":9,"ts":"2026-10-07T08:25:01.959Z","type":"failed","exitCode":30,"code":"interrupted","message":"Stopped by SIGTERM","phase":"train","signal":"SIGTERM"}
  row: status cancelled | failure_code null | hold 8 | charge 1 | billed_seconds 28 | price micro-USD/s 250
       queued 08:24:29.671 | started 08:24:34.000 | cancel requested 08:25:01.555 | gpu stopped 08:25:01.563 | completed 08:25:01.582 | settled 08:25:01.582
       nosana id fakedm0003 | access mode api_key | nosana timeout 1200 s | run limit 300 s | last event seq 8
  ledger rows with reference d73e96e1-31cd-4cd3-8b61-a37329d4bbb6 (time | amount cents | type | balance after | description):
    08:24:29.656 | -8 | training_reservation | 184141 | Fine-tuning hold (4090, run limit 300s)
    08:25:01.595 | 8 | training_reservation_release | 184149 | Fine-tuning hold released (cancelled)
    08:25:01.598 | -1 | training_usage | 184148 | Fine-tuning usage (4090, 28s)
  balance before the job 184149 | after 184148 | difference 1 cents
  ok   status is cancelled (cancelled)
  ok   one training_reservation row for the whole hold
  ok   one training_reservation_release row returning the whole hold
  ok   one training_usage row for the charge (charge 1)
  ok   the charge is not above the hold (1 <= 8)
  ok   the balance fell by exactly the charge (1)
  ok   every row's balance_after follows from the one before
  ok   charge = price x billed seconds, rounded up to a cent, capped by the hold (250 micro-USD x 28 s = 1 cents (whole seconds; the charge uses milliseconds))
  stand-in deployment: wheelsai-train-d73e96e1-31cd-4cd3-8b61-a37329d4bbb6-72efe18cee5a439a STOPPED, timeout sent 20, strategy SIMPLE, confidential true | orphan records: training_cancelled/api_key
  started -> cancel requested: 27.6 s; billed 28 s; cancel requested -> settled: 0.0 s
  ok   billed time ends at the cancel request
  ok   no model was registered
```

The cancel answered `cancelled` at once: the job is settled when the stop has been requested and
recorded for the sweep, not when the process has gone. The charge covers the time from the
Nosana start to the cancel request. The trainer was signalled within a second and exited 30.

#### G. A failure the data caused: charged for the seconds run

```
  dataset "proof-long-prompts" uploaded and validated: 12 rows, 37780 bytes
[08:25:02] POST /api/training/jobs {"name":"Proof data failure","baseModelId":"phi-3-mini","datasetId":"7b602ba1-0a80-4970-916a-a44010fc7122","method":"lora","gpuTier":"4090","maxRuntimeSeconds":300,"hyperparams":{"epochs":1,"maxSeqLength":128}}
  -> HTTP 201 {"job":{"id":"7d4b9f59-1b80-4c30-b594-7462cf3b2680","name":"Proof data failure","status":"pending"},"reservation":{"cents":8,"maxRuntimeSeconds":300,"pricePerSecondUsd":0.00025},"estimate":{"basis":"planning","trainTokens":1536,"steps":1,"seconds":{"imagePull":240,"setup":185,"train":1,"wrapUp":60,"trainer":246,"total":486},"estimate":{"seconds":300,"cents":8},"low":{"seconds":292,"cents":8},"high":{"seconds":300,"cents":8},"pricePerSecondUsd":0.00025,"runLimit":{"minSeconds":300,"maxSeconds":20700,"suggestedSeconds":900,"appliedSeconds":300},"maximumCents":8,"fitsRunLimit":false,"suggestionCapped":false},"message":"Training job created. It is being submitted to the GPU network."}
  balance 184148 -> 184140 cents
  [08:25:02] status submitting | progress 0% | step -/- | phase - | loss - | eval - | cost so far - | charged -
  [08:25:03] status queued | progress 0% | step -/- | phase - | loss - | eval - | cost so far - | charged -
  [08:25:07] [node] wheelsai-train-7d4b9f59-1b80-4c30-b594-7462cf3b2680-eeb6c7677f9d94b2: a node took the job; trainer started (replaced or removed: BASE_MODEL)
  [08:25:08] status running | progress 0% | step -/- | phase - | loss - | eval - | cost so far 1 | charged -
  [08:25:09] status running | progress 0% | step -/- | phase load_model | loss - | eval - | cost so far 1 | charged -
  [08:25:10] status running | progress 0% | step -/- | phase tokenize | loss - | eval - | cost so far 1 | charged -
  [08:25:10] [node] wheelsai-train-7d4b9f59-1b80-4c30-b594-7462cf3b2680-eeb6c7677f9d94b2: trainer exited with code 11
  [08:25:12] status failed | progress 0% | step -/- | phase tokenize | loss - | eval - | cost so far - | charged 1
  trainer: exit code 11; last event: WHEELSAI_EVENT {"v":1,"seq":5,"ts":"2026-10-07T08:25:10.376Z","type":"failed","exitCode":11,"code":"dataset_no_usable_rows","message":"None of the 12 rows can be trained on","phase":"tokenize","skipReasons":{"no_assistant_tokens_after_truncation":12}}
  job page: failure {"code":"dataset_no_usable_rows","message":"None of the 12 rows can be trained on","charged":true}
  row: status failed | failure_code dataset_no_usable_rows | hold 8 | charge 1 | billed_seconds 3 | price micro-USD/s 250
       queued 08:25:02.720 | started 08:25:07.000 | cancel requested null | gpu stopped 08:25:10.000 | completed 08:25:12.071 | settled 08:25:12.071
       nosana id fakedm0004 | access mode api_key | nosana timeout 1200 s | run limit 300 s | last event seq 5
       last_error: None of the 12 rows can be trained on
  ledger rows with reference 7d4b9f59-1b80-4c30-b594-7462cf3b2680 (time | amount cents | type | balance after | description):
    08:25:02.706 | -8 | training_reservation | 184140 | Fine-tuning hold (4090, run limit 300s)
    08:25:12.081 | 8 | training_reservation_release | 184148 | Fine-tuning hold released (failed)
    08:25:12.082 | -1 | training_usage | 184147 | Fine-tuning usage (4090, 3s)
  balance before the job 184148 | after 184147 | difference 1 cents
  ok   status is failed (failed)
  ok   one training_reservation row for the whole hold
  ok   one training_reservation_release row returning the whole hold
  ok   one training_usage row for the charge (charge 1)
  ok   the charge is not above the hold (1 <= 8)
  ok   the balance fell by exactly the charge (1)
  ok   every row's balance_after follows from the one before
  ok   charge = price x billed seconds, rounded up to a cent, capped by the hold (250 micro-USD x 3 s = 1 cents (whole seconds; the charge uses milliseconds))
  stand-in deployment: wheelsai-train-7d4b9f59-1b80-4c30-b594-7462cf3b2680-eeb6c7677f9d94b2 STOPPED, timeout sent 20, strategy SIMPLE, confidential true | orphan records: 0
  ok   the failure names the trainer's code and says it was charged
```

The dataset here is valid for the API (twelve alpaca rows) but every prompt is longer than the
128-token sequence length the job chose, so the trainer finds no answer token to learn from and
exits 11. That is the data's doing: the seconds run are charged (one cent is the smallest
charge).

#### H. A failure the platform caused: the base model could not be pulled; charged nothing

```
[08:25:12] POST /api/training/jobs {"name":"Proof platform failure","baseModelId":"phi-3-mini","datasetId":"dd066e6d-8c63-492a-889f-fe81b4957496","method":"lora","gpuTier":"4090","maxRuntimeSeconds":300,"hyperparams":{"epochs":3,"batchSize":4,"gradientAccumulationSteps":1,"learningRate":0.001,"maxSeqLength":128,"evalSplit":0.1}}
  -> HTTP 201 {"job":{"id":"5515961c-f3f8-4d22-a388-88623295e8bf","name":"Proof platform failure","status":"pending"},"reservation":{"cents":8,"maxRuntimeSeconds":300,"pricePerSecondUsd":0.00025},"estimate":{"basis":"planning","trainTokens":3120,"steps":30,"seconds":{"imagePull":240,"setup":185,"train":1,"wrapUp":60,"trainer":246,"total":486},"estimate":{"seconds":300,"cents":8},"low":{"seconds":292,"cents":8},"high":{"seconds":300,"cents":8},"pricePerSecondUsd":0.00025,"runLimit":{"minSeconds":300,"maxSeconds":20700,"suggestedSeconds":900,"appliedSeconds":300},"maximumCents":8,"fitsRunLimit":false,"suggestionCapped":false},"message":"Training job created. It is being submitted to the GPU network."}
  balance 184147 -> 184139 cents
  [08:25:12] status submitting | progress 0% | step -/- | phase - | loss - | eval - | cost so far - | charged -
  [08:25:13] status queued | progress 0% | step -/- | phase - | loss - | eval - | cost so far - | charged -
  [08:25:17] [node] wheelsai-train-5515961c-f3f8-4d22-a388-88623295e8bf-92bc978a24c58d1a: a node took the job; trainer started (replaced or removed: BASE_MODEL; BASE_MODEL names a model that is not in the node's cache, with the Hub switched off)
  [08:25:18] status running | progress 0% | step -/- | phase - | loss - | eval - | cost so far 1 | charged -
  [08:25:19] status running | progress 0% | step -/- | phase load_model | loss - | eval - | cost so far 1 | charged -
  [08:25:19] [node] wheelsai-train-5515961c-f3f8-4d22-a388-88623295e8bf-92bc978a24c58d1a: stop requested; SIGTERM sent to the trainer
  [08:25:19] [node] wheelsai-train-5515961c-f3f8-4d22-a388-88623295e8bf-92bc978a24c58d1a: trainer exited with code 143 (SIGTERM)
  [08:25:19] status failed | progress 0% | step -/- | phase load_model | loss - | eval - | cost so far - | charged 0
  trainer: exit code 143; last event: WHEELSAI_EVENT {"v":1,"seq":4,"ts":"2026-10-07T08:25:19.457Z","type":"failed","exitCode":12,"code":"base_model_download_failed","message":"The base model could not be downloaded from Hugging Face","phase":"load_model"}
  job page: failure {"code":"base_model_download_failed","message":"The base model could not be downloaded from Hugging Face","charged":false}
  row: status failed | failure_code base_model_download_failed | hold 8 | charge 0 | billed_seconds 0 | price micro-USD/s 250
       queued 08:25:12.731 | started 08:25:17.000 | cancel requested null | gpu stopped 08:25:19.467 | completed 08:25:19.481 | settled 08:25:19.481
       nosana id fakedm0005 | access mode api_key | nosana timeout 1200 s | run limit 300 s | last event seq 4
       last_error: The base model could not be downloaded from Hugging Face
  ledger rows with reference 5515961c-f3f8-4d22-a388-88623295e8bf (time | amount cents | type | balance after | description):
    08:25:12.710 | -8 | training_reservation | 184139 | Fine-tuning hold (4090, run limit 300s)
    08:25:19.488 | 8 | training_reservation_release | 184147 | Fine-tuning hold released (failed)
  balance before the job 184147 | after 184147 | difference 0 cents
  ok   status is failed (failed)
  ok   one training_reservation row for the whole hold
  ok   one training_reservation_release row returning the whole hold
  ok   no training_usage row (charge 0)
  ok   the charge is not above the hold (0 <= 8)
  ok   the balance fell by exactly the charge (0)
  ok   every row's balance_after follows from the one before
  stand-in deployment: wheelsai-train-5515961c-f3f8-4d22-a388-88623295e8bf-92bc978a24c58d1a STOPPED, timeout sent 20, strategy SIMPLE, confidential true | orphan records: training_failed/api_key
  ok   the failure is a base-model code and says nothing was charged
```

The node was told to use a base model that is not in its cache, with the Hub off, so the trainer
reports `base_model_download_failed` (exit 12). The hold comes back whole and there is no usage
row.

#### I. No node takes the job: failed after the queue timeout (60 s here), charged nothing

```
[08:25:19] POST /api/training/jobs {"name":"Proof no capacity","baseModelId":"phi-3-mini","datasetId":"dd066e6d-8c63-492a-889f-fe81b4957496","method":"lora","gpuTier":"4090","maxRuntimeSeconds":300,"hyperparams":{"epochs":3,"batchSize":4,"gradientAccumulationSteps":1,"learningRate":0.001,"maxSeqLength":128,"evalSplit":0.1}}
  -> HTTP 201 {"job":{"id":"aa4149bc-dfc1-4a0e-8b18-c38018146882","name":"Proof no capacity","status":"pending"},"reservation":{"cents":8,"maxRuntimeSeconds":300,"pricePerSecondUsd":0.00025},"estimate":{"basis":"planning","trainTokens":3120,"steps":30,"seconds":{"imagePull":240,"setup":185,"train":1,"wrapUp":60,"trainer":246,"total":486},"estimate":{"seconds":300,"cents":8},"low":{"seconds":292,"cents":8},"high":{"seconds":300,"cents":8},"pricePerSecondUsd":0.00025,"runLimit":{"minSeconds":300,"maxSeconds":20700,"suggestedSeconds":900,"appliedSeconds":300},"maximumCents":8,"fitsRunLimit":false,"suggestionCapped":false},"message":"Training job created. It is being submitted to the GPU network."}
  balance 184147 -> 184139 cents
  [08:25:19] status submitting | progress 0% | step -/- | phase - | loss - | eval - | cost so far - | charged -
  [08:25:20] [node] wheelsai-train-aa4149bc-dfc1-4a0e-8b18-c38018146882-68c281695771ff89: queued; no node will take it
  [08:25:20] status queued | progress 0% | step -/- | phase - | loss - | eval - | cost so far - | charged -
  [08:26:20] status failed | progress 0% | step -/- | phase - | loss - | eval - | cost so far - | charged 0
  job page: failure {"code":"no_capacity","message":"No GPU node took the job within the queue time","charged":false}
  row: status failed | failure_code no_capacity | hold 8 | charge 0 | billed_seconds 0 | price micro-USD/s 250
       queued 08:25:19.850 | started null | cancel requested null | gpu stopped null | completed 08:26:20.045 | settled 08:26:20.045
       nosana id fakedm0006 | access mode api_key | nosana timeout 1200 s | run limit 300 s | last event seq 0
       last_error: No GPU node took the job within the queue time
  ledger rows with reference aa4149bc-dfc1-4a0e-8b18-c38018146882 (time | amount cents | type | balance after | description):
    08:25:19.837 | -8 | training_reservation | 184139 | Fine-tuning hold (4090, run limit 300s)
    08:26:20.052 | 8 | training_reservation_release | 184147 | Fine-tuning hold released (failed)
  balance before the job 184147 | after 184147 | difference 0 cents
  ok   status is failed (failed)
  ok   one training_reservation row for the whole hold
  ok   one training_reservation_release row returning the whole hold
  ok   no training_usage row (charge 0)
  ok   the charge is not above the hold (0 <= 8)
  ok   the balance fell by exactly the charge (0)
  ok   every row's balance_after follows from the one before
  stand-in deployment: wheelsai-train-aa4149bc-dfc1-4a0e-8b18-c38018146882-68c281695771ff89 STOPPED, timeout sent 20, strategy SIMPLE, confidential true | orphan records: training_queue_timeout/api_key
  queued -> settled: 60.2 s
  ok   the failure code is no_capacity
  ok   the deployment was stopped on the stand-in
```

#### J. The submit fails (the stand-in answers 500 to the create): failed, charged nothing

```
[08:26:20] POST /api/training/jobs {"name":"Proof submit failure","baseModelId":"phi-3-mini","datasetId":"dd066e6d-8c63-492a-889f-fe81b4957496","method":"lora","gpuTier":"4090","maxRuntimeSeconds":300,"hyperparams":{"epochs":3,"batchSize":4,"gradientAccumulationSteps":1,"learningRate":0.001,"maxSeqLength":128,"evalSplit":0.1}}
  -> HTTP 201 {"job":{"id":"256e7b45-a735-4513-8c22-67dc6fc2eb6a","name":"Proof submit failure","status":"pending"},"reservation":{"cents":8,"maxRuntimeSeconds":300,"pricePerSecondUsd":0.00025},"estimate":{"basis":"planning","trainTokens":3120,"steps":30,"seconds":{"imagePull":240,"setup":185,"train":1,"wrapUp":60,"trainer":246,"total":486},"estimate":{"seconds":300,"cents":8},"low":{"seconds":292,"cents":8},"high":{"seconds":300,"cents":8},"pricePerSecondUsd":0.00025,"runLimit":{"minSeconds":300,"maxSeconds":20700,"suggestedSeconds":900,"appliedSeconds":300},"maximumCents":8,"fitsRunLimit":false,"suggestionCapped":false},"message":"Training job created. It is being submitted to the GPU network."}
  balance 184147 -> 184139 cents
  [08:26:20] status submitting | progress 0% | step -/- | phase - | loss - | eval - | cost so far - | charged -
  [08:26:21] status failed | progress 0% | step -/- | phase - | loss - | eval - | cost so far - | charged 0
  job page: failure {"code":"submit_failed","message":"The job could not be submitted to the GPU network","charged":false}
  row: status failed | failure_code submit_failed | hold 8 | charge 0 | billed_seconds 0 | price micro-USD/s 250
       queued null | started null | cancel requested null | gpu stopped null | completed 08:26:20.394 | settled 08:26:20.394
       nosana id null | access mode null | nosana timeout 1200 s | run limit 300 s | last event seq 0
       last_error: The job could not be submitted to the GPU network
  ledger rows with reference 256e7b45-a735-4513-8c22-67dc6fc2eb6a (time | amount cents | type | balance after | description):
    08:26:20.351 | -8 | training_reservation | 184139 | Fine-tuning hold (4090, run limit 300s)
    08:26:20.407 | 8 | training_reservation_release | 184147 | Fine-tuning hold released (failed)
  balance before the job 184147 | after 184147 | difference 0 cents
  ok   status is failed (failed)
  ok   one training_reservation row for the whole hold
  ok   one training_reservation_release row returning the whole hold
  ok   no training_usage row (charge 0)
  ok   the charge is not above the hold (0 <= 8)
  ok   the balance fell by exactly the charge (0)
  ok   every row's balance_after follows from the one before
  stand-in deployment: none | orphan records: 0
  deployment name of this attempt: wheelsai-train-256e7b45-a735-4513-8c22-67dc6fc2eb6a-ef90511f00690c5c; list requests to the stand-in after the failure: 1
  ok   the failure code is submit_failed
  ok   Nosana's list was asked for the deterministic name before the refund
  api log: [08:26:20] INFO: Training job admitted
  api log: [08:26:20] INFO: Creating Nosana deployment
  api log: [08:26:20] ERROR: Nosana deployment creation failed
  api log: [08:26:20] ERROR: Training job submit failed
  api log: [08:26:20] INFO: Training job settled
```

After the failed create the service asked the stand-in for its deployment list, looking for the
deterministic name of this attempt, found nothing, and only then returned the hold. The case
"the create failed but the deployment exists" cannot be produced with this stand-in; it is
covered by unit tests.

#### K. Callbacks blocked: the run is followed and completed from the job's logs alone

```
[08:26:21] POST /api/training/jobs {"name":"Proof logs only","baseModelId":"phi-3-mini","datasetId":"dd066e6d-8c63-492a-889f-fe81b4957496","method":"lora","gpuTier":"4090","maxRuntimeSeconds":300,"hyperparams":{"epochs":3,"batchSize":4,"gradientAccumulationSteps":1,"learningRate":0.001,"maxSeqLength":128,"evalSplit":0.1}}
  -> HTTP 201 {"job":{"id":"e879ef65-d56d-4be7-8aee-6bd97a7e63e6","name":"Proof logs only","status":"pending"},"reservation":{"cents":8,"maxRuntimeSeconds":300,"pricePerSecondUsd":0.00025},"estimate":{"basis":"planning","trainTokens":3120,"steps":30,"seconds":{"imagePull":240,"setup":185,"train":1,"wrapUp":60,"trainer":246,"total":486},"estimate":{"seconds":300,"cents":8},"low":{"seconds":292,"cents":8},"high":{"seconds":300,"cents":8},"pricePerSecondUsd":0.00025,"runLimit":{"minSeconds":300,"maxSeconds":20700,"suggestedSeconds":900,"appliedSeconds":300},"maximumCents":8,"fitsRunLimit":false,"suggestionCapped":false},"message":"Training job created. It is being submitted to the GPU network."}
  balance 184147 -> 184139 cents
  [08:26:21] status submitting | progress 0% | step -/- | phase - | loss - | eval - | cost so far - | charged -
  [08:26:21] status queued | progress 0% | step -/- | phase - | loss - | eval - | cost so far - | charged -
  [08:26:26] [node] wheelsai-train-e879ef65-d56d-4be7-8aee-6bd97a7e63e6-73f70880fddb32ff: a node took the job; trainer started (replaced or removed: BASE_MODEL, CALLBACK_URL; CALLBACK_URL points at a server that answers 403 to everything)
  [08:26:28] status running | progress 0% | step -/- | phase - | loss - | eval - | cost so far 1 | charged -
  [08:27:06] status running | progress 0% | step -/- | phase - | loss - | eval - | cost so far 2 | charged -
  [08:27:12] [node] wheelsai-train-e879ef65-d56d-4be7-8aee-6bd97a7e63e6-73f70880fddb32ff: trainer exited with code 0
  [08:27:14] status completed | progress 100% | step 27/27 | phase upload | loss 0.182407 | eval 0.315895 | cost so far - | charged 2
    api log: [08:27:14] INFO: Training run ended
    api log: service: "wheelsai-api"
    api log: env: "development"
    api log: context: "training-jobs"
    api log: jobId: "e879ef65-d56d-4be7-8aee-6bd97a7e63e6"
    api log: deploymentState: "ended"
    api log: nosanaJobState: "COMPLETED"
    api log: rawTimeStart: 1791361586
    api log: rawTimeEnd: 1791361632
    api log: startUsed: "2026-10-07T08:26:26.000Z"
    api log: startFromNosana: true
    api log: endUsed: "2026-10-07T08:27:12.000Z"
    api log: endFromNosana: true
    api log: exitCode: 0
    api log: resultLogChars: 2406
    api log: trainerEvent: "completed"
    api log: trainerEventFrom: "nosana_result"
  callbacks the blocker refused: 16; mentions of this job's callback route in the API's log: 0
  row: status completed | failure_code null | hold 8 | charge 2 | billed_seconds 46 | price micro-USD/s 250
       queued 08:26:21.176 | started 08:26:26.000 | cancel requested null | gpu stopped 08:27:12.000 | completed 08:27:14.126 | settled 08:27:14.126
       nosana id fakedm0007 | access mode api_key | nosana timeout 1200 s | run limit 300 s | last event seq 16
  ledger rows with reference e879ef65-d56d-4be7-8aee-6bd97a7e63e6 (time | amount cents | type | balance after | description):
    08:26:21.152 | -8 | training_reservation | 184139 | Fine-tuning hold (4090, run limit 300s)
    08:27:14.137 | 8 | training_reservation_release | 184147 | Fine-tuning hold released (completed)
    08:27:14.138 | -2 | training_usage | 184145 | Fine-tuning usage (4090, 46s)
  balance before the job 184147 | after 184145 | difference 2 cents
  ok   status is completed (completed)
  ok   one training_reservation row for the whole hold
  ok   one training_reservation_release row returning the whole hold
  ok   one training_usage row for the charge (charge 2)
  ok   the charge is not above the hold (2 <= 8)
  ok   the balance fell by exactly the charge (2)
  ok   every row's balance_after follows from the one before
  ok   charge = price x billed seconds, rounded up to a cent, capped by the hold (250 micro-USD x 46 s = 2 cents (whole seconds; the charge uses milliseconds))
  stand-in deployment: wheelsai-train-e879ef65-d56d-4be7-8aee-6bd97a7e63e6-73f70880fddb32ff STOPPED, timeout sent 20, strategy SIMPLE, confidential true | orphan records: 0
  job page: logSource nosana_result | step 27/27 | loss 0.182407 | eval 0.315895 | fineTunedModel {"id":"ed9ad8b9-a13e-45c8-9d41-d7cab5c7e1b7","slug":"proof-logs-only-e879ef65","name":"Proof logs only"}
  GET logs -> source nosana_result, totalLines 16
  ok   every callback was blocked and none reached the API
  ok   progress, the outcome and the log text came from the Nosana job result
  ok   the adapter was verified and a model registered
$ npx tsx scripts/nosana-training-job-check.ts fakedm0007   (the API's environment; the stand-in answers)
  Nosana training job check - read-only (two reads, nothing is created, started or stopped)
  time: 2026-10-07T08:27:15.912Z
  access mode: api_key | network: mainnet
  
  deployment fakedm0007
    status (as this code reads it): stopped
    jobs listed: 1
      job v6cKMMru...  fields: job, status
  
  job v6cKMMru...
    state: raw "COMPLETED" -> read as "completed"
    host node: LocaLCpuNode1111111111111111111111111111111 | market: not set
    timeStart: raw 1791361586 -> read as 2026-10-07T08:26:26.000Z
    timeEnd:   raw 1791361632 -> read as 2026-10-07T08:27:12.000Z
    listedAt:  raw null -> read as not set
    timeEnd - timeStart as read: 46 s
    A raw value near 1.8e9 is unix seconds, near 1.8e12 milliseconds. Compare the times as read with the
    trainer's own `started` and `completed` event timestamps on the job's page.
  
  job result: present, fields: opStates, status
    opStates: 1
      op "train": fields exitCode, logs, operationId, status
        exitCode 0 | status "success" | log entries 16
        a log entry's fields: log, type | entry types seen: stdout
        entries holding more than one line: 0
  
  as the poller reads it
    exit code: 0
    log text: 2406 characters, 17 lines
    trainer events recovered: 16 (seq 1..16: started phase phase phase phase step eval step step eval step step eval phase uploaded completed)
    final event: completed
  ok   the check script reads the job the way the poller did
```

The trainer's callbacks went to a server that answers 403, so the API received none. The poller
moved the job to `running` from the Nosana job's state, and when the job ended it read the exit
code and the `WHEELSAI_EVENT` lines out of the job result: progress, the final losses, the
`uploaded` event the adapter was checked against, and the log text. The outcome and the charge
are the same as with callbacks. The last block is the read-only script that part 2 uses, run
here against the stand-in.

#### L. A run that reaches its own run limit (300 s): partial adapter, charged, never above the hold

```
[08:27:16] POST /api/training/jobs {"name":"Proof run limit","baseModelId":"phi-3-mini","datasetId":"c35ec404-15fd-4fe7-81f3-236510184651","method":"lora","gpuTier":"4090","maxRuntimeSeconds":300,"hyperparams":{"epochs":10,"batchSize":4,"gradientAccumulationSteps":1,"maxSeqLength":128}}
  -> HTTP 201 {"job":{"id":"fabe321e-6f7e-4fcb-b74e-95cac1881f91","name":"Proof run limit","status":"pending"},"reservation":{"cents":8,"maxRuntimeSeconds":300,"pricePerSecondUsd":0.00025},"estimate":{"basis":"planning","trainTokens":83200,"steps":800,"seconds":{"imagePull":240,"setup":185,"train":27,"wrapUp":60,"trainer":272,"total":512},"estimate":{"seconds":300,"cents":8},"low":{"seconds":300,"cents":8},"high":{"seconds":300,"cents":8},"pricePerSecondUsd":0.00025,"runLimit":{"minSeconds":300,"maxSeconds":20700,"suggestedSeconds":900,"appliedSeconds":300},"maximumCents":8,"fitsRunLimit":false,"suggestionCapped":false},"message":"Training job created. It is being submitted to the GPU network."}
  balance 184145 -> 184137 cents
  [08:27:16] status submitting | progress 0% | step -/- | phase - | loss - | eval - | cost so far - | charged -
  [08:27:16] status queued | progress 0% | step -/- | phase - | loss - | eval - | cost so far - | charged -
  [08:27:21] [node] wheelsai-train-fabe321e-6f7e-4fcb-b74e-95cac1881f91-bd38986ac3fae6cc: a node took the job; trainer started (replaced or removed: BASE_MODEL)
  [08:27:22] status running | progress 0% | step -/- | phase - | loss - | eval - | cost so far 1 | charged -
  [08:27:24] status running | progress 0% | step -/- | phase load_model | loss - | eval - | cost so far 1 | charged -
  [08:27:28] status running | progress 0% | step -/- | phase train | loss - | eval - | cost so far 1 | charged -
  [08:27:58] status running | progress 0% | step 1/760 | phase train | loss 2.77719 | eval - | cost so far 1 | charged -
  [08:28:01] status running | progress 0% | step 1/760 | phase train | loss 2.77719 | eval - | cost so far 2 | charged -
  [08:28:24] status running | progress 0% | step 2/760 | phase train | loss 2.808123 | eval - | cost so far 2 | charged -
  ... (23 more lines like these, one per reported step, left out) ...
  [08:31:44] status running | progress 19% | step 151/760 | phase train | loss 0.132174 | eval 0.126651 | cost so far 7 | charged -
  [08:31:47] status running | progress 19% | step 151/760 | phase train | loss 0.132174 | eval 0.087821 | cost so far 7 | charged -
  [08:31:56] status running | progress 20% | step 158/760 | phase train | loss 0.065664 | eval 0.087821 | cost so far 7 | charged -
  [08:31:57] status running | progress 20% | step 158/760 | phase upload | loss 0.065664 | eval 0.087235 | cost so far 7 | charged -
  [08:31:58] [node] wheelsai-train-fabe321e-6f7e-4fcb-b74e-95cac1881f91-bd38986ac3fae6cc: stop requested; SIGTERM sent to the trainer
  [08:31:58] [node] wheelsai-train-fabe321e-6f7e-4fcb-b74e-95cac1881f91-bd38986ac3fae6cc: trainer exited with code 143 (SIGTERM)
  [08:31:59] status completed | progress 100% | step 158/760 | phase upload | loss 0.099534 | eval 0.087235 | cost so far - | charged 7
  trainer: exit code 143; last event: WHEELSAI_EVENT {"v":1,"seq":32,"ts":"2026-10-07T08:31:58.512Z","type":"completed","finalTrainLoss":0.099534,"finalEvalLoss":0.087235,"trainSeconds":265.145,"steps":158,"totalSteps":760,"stopReason":"max_runtime"}
  row: status completed | failure_code null | hold 8 | charge 7 | billed_seconds 278 | price micro-USD/s 250
       queued 08:27:16.063 | started 08:27:21.000 | cancel requested null | gpu stopped 08:31:58.540 | completed 08:31:58.667 | settled 08:31:58.667
       nosana id fakedm0008 | access mode api_key | nosana timeout 1200 s | run limit 300 s | last event seq 32
  ledger rows with reference fabe321e-6f7e-4fcb-b74e-95cac1881f91 (time | amount cents | type | balance after | description):
    08:27:16.046 | -8 | training_reservation | 184137 | Fine-tuning hold (4090, run limit 300s)
    08:31:58.678 | 8 | training_reservation_release | 184145 | Fine-tuning hold released (completed)
    08:31:58.679 | -7 | training_usage | 184138 | Fine-tuning usage (4090, 278s)
  balance before the job 184145 | after 184138 | difference 7 cents
  ok   status is completed (completed)
  ok   one training_reservation row for the whole hold
  ok   one training_reservation_release row returning the whole hold
  ok   one training_usage row for the charge (charge 7)
  ok   the charge is not above the hold (7 <= 8)
  ok   the balance fell by exactly the charge (7)
  ok   every row's balance_after follows from the one before
  ok   charge = price x billed seconds, rounded up to a cent, capped by the hold (250 micro-USD x 278 s = 7 cents (whole seconds; the charge uses milliseconds))
  stand-in deployment: wheelsai-train-fabe321e-6f7e-4fcb-b74e-95cac1881f91-bd38986ac3fae6cc STOPPED, timeout sent 20, strategy SIMPLE, confidential true | orphan records: training_completed/api_key
  job page: partial true | step 158/760 | fineTunedModel {"id":"b14537a8-25ff-425e-98eb-42c85c7e075e","slug":"proof-run-limit-fabe321e","name":"Proof run limit"}
  ok   the job is marked partial and has a model
  ok   the charge is at or below the hold
```

The trainer keeps a reserve of 30 s out of its 300, stops training at about 270 s with about a fifth of
the steps done, uploads what it has and reports `stopReason: "max_runtime"`. The job completes
as partial, with a model, and is charged for the time run, below the hold.

#### Totals before the refusals

```
  name | status | failure code | hold | charge | billed seconds
  Proof report style | completed | - | 8 | 1 | 38
  Proof cancelled | cancelled | - | 8 | 1 | 28
  Proof data failure | failed | dataset_no_usable_rows | 8 | 1 | 3
  Proof platform failure | failed | base_model_download_failed | 8 | 0 | 0
  Proof no capacity | failed | no_capacity | 8 | 0 | 0
  Proof submit failure | failed | submit_failed | 8 | 0 | 0
  Proof logs only | completed | - | 8 | 2 | 46
  Proof run limit | completed | - | 8 | 7 | 278
  balance at the start 184150 | now 184138 | difference 12 | sum of the charges 12
  ok   the balance fell by exactly the sum of the charges
  training ledger rows by type: training_reservation x8 = -64 | training_reservation_release x8 = 64 | training_usage x5 = -12
  ok   every hold was released exactly once (8 holds, 8 releases, 8 jobs)
  ok   no job is left unfinished
  stand-in: 731 Nosana requests (9 creates, 6 stops), 0 vault requests; Solana RPC requests: 0
  orphan records left for the sweep (it is part of the deployment status worker, which is off in this run): training_cancelled x1, training_completed x2, training_failed x1, training_queue_timeout x1
  stand-in deployments at the end: fakedm0001:STOPPED fakedm0002:STOPPED fakedm0003:STOPPED fakedm0004:STOPPED fakedm0005:STOPPED fakedm0006:STOPPED fakedm0007:STOPPED fakedm0008:STOPPED
  ok   no Solana RPC request was made
  ok   the Nosana key and the server secret are in no line of the API's log
```

#### M. Job creation refused when something is not configured: no row, no hold

For each case the API was restarted with one setting removed or changed.

```
[08:32:02] API started on http://127.0.0.1:4360 (TRAINING_IMAGE unset)
  capabilities: canStart false; blockers training_image_not_configured
  POST /api/training/jobs -> HTTP 501 {"error":"training_image_not_configured","message":"Fine-tuning is not available: the training image is not configured."}
  before: training jobs 9 | ledger rows 86 | balance 184138 | after: training jobs 9 | ledger rows 86 | balance 184138
  ok   TRAINING_IMAGE unset: 501 training_image_not_configured
  ok   nothing was created or held
[08:32:06] API started on http://127.0.0.1:4360 (TRAINING_IMAGE is a tag, not a digest)
  capabilities: canStart false; blockers training_image_not_configured
  POST /api/training/jobs -> HTTP 501 {"error":"training_image_not_configured","message":"Fine-tuning is not available: the training image is not configured."}
  before: training jobs 9 | ledger rows 86 | balance 184138 | after: training jobs 9 | ledger rows 86 | balance 184138
  ok   TRAINING_IMAGE is a tag, not a digest: 501 training_image_not_configured
  ok   nothing was created or held
[08:32:10] API started on http://127.0.0.1:4360 (no object storage (STORAGE_DRIVER unset))
  capabilities: canStart false; blockers dataset_storage_not_configured
  POST /api/training/jobs -> HTTP 503 {"error":"dataset_storage_not_configured","message":"Fine-tuning is not available: object storage is not configured on this server."}
  before: training jobs 9 | ledger rows 86 | balance 184138 | after: training jobs 9 | ledger rows 86 | balance 184138
  ok   no object storage (STORAGE_DRIVER unset): 503 dataset_storage_not_configured
  ok   nothing was created or held
[08:32:14] API started on http://127.0.0.1:4360 (PUBLIC_API_URL unset)
  capabilities: canStart false; blockers training_callbacks_not_configured
  POST /api/training/jobs -> HTTP 503 {"error":"training_callbacks_not_configured","message":"Fine-tuning is not available: the API has no public address for a training run to report to."}
  before: training jobs 9 | ledger rows 86 | balance 184138 | after: training jobs 9 | ledger rows 86 | balance 184138
  ok   PUBLIC_API_URL unset: 503 training_callbacks_not_configured
  ok   nothing was created or held
[08:32:17] API started on http://127.0.0.1:4360 (TRAINING_POLL_INTERVAL_MS=0)
  capabilities: canStart false; blockers training_poller_disabled
  POST /api/training/jobs -> HTTP 503 {"error":"training_poller_disabled","message":"Fine-tuning is not available: the worker that follows training runs is switched off."}
  before: training jobs 9 | ledger rows 86 | balance 184138 | after: training jobs 9 | ledger rows 86 | balance 184138
  ok   TRAINING_POLL_INTERVAL_MS=0: 503 training_poller_disabled
  ok   nothing was created or held
[08:32:21] API started on http://127.0.0.1:4360 (no Nosana credential)
  capabilities: canStart false; blockers nosana_not_configured
  POST /api/training/jobs -> HTTP 501 {"error":"nosana_not_configured","message":"Fine-tuning cannot start: no GPU network account is configured."}
  before: training jobs 9 | ledger rows 86 | balance 184138 | after: training jobs 9 | ledger rows 86 | balance 184138
  ok   no Nosana credential: 501 nosana_not_configured
  ok   nothing was created or held
[08:32:25] API started on http://127.0.0.1:4360 (the development Nosana mock on (ALLOW_NOSANA_MOCK=true))
  capabilities: canStart false; blockers training_requires_real_nosana
  POST /api/training/jobs -> HTTP 501 {"error":"training_requires_real_nosana","message":"Fine-tuning needs the real GPU network; this server runs with a stand-in for it."}
  before: training jobs 9 | ledger rows 86 | balance 184138 | after: training jobs 9 | ledger rows 86 | balance 184138
  ok   the development Nosana mock on (ALLOW_NOSANA_MOCK=true): 501 training_requires_real_nosana
  ok   nothing was created or held
[08:32:28] API started on http://127.0.0.1:4360 (full configuration again)
  with the organization's balance set to 3 cents in the copy: POST /api/training/jobs -> HTTP 402 {"error":"insufficient_credits","message":"Not enough credits to hold the cost of the full run limit","requiredCents":8,"balanceCents":3}
  ok   insufficient credits is 402 with the required amount
  ok   nothing was created or held
```

#### Result and cleanup

```
ALL CHECKS PASSED
```

```
Redis index 13 flushed
DROP DATABASE wheelsai_ftproof
```

### 1.4 Two changes the run led to

| Seen in the run | What the code does now | Tests |
|---|---|---|
| With no Nosana credential every create answered `400 unknown_gpu_tier` ("GPU tier '4090' is not available"), while `GET /api/training/capabilities` named `nosana_not_configured`: a server with no account lists no deployable tier, so the tier check refused first. | `placeableTrainingTiers` (`services/trainingJobs.ts`, used by `buildTrainingDeps.ts`): with no credential, as already with the development mock, every tier of the price table passes the tier check, and the refusal is the honest `501 nosana_not_configured` at its place in the order. Section M above is the run after the fix. | `trainingJobs.unit.test.ts`, 2 |
| Nothing recorded what Nosana itself reported about a finished job, so the unit of its time fields could not be read off a paid run. | One log line per job, "Training run ended", with the raw `timeStart` and `timeEnd`, the job state, the exit code, the size of the result's log and which times billing used (shown in C and K). No URL or credential is in it. | `trainingJobs.unit.test.ts`, 1 |

A third file is new for part 2: `apps/api/scripts/nosana-training-job-check.ts`, a read-only
look at one training deployment through the API's own Nosana client (two reads). Its output
against the stand-in is at the end of K.

### 1.5 What the run showed that is worth knowing

- **Most ended jobs leave an orphan record.** Five of the eight jobs here did. Nosana (as the
  stand-in models it) answers a stop with "stopping", so the release cannot be confirmed in the
  same call; the job is settled once the deployment is durably handed to the sweep. The sweep
  belongs to the deployment status worker, which was off in this run, so the records stayed
  open. In production `DEPLOYMENT_STATUS_INTERVAL_MS` must be above 0; since the review, job
  creation refuses with `503 training_orphan_sweep_disabled` when it is 0 (1.6).
- **The trainer is stopped while it is shutting down** on every run that reports by callback,
  because the API acts on the `completed` or `failed` event at once. The outcome is taken from
  the event. The process's own exit code is then 143, 30, or anything else.
- **One cent is the smallest charge.** A data failure after 3 seconds cost 1 cent.
- **At the minimum run limit the estimate says a tiny job may not fit** (`fitsRunLimit: false`):
  its planning constants for set-up and wrap-up alone are 245 s of the 300.

### 1.6 After the review: what changed, and the run again

Two reviews of the build (lifecycle and money; routes, serving and pages) found six defects.
Each was confirmed against the code with a test that failed first, and fixed:

| Found | What the code does now | Tests |
|---|---|---|
| An interruption (exit 30) after the run limit had passed was charged as `run_limit_reached`, the whole hold for a run with no adapter, when Nosana's timeout landed after a slow image pull. | Any interruption the user did not ask for is free, at the limit or not. The trainer's own stop at its limit (exit 0, partial adapter) is still a charged completion. `run_limit_reached` no longer exists. | `trainingStateMachine.unit.test.ts`, `trainingJobs.unit.test.ts` (two who-pays rows past the limit) |
| A cancel that landed after a free failure (out of memory, still `running` inside the 300 s grace) turned it into a charged cancel. | Once the trainer's terminal event is recorded, cancel answers `409 training_already_finished` (its write is a compare-and-set on the event sequence it read). A run found to have ended before the request is settled as it ended: completed first goes `cancelling -> finalizing` (the one new transition) and is charged as a completion; failed first ends `cancelled` with the failure's code, charged as that failure is. On Nosana's or the trainer's clock alone, an interruption, 143 or 137 is taken as our own stop. | `trainingJobs.unit.test.ts`, 6 |
| The active-job quota was not serialised: concurrent creates all passed it. | The first statement of the create transaction updates the organization's `credit_balances` row by 0, taking its lock; the counts follow it. On a Postgres copy: six concurrent creates with a limit of 2 admitted 2, and all six without the lock. | `trainingJobs.unit.test.ts` (a fake whose transactions run concurrently and wait only on row locks), 2 |
| Nothing bounded runs that fail free, each paid for by the platform. | `TRAINING_FREE_FAILURES_PER_DAY` (default 3): at the limit create and retry answer `409 training_free_failure_limit` with `retryAt`, counted again inside the transaction after the lock; capabilities list it for the organization. | `trainingJobs.unit.test.ts`, 2; `trainingRoutes.unit.test.ts` |
| Job creation did not check the orphan sweep; the poller could starve jobs past the first 200. | `503 training_orphan_sweep_disabled` when `DEPLOYMENT_STATUS_INTERVAL_MS` is 0 (also a blocker). The poller takes jobs by `last_reconciled_at` (a column added in place to `20261012100000_fine_tuning`, drift check empty) and stamps them as taken. | `runTrainingPollerTick.unit.test.ts`, 2 |
| A rank-4 adapter could never be served: vLLM 0.6.x refuses `--max-lora-rank 4`. | `--max-lora-rank` is the smallest of 8, 16, 32, 64, 128, 256 at least the rank (`vllmMaxLoraRank`). | `vllmLoraJobDefinition.unit.test.ts`, 1 |
| The new-job page could not start a job on a Parquet dataset: every estimate was 422 and Start needs one. | `POST /estimate` with a run limit answers `estimate: null` with the `hold`; without one, 422 asks for a run limit. The page requires the limit for such a dataset and reviews the hold without an estimate. | `trainingJobs.unit.test.ts`, `trainingRoutes.unit.test.ts`, `apps/web/src/lib/training.unit.test.ts` |

`findDeploymentByName` reading a single page of Nosana's list was not changed; it is in
`docs/HARDENING-BACKLOG.md` for the paid run to settle.

After the fixes, from the repository root: `npm run -s test:unit -w @wheelsai/api` gave 4683
tests, 4683 passed. The end-to-end script ran again in full with two settings added for it,
`DEPLOYMENT_STATUS_INTERVAL_MS=5000` (job creation now needs the worker) and
`TRAINING_FREE_FAILURES_PER_DAY=20` (the script ends three runs free on purpose), and one
refusal case added (`DEPLOYMENT_STATUS_INTERVAL_MS=0` gives `503 training_orphan_sweep_disabled`):
`ALL CHECKS PASSED`, 123 checks, eight jobs with 8 holds and 8 releases, 0 vault requests and 0
Solana RPC requests. The transcript in 1.3 is the run before the review. In this one every
scenario ended with the same status, failure code and charge class; the seconds and cents vary
with how long the CPU took (charges of 3, 1, 1, 0, 0, 0, 2 and 7 cents, 14 in all, against 12
before; the balance fell by exactly that).

---

## 2. The first paid run — checklist

The founder runs this with the Nosana key present. It produces the two receipts the grant
proofs need: **a paid fine-tuning job** and **a paid inference request against the model it
produced**, both on Nosana. Record each result in the table at the end and fill in both
receipts. Stop at the first step whose result is not the expected one.

**Do `docs/NOSANA-DEPLOY-RUN.md` part 2 first.** It is the first create, start and stop of ours
on Nosana, on a deployment that costs a few cents, and it confirms on our own deployment what
the verification settled: the timeout unit (minutes), how a debit and a refund appear, and that
`running` waits for an endpoint that is online. A training job's Nosana timeout is the run limit
plus 15 minutes, sent in minutes.

### The account, the balance and the key (read on 2026-10-07)

- **The Nosana account is shared with the founder's other project, and its spend lowers the
  same balance.** Its deployments are on the same list (19 at the verification) and its debits
  and refunds are in the same transaction list. Keep it idle during this run, or record what it
  did: B0, B1 and B2 below are only ours if it spent nothing.
- **Available credit at the verification was $5.091** ($28 assigned, $0 reserved, $22.909
  settled; USD). **The "$15 loaded" this checklist assumed is not there.** With the $5 floor,
  the serving deploy on the 4070 (step 16) needs $5.097 and is refused today.
- **Recommended starting balance: about $15 available before step 1** (a top-up of about $10,
  more if the deployment run has spent some of it). The serving deployment is SIMPLE-EXTEND:
  Nosana debits its full timeout when a node takes the job and again at each extension, and
  returns the unused part only after the stop.
- **Use the narrow key.** The deployment run replaces the all-scope key, which was also pasted
  into a chat, with one that holds only `credits:read`, `deployments:read`, `deployments:write`
  and `jobs:read`, and revokes the old one. Do not run this checklist with the all-scope key.
  `jobs:read` is what step 9 needs.
- **A confidential job definition can be read back by every holder of an account key**, through
  `/deployments/{id}/revisions` and `/deployments/{id}/jobs/{job}`, environment values included.
  The training definition holds the callback secret and the signed dataset and upload URLs; the
  serving definition holds the signed adapter URL; with a gated model it would hold `HF_TOKEN`.
  On a shared account that means the other project's key holders can read them. This run uses
  an ungated model and short-lived links; a Nosana account that only WheelsAI uses is in
  `docs/HARDENING-BACKLOG.md`.

**The code this checklist assumes.** Besides the fixes listed in the deployment run document:
`required_vram` is no longer in the training job definition (step 4), the training poller takes
its job from `GET /deployments/{id}/jobs` (steps 6 to 10), and
`scripts/nosana-training-job-check.ts` reads that route (step 9). Do not start until these are
committed and the unit suite passes against the re-based stand-in.

### What will run

| | Value | Why |
|---|---|---|
| Base model | `phi-3-mini` (`microsoft/Phi-3-mini-4k-instruct`) | Ungated: no Hugging Face token is needed. |
| Method | `qlora` | Fits the cheapest tier. It is also the path that has never executed (4-bit loading on the node's driver). |
| Tier | `4070` (12 GB), $0.54 an hour retail, $0.09603 an hour on Nosana with the fee (our figure, rounded up per second, is $0.0972) | The cheapest tier the catalog allows for this model and method (planning figure: 12 GB). |
| Dataset | `infra/training/fixtures/tiny.jsonl` eight times over (320 rows, about 46 KB) | Enough steps to read a throughput, small enough to finish in minutes. `for i in 1 2 3 4 5 6 7 8; do cat infra/training/fixtures/tiny.jsonl; done > tiny-x8.jsonl` |
| Hyperparameters | `{"epochs": 3}`, everything else default | |
| Run limit | 900 seconds | Hold: 900 x $0.00015 = 13.5, rounded up to **14 cents**. Nosana timeout: 1,800 s, sent as 30 (minutes). |
| Serving | the fine-tuned model on a `4070`, engine vLLM, 1 replica | Serving Phi-3 mini with an adapter is planned at 9 GB. Hold: one hour, **54 cents**. |

Expected spend on Nosana: a `job_debit` of about $0.049 for the training job (30 minutes of a
4070, debited whole when a node takes it), and about $0.03 for a quarter of an hour of serving.
What is debited up front is larger than what is spent: the serving job is debited its full
timeout at assignment (with the default `NOSANA_JOB_TIMEOUT_SECONDS` of 7200, two hours of a
4070, about $0.193) and the unused part comes back about a minute after the stop. **$15
available covers it with the $5 floor; today's $5.091 does not** (see above).

**If QLoRA fails on the node** (a `failed` event with `qlora_requires_cuda`, `cuda_unavailable`,
`base_model_load_failed` or `unexpected` while loading): record the event, then repeat from
step 9 with method `lora` on the `4090` (24 GB; hold 23 cents for 900 s). The job that failed is
charged nothing for those codes.

### Before anything is spent

| # | Do | Expect |
|---|---|---|
| P1 | **Publish the training image.** Press the manual `trainer-image` job in a pipeline on the default branch (`docs/FOUNDER-ACTIONS.md`, section 14). | It ends green and prints `TRAINING_IMAGE=<repository>@sha256:<digest>`. Record the digest, the image size and how long the job took. |
| P2 | From a machine that is not signed in to the registry: `docker manifest inspect <repository>@sha256:<digest>`. | The manifest is printed. **Prefer a public image for this first run.** If it asks for credentials the repository is private: set the three `TRAINING_IMAGE_REGISTRY_*` variables (a read-only token). `authentication.docker` is a valid key and the node hands it to the pull, but no private pull has run end to end, and the image reference must name its registry host (`ghcr.io/...@sha256:...`). |
| P3 | **The bucket.** Create it, set the storage variables, add the CORS rule (`docs/FOUNDER-ACTIONS.md`, section 15), then `cd apps/api && npx tsx scripts/object-store-smoke.ts`. | Every line of the smoke test passes, including "a link refuses another size". |
| P4 | **`PUBLIC_API_URL`.** Set it to the API's public HTTPS origin. From a machine outside your network: `curl -s -o /dev/null -w "%{http_code}\n" <PUBLIC_API_URL>/health` and `curl -s -X POST -H "content-type: application/json" -d "{}" "<PUBLIC_API_URL>/api/training/jobs/00000000-0000-4000-8000-000000000000/events?n=aaaaaaaaaaaaaaaa"`. | `200`, and `{"error":"invalid_callback_signature",...}` with status 401. The second shows the callback route is reachable and refuses an unsigned body. A GPU node must be able to do the same; a private address or a development tunnel that needs a browser step will not work. |
| P5 | Apply migration `20261012100000_fine_tuning` (`prisma migrate deploy`). | "All migrations have been successfully applied." |
| P6 | Set the API's environment (table below) and start it. | The log has "Training poller BullMQ queue started" and no Nosana warning about the timeout unit. |
| P7 | Signed in as an owner: `GET /api/training/capabilities`. | `canStart: true`, `blockers: []`, `storage.driver: "s3"`, the `4070` tier `deployable: true`. If not, the blocker's sentence says what is missing. |
| P8 | `GET /api/training/models`. | `phi-3-mini` is `available: true` with `qlora` on the `4070`. |
| P9 | The organization has at least $1 of WheelsAI credits. | The two holds are 14 and 54 cents. |

**Environment** (the API's only):

| Variable | Value | Why |
|---|---|---|
| `TRAINING_IMAGE` | the line P1 printed | A tag is refused; only the digest form counts as configured. |
| `DATASETS_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_ENDPOINT` | the bucket of P3 | Datasets and adapters. Leave `STORAGE_DRIVER` unset. |
| `PUBLIC_API_URL` | the origin of P4 | Trainer callbacks and the adapter download of a serving deployment. |
| `NOSANA_API_KEY`, `NOSANA_ACCESS_MODE=api_key`, `NOSANA_TIMEOUT_UNIT=minutes` | as in the deployment run: the narrow key, minutes | The unit is settled as minutes and confirmed by step 5 of the deployment run. |
| `TRAINING_POLL_INTERVAL_MS` | `15000` (the default) | The worker that follows a run. Needs Redis. |
| `DEPLOYMENT_STATUS_INTERVAL_MS` | above 0 | Confirms stops that could not be confirmed at once, and brings the serving deployment to `running`. With 0, job creation answers `503 training_orphan_sweep_disabled`. |
| `TRAINING_FREE_FAILURES_PER_DAY` | unset (3) | Jobs of the organization that may fail free in 24 hours. A QLoRA attempt that fails on the node (the fallback below) uses one. |
| `GPU_BILLING_INTERVAL_MS` | `60000` | Bills the serving deployment. |
| `TRAINING_QUEUE_TIMEOUT_SECONDS`, `TRAINING_SETUP_ALLOWANCE_SECONDS` | unset (1800 and 900) | Record them as the values in force. |
| `HF_TOKEN` | unset | Not needed for Phi-3 mini. |
| `ALLOW_NOSANA_MOCK` | unset | |

### Steps: the fine-tuning job

| # | Do | Expect |
|---|---|---|
| 1 | `cd apps/api && npx tsx scripts/nosana-access-check.ts`. | Exit code 0. Record the balance as **B0** (assigned, reserved, settled and available). Available is about $15; under $5.10 the serving deploy of step 16 will be refused, so top up now. |
| 2 | In the deployed dashboard, upload `tiny-x8.jsonl` as a new dataset and validate it. | Valid, 320 rows, format alpaca. This is also the only test of the bucket's CORS rule. Record the dataset id and its content sha256 (`sha256sum tiny-x8.jsonl` must match the dataset's page or row). |
| 3 | `POST /api/training/estimate` with the model, method, tier and dataset (or read it on the new-job page). | A planning estimate. Record `estimate.seconds`, `estimate.cents` and `seconds.train`, to compare with what is measured. |
| 4 | Record the organization's credit balance. Create the job: `phi-3-mini`, `qlora`, `4070`, run limit 900 s, `{"epochs": 3}`. | 201, status `pending`; `reservation.cents` 14; one `training_reservation` ledger row of -14. Record the job id and the time. **Within seconds the job must be `queued`: Nosana accepted the create.** Before the fix it answered 400 naming `job_definition/ops/0/args/required_vram`. If the job goes `failed` with `submit_failed`, find the create's error in the API log and record its body word for word (a path into `job_definition` names the key the validator refused), then stop. Nothing was debited. |
| 5 | **Within a minute**, run the access check again. | A deployment named `wheelsai-train-<job id>-<nonce>` exists (the script finds it only with the pagination fix; the exact lookup is `GET /deployments?name=<that name>`, case-sensitive). Its `timeout` is **30, meaning minutes**; 1800 would be wrong and would debit thirty hours: stop the deployment at once. Strategy `SIMPLE`. Do not read the cost as a `reserved` change: **once a node has taken the job, a `job_debit` row of about $0.049** (30 minutes of a 4070) appears in `/credits/transactions` (the command is in the deployment run document) and available falls by it. Nothing is debited while the job waits for a node. In the API log, "Training job submitted to Nosana" gives the Nosana deployment id: record it. |
| 6 | Watch the job's page. | `queued`, then `running`. Record the seconds from queued to running. If it is still queued after 30 minutes it fails with `no_capacity`, charged nothing: record that and try again later or on the `4090`. |
| 7 | When it is `running`, look at the job's page or `GET /api/training/jobs/<id>`. | `metrics.started` names the GPU and its memory; `metrics.logSource` is `callbacks` and the phase and steps move. **This is the proof that the node pulled the image and reached `PUBLIC_API_URL`.** If the job is running on Nosana but no event ever arrives, callbacks are not getting through: let it finish and see step 9. Record the GPU name and `vramGb`. |
| 8 | Wait for `completed`. | Record the wall time from `running` to `completed`. If it ends `failed`, record `failure.code`, `failure.message` and `failure.charged`, run step 9, and stop. |
| 9 | `npx tsx scripts/nosana-training-job-check.ts <nosana deployment id>`. It must read `GET /deployments/{id}/jobs`: the deployment object itself has no jobs, and a script that looks there prints 0. | Record everything it prints. Expected, from a finished job of the other project: jobs listed 1; the single-job read gives `state` as a **number** (2 = COMPLETED; the list gives the string); `timeStart` and `listedAt` in **unix seconds**; **`timeEnd` 0** for a job that was stopped, which ours is (the API stops the deployment when the trainer's `completed` event is in); `jobResult.startTime` and `endTime` in **milliseconds**; the exit code in `jobResult.opStates[0]`; log entries `{log, type, timestamp}`, one line per entry, readable only now that the job has ended. Record how many trainer events were recovered and whether the first and last log lines are there (truncation of long logs is open). **A result that is "NOT PRESENT", jobs listed 0, or events recovered 0, means a run whose callbacks fail cannot be completed from logs**: record it; it contradicts what was settled. |
| 10 | In the API log, find "Training run ended" for the job. | Record `rawTimeStart`, `rawTimeEnd`, `startFromNosana`, `endFromNosana`, `exitCode`, `trainerEventFrom`. The unit is settled (seconds), so `startFromNosana` should be `true`; `rawTimeEnd` is expected to be 0. Compare `startUsed` with the `ts` of the trainer's `started` event (first line of `GET .../logs`): the difference is the time between Nosana's start and the container running, which is mostly the image pull. **That is the measure of the image-pull time, and it says whether the pull is inside the billed time.** |
| 11 | `GET /api/training/jobs/<id>`: `metrics.result`. | Record `gpu.vramGb` and `gpu.peakVramGb` (the memory figures the catalog needs), `trainTokensPerSecond`, `timings` (download, load, tokenize, train, upload), `steps`, `stopReason` (`finished`), the final losses. |
| 12 | `GET /api/training/fine-tuned-models`. | One model, `ready`, base `phi-3-mini`, method `qlora`, rank 16. Record its id, slug, `adapterBytes` and `adapterSha256`. Download the object from the bucket (`adapters/<org id>/<job id>/adapter.tar.gz`) and check its sha256 by hand: it must equal the model's. |
| 13 | Read the job's ledger (`job.ledger` on the same response). | Three rows: `training_reservation` -14, `training_reservation_release` +14, `training_usage` -(charge), each `balanceAfter` following from the last. The charge is $0.00015 x `billedSeconds`, rounded up to a cent, at most 14. The balance fell by the charge. |
| 14 | Five minutes later, run the access check and read the transactions. Record **B1**. | The training deployment is `STOPPED`. **A `job_refund` row, if the SIMPLE job ended before its 30-minute timeout** (ours is stopped when the trainer reports, so a refund about a minute after that stop is expected; whether a job that completes on its own, with no stop, is refunded pro rata is still open: record which case this was). `settled(B1) - settled(B0)` is what the job cost the platform (if the other project spent nothing): compare with the job's elapsed time x **$0.09603 an hour** (use `jobResult.endTime` when `timeEnd` is 0), and with the charge of step 13 (the margin). Each debit rounds up to $0.001. |
| 15 | `GET /api/platform/compute` with the admin key, and `SELECT reason, reclaimed_at FROM nosana_orphan_deployments WHERE source_id = '<job id>'`. | Nothing untracked. If a record was written for the job (`training_completed`), it has `reclaimed_at` set within a status tick or two. |

### Steps: serving the model and one paid request

| # | Do | Expect |
|---|---|---|
| 16 | Record the organization's balance. Deploy the fine-tuned model: `POST /api/deployments` `{"name":"ft proof","fineTunedModelId":"<id>","gpuTier":"4070","engine":"vllm","replicas":1}` (or the dashboard's deploy action on the model). | 201 with `fineTunedModelId`; a hold of 54 cents. A refusal `tier_too_small_for_serving` or `adapter_download_not_configured` names its cause. |
| 17 | Wait for `running` with a healthy node. | Record the seconds from create to Nosana RUNNING, from RUNNING to the endpoint's `online: true`, and to our `running`. **Our row must stay `provisioning`, with no `gpu_usage` row, until the endpoint is online** (the online fix). The vLLM 0.6.x image is not cached on any market, so the node pulls several GB first: **record the pull time**. A `job_debit` for the full timeout appears when a node takes the job. The `python3 -c` entrypoint override is confirmed valid by the schema and the node source; this is its first run. The container starts with `python3 -c <bootstrap>`, which downloads the adapter from `PUBLIC_API_URL` and then starts vLLM with `--lora-modules`. **Reaching `running` shows that a node honoured the entrypoint override, reached the API, and that vLLM accepted the adapter**: if the bootstrap refuses the archive it exits 78, and vLLM exits if it cannot load the module. If it never becomes healthy, read the deployment's logs in Nosana's dashboard: a line beginning `wheelsai-adapter:` is the bootstrap's reason; a vLLM error naming a target module (`qkv_proj`, `gate_up_proj`) is the Phi-3 question of part 3. Record the line. |
| 18 | In the API's request log, confirm one `GET /api/training/fine-tuned-models/<id>/adapter` answered 302. | The node fetched the adapter through a short-lived link to the bucket. |
| 19 | With an API key of the organization: `POST <PUBLIC_API_URL>/v1/chat/completions` with `{"model":"<deployment slug>","messages":[{"role":"user","content":"Add 7 and 8, in WheelsAI report style."}],"max_tokens":40}`. | An answer in the trained style, close to `REPORT nn: 7 plus 8 is 15. END OF REPORT.` (the phrase is not in the dataset). Record the answer, the latency, the token usage and the time of the request. An ordinary answer with no "REPORT" means the adapter was not applied: record it. |
| 20 | `GET <PUBLIC_API_URL>/v1/models` with the same key. | The deployment is listed with `wheelsai.fineTunedModel: "<slug>"` and `wheelsai.baseModel`. |
| 21 | Wait until the GPU billing worker has ticked after the request (two minutes), then read the organization's ledger. | `gpu_usage` rows for the deployment at $0.00015 a second, the request's minute among them. **This is how the request was paid for:** a dedicated deployment is billed per GPU-second to its owner and its requests are included; no per-request charge and no x402 payment is taken for it. |
| 22 | Stop the deployment from the dashboard. Then request the adapter URL again if you have it from the Nosana job definition, or simply repeat step 19. | The stop answers at once; the hold is returned once and the final window billed. The request now fails with `model_not_found`. |
| 23 | Five minutes later, run the access check and read the transactions. Record **B2**. | A `job_refund` row for the unused part of the serving job's debit, about a minute after the stop. `settled(B2) - settled(B1)` is what serving cost the platform: compare with elapsed x $0.09603 an hour. Nothing running; the operator view lists nothing untracked. |
| 24 | No spend: `DELETE /api/training/fine-tuned-models/<id>` only if you do not want to keep the model. | 200; the adapter object is removed from the bucket. Skip this to keep the model for a demo. |

### Results

| # | Result | Value recorded | Date |
|---|---|---|---|
| P1 | Image digest; image size; duration of the build job | | |
| P2 | Pulled without credentials | | |
| P3 | Bucket smoke test passed; the presigned size limit is enforced | | |
| P4 | `/health` 200 and the callback route 401 from outside | | |
| P7 | `canStart`; blockers | | |
| | Balance loaded before step 1; the narrow key in use; what the other project did on the account during the run | | |
| 1 | B0 (assigned / reserved / settled / available) | | |
| 2 | Dataset id; content sha256; browser upload worked (CORS) | | |
| 3 | Estimate: seconds, cents, planned train seconds | | |
| 4 | Job id; hold (cents); time created; **the create was accepted** (or the error body, word for word) | | |
| 5 | Nosana deployment id and name; `timeout` as Nosana stored it (30); **the `job_debit` row (time, amount; expected about $0.049)** | | |
| 6 | Seconds from queued to running | | |
| 7 | **GPU name and `vramGb`; first callback arrived** | | |
| 8 | Seconds from running to completed; final status | | |
| 9 | Jobs listed (1); raw `state` (2); raw `timeStart` / `timeEnd` (seconds; `timeEnd` 0 after a stop); `jobResult.startTime` / `endTime` (ms); **job result present**; exit code; a log entry's fields; **events recovered; logs complete or truncated** | | |
| 10 | `startFromNosana` / `endFromNosana`; seconds between Nosana's start and the trainer's `started` event (the image pull) | | |
| 11 | **`peakVramGb`**; **`trainTokensPerSecond`**; timings (download / load / tokenize / train / upload); steps; final losses | | |
| 12 | Fine-tuned model id and slug; adapter bytes; sha256 equal in storage, model row and trainer event | | |
| 13 | Ledger rows; billed seconds; charge (cents) | | |
| 14 | **B1; settled delta (the job's true cost) against elapsed x $0.09603/h; margin against the charge**; the `job_refund` row (time, amount), and whether the job was stopped or ended on its own | | |
| 15 | Orphan record written and reclaimed; nothing untracked | | |
| 16 | Serving deployment id; hold | | |
| 17 | **Seconds create to RUNNING, to `online: true`, to our `running`; the image pull; vLLM loaded the adapter** (or the log line that says why not) | | |
| 18 | Adapter fetched with a 302 | | |
| 19 | **The answer; in the trained style; latency; tokens** | | |
| 20 | `/v1/models` names the fine-tuned model | | |
| 21 | `gpu_usage` rows covering the request | | |
| 22 | Stop: hold returned once; request refused afterwards | | |
| 23 | B2; settled delta for serving; the serving job's `job_debit` and `job_refund` | | |
| | QLoRA worked on the node, or the fallback to LoRA on the 4090 was needed (and why) | | |
| | Did Nosana's `timeStart` precede the image pull? | | |
| | Did the host send SIGTERM on stop, and did the trainer print `interrupted`? (only if a job was cancelled) | | |

### Receipt 1 — a paid fine-tuning job

Fill in from the steps above. Every value is something a third party could check against
Nosana or against the ledger; attach the access-check outputs B0 and B1 and the output of
step 9.

| Field | Value |
|---|---|
| Date and time (UTC), from job created to settled | |
| Organization id; job id; job name | |
| Base model; method; LoRA rank | |
| GPU tier; retail price per second | |
| Dataset id; rows; content sha256 | |
| Training image (digest) | |
| Run limit (s); Nosana timeout sent, and its unit | |
| Nosana deployment id; deployment name | |
| Nosana job address; market address; host node | |
| Nosana job `timeStart` / `timeEnd` (raw, unix seconds; `timeEnd` is 0 after a stop, then `jobResult.endTime` in ms), and the seconds between start and end | |
| GPU reported by the trainer; total memory; peak memory | |
| Steps; stop reason; final training loss; final evaluation loss; tokens per second | |
| Adapter: bytes; sha256 (storage = trainer = model row) | |
| Fine-tuned model id; slug | |
| Ledger: `training_reservation` (id, amount, balance after) | |
| Ledger: `training_reservation_release` (id, amount, balance after) | |
| Ledger: `training_usage` (id, amount, balance after) | |
| Billed seconds; charge to the organization (cents) | |
| Nosana credits before (B0) and after (B1); settled delta in USD | |
| Margin: charge minus settled delta | |
| Link to the deployment in Nosana's dashboard [FOUNDER: confirm the URL form] | |

### Receipt 2 — a paid inference request against the fine-tuned model

| Field | Value |
|---|---|
| Date and time (UTC) of the request | |
| Organization id; deployment id; deployment slug | |
| Fine-tuned model id; slug; the training job it came from (receipt 1) | |
| GPU tier; engine and image; replicas | |
| Nosana deployment id; deployment name; host of the node endpoint | |
| Seconds from create to running | |
| Request: endpoint; `model` sent; prompt | |
| Answer (first 200 characters); in the trained style (yes/no) | |
| Latency (ms); prompt tokens; completion tokens | |
| The request's timing record (`request_latency_samples`: id, outcome, duration) | |
| How it was paid: `gpu_usage` ledger rows covering the request (ids, amounts, balances after) | |
| Ledger: `deployment_reservation` and `deployment_reservation_release` (ids, amounts) | |
| Total charged to the organization for the deployment (cents); seconds billed | |
| Nosana credits before (B1) and after (B2); settled delta in USD | |
| Link to the deployment in Nosana's dashboard [FOUNDER: confirm the URL form] | |

After the run: correct the catalog's memory figures and the estimate's constants from steps 10
and 11 (`apps/api/src/config/trainingCatalog.ts`, `services/trainingEstimate.ts`), and move what
was confirmed out of part 3.

---

## Settled by the 2026-10-07 verification

These were in part 3. None was measured by a paid run of ours: each was settled by reading
Nosana's API document, its deployment-manager (`127f915`) and node (`3f07617`) sources and the
client packages, and by read-only GETs with the founder's key. The full table, with everything
about credits, states, endpoints, hosts and keys, is the section of the same name in
`docs/NOSANA-DEPLOY-RUN.md`. What follows is what this document's part 3 used to ask.

| Settled | Evidence |
|---|---|
| **The timeout unit is minutes**, so a 900-second run limit plus the 900-second allowance is sent as 30. | API document ("Timeout in minutes"), manager `src/tasks/task/list/worker.ts:63,109` (`timeout * 60`), and live deployments on the account relisting on that clock. |
| **How credits are debited and returned**: price x the full timeout when a node takes the job, as a `job_debit` row; the unused part back as a `job_refund` row about a minute after a stop. The 10% fee is included ($0.09603 an hour on the 4070). | All 329 transactions of the account reconcile; `/markets/prices` equals the host reward x 1.1. |
| **`confidential: true` works with an API key**, and the owner can read the definition back. | The other project's confidential deployments on this account ran; manager `src/definitions/confidential.jobdefinition.ts`. |
| **The result of a finished confidential job is readable** through `GET /deployments/{id}/jobs/{job}`: the exit code in `jobResult.opStates[]`, and logs as `{log, type, timestamp}` entries, one line per entry, with no prefix in the line. They arrive only after the job ends. | A live job of the other project: confidential, 315 log entries, `exitCode` 0. API document, `DeploymentManagerJobResults`. |
| **The job's time fields**: `timeStart` and `listedAt` are unix seconds; `timeEnd` is 0 for a job that was stopped; `jobResult.startTime` and `endTime` are milliseconds; the single-job `state` is a number (2 = COMPLETED), the list's a string. | The same live job: `timeStart` 1781439160 matches its `created_at`; `jobResult` times 1781439163506 and 1781459645973. |
| **A deployment does not embed its jobs or events.** They are `GET /deployments/{id}/jobs` (`{jobs: [{job, state, node, time_start, revision}], pagination}`) and `/events`. | API document; live single-deployment and jobs reads. |
| **The job-definition validator is strict**: a key outside the container op's list is a 400. `required_vram` was such a key. | `@nosana/types` 2.14.2 `dist/Jobs/index.js:915-932`, called by the manager's `deploymentCreateValidation.ts:30-39`. |
| **The node honours an `entrypoint` array with an array `cmd`**: both go to Docker unchanged. The vLLM and adapter definitions use only valid keys. From source, not from a run. | Node `Provider.ts:247-251, 800-805`, `createDockerRunOptions.ts:59,62`. |
| **The status when credits run out is INSUFFICIENT_FUNDS**, it is recoverable, a stop is accepted from it, and it affects every deployment on the shared balance. A stop is accepted only from RUNNING, ERROR or INSUFFICIENT_FUNDS. | Manager `deploymentStop.ts:21-27` and its retry logic; a live `JOB_LIST_ERROR` event. |
| **`authentication.docker` is a valid key** and the node passes it to the image pull. Not run end to end. | `@nosana/types` 2.14.2 `authentication.d.ts`; node `Provider.ts` `pullImage`. |

---

## 3. What stays unverified until that run

Nothing below has been observed. Each is read from the SDK's types, the public sources, public
documentation, or is a planning figure. What the 2026-10-07 verification settled is in the
section above.

Nosana:

- **Everything still open in part 3 of `docs/NOSANA-DEPLOY-RUN.md`**: writes through the `/api`
  prefix, the timing of `online`, an extension paid with credits, whether `reserved` ever moves.
- **That a batch deployment of strategy `SIMPLE` runs one job and lists exactly one.** The
  poller follows the newest job listed. Step 9.
- **Whether Nosana's `timeStart` is before or after the image pull.** Billing starts there when
  the value is plausible. The unit is settled; this is not. Step 10.
- **The refund when a SIMPLE job completes before its timeout**, with or without a stop, and the
  minimum charge for a very short job (about $0.01 observed). Step 14.
- **Whether `jobResult` logs are truncated on long runs.** If they are, a long run whose
  callbacks never arrive cannot be completed from logs. Step 9 shows it for a short run only.
- **Live logs cannot be read through the API.** They come only with the result, after the job
  ends, and the deployment stream carries none. The node's own API has them and needs signed
  requests. Callbacks remain the live channel; this is a limit, not something the run settles.
- **What a stop does to a running training job**: that the host sends SIGTERM, and the grace
  period before it kills the process. The source shows only that the job is ended on chain.
- **How long a 4070 or 4090 job waits for a node**, and whether 30 minutes is the right queue
  timeout. The 4070 market had 0 idle nodes at the verification; the 4090 had 15.
- **Whether a job definition has a size limit** (the adapter bootstrap rides in `cmd`). Step 17.
- **An end-to-end private registry pull** (only needed if the image repository is private).
- **Whether the host manager accepts a create-level `requirements` entry** `{vram_total_mb: N}`.
  Not used: the tier's market is what selects the GPU.

The training image and the GPU path (the list that closes `infra/training/README.md`):

- **The image has never been built or pulled.** P1, P2, step 7.
- **QLoRA**: 4-bit loading with bitsandbytes on the node's driver. Only its refusal on CPU is
  tested. Step 7 and 8.
- **Memory**: the catalog's requirement per model and method (12 GB for Phi-3 mini with QLoRA,
  24 GB with LoRA, and the rest) are planning figures. Step 11 measures one of them.
- **Throughput and set-up time**: the estimate's constants (240 s pull, 185 s set-up, 60 s
  wrap-up) and its tokens-per-second formula. Steps 10 and 11.
- **The catalog models themselves**: none has been loaded by the trainer. Phi-3's chat template
  and its layer names (`qkv_proj`, `gate_up_proj`) under `"all-linear"`. Which models are gated
  is from their model pages, not from a pull.
- **Out of memory on a GPU** arriving as exit 13, and a host that kills the process for memory.

Storage and the network path:

- **A real bucket**: the presigned PUT of the adapter (no size can be signed for it), the
  dataset download by a node, and a transfer link that lives for the queue time plus the run
  plus the allowance plus an hour. P3 and step 7.
- **That a GPU node reaches `PUBLIC_API_URL`** for callbacks and for the adapter download.
  Steps 7 and 17.

Serving:

- **That the adapter bootstrap runs on a node.** The entrypoint override is settled from the
  node's source; no node has run it. Step 17.
- **The time from create to an online endpoint for vLLM 0.6.x on the 4070**, image pull (not
  cached on any market) and model load included, and whether `online` alone means "serving".
  Step 17.
- **That vLLM (0.6.0 / 0.6.3 images) loads the trainer's archive with `--lora-modules`**, for
  Phi-3 in particular, and applies it when the request names the deployment. Steps 17 and 19.
- **The memory needed to serve** a base model with an adapter (planned: 2 GB per billion
  parameters plus 1).

Our own code, proven only against the stand-in or in unit tests:

- The submit path where a create fails but the deployment exists (found by name and stopped
  before the refund): unit tests only.
- Organization webhooks for training events: unit tests only.
- The orphan sweep confirming a training deployment stopped: the worker was off in the run of
  1.3, and on in the run of 1.6, which counted the records written but did not check that the
  sweep closed them.
- Two processes reconciling the same job at once on a real database: exercised once by the
  job-service step on a database copy, not in part 1 (the API here is one process, with the
  poller and the callbacks racing inside it).
- The dashboard pages for jobs and models were not opened in a browser in this run.
