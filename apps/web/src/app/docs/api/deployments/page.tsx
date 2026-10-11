import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Endpoint, Fields } from "@/components/marketing/docs/endpoint";
import { DocTable } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Models and deployments",
  description:
    "WheelsAI model catalog and GPU deployment API: list models and GPU tiers, estimate cost, create, scale, restart and stop Nosana GPU deployments, and read their metrics.",
};

const toc = [
  { id: "models", title: "Model catalog" },
  { id: "list-models", title: "List models and GPU tiers", sub: true },
  { id: "get-model", title: "Get a model", sub: true },
  { id: "estimate", title: "Estimate cost", sub: true },
  { id: "deployments", title: "Deployments" },
  { id: "statuses", title: "Statuses", sub: true },
  { id: "list-deployments", title: "List deployments", sub: true },
  { id: "create-deployment", title: "Create a deployment", sub: true },
  { id: "get-deployment", title: "Get a deployment", sub: true },
  { id: "update-deployment", title: "Scale a deployment", sub: true },
  { id: "restart-deployment", title: "Restart", sub: true },
  { id: "dependents", title: "Agents that answer from it", sub: true },
  { id: "delete-deployment", title: "Stop", sub: true },
  { id: "metrics", title: "Metrics", sub: true },
  { id: "logs", title: "Events", sub: true },
];

