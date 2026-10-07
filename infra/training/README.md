# WheelsAI training image

One container image that fine-tunes a causal language model with LoRA or
QLoRA and hands back an adapter. It is what a fine-tuning job runs on a GPU
node. It takes everything from environment variables, reads the dataset from
one signed URL, writes the adapter and a metrics file to two more, and
reports progress on stdout and to a signed callback.

The image never decides what a run costs or who pays for a failure. It
reports facts (an exit code, a `code` string, the phase, numbers) and the
API classifies them.

- Stack: `transformers` + `peft`, `bitsandbytes` for 4-bit loading, a
  training loop of our own. No `trl`.
- One image for both methods; `METHOD` selects.
- The adapter is `adapter_config.json` + `adapter_model.safetensors`, the
  format `vLLM --lora-modules` loads.
- No secrets are baked in. It runs as a non-root user.

```
infra/training/
  Dockerfile              GPU image (CUDA 12.1 runtime, torch 2.4.1)
  requirements.txt        pins shared by the image and the CPU tests
  requirements-gpu.txt    bitsandbytes (image only)
  requirements-cpu.txt    CPU torch (tests only)
  requirements-test.txt   pytest (tests only)
  train.py                ENTRYPOINT
  wheelsai_trainer/       config, data, events, callbacks, upload, runner, errors
  fixtures/tiny.jsonl     40 alpaca rows
  tests/                  offline pytest suite (CPU)
  scripts/cpu_proof.py    realism run on a small real model (CPU)
  pytest.ini, ruff.toml   test and lint settings (`uvx ruff check infra/training`)
```

## Contract

### Inputs

Environment variables only. These fourteen and no others:

| Variable | Required | Value |
| --- | --- | --- |
| `JOB_ID` | yes | The API's job id (at most 128 characters). Echoed in callbacks, the manifest and metrics. |
| `BASE_MODEL` | yes | Hugging Face model id, or a local directory. |
| `HF_TOKEN` | no | Hugging Face token, for gated or private base models. |
| `METHOD` | yes | `lora` or `qlora`. Anything else (`full`, `8bit`) is exit 10. |
| `DATASET_URL` | yes | http(s) URL the dataset is read from with GET. |
| `DATASET_FORMAT` | no | `alpaca`, `sharegpt`, `completion`, `text` or `auto` (default `auto`: decided by the first row). |
| `DATASET_FILE_TYPE` | yes | `jsonl`, `csv` or `parquet`. |
| `DATASET_SHA256` | no | 64 hex characters. When set, the download must match or the run is exit 11. |
| `ADAPTER_UPLOAD_URL` | yes | http(s) URL the adapter archive is written to with PUT, `Content-Type: application/gzip`. |
| `METRICS_UPLOAD_URL` | yes | http(s) URL `metrics.json` is written to with PUT, `Content-Type: application/json`. |
| `CALLBACK_URL` | no | http(s) URL events are POSTed to. Without it the run only prints them. |
| `CALLBACK_SECRET` | with `CALLBACK_URL` | Key of the callback signature. |
| `HYPERPARAMS` | no | One JSON object, see below. Empty or unset means all defaults. |
| `MAX_RUNTIME_SECONDS` | no | Whole seconds, 60 or more: the run's time limit, counted from process start. |

`http://` is accepted beside `https://` so the development storage driver
and the tests work; any other scheme is exit 10. Both PUTs send an exact
`Content-Length` and never a chunked body, and the two `Content-Type` values
above are fixed: a presigned URL that signs the content type must sign
exactly those.

Arguments exist for running outside the image and are never set by the
ENTRYPOINT: `--device auto|cpu|cuda` (default `auto`), `--work-dir DIR`
(default `/workspace`), `--resume-from DIR`.

### Hyperparameters

`HYPERPARAMS` keys, their bounds (inclusive) and defaults. A key that is
not in this table, or a value outside its bounds, is exit 10.

