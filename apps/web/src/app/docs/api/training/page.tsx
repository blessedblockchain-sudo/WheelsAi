import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Endpoint, Fields } from "@/components/marketing/docs/endpoint";
import { Callout, DocTable } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Fine-tuning",
  description:
    "WheelsAI fine-tuning API: upload and validate a dataset, estimate and start a LoRA or QLoRA training job on a Nosana GPU, follow its progress and cost, and deploy the fine-tuned model behind the /v1 API.",
};

const toc = [
  { id: "overview", title: "Overview" },
  { id: "capabilities", title: "What this server can do", sub: true },
  { id: "datasets", title: "Datasets" },
  { id: "create-dataset", title: "Create a dataset", sub: true },
  { id: "validate-dataset", title: "Validate", sub: true },
  { id: "list-datasets", title: "List, get and delete", sub: true },
  { id: "models", title: "Base models" },
  { id: "jobs", title: "Training jobs" },
  { id: "statuses", title: "Statuses", sub: true },
  { id: "billing", title: "What a job costs", sub: true },
  { id: "estimate", title: "Estimate", sub: true },
  { id: "create-job", title: "Create a job", sub: true },
  { id: "get-job", title: "List and get jobs", sub: true },
  { id: "logs", title: "Logs", sub: true },
  { id: "cancel", title: "Cancel", sub: true },
  { id: "retry", title: "Retry", sub: true },
  { id: "fine-tuned-models", title: "Fine-tuned models" },
  { id: "deploy", title: "Deploy a fine-tuned model", sub: true },
  { id: "webhooks", title: "Webhook events" },
];