export default function DeploymentsApiPage() {
  return (
    <DocPage
      href="/docs/api/deployments"
      title="Models and deployments"
      lead="The model catalog is public. Deployments run a catalog model on a Nosana GPU tier for your organization and are called through the /v1 API."
      toc={toc}
    >
      <h2 id="models">Model catalog</h2>

      <Endpoint id="list-models" method="GET" path="/api/models" auth="Public" title="List models and GPU tiers">
        <Fields
          title="Query"
          fields={[
            { name: "tier", type: "enum", description: <><code>free</code> (free chat models only), <code>gpu</code> (deployable catalog only) or <code>all</code> (default: both).</> },
            { name: "engine", type: "enum", description: <><code>vllm</code> or <code>ollama</code>: models that support it.</> },
            { name: "tag", type: "string", description: "Models carrying this tag." },
            { name: "search", type: "string", description: "Matches name and description." },
          ]}
        />
        <p>
          Returns <code>&#123; models, gpuTiers &#125;</code>. Deployable models carry <code>id</code>, <code>hfId</code>,{" "}
          <code>displayName</code>, <code>supportedEngines</code>, <code>defaultEngine</code>, <code>minGpuTier</code>,{" "}
          <code>contextLength</code>, <code>tags</code> and <code>pricingTier</code>. Each GPU tier has <code>id</code>,{" "}
          <code>name</code>, <code>vram</code> (GB) and <code>pricePerHour</code> (USD per replica). Only tiers open for
          deployment are listed.
        </p>
        <p>
          <code>GET /api/models/free</code> returns just the free chat models: <code>models</code> (available now)
          and <code>allModels</code> (the full free catalog).
        </p>
      </Endpoint>

      <Endpoint id="get-model" method="GET" path="/api/models/{modelId}" auth="Public" title="Get a model">
        <p>
          Returns <code>&#123; model, compatibleGpuTiers &#125;</code>, the tiers at or above the model&apos;s minimum.{" "}
          <code>GET /api/models/&#123;modelId&#125;/engines</code> lists its engines and the default.
        </p>
      </Endpoint>

      <Endpoint id="estimate" method="POST" path="/api/models/{modelId}/estimate" auth="Public" title="Estimate monthly GPU cost">
        <Fields
          fields={[
            { name: "gpuTier", type: "string", required: true, description: "A tier id." },
            { name: "replicas", type: "integer", description: "1 to 10, default 1." },
            { name: "hoursPerMonth", type: "number", description: "Default 720 (always on)." },
            { name: "engine", type: "enum", description: <><code>vllm</code> or <code>ollama</code>; must be supported by the model.</> },
          ]}
        />
        <p>
          Returns <code>estimate.computePerMonth</code> in USD with a <code>breakdown</code> of the hourly rate and total GPU
          hours.
        </p>
      </Endpoint>

      <h2 id="deployments">Deployments</h2>
      <p>
        Every deployment endpoint accepts an API key or a session and is scoped to your organization. The step-by-step flow is in{" "}
        <Link href="/docs/guides/deploy-a-model">Deploy a model</Link>.
      </p>

      <h3 id="statuses">Statuses</h3>
      <DocTable
        caption="Deployment statuses"
        columns={[
          { key: "status", label: "Status" },
          { key: "meaning", label: "Meaning" },
        ]}
        rows={[
          { status: <code>pending</code>, meaning: "Admitted; the GPU job is being submitted." },
          { status: <code>provisioning</code>, meaning: "Submitted to Nosana; waiting for a node." },
          { status: <code>running</code>, meaning: "Nosana reports the deployment running with at least one live endpoint. The /v1 endpoint is available." },
          { status: <code>degraded</code>, meaning: "Was running, but no live endpoint is reported right now. Returns to running when one comes back." },
          { status: <code>stopped</code>, meaning: "Stopped by you, or because the balance could not pay for more GPU time." },
          { status: <code>failed</code>, meaning: "The job could not be submitted, or Nosana reported an error or insufficient funds." },
        ]}
      />
      <p>
        Transitions observed by the platform fire the <code>deployment.running</code>, <code>deployment.failed</code> and{" "}
        <code>deployment.stopped</code> <Link href="/docs/api/webhooks">webhooks</Link>.
      </p>

      <Endpoint id="list-deployments" method="GET" path="/api/deployments" auth="API key or session" title="List deployments">
        <p>
          Returns <code>&#123; deployments, total &#125;</code>, newest first, each with <code>id</code>, <code>name</code>,{" "}
          <code>slug</code>, <code>model</code>, <code>engine</code>, <code>gpuTier</code>, <code>replicas</code>,{" "}
          <code>status</code>, <code>healthyNodes</code>, <code>totalNodes</code> and <code>endpoint</code> (the OpenAI-compatible
          URL once running, otherwise <code>null</code>).
        </p>
      </Endpoint>

      <Endpoint id="create-deployment" method="POST" path="/api/deployments" auth="API key or session" title="Create a deployment">
        <Fields
          fields={[
            { name: "name", type: "string", required: true, description: "3 to 50 characters. Determines the slug used in /v1 paths." },
            { name: "modelId", type: "string", required: true, description: <>A catalog model id. Leave it out when you send <code>fineTunedModelId</code>.</> },
            { name: "fineTunedModelId", type: "uuid", description: <>One of your <Link href="/docs/api/training#fine-tuned-models">fine-tuned models</Link>, served instead of a catalog model. The base model is taken from it and the engine must be <code>vllm</code>.</> },
            { name: "gpuTier", type: "string", required: true, description: <>A tier id: <code>3060</code>, <code>4070</code>, <code>4090</code>, <code>a100</code> or <code>h100</code>, as offered by <code>GET /api/models</code>.</> },
            { name: "engine", type: "enum", description: <><code>vllm</code> (default) or <code>ollama</code>.</> },
            { name: "replicas", type: "integer", description: "1 to 10, default 1." },
            { name: "config.maxTokens", type: "integer", description: "Server-side context limit, 256 to 32,768, default 4096." },
            { name: "config.gpuMemoryUtilization", type: "number", description: "0.5 to 0.95, default 0.9 (vLLM)." },
          ]}
        />
        <CodeBlock
          language="json"
          code={`{
  "deployment": { "id": "…", "name": "support-llm", "slug": "support-llm", "status": "pending" },
  "message": "Deployment created. Provisioning GPU node..."
}`}
        />
        <p>Errors:</p>
        <ul>
          <li>
            <code>400</code>: unknown model or GPU tier, or invalid fields.
          </li>
          <li>
            With <code>fineTunedModelId</code>, before anything is reserved: <code>404</code>{" "}
            <code>fine_tuned_model_not_found</code>; <code>409</code> <code>fine_tuned_model_not_ready</code> (it was
            deleted) or <code>fine_tuned_model_not_servable</code>; <code>400</code>{" "}
            <code>engine_not_supported_for_adapters</code>, <code>fine_tuned_model_base_mismatch</code> (a{" "}
            <code>modelId</code> that is not its base model) or <code>tier_too_small_for_serving</code> (with{" "}
            <code>requiredVramGb</code>); <code>503</code> <code>adapter_download_not_configured</code> when serving
            fine-tuned models is temporarily unavailable.
          </li>
          <li>
            <code>402</code> <code>insufficient_credits</code>: the one-hour reservation (GPU rate × 3,600 × replicas) is more
            than your balance. The message states the amount.
          </li>
          <li>
            <code>429</code> <code>deployment_quota_exceeded</code>: too many active deployments in the organization.
          </li>
          <li>
            <code>501</code> <code>gpu_market_not_configured</code>: GPU deployment, or that tier&apos;s market, is
            temporarily unavailable. Nothing was created and nothing was reserved; try another tier or retry later.
          </li>
          <li>
            <code>503</code> <code>compute_capacity_unavailable</code>: new GPU deployments are temporarily unavailable. Nothing
            was created, reserved or charged; retry later. The <Link href="/status">status page</Link> shows when they resume.
          </li>
        </ul>
        <p>
          Fires <code>deployment.started</code>.
        </p>
      </Endpoint>

      <Endpoint id="get-deployment" method="GET" path="/api/deployments/{deploymentId}" auth="API key or session" title="Get a deployment">
        <p>
          Returns <code>&#123; deployment &#125;</code> with its model, configuration, status, node health,{" "}
          <code>fineTunedModel</code> (<code>&#123; id, name, slug &#125;</code>, or <code>null</code> for a catalog
          model) and <code>endpoint</code>. Call the model through <code>endpoint</code>; GPU nodes are not called directly.
        </p>
      </Endpoint>

      <Endpoint id="update-deployment" method="PATCH" path="/api/deployments/{deploymentId}" auth="API key or session" title="Scale a deployment">
        <Fields
          fields={[
            { name: "replicas", type: "integer", description: "1 to 10." },
            { name: "config.maxTokens", type: "integer", description: "256 to 32,768." },
          ]}
        />
        <p>
          Replica changes apply to a running deployment. Adding replicas reserves credit for the added replicas first, the same
          way as creation; removing replicas returns their share of the reservation. The GPU time used so far is charged at
          the current replica count before the change, and the new count is billed only from the moment Nosana has applied
          it.
        </p>
        <p>
          One replica change runs at a time. While it is in progress the response&apos;s <code>replicas</code> is still the
          count that is running (and billed) and <code>pendingReplicas</code> is the target.
        </p>
        <ul>
          <li>
            <code>402</code> <code>insufficient_credits</code>: your balance does not cover the GPU time used so far, or the
            reservation for the added replicas. Nothing was changed.
          </li>
          <li>
            <code>409</code> <code>replica_change_in_progress</code>: an earlier change has not finished. Retry once it has.
          </li>
          <li>
            <code>409</code> <code>deployment_not_running</code> or <code>deployment_conflict</code>: the deployment is not
            running, or it changed while it was being scaled.
          </li>
          <li>
            <code>503</code> <code>compute_capacity_unavailable</code>: replicas cannot be added while new GPU capacity is
            paused. Replicas and reservation are as they were.
          </li>
          <li>
            <code>502</code> <code>nosana_scale_failed</code>: Nosana refused the change. Replicas and reservation are as they
            were.
          </li>
          <li>
            <code>502</code> <code>nosana_scale_unconfirmed</code>: Nosana did not confirm the change and could not be asked.
            The deployment keeps its current count, and the change is resolved to what Nosana actually runs within a few
            minutes; further replica changes answer <code>409</code> until then.
          </li>
        </ul>
      </Endpoint>

      <Endpoint id="restart-deployment" method="POST" path="/api/deployments/{deploymentId}/restart" auth="API key or session" title="Restart a deployment">
        <p>
          Resubmits the GPU job with the deployment&apos;s current configuration. Answers <code>503</code>{" "}
          <code>compute_capacity_unavailable</code>, with nothing reserved or charged, while new GPU deployments are
          temporarily unavailable.
        </p>
      </Endpoint>

      <Endpoint id="dependents" method="GET" path="/api/deployments/{deploymentId}/dependents" auth="API key or session" title="Agents that answer from a deployment">
        <p>
          Read it before a stop. Returns the agents of your organization that will stop answering if this deployment is
          stopped now: agents set to the model it runs, when no other running deployment of yours would answer for
          that model. It changes nothing. A deployment that is not live has none.
        </p>
        <CodeBlock
          language="json"
          code={`{
  "agents": [
    {
      "id": "…",
      "name": "Support Bot",
      "onSale": true,
      "listing": { "id": "…", "title": "Support Bot", "pricingModel": "monthly", "subscribers": 3 }
    }
  ]
}`}
        />
        <p>
          <code>onSale</code> is whether the agent has a published listing that sells use; <code>listing</code> is that
          listing, or <code>null</code>. <code>subscribers</code> counts its subscriptions that are <code>active</code> or{" "}
          <code>past_due</code>. A listing whose agent cannot answer is paused; see{" "}
          <Link href="/docs/guides/marketplace#model-stops">When the model stops</Link>.
        </p>
      </Endpoint>

      <Endpoint id="delete-deployment" method="DELETE" path="/api/deployments/{deploymentId}" auth="API key or session" title="Stop a deployment">
        <p>
          Stops the deployment&apos;s Nosana jobs and marks it <code>stopped</code>. The admission reservation is returned to
          your balance. Fires <code>deployment.stopped</code>.
        </p>
        <CodeBlock
          language="json"
          code={`{ "message": "Deployment stopped", "fundsReleased": true }`}
        />
        <p>
          <code>fundsReleased</code> is <code>false</code> when the GPUs were still winding down as the call returned;
          that is confirmed in the background and does not change what you are billed. Your reservation is returned and
          GPU billing ends at the stop either way.
        </p>
        <p>
          Agents set to this deployment&apos;s model stop answering, and their listings that sell use are paused:
          nobody can start using them and nobody is charged. <code>GET .../dependents</code> lists them beforehand.
        </p>
      </Endpoint>

      <Endpoint id="metrics" method="GET" path="/api/deployments/{deploymentId}/metrics" auth="API key or session" title="Usage metrics, last 24 hours">
        <p>
          Returns totals for <code>requests</code>, <code>inputTokens</code>, <code>outputTokens</code> and{" "}
          <code>errorRate</code>, plus a <code>byHour</code> series, from the usage recorded for each <code>/v1</code>{" "}
          request. <code>avgLatencyMs</code>, <code>p50LatencyMs</code> and <code>p95LatencyMs</code> are the end-to-end
          time of the answered requests in the same 24 hours, measured per request at the API over{" "}
          <code>latencySampleCount</code> requests; all three are <code>null</code> when none was measured.
        </p>
      </Endpoint>

      <Endpoint id="logs" method="GET" path="/api/deployments/{deploymentId}/logs" auth="API key or session" title="Deployment events">
        <p>
          Query <code>lines</code> (10 to 1000, default 100). Returns the lifecycle events Nosana reports for the deployment,
          oldest first. Container output (stdout and stderr) is not available through Nosana, so it is not included.
        </p>
      </Endpoint>
    </DocPage>
  );
}