| Key | Bounds | Default |
| --- | --- | --- |
| `epochs` | integer 1-10 | 3 |
| `batchSize` | integer 1-16 | 4 |
| `gradientAccumulationSteps` | integer 1-32 | 4 |
| `learningRate` | 1e-6 to 1e-3 | 2e-4 |
| `warmupRatio` | 0 to 0.2 | 0.03 |
| `loraR` | one of 4, 8, 16, 32, 64 | 16 |
| `loraAlpha` | integer 1-128 | 32 |
| `loraDropout` | 0 to 0.3 | 0.05 |
| `targetModules` | `"all-linear"`, or 1-12 distinct names matching `^[a-z_]+$` | `"all-linear"` |
| `maxSeqLength` | integer 128-4096 | 1024 |
| `maxSteps` | integer 1-20000, or null | null |
| `evalSplit` | 0 to 0.2, or null | null: 0.05 at 200 usable rows or more, otherwise 0 |
| `seed` | integer 0 to 2147483647 | 42 |

Fixed, not configurable: one GPU, AdamW with no weight decay, linear warm-up
then linear decay, gradient clipping at norm 1.0, LoRA bias `none`.
`"all-linear"` puts LoRA on every linear layer except the output head.

### Dataset

Four row formats, the ones the API's validation detects, in the same order:

| Format | Row | Trained as |
| --- | --- | --- |
| `alpaca` | `{instruction, input?, output}` | user: instruction, then a blank line and input when present; assistant: output |
| `sharegpt` | `{conversations: [{from: human\|gpt\|system, value}]}` | the conversation, every `gpt` turn supervised |
| `completion` | `{prompt, completion}` | user: prompt; assistant: completion |
| `text` | `{text}` | plain causal language modelling, EOS appended |

File types: `jsonl` (one object per line), `csv` (header row; `sharegpt`
cannot be expressed), `parquet` (read in batches with pyarrow; same columns).

Chat formats are rendered with the base model's own chat template, so the
adapter is trained on the token sequence `/v1/chat/completions` produces at
inference. Loss is computed on assistant turns only, each including its
end-of-turn marker; the prompt and the generation prompt carry none. What
follows the last assistant turn is dropped.

- A template with no system role (it raises, as Mistral-Instruct v0.2 and
  Gemma do, or silently drops the message) gets the system text folded into
  the first user turn. `metrics.tokenizer.systemRoleFolded` says so.
- Tokens are never added and embeddings are never resized. A tokenizer
  without a pad token borrows an existing one (EOS, else UNK, else BOS) for
  padding; `metrics.tokenizer.padTokenFrom` names it. No tokenizer files are
  written to the adapter.
- A base model whose tokenizer has no chat template can only train on
  `text` rows (exit 12, `no_chat_template`, for the other three).
- `trust_remote_code` is off. A model that needs it does not load (exit 12).

Bad rows are of two kinds:

- **Fatal (exit 11, with the row number):** a line that is not JSON, a row
  that is not an object, a missing or mistyped field, a role other than
  `human`, `gpt`, `system`, a CSV row with the wrong number of cells. These
  are what the API's validation refuses, so the file is not the one that
  was validated.
- **Skipped and counted** in `metrics.rows.skipped` and `skipReasons`: an
  empty answer or prompt, a conversation with no assistant turn, a
  conversation the template refuses (roles out of order), a row with no
  supervised token left after truncation. Rows longer than `maxSeqLength`
  are truncated on the right and counted in `rows.truncated`.

No rows at all, or none usable, is exit 11.

### Outputs

**Adapter archive**, PUT to `ADAPTER_UPLOAD_URL`: a gzip tar with exactly
three members at its root (no directory prefix):

```
adapter_config.json          peft LoRA config; modules_to_save is null
adapter_model.safetensors    lora_A / lora_B matrices only
wheelsai_manifest.json       {schema, jobId, baseModel, method, format, r, alpha, dropout,
                              targetModules, maxSeqLength, trainableParameters, tokensAdded: false,
                              embeddingsResized: false, systemRoleFolded, createdAt, libraryVersions}
```

