import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Callout, DocTable } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Deploy a model",
  description:
    "Deploy an open-weight model from the WheelsAI catalog to a Nosana GPU tier, understand the credit reservation and per-second GPU pricing, and call it through the OpenAI-compatible /v1 API.",
};

const toc = [
  { id: "choose", title: "1. Choose a model and GPU" },
  { id: "estimate", title: "2. Estimate the cost" },
  { id: "create", title: "3. Create the deployment" },
  { id: "admission", title: "Admission: quota and reservation", sub: true },
  { id: "lifecycle", title: "4. Watch it come up" },
  { id: "call", title: "5. Call the endpoint" },
  { id: "billing", title: "How GPU time is billed" },
  { id: "stop", title: "6. Scale, restart or stop" },
];

export default function DeployModelPage() {
  return (
    <DocPage
      href="/docs/guides/deploy-a-model"
      title="Deploy a model"
      lead="Run an open-weight model on Nosana's decentralized GPU network and call it like any OpenAI-compatible API. You pick the model and the GPU tier; WheelsAI submits the job, tracks its health and bills GPU time from your credits."
      toc={toc}
    >
      <h2 id="choose">1. Choose a model and GPU</h2>
      <p>
        The deployable catalog is served by <code>GET /api/models</code> (no authentication needed) and shown in the dashboard
        under <strong>Models</strong>. Each model lists the engines it supports (<code>vllm</code> or <code>ollama</code>), its
        default engine, context length and the minimum GPU tier it needs. The same response carries the GPU tiers with their
        current hourly price:
      </p>
      <CodeBlock language="bash" code={`curl -s "$WHEELSAI_API_URL/api/models?tier=gpu" | jq '.gpuTiers'`} />
      <DocTable
        caption="GPU tiers"
        columns={[
          { key: "id", label: "Tier id" },
          { key: "gpu", label: "GPU" },
          { key: "vram", label: "VRAM" },
        ]}
        rows={[
          { id: <code>3060</code>, gpu: "RTX 3060", vram: "8 GB" },
          { id: <code>4070</code>, gpu: "RTX 4070", vram: "12 GB" },
          { id: <code>4090</code>, gpu: "RTX 4090", vram: "24 GB" },
          { id: <code>a100</code>, gpu: "A100", vram: "40 GB" },
          { id: <code>h100</code>, gpu: "H100", vram: "80 GB" },
        ]}
      />
      <p>
        Prices are set per second, per replica, and <code>pricePerHour</code> in the response is that rate times 3,600. Always
        read prices from the API rather than copying them from anywhere else: the same table drives the estimate, the reservation
        and the charge. <code>GET /api/models/&#123;modelId&#125;</code> returns only the tiers compatible with that model.
      </p>

      <h2 id="estimate">2. Estimate the cost</h2>
      <CodeBlock
        language="bash"
        code={`curl -s -X POST "$WHEELSAI_API_URL/api/models/$MODEL_ID/estimate" \\
  -H "Content-Type: application/json" \\
  -d '{"gpuTier":"4090","replicas":1,"hoursPerMonth":720}'`}
      />
      <p>
        The response&apos;s <code>estimate.computePerMonth</code> is the GPU rate times hours times replicas, in USD.{" "}
        <code>hoursPerMonth</code> defaults to 720 (always on).
      </p>

      <h2 id="create">3. Create the deployment</h2>
      <p>
        In the dashboard use <strong>Deployments → New deployment</strong>. From code, with an API key:
      </p>
      <CodeBlock
        language="bash"
        code={`curl -s -X POST "$WHEELSAI_API_URL/api/deployments" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "support-llm",
    "modelId": "'"$MODEL_ID"'",
    "gpuTier": "4090",
    "engine": "vllm",
    "replicas": 1
  }'`}
      />
      <p>
        The name (3 to 50 characters) becomes a URL slug that is unique within your organization, for example{" "}
        <code>support-llm</code>. The full field list is in the{" "}
        <Link href="/docs/api/deployments#create-deployment">API reference</Link>. A successful call answers{" "}
        <code>201</code> with the deployment in status <code>pending</code>; the GPU job is submitted to Nosana in the
        background.
      </p>

      <h3 id="admission">Admission: quota and reservation</h3>
      <p>Two checks run before anything is submitted, because Nosana jobs are paid for as soon as they start:</p>
      <ul>
        <li>
          <strong>Active deployment quota.</strong> An organization can have a limited number of active deployments at once (5
          by default). Over the limit the API answers <code>429</code> with <code>deployment_quota_exceeded</code>.
        </li>
        <li>
          <strong>Credit reservation.</strong> One hour of GPU time for the chosen tier and replica count is reserved from your
          balance. If the balance cannot cover it, the API answers <code>402</code> with <code>insufficient_credits</code> and
          the amount required, and no deployment is created. The reservation is returned to your balance when the deployment
          ends, whether it failed or was stopped. Both the hold and the release appear as rows in your credit ledger.
        </li>
      </ul>

      <h2 id="lifecycle">4. Watch it come up</h2>
      <p>
        A background worker reconciles each deployment with Nosana and probes the health of its nodes. Poll{" "}
        <code>GET /api/deployments/&#123;id&#125;</code>, watch the dashboard, or subscribe to the{" "}
        <code>deployment.running</code>, <code>deployment.failed</code> and <code>deployment.stopped</code>{" "}
        <Link href="/docs/api/webhooks">webhooks</Link>. The list endpoint also reports <code>healthyNodes</code> and{" "}
        <code>totalNodes</code>.
      </p>

      <h2 id="call">5. Call the endpoint</h2>
      <p>
        Once the status is <code>running</code> and at least one node is healthy, send OpenAI-style chat requests to{" "}
        <code>/v1/&#123;deploymentSlug&#125;/chat/completions</code>:
      </p>
      <CodeBlock
        language="bash"
        code={`curl -s "$WHEELSAI_API_URL/v1/support-llm/chat/completions" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "messages": [
      {"role": "system", "content": "You answer briefly."},
      {"role": "user", "content": "What is a LoRA adapter?"}
    ],
    "max_tokens": 512
  }'`}
      />
      <p>
        Or point the official OpenAI SDK at the deployment. The deployment slug is part of the base URL, and your WheelsAI API
        key is the <code>apiKey</code>:
      </p>
      <CodeBlock
        language="ts"
        code={`import OpenAI from "openai";

const client = new OpenAI({
  baseURL: \`\${process.env.WHEELSAI_API_URL}/v1/support-llm\`,
  apiKey: process.env.WHEELSAI_API_KEY,
});

const completion = await client.chat.completions.create({
  model: "support-llm", // accepted but not used for routing; the slug in the URL picks the deployment
  messages: [{ role: "user", content: "Hello" }],
  max_tokens: 256,
});
console.log(completion.choices[0]?.message.content);`}
      />
      <Callout variant="warning" title="Streaming is not available on /v1 yet">
        <p>
          Omit <code>stream</code> (or send <code>false</code>). The endpoint currently returns complete JSON responses only.
        </p>
      </Callout>
      <p>
        Requests are covered by the deployment&apos;s GPU time: nothing is held or charged per token on top of it. See{" "}
        <Link href="/docs/api/inference">Chat completions</Link> for the request fields, the <code>max_tokens</code> cap and
        the errors.
      </p>

      <h2 id="billing">How GPU time is billed</h2>
      <p>
        A running deployment is charged for GPU time at its tier&apos;s per-second rate, times its replica count, from your credit
        balance. Charges are whole cents; time worth less than a cent carries over to the next charge rather than being rounded
        up. When the balance can no longer cover the GPU time, the deployment is stopped, so a deployment never runs on credit you
        do not have. Requests you send to the deployment through <code>/v1</code> are included in this GPU time: there is no
        separate token charge and no extra ledger row per request.
      </p>
      <p>
        Read more about the design in{" "}
        <Link href="/blog/per-second-gpu-billing-on-nosana">Building on Nosana: per-second GPU billing</Link>.
      </p>

      <h2 id="stop">6. Scale, restart or stop</h2>
      <ul>
        <li>
          <code>PATCH /api/deployments/&#123;id&#125;</code> updates <code>replicas</code> (1 to 10) or{" "}
          <code>config.maxTokens</code>. One replica change runs at a time, and the new count is billed only once Nosana
          has applied it.
        </li>
        <li>
          <code>POST /api/deployments/&#123;id&#125;/restart</code> resubmits the job.
        </li>
        <li>
          <code>DELETE /api/deployments/&#123;id&#125;</code> stops the deployment and its Nosana jobs. Stopped deployments stop
          accruing GPU time.
        </li>
      </ul>
    </DocPage>
  );
}