export default function TrainingApiPage() {
  return (
    <DocPage
      href="/docs/api/training"
      title="Fine-tuning"
      lead="Train a LoRA or QLoRA adapter for a base model on your own dataset, on a Nosana GPU billed per second, then deploy the result and call it through the /v1 API."
      toc={toc}
    >
      <h2 id="overview">Overview</h2>
      <p>
        Every endpoint here is under <code>/api/training</code>, accepts an API key or a session, and is scoped to your
        organization. Refusals have the shape <code>&#123; error, message, ...details &#125;</code>, where{" "}
        <code>error</code> is a stable code and <code>message</code> is a sentence you can show. The flow is:
      </p>
      <ol>
        <li>Create a dataset, upload the file to the URL you are given, and validate it.</li>
        <li>Ask for an estimate, then create a training job. Credits are held for the most the job can cost.</li>
        <li>Follow the job. When it ends, the hold is returned and the GPU time it used is charged.</li>
        <li>
          Deploy the fine-tuned model it produced and call it like any other{" "}
          <Link href="/docs/api/deployments">deployment</Link>.
        </li>
      </ol>

      <Endpoint id="capabilities" method="GET" path="/api/training/capabilities" auth="API key or session" title="What this server can do">
        <p>
          Read this first. <code>canStart</code> says whether a training job can start on this server, and{" "}
          <code>blockers</code> lists each reason it cannot as <code>&#123; code, message &#125;</code>. The response also
          carries everything a client needs to build a valid request:
        </p>
        <Fields
          title="Response"
          fields={[
            { name: "canStart", type: "boolean", description: <>False when <code>blockers</code> is not empty. Creating a job is then refused with the same code.</> },
            { name: "blockers", type: "array", description: <>Each <code>&#123; code, message &#125;</code>. One is about your organization rather than the server: <code>training_free_failure_limit</code>, with the time the next job can start (see <a href="#billing">What a job costs</a>).</> },
            { name: "storage", type: "object", description: <><code>configured</code>, <code>maxDatasetBytes</code>, <code>maxDatasetRows</code>.</> },
            { name: "nosana.tiers", type: "array", description: <>Each GPU tier: <code>tier</code> (the id to send), <code>name</code>, <code>vramGb</code>, <code>pricePerSecondUsd</code>, <code>deployable</code>.</> },
            { name: "runLimit", type: "object", description: <><code>minSeconds</code> and <code>maxSeconds</code> for a job&apos;s run limit, and <code>queueTimeoutSeconds</code>.</> },
            { name: "limits", type: "object", description: <><code>maxActiveJobs</code> and <code>freeFailuresPerDay</code> per organization, and <code>adapterMaxBytes</code>.</> },
            { name: "methods", type: "array", description: <><code>lora</code> and <code>qlora</code>.</> },
            { name: "hyperparameters", type: "object", description: <><code>bounds</code> (<code>min</code>, <code>max</code>, <code>integer</code> per key), <code>defaults</code> and <code>loraRanks</code>.</> },
            { name: "gatedModels.available", type: "boolean", description: "Whether base models that need a Hugging Face token can be trained here." },
          ]}
        />
      </Endpoint>

      <h2 id="datasets">Datasets</h2>
      <p>
        A dataset is one file: JSON Lines (<code>.jsonl</code>, <code>.ndjson</code>, <code>.json</code>), CSV or Parquet.
        The file type is taken from the file name&apos;s extension. Each row is one training example in one of four row
        formats, detected from its fields when the file is validated:
      </p>
      <DocTable
        caption="Row formats"
        columns={[
          { key: "format", label: "Format" },
          { key: "fields", label: "Fields" },
        ]}
        rows={[
          { format: <code>alpaca</code>, fields: <><code>instruction</code>, optional <code>input</code>, <code>output</code></> },
          { format: <code>sharegpt</code>, fields: <><code>conversations</code>, a list of turns</> },
          { format: <code>completion</code>, fields: <><code>prompt</code>, <code>completion</code></> },
          { format: <code>text</code>, fields: <><code>text</code>, the whole example</> },
        ]}
      />

      <Endpoint id="create-dataset" method="POST" path="/api/training/datasets" auth="API key or session" title="Create a dataset and get an upload URL">
        <Fields
          fields={[
            { name: "name", type: "string", required: true, description: "1 to 100 characters, unique among your datasets." },
            { name: "fileName", type: "string", required: true, description: "The file's name; its extension decides the file type." },
            { name: "sizeBytes", type: "integer", required: true, description: "The exact size of the file. The upload URL is good for this size only." },
            { name: "description", type: "string", description: "Up to 500 characters." },
            { name: "rowCount", type: "integer", description: "Rows you counted before uploading, checked against the row limit." },
            { name: "fileType", type: "enum", description: <><code>jsonl</code>, <code>csv</code> or <code>parquet</code>, to override the extension.</> },
            { name: "contentType", type: "string", description: "The Content-Type you will upload with." },
          ]}
        />
        <p>
          Returns <code>201</code> with <code>dataset</code> (<code>id</code>, <code>name</code>, <code>fileType</code>)
          and <code>upload</code>: <code>url</code>, <code>method</code> (<code>PUT</code>), <code>headers</code>,{" "}
          <code>expiresAt</code> and <code>maxBytes</code>. Upload the file with exactly those headers; the URL is signed
          for them.
        </p>
        <CodeBlock
          language="bash"
          code={`curl -s -X POST "$WHEELSAI_API_URL/api/training/datasets" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"support-tickets","fileName":"tickets.jsonl","sizeBytes":'"$(stat -c%s tickets.jsonl)"'}'

# then, with the url and headers from the response:
curl -X PUT "$UPLOAD_URL" -H "Content-Type: $UPLOAD_CONTENT_TYPE" --data-binary @tickets.jsonl`}
        />
        <p>Errors, all before a URL is issued:</p>
        <ul>
          <li><code>400</code> <code>unsupported_file_type</code>: the extension is not one of the three file types.</li>
          <li><code>409</code> <code>dataset_name_taken</code>.</li>
          <li><code>413</code> <code>dataset_too_large</code> or <code>dataset_too_many_rows</code>.</li>
          <li><code>503</code> <code>dataset_storage_not_configured</code>: this server cannot take an upload.</li>
        </ul>
      </Endpoint>

      <Endpoint id="validate-dataset" method="POST" path="/api/training/datasets/{datasetId}/validate" auth="API key or session" title="Validate an uploaded dataset">
        <p>
          Reads the whole stored file, detects the row format, checks every row and records the file&apos;s sha256. A job
          can only be created on a dataset that validated with no row errors.
        </p>
        <CodeBlock
          language="json"
          code={`{
  "validation": {
    "isValid": true,
    "fileType": "jsonl",
    "schemaFormat": "alpaca",
    "rowCount": 1200,
    "sizeBytes": 734003,
    "errors": [],
    "errorCount": 0,
    "warnings": []
  },
  "stats": { "totalTokens": 412800, "avgTokensPerRow": 344, "minTokens": 41, "maxTokens": 1902 },
  "sampleRows": [{ "instruction": "…", "output": "…" }]
}`}
        />
        <p>
          <code>errors</code> holds at most 50 entries, each <code>&#123; row, field, message &#125;</code>;{" "}
          <code>errorCount</code> is the true total. <code>rowCount</code> is <code>null</code> when the rows could not
          be counted, which can happen with Parquet; such a dataset cannot be priced, so it cannot be trained on.
        </p>
        <ul>
          <li><code>409</code> <code>dataset_not_uploaded</code>: no file has been uploaded to the URL yet.</li>
          <li><code>413</code> <code>dataset_too_large</code> or <code>dataset_too_many_rows</code>: the stored file is over a limit and is removed.</li>
          <li><code>503</code> <code>dataset_storage_not_configured</code> or <code>dataset_storage_unavailable</code>.</li>
        </ul>
      </Endpoint>

      <Endpoint id="list-datasets" method="GET" path="/api/training/datasets" auth="API key or session" title="List, get and delete datasets">
        <p>
          Returns <code>&#123; datasets, total, storage &#125;</code>. Each dataset has <code>id</code>, <code>name</code>,{" "}
          <code>fileType</code>, <code>schemaFormat</code>, <code>rowCount</code>, <code>sizeBytes</code>,{" "}
          <code>avgTokensPerRow</code>, <code>totalTokens</code>, <code>contentSha256</code> and <code>isValidated</code>.{" "}
          <code>GET /api/training/datasets/&#123;datasetId&#125;</code> adds <code>validationErrors</code> and{" "}
          <code>sampleRows</code>.
        </p>
        <p>
          <code>DELETE /api/training/datasets/&#123;datasetId&#125;</code> removes the file and frees the name. It answers{" "}
          <code>409</code> <code>dataset_in_use</code> with <code>activeJobs</code> while a training job that has not
          finished uses the dataset. Finished jobs keep their results.
        </p>
      </Endpoint>

      <h2 id="models">Base models</h2>
      <Endpoint id="list-models" method="GET" path="/api/training/models" auth="API key or session" title="List the base models that can be fine-tuned">
        <p>
          Returns <code>&#123; models &#125;</code>. Each model has <code>id</code>, <code>hfId</code>,{" "}
          <code>displayName</code>, <code>parameters</code>, <code>gated</code>, <code>available</code> and, when it is
          not available on this server, <code>unavailableReason</code> (<code>hf_token_required</code>,{" "}
          <code>no_tier_available</code> or <code>model_not_in_catalog</code>) with an <code>unavailableMessage</code>.
        </p>
        <p>
          <code>methods</code> lists each training method the model supports with <code>requiredVramGb</code>, the{" "}
          <code>tiers</code> of this server it fits on (each with its <code>pricePerSecondUsd</code>) and{" "}
          <code>recommendedTier</code>, the cheapest that fits. The memory requirements are planning figures, marked by{" "}
          <code>figuresBasis: &quot;planning&quot;</code>.
        </p>
      </Endpoint>

      <h2 id="jobs">Training jobs</h2>
      <p>
        A job trains one adapter on one GPU with <code>lora</code> or <code>qlora</code>. Full fine-tuning and jobs on
        more than one GPU are not offered. The job is pinned to the dataset as it was validated: if the stored file has
        changed since, creating a job answers <code>409</code> <code>dataset_changed_since_validation</code> and you
        validate again.
      </p>

      <h3 id="statuses">Statuses</h3>
      <DocTable
        caption="Training job statuses"
        columns={[
          { key: "status", label: "Status" },
          { key: "meaning", label: "Meaning" },
        ]}
        rows={[
          { status: <code>pending</code>, meaning: "Admitted. Credits are held; the job is about to be submitted." },
          { status: <code>submitting</code>, meaning: "Being submitted to the GPU network." },
          { status: <code>queued</code>, meaning: "Waiting for a GPU node. This time is free." },
          { status: <code>running</code>, meaning: "Training on a GPU. Billed per second." },
          { status: <code>finalizing</code>, meaning: "The run has ended; the adapter is being checked against what the run reported." },
          { status: <code>completed</code>, meaning: "The adapter is stored and a fine-tuned model exists. Final." },
          { status: <code>failed</code>, meaning: <>Ended without a usable adapter. Final. <code>failure</code> says why and whether it was charged.</> },
          { status: <code>cancelling</code>, meaning: "You cancelled; the stop is being confirmed." },
          { status: <code>cancelled</code>, meaning: "Cancelled. Final." },
        ]}
      />

      <h3 id="billing">What a job costs</h3>
      <p>
        When a job is created, credits are held for the most it can cost: the tier&apos;s price per second times the
        job&apos;s run limit. When the job ends, the whole hold is returned and the seconds the run was on the GPU are
        charged at the price the job was admitted at, never more than the hold. Both appear as entries on your credit
        ledger with the job&apos;s id as their reference.
      </p>
      <DocTable
        caption="Who pays"
        columns={[
          { key: "outcome", label: "Outcome" },
          { key: "charge", label: "Charged" },
        ]}
        rows={[
          { outcome: "Completed, including a run the trainer stopped at its run limit and kept a partial adapter from", charge: "The seconds it ran" },
          { outcome: "Cancelled by you while running", charge: "The seconds it ran up to your cancel request, not the time the stop then took" },
          { outcome: "Cancelled by you before it reached a GPU", charge: "Nothing" },
          { outcome: "Cancelled by you after the run had already ended on its own", charge: "As it ended: a completed run is finished and charged as completed, a failure as that failure says below. The job shows the failure's reason." },
          { outcome: "Failed because of the data: rows the trainer could not use, or a loss that diverged", charge: "The seconds it ran" },
          { outcome: "No GPU node took the job within the queue time", charge: "Nothing" },
          { outcome: "Failed for a reason that is not your data: the job could not be submitted, the base model or the dataset could not be fetched, the adapter could not be uploaded or did not match, the run ran out of memory on a tier the API accepted, crashed, or was interrupted on the GPU node", charge: "Nothing" },
        ]}
      />
      <p>
        A job&apos;s <code>reservationCents</code> is the hold, <code>costSoFarCents</code> the cost so far while it
        runs, and once it is settled <code>actualCostCents</code> the charge and <code>billedSeconds</code> the time
        billed. The GPU network is given extra time on top of your run limit for pulling the container image, so that
        pull cannot cut your run short.
      </p>
      <p>
        A run that fails for a reason that is not your data costs you nothing, but the GPU time is still spent. An
        organization may therefore have at most <code>limits.freeFailuresPerDay</code> jobs end that way in any 24
        hours. At the limit, creating or retrying a job answers <code>409</code>{" "}
        <code>training_free_failure_limit</code> with <code>retryAt</code>, the time the next job can start, and the
        capabilities list the same reason. Check why the earlier runs failed (often memory: a smaller batch size or
        sequence length, QLoRA, or a larger tier) before starting another.
      </p>

      <Endpoint id="estimate" method="POST" path="/api/training/estimate" auth="API key or session" title="Estimate time and cost">
        <Fields
          fields={[
            { name: "baseModelId", type: "string", required: true, description: <>A model id from <code>GET /api/training/models</code>.</> },
            { name: "datasetId", type: "uuid", required: true, description: "A validated dataset." },
            { name: "method", type: "enum", description: <><code>lora</code> (default) or <code>qlora</code>.</> },
            { name: "gpuTier", type: "string", description: "A tier id. Omitted: the cheapest tier the model and method fit on." },
            { name: "maxRuntimeSeconds", type: "integer", description: <>The run limit. Omitted: the suggested limit. <code>maxRuntimeMinutes</code> is accepted instead, not both.</> },
            { name: "hyperparams", type: "object", description: "The same object a job takes." },
          ]}
        />
        <CodeBlock
          language="json"
          code={`{
  "estimate": {
    "basis": "planning",
    "gpuTier": "4090",
    "recommendedGpuTier": "4090",
    "pricePerSecondUsd": 0.00015,
    "estimate": { "seconds": 2100, "cents": 32 },
    "low": { "seconds": 1400, "cents": 21 },
    "high": { "seconds": 3500, "cents": 53 },
    "runLimit": { "minSeconds": 300, "maxSeconds": 85500, "suggestedSeconds": 5400, "appliedSeconds": 5400 },
    "maximumCents": 81,
    "fitsRunLimit": true,
    "suggestionCapped": false
  },
  "dataset": { "id": "…", "rowCount": 1200, "avgTokensPerRow": 344 }
}`}
        />
        <p>
          The figures in this example are illustrative. An estimate is a planning figure worked out from the
          dataset&apos;s size and the model, returned with a <code>low</code> and a <code>high</code> bound; the charge is
          for the time the run actually takes. <code>maximumCents</code> is what would be held at{" "}
          <code>runLimit.appliedSeconds</code>. <code>fitsRunLimit</code> is false when the expected time is longer than
          the run limit. Answers the same refusals as creating a job up to the tier checks.
        </p>
        <p>
          Every answer also carries <code>hold</code>: <code>&#123; cents, maxRuntimeSeconds, pricePerSecondUsd, gpuTier &#125;</code>,
          what creating this job would hold. A dataset with no measured tokens per row (a Parquet file) has no
          estimate: with a <code>maxRuntimeSeconds</code> the answer is <code>estimate: null</code> with the hold, and
          the job can be created with that run limit; without one it is <code>422</code>{" "}
          <code>training_estimate_unavailable</code>, asking for a run limit.
        </p>
      </Endpoint>

      <Endpoint id="create-job" method="POST" path="/api/training/jobs" auth="API key or session" title="Create a training job">
        <Fields
          fields={[
            { name: "name", type: "string", required: true, description: "1 to 100 characters. Also names the fine-tuned model." },
            { name: "baseModelId", type: "string", required: true, description: <>A model id from <code>GET /api/training/models</code>.</> },
            { name: "datasetId", type: "uuid", required: true, description: "A validated dataset with a known row count." },
            { name: "gpuTier", type: "string", required: true, description: <>A tier id from the capabilities, large enough for the model and method.</> },
            { name: "method", type: "enum", description: <><code>lora</code> (default) or <code>qlora</code>.</> },
            { name: "maxRuntimeSeconds", type: "integer", description: <>The run limit, within <code>runLimit</code> of the capabilities. Omitted: the estimate&apos;s suggestion. The trainer stops at this limit and keeps what it has.</> },
            { name: "hyperparams", type: "object", description: <>Any of <code>epochs</code>, <code>batchSize</code>, <code>gradientAccumulationSteps</code>, <code>learningRate</code>, <code>warmupRatio</code>, <code>loraR</code>, <code>loraAlpha</code>, <code>loraDropout</code>, <code>targetModules</code>, <code>maxSeqLength</code>, <code>maxSteps</code>, <code>evalSplit</code>, <code>seed</code>, within the bounds of the capabilities. A key that is not in this list is refused, not ignored.</> },
          ]}
        />
        <CodeBlock
          language="bash"
          code={`curl -s -X POST "$WHEELSAI_API_URL/api/training/jobs" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "support-assistant-v1",
    "baseModelId": "'"$BASE_MODEL_ID"'",
    "datasetId": "'"$DATASET_ID"'",
    "method": "qlora",
    "gpuTier": "'"$GPU_TIER"'",
    "maxRuntimeSeconds": 5400,
    "hyperparams": { "epochs": 3, "loraR": 16 }
  }'`}
        />
        <p>
          Returns <code>201</code> with <code>job</code> (<code>id</code>, <code>name</code>, <code>status</code>:{" "}
          <code>pending</code>), <code>reservation</code> (<code>cents</code>, <code>maxRuntimeSeconds</code>,{" "}
          <code>pricePerSecondUsd</code>) and <code>estimate</code>. Fires <code>training.started</code>.
        </p>
        <p>Refusals are checked in this order, and nothing is created or held when one is returned:</p>
        <ul>
          <li><code>400</code>: invalid fields, <code>invalid_run_limit</code>, <code>unknown_hyperparameter</code> or <code>invalid_hyperparameter</code> (with <code>field</code>), <code>run_limit_out_of_range</code> (with <code>minSeconds</code> and <code>maxSeconds</code>).</li>
          <li><code>404</code> <code>dataset_not_found</code>, <code>model_not_found</code> or <code>model_not_trainable</code>.</li>
          <li><code>409</code> <code>dataset_not_validated</code>.</li>
          <li><code>422</code> <code>dataset_row_count_unknown</code>.</li>
          <li><code>409</code> <code>dataset_changed_since_validation</code>.</li>
          <li><code>400</code> <code>unsupported_method</code>, <code>unsupported_gpu_count</code>, <code>hf_token_required</code>, <code>unknown_gpu_tier</code> or <code>tier_too_small</code> (with <code>requiredVramGb</code>).</li>
          <li><code>501</code> or <code>503</code> with one of the <code>blockers</code> codes of the capabilities, when fine-tuning cannot start on this server; or <code>503</code> <code>compute_capacity_unavailable</code> when new GPU jobs are paused (retry later).</li>
          <li><code>409</code> <code>training_quota_exceeded</code> (with <code>activeJobs</code> and <code>limit</code>).</li>
          <li><code>409</code> <code>training_free_failure_limit</code> (with <code>limit</code> and <code>retryAt</code>): see <a href="#billing">What a job costs</a>.</li>
          <li><code>402</code> <code>insufficient_credits</code> (with <code>requiredCents</code> and <code>balanceCents</code>): the hold is more than your balance.</li>
        </ul>
      </Endpoint>

      <Endpoint id="get-job" method="GET" path="/api/training/jobs/{jobId}" auth="API key or session" title="List and get jobs">
        <p>
          <code>GET /api/training/jobs</code> returns <code>&#123; jobs, total &#125;</code>, newest first, at most 200;
          filter with <code>?status=</code> and one of the nine statuses. Each job carries its <code>status</code>,{" "}
          <code>progress</code> (0 to 100), <code>currentStep</code>, <code>totalSteps</code>,{" "}
          <code>currentEpoch</code>, <code>totalEpochs</code>, <code>trainingLoss</code>, <code>evalLoss</code>, the money
          fields described under <a href="#billing">What a job costs</a>, and its times: <code>createdAt</code>,{" "}
          <code>queuedAt</code>, <code>startedAt</code>, <code>cancelRequestedAt</code>, <code>completedAt</code> and{" "}
          <code>settledAt</code>.
        </p>
        <p>
          A failed job has <code>failure</code>: <code>&#123; code, message, charged &#125;</code>. The single-job
          response adds <code>hyperparams</code>, <code>dataset</code>, <code>metrics</code> (including the{" "}
          <code>trainLoss</code> and <code>evalLoss</code> series as <code>[step, loss]</code> pairs),{" "}
          <code>partial</code> (true when the run stopped at its run limit), <code>fineTunedModel</code> once there is
          one, and <code>ledger</code>: the credit entries of this job, each with <code>type</code> (
          <code>training_reservation</code>, <code>training_reservation_release</code> or <code>training_usage</code>),{" "}
          <code>amountCents</code> and <code>balanceAfterCents</code>.
        </p>
      </Endpoint>

      <Endpoint id="logs" method="GET" path="/api/training/jobs/{jobId}/logs" auth="API key or session" title="Training logs">
        <p>
          Query <code>tail</code> (10 to 10,000, default 1000). Returns <code>&#123; jobId, status, logs, totalLines, source &#125;</code>;{" "}
          <code>source</code> is <code>callbacks</code>, <code>nosana_result</code> or <code>none</code> when no line has
          been received.
        </p>
      </Endpoint>

      <Endpoint id="cancel" method="POST" path="/api/training/jobs/{jobId}/cancel" auth="API key or session" title="Cancel a job">
        <p>
          Answers <code>200</code> <code>&#123; status: &quot;cancelled&quot; &#125;</code> when the job is over at once,
          or <code>202</code> <code>&#123; status: &quot;cancelling&quot; &#125;</code> while the stop is being confirmed.
          A job that is <code>finalizing</code>, <code>cancelling</code> or final answers <code>409</code>{" "}
          <code>training_job_not_cancellable</code>, and one whose run has already reported how it ended answers{" "}
          <code>409</code> <code>training_already_finished</code>: it is settled as it ended. No adapter is kept from a
          cancelled run.
        </p>
        <p>
          A cancel cannot change what had already happened. When the run turns out to have ended before your request,
          the job is settled as it ended: a run that completed first is finished and you get its model; one that
          failed first ends <code>cancelled</code> with that failure&apos;s reason, charged as the table above says.
        </p>
      </Endpoint>

      <Endpoint id="retry" method="POST" path="/api/training/jobs/{jobId}/retry" auth="API key or session" title="Retry a job">
        <p>
          Creates a new job with the configuration of one that failed or was cancelled, and returns it like a create with{" "}
          <code>retryOf</code>. The new job takes its own hold and can be refused for every reason a new job can. A job
          that is not over answers <code>409</code> <code>training_job_not_finished</code>.
        </p>
      </Endpoint>

      <h2 id="fine-tuned-models">Fine-tuned models</h2>
      <p>
        A completed job produces one fine-tuned model: a LoRA adapter your organization owns, stored with its size and
        sha256.
      </p>
      <Endpoint id="list-fine-tuned" method="GET" path="/api/training/fine-tuned-models" auth="API key or session" title="List, get and delete fine-tuned models">
        <p>
          Returns <code>&#123; fineTunedModels, total &#125;</code>, newest first. Each has <code>id</code>,{" "}
          <code>name</code>, <code>slug</code>, <code>baseModelId</code>, <code>baseModelHfId</code>, <code>method</code>,{" "}
          <code>loraR</code>, <code>adapterBytes</code>, <code>adapterSha256</code>, <code>metrics</code>,{" "}
          <code>trainingJob</code>, <code>deployments</code> (every deployment that names it) and{" "}
          <code>activeDeployments</code>. <code>GET /api/training/fine-tuned-models/&#123;id&#125;</code> returns one.
        </p>
        <p>
          <code>DELETE /api/training/fine-tuned-models/&#123;id&#125;</code> removes the adapter from storage. It answers{" "}
          <code>409</code> <code>model_in_use</code> while an active deployment serves the model; stop the deployment
          first.
        </p>
      </Endpoint>

      <h3 id="deploy">Deploy a fine-tuned model</h3>
      <p>
        Send <code>fineTunedModelId</code> instead of <code>modelId</code> to{" "}
        <Link href="/docs/api/deployments#create-deployment">POST /api/deployments</Link>. The deployment runs the base
        model on vLLM with your adapter loaded, and you call it at <code>/v1/&#123;slug&#125;/chat/completions</code>{" "}
        with the deployment&apos;s slug as the model name, exactly like a catalog model. It is billed as GPU time like any
        other deployment. The walk-through is in{" "}
        <Link href="/docs/guides/deploy-a-model#fine-tuned">Deploy a model</Link>.
      </p>
      <Callout variant="note" title="Stopping a deployment revokes its access to the adapter">
        <p>
          A deployment fetches the adapter when it starts, with access that is valid only for that deployment while it is
          active. Deleting a fine-tuned model is refused while a deployment serves it.
        </p>
      </Callout>

      <h2 id="webhooks">Webhook events</h2>
      <p>
        <code>training.started</code> is sent once when a job is admitted. Exactly one of{" "}
        <code>training.completed</code>, <code>training.failed</code> and <code>training.cancelled</code> is sent when it
        ends, with <code>chargedCents</code> and <code>billedSeconds</code>. See{" "}
        <Link href="/docs/api/webhooks#events">Webhooks</Link> for the payloads and signature.
      </p>
    </DocPage>
  );
}