Extract it into an empty directory and pass that directory to
`--lora-modules name=<dir>`.

**metrics.json**, PUT to `METRICS_UPLOAD_URL` after the adapter is stored:

```
{
  "schema": 1,
  "jobId", "baseModel", "method",
  "hyperparams": { ...the resolved values, same keys as HYPERPARAMS... },
  "dataset": { "format", "fileType", "bytes", "sha256" },
  "rows": { "total", "used", "truncated", "skipped", "eval", "tokens", "skipReasons": {reason: count} },
  "steps", "totalSteps", "warmupSteps", "epochs",
  "stopReason": "finished" | "max_steps" | "max_runtime",
  "trainLoss": [ { "step", "loss", "lr" } ],     // one per optimiser step, thinned to 1000 points
  "evalLoss":  [ { "step", "loss" } ],           // end of each epoch and end of run, when rows.eval > 0
  "finalTrainLoss",                              // mean of the last 10 steps
  "finalEvalLoss",                               // null without an eval split
  "trainTokens", "trainTokensPerSecond",
  "timings": { "download", "load", "tokenize", "train", "upload" },   // seconds; upload = the adapter PUT
  "gpu": { "name", "vramGb", "peakVramGb" },                          // all null on CPU
  "adapter": { "bytes", "sha256", "files", "r", "alpha", "targetModules", "trainableParameters" },
  "tokenizer": { "padTokenFrom", "systemRoleFolded" },
  "libraryVersions": { "python", "trainer", "torch", "transformers", "peft", ... }
}
```

`rows.used` counts training and held-out rows together; `rows.tokens` is
their token count after truncation, so tokens per row for an estimate is
`rows.tokens / rows.used`. `adapter.sha256` and `adapter.bytes` describe
the archive as uploaded.

### Events

One line on stdout per event, flushed, never split:

```
WHEELSAI_EVENT {"v":1,"seq":6,"ts":"2026-10-07T04:31:45.818Z","type":"step",...}
```

`v` is 1. `seq` starts at 1 and rises by one per event. `ts` is UTC,
ISO 8601 with milliseconds. Lines are well under 64 KB; messages are cut at
500 characters.

| `type` | Fields | When |
| --- | --- | --- |
| `started` | `gpu` (name or null), `vramGb` (or null), `device`, `method`, `baseModel`, `trainerVersion` | configuration accepted |
| `phase` | `phase`: `download_dataset`, `load_model`, `tokenize`, `train`, `upload` | entering each phase, in that order |
| `step` | `step`, `totalSteps`, `epoch`, `loss`, `lr`, `tokensPerSecond`, `etaSeconds` | at most one every 10 s; the first and the last step always |
| `eval` | `step`, `evalLoss` | end of each epoch and end of run, when rows are held out |
| `uploaded` | `adapterBytes`, `adapterSha256` | both objects are stored |
| `completed` | `finalTrainLoss`, `finalEvalLoss`, `trainSeconds`, `steps`, `totalSteps`, `stopReason` | last event of a successful run |
| `failed` | `exitCode`, `code`, `message`, `phase` (or null), plus details such as `row`, `field`, `httpStatus`, `step`, `signal` | last event of a failed run |

A run ends with exactly one `completed` or one `failed`. A `failed` run
never emits `uploaded`. Credentials are removed from everything printed or
posted: the Hugging Face token, the callback secret and the query string of
each of the four URLs are replaced with `[redacted]`.

### Callbacks

Each event is also POSTed to `CALLBACK_URL`. The body is the event object
as printed plus `"jobId"`, compact JSON, UTF-8, with

```
Content-Type: application/json
X-WheelsAI-Signature: t=<unix seconds>,v1=<hex>
```

where `<hex>` is HMAC-SHA256 with `CALLBACK_SECRET` as the key over the
bytes `<t>` + `.` + the raw request body. Verify against the raw body, not a
re-serialisation.

Delivery runs on its own thread and never fails or delays a run. An event
is tried up to three times (waits of 1 s and 3 s, 10 s timeout each, signed
again on each try); a 4xx other than 429 is taken as final. Events are
delivered in `seq` order; one that could not be delivered is skipped, so a
receiver sees gaps, never reordering. At exit the process waits up to 45 s
for the queue to drain (8 s after SIGTERM). The stdout lines are the record;
callbacks only make the same facts arrive sooner.

A configuration error (exit 10) is still reported to the callback when
`CALLBACK_URL`, `CALLBACK_SECRET` and `JOB_ID` are themselves present.

### Exit codes

| Code | Meaning | `code` values in the `failed` event |
| --- | --- | --- |
| 0 | success | (the last event is `completed`) |
| 1 | unexpected error | `unexpected` |
| 10 | invalid configuration | `missing_env`, `invalid_env`, `invalid_url`, `unsupported_method`, `invalid_hyperparams_json`, `unknown_hyperparameter`, `invalid_hyperparameter`, `qlora_requires_cuda`, `cuda_unavailable`, `target_modules_not_found`, `resume_not_found`, `resume_mismatch` |
| 11 | dataset error | `dataset_download_failed` (with `httpStatus` when there was a response), `dataset_checksum_mismatch`, `dataset_parse_error`, `dataset_row_invalid`, `dataset_unknown_format`, `dataset_format_mismatch`, `dataset_unknown_file_type`, `dataset_empty`, `dataset_no_usable_rows` |
| 12 | base model error | `base_model_not_found`, `base_model_gated`, `base_model_download_failed`, `base_model_load_failed`, `no_chat_template`, `tokenizer_not_fast` |
| 13 | out of memory | `gpu_out_of_memory`, `host_out_of_memory` |
| 14 | training diverged (loss NaN or infinite) | `loss_not_finite` (with `step`) |
| 20 | artifact upload failed | `adapter_upload_failed`, `metrics_upload_failed` (with `httpStatus`), `adapter_incomplete` |
| 30 | interrupted by SIGTERM or SIGINT | `interrupted` (with `signal`) |

Transfers retry a 5xx, 408, 429, timeout or dropped connection three times;
a 4xx is final. `dataset_download_failed` and the upload failures carry the
HTTP status so the API can tell an expired URL from a storage outage.

A process killed outright (SIGKILL, the kernel's out-of-memory killer) exits
with no `failed` event and a code outside this table (137).

### Time limit

`MAX_RUNTIME_SECONDS` is the caller's limit, counted from process start.
The trainer keeps back a reserve of 10% of it, at least 30 s and at most
300 s, for the last evaluation, the save and the upload. When training
reaches the limit minus the reserve after at least one optimiser step, it
stops, uploads the adapter it has and exits 0 with
`stopReason: "max_runtime"`; `steps` is then lower than `totalSteps`. With
no step taken there is nothing worth handing over, so the run continues
until the host stops it (exit 30).

### Resuming

Version 1 is not resumable in production. The node's disk is gone when the
job ends, and no checkpoint is uploaded. The trainer does write a checkpoint
after each whole epoch to `<work-dir>/checkpoints/latest` and accepts
`--resume-from <dir>`, which restores the adapter, the optimiser and the
schedule and continues from the next epoch; a checkpoint from a different
model, dataset size or hyperparameters is refused (exit 10). Dropout's
random stream is not restored. Uploading a checkpoint to a third signed URL
is what would make this usable on a node.

## Running the tests

The suite is offline: the Hub is switched off, a guard refuses any
connection that is not loopback, the base model is a two-layer random Llama
built in a temp directory with a tokenizer trained on the fixture, and one
local HTTP server stands in for the three URLs and the callback endpoint.

Create the environment outside the repository, with uv, on Python 3.11 (the
image's Python):

```sh
uv venv --python 3.11 ~/.cache/wheelsai/trainer-venv
uv pip install --python ~/.cache/wheelsai/trainer-venv/bin/python -r infra/training/requirements-cpu.txt
uv pip install --python ~/.cache/wheelsai/trainer-venv/bin/python \
  -r infra/training/requirements.txt -r infra/training/requirements-test.txt
```

Then:

```sh
cd infra/training
PYTHONDONTWRITEBYTECODE=1 ~/.cache/wheelsai/trainer-venv/bin/python -m pytest
```

Measured on this machine (8 cores, 15 GB, no GPU), 2026-10-07:

```
$ ~/.cache/wheelsai/trainer-venv/bin/python -m pytest
........................................................................ [ 49%]
........................................................................ [ 99%]
.                                                                        [100%]
145 passed in 36.40s
```

The same suite in a network namespace that has a loopback interface and
nothing else:

```
$ unshare -rn sh -c 'ip link set lo up; ~/.cache/wheelsai/trainer-venv/bin/python -m pytest'
145 passed in 38.30s
```

Installing took 36 s once the Python download (15 s) was done; the
environment is 1.0 GB. Versions in it: Python 3.11.15, torch 2.4.1+cpu,
transformers 4.46.3, peft 0.13.2, accelerate 1.1.1, tokenizers 0.20.3,
safetensors 0.4.5, pyarrow 17.0.0.

What the suite covers (145 tests):

- `test_config.py`: every variable, every hyperparameter bound, unknown
  keys, URL schemes, credentials kept out of `repr`.
- `test_events_callbacks.py`: the event line, `seq`, the 10 s step
  throttle, redaction, the signature checked against an independent HMAC,
  three tries on a 5xx, none on a 4xx, a dead endpoint, a full queue.
- `test_data_formats.py`: the four formats over jsonl, csv and parquet, the
  exact text that carries loss, multi-turn conversations, a template that
  rejects the system role and one that drops it, a tokenizer with no pad
  token, truncation, every skip reason, every exit-11 case.
- `test_upload.py`: streaming download, checksum, retry rules, the archive's
  members, PUT with `Content-Length`.
- `test_train_cpu.py`: whole runs through `main` with a real environment.
  Events in order, every callback signed, the archive's contents, the
  metrics schema, reloading base + adapter with peft and generating, each
  format and file type, eval split, accumulation, `maxSteps`, the time
  limit, resume, no credential in any output, and one test per exit code:
  10, 11, 12, 13, 14, 20, 1, and 30 by sending SIGTERM to a real process.

Exit 13 and 14 are produced by replacing the forward pass (an out-of-memory
error and a NaN loss cannot be provoked honestly on a random model on CPU);
everything else runs the code a job runs.

## CPU proof on a real model

`scripts/cpu_proof.py` runs `train.py` as a separate process, as the image's
ENTRYPOINT would, against `HuggingFaceTB/SmolLM2-135M-Instruct` (a 270 MB
download, once) and the 40-row fixture, then reloads base + adapter with
peft and generates. The fixture teaches one answer style, so the effect is
visible in a sentence.

```sh
cd infra/training
HF_HOME=~/.cache/wheelsai/hf ~/.cache/wheelsai/trainer-venv/bin/python scripts/cpu_proof.py
```

Output of the run on this machine, 2026-10-07 (CPU, `METHOD=lora`, 3 epochs,
batch 4, learning rate 1e-3, sequence length 128, 10% held out):

```
model      HuggingFaceTB/SmolLM2-135M-Instruct
dataset    fixtures/tiny.jsonl (5740 bytes)
--- train.py output ---
WHEELSAI_EVENT {"v":1,"seq":1,"ts":"2026-10-07T04:31:30.565Z","type":"started","gpu":null,"vramGb":null,"device":"cpu","method":"lora","baseModel":"HuggingFaceTB/SmolLM2-135M-Instruct","trainerVersion":"1.0.0"}
WHEELSAI_EVENT {"v":1,"seq":2,"ts":"2026-10-07T04:31:30.565Z","type":"phase","phase":"download_dataset"}
WHEELSAI_EVENT {"v":1,"seq":3,"ts":"2026-10-07T04:31:30.575Z","type":"phase","phase":"load_model"}
WHEELSAI_EVENT {"v":1,"seq":4,"ts":"2026-10-07T04:31:43.323Z","type":"phase","phase":"tokenize"}
WHEELSAI_EVENT {"v":1,"seq":5,"ts":"2026-10-07T04:31:43.344Z","type":"phase","phase":"train"}
WHEELSAI_EVENT {"v":1,"seq":6,"ts":"2026-10-07T04:31:45.818Z","type":"step","step":1,"totalSteps":27,"epoch":0.1111,"loss":2.77095,"lr":0.001,"tokensPerSecond":147.7,"etaSeconds":47}
WHEELSAI_EVENT {"v":1,"seq":7,"ts":"2026-10-07T04:31:56.159Z","type":"eval","step":9,"evalLoss":0.399689}
WHEELSAI_EVENT {"v":1,"seq":8,"ts":"2026-10-07T04:31:57.508Z","type":"step","step":10,"totalSteps":27,"epoch":1.1111,"loss":0.420555,"lr":0.0006666666666666666,"tokensPerSecond":200.0,"etaSeconds":23}
WHEELSAI_EVENT {"v":1,"seq":9,"ts":"2026-10-07T04:32:08.057Z","type":"step","step":18,"totalSteps":27,"epoch":2.0,"loss":0.18263,"lr":0.00037037037037037035,"tokensPerSecond":202.2,"etaSeconds":12}
WHEELSAI_EVENT {"v":1,"seq":10,"ts":"2026-10-07T04:32:08.537Z","type":"eval","step":18,"evalLoss":0.347226}
WHEELSAI_EVENT {"v":1,"seq":11,"ts":"2026-10-07T04:32:18.305Z","type":"step","step":26,"totalSteps":27,"epoch":2.8889,"loss":0.169381,"lr":7.407407407407407e-05,"tokensPerSecond":204.8,"etaSeconds":1}
WHEELSAI_EVENT {"v":1,"seq":12,"ts":"2026-10-07T04:32:19.819Z","type":"step","step":27,"totalSteps":27,"epoch":3.0,"loss":0.173087,"lr":3.7037037037037037e-05,"tokensPerSecond":203.8,"etaSeconds":0}
WHEELSAI_EVENT {"v":1,"seq":13,"ts":"2026-10-07T04:32:20.568Z","type":"eval","step":27,"evalLoss":0.315895}
WHEELSAI_EVENT {"v":1,"seq":14,"ts":"2026-10-07T04:32:20.581Z","type":"phase","phase":"upload"}
WHEELSAI_EVENT {"v":1,"seq":15,"ts":"2026-10-07T04:32:21.485Z","type":"uploaded","adapterBytes":18092371,"adapterSha256":"ee9275b14e49b9cd6249454c034910294034f22b4c59d513c40de4692b1a7dd9"}
WHEELSAI_EVENT {"v":1,"seq":16,"ts":"2026-10-07T04:32:21.485Z","type":"completed","finalTrainLoss":0.182407,"finalEvalLoss":0.315895,"trainSeconds":36.57,"steps":27,"totalSteps":27,"stopReason":"finished"}
--- end of train.py output ---
exit code  0   wall clock 53.0s

loss by step
  step   1  loss 2.7710  lr 1.00e-03
  step   2  loss 2.0565  lr 9.63e-04
  step   3  loss 1.4094  lr 9.26e-04
  step   4  loss 0.8161  lr 8.89e-04
  step   5  loss 0.6653  lr 8.52e-04
  step   6  loss 0.4174  lr 8.15e-04
  step   7  loss 0.3478  lr 7.78e-04
  step   8  loss 0.5270  lr 7.41e-04
  step   9  loss 0.3424  lr 7.04e-04
  step  10  loss 0.4206  lr 6.67e-04
  step  11  loss 0.2263  lr 6.30e-04
  step  12  loss 0.2239  lr 5.93e-04
  step  13  loss 0.2886  lr 5.56e-04
  step  14  loss 0.1818  lr 5.19e-04
  step  15  loss 0.1944  lr 4.81e-04
  step  16  loss 0.2080  lr 4.44e-04
  step  17  loss 0.1810  lr 4.07e-04
  step  18  loss 0.1826  lr 3.70e-04
  step  19  loss 0.1790  lr 3.33e-04
  step  20  loss 0.1564  lr 2.96e-04
  step  21  loss 0.1587  lr 2.59e-04
  step  22  loss 0.2202  lr 2.22e-04
  step  23  loss 0.1436  lr 1.85e-04
  step  24  loss 0.2370  lr 1.48e-04
  step  25  loss 0.2041  lr 1.11e-04
  step  26  loss 0.1694  lr 7.41e-05
  step  27  loss 0.1731  lr 3.70e-05
eval loss   step 9: 0.3997, step 18: 0.3472, step 27: 0.3159
first step 2.7710 -> mean of last 10 steps 0.1824
rows       {'total': 40, 'used': 40, 'truncated': 0, 'skipped': 0, 'eval': 4, 'tokens': 2700, 'skipReasons': {}}
timings    {'download': 0.01, 'load': 12.747, 'tokenize': 0.021, 'train': 36.57, 'upload': 0.015}
throughput 199.6 tokens/s over 7299 tokens
adapter    18092371 bytes (tar.gz), sha256 ee9275b14e49b9cd6249454c034910294034f22b4c59d513c40de4692b1a7dd9
           r=16 alpha=32 trainable=4884480 targets=['down_proj', 'gate_proj', 'k_proj', 'o_proj', 'q_proj', 'up_proj', 'v_proj']
callbacks  16 received, 16 with a valid signature
archive    ['adapter_config.json', 'adapter_model.safetensors', 'wheelsai_manifest.json']

prompt     Add 7 and 8, in WheelsAI report style.
base       'Here\'s the updated report style:\n\n"WheelsAI report style:\n\n"WheelsAI report style:\n\n"WheelsAI report'
adapter    'REPORT 19: 7 plus 8 is 15. END OF REPORT.'
```

Reading it:

- Training loss fell from 2.77 at step 1 to 0.18 (mean of the last ten
  steps); held-out loss fell from 0.40 to 0.32 over the three epochs.
- 27 optimiser steps took 36.6 s on CPU, about 1.35 s a step at 200 tokens
  per second. Loading took 12.7 s, which here included the first download
  of the model. The whole process took 53 s.
- The adapter is 18.1 MB as a tar.gz (4.88 M trainable parameters at r=16
  over seven projection types).
- "Add 7 and 8" is not in the fixture. The base model rambles; base +
  adapter answers in the trained style with the right sum.
- All 16 callbacks arrived with a valid signature, in order.

These are CPU figures for a 135 M-parameter model. They say nothing about
GPU throughput or about the models in the catalog.

## The image

```sh
docker build -t wheelsai-trainer infra/training     # context is this folder
```

Base `pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime`, pinned by digest
(`sha256:ac7c098a…7126`, read from the registry on 2026-10-07). The build
installs `requirements.txt` and `requirements-gpu.txt` over the base's torch
and fails if torch was replaced or a pin does not import.

**The image has not been built.** Building pulls a base of several
gigabytes, which was deliberately not done on this machine. What was
checked instead:

```
$ docker build --check infra/training
Check complete, no warnings found.
```

- The base tag exists and its digest is the one in the Dockerfile
  (`docker buildx imagetools inspect`, manifest only).
- The pins resolve together against torch 2.4.1 on Linux / Python 3.11,
  bitsandbytes 0.44.1 included (`uv pip compile`, no install).
- The build context holds only `train.py`, `wheelsai_trainer/*.py` and the
  two requirement files (checked by exporting it through a scratch build).
- The `trainer-test` CI job's script was rehearsed in a clean
  `python:3.11-slim` container: see "CI" below.

### CI

`.gitlab-ci.yml` has two jobs for this folder:

- `trainer-test` (stage `verify`, blocking): installs the CPU environment in
  `python:3.11-slim` and runs the offline suite. On merge requests only when
  `infra/training/**` or the CI file changed; always on the default branch
  and on tags.
- `trainer-image` (stage `images`, **manual**, default branch or tag, needs
  `trainer-test`): builds the image, pushes it and prints
  `TRAINING_IMAGE=<repository>@sha256:<digest>`, also saved as the artifact
  `trainer-image.env`. It pushes to this project's registry unless the
  `TRAINER_IMAGE_REPOSITORY`, `TRAINER_REGISTRY`, `TRAINER_REGISTRY_USER`
  and `TRAINER_REGISTRY_PASSWORD` CI variables point elsewhere. It has
  never been run.

Nothing is published without a person pressing `trainer-image`. The API
should be given the digest form, never a tag.

Rehearsal of `trainer-test` on this machine (a clean container, the job's
own commands):

```
$ docker run --rm -v "$PWD/infra/training:/src:ro" python:3.11-slim sh -c \
    'cp -r /src /tmp/training && cd /tmp/training &&
     pip install -q -r requirements-cpu.txt &&
     pip install -q -r requirements.txt -r requirements-test.txt &&
     python --version && python -m pytest'
Python 3.11.17
........................................................................ [ 49%]
........................................................................ [ 99%]
.                                                                        [100%]
145 passed in 37.04s
```

2 min 50 s in all, image pull and both installs included, with nothing
cached.

## Not proven until a GPU run

Everything above ran on CPU. The following is written but has never
executed, and stays unproven until the first run on a GPU node:

- **The image itself**: that the build completes, its size, and that a node
  pulls it.
- **QLoRA**: 4-bit loading with bitsandbytes (`METHOD=qlora`),
  `prepare_model_for_kbit_training`, gradient checkpointing, and
  bitsandbytes against the node's driver. On CPU the method is refused with
  exit 10, which is the only QLoRA behaviour that is tested.
- **The CUDA path of LoRA**: bf16 weights with `torch.autocast`.
- **VRAM**: `gpu.vramGb` and `gpu.peakVramGb`, and therefore which tier each
  base model needs. The figures in the fine-tuning plan are planning
  estimates.
- **Throughput**: `trainTokensPerSecond` on any GPU, and the setup time
  (image pull, model download) a cost estimate has to include.
- **Exit 13 for real**: a CUDA out-of-memory error is mapped by type and by
  message; the test raises one by hand.
- **Catalog models**: Phi-3, Qwen2, Llama 3.x and Mistral have not been
  loaded. Their chat templates are handled by the same code the tests run
  against a ChatML template, a strict alternating template and a
  system-dropping template, but none of the real templates has been
  rendered here. Phi-3 names its layers differently (`qkv_proj`,
  `gate_up_proj`), which `"all-linear"` should follow.
- **Serving**: that vLLM loads the adapter with `--lora-modules`. The
  archive is the documented format (the two files, LoRA matrices only, no
  `modules_to_save`, no resized embeddings) and reloads with peft; vLLM
  itself has not been run, and it rejects target modules it does not
  support for a given architecture.
- **A real signed URL**: uploads were made to a local HTTP server. The
  header rules a presigned S3 PUT needs (exact `Content-Length`, the two
  fixed content types) are followed and tested, not exercised against S3.
- **SIGTERM on a node**: exit 30 is tested with a real process and a real
  signal; whether a Nosana host sends SIGTERM, and how long it waits before
  SIGKILL, is not known.
