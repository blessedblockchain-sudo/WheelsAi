import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Endpoint, Fields } from "@/components/marketing/docs/endpoint";
import { Callout, DocTable } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Webhooks",
  description:
    "WheelsAI webhooks: event types and payloads, HMAC-SHA256 signature verification, delivery retries, and the webhook management endpoints.",
};

const toc = [
  { id: "events", title: "Events" },
  { id: "payload", title: "Payload and headers" },
  { id: "verify", title: "Verify the signature" },
  { id: "delivery", title: "Delivery and retries" },
  { id: "manage", title: "Manage webhooks" },
  { id: "create-webhook", title: "Create a webhook", sub: true },
  { id: "other-webhook-endpoints", title: "Other endpoints", sub: true },
];

export default function WebhooksApiPage() {
  return (
    <DocPage
      href="/docs/api/webhooks"
      title="Webhooks"
      lead="Webhooks POST a signed JSON event to your URL when something happens in your organization: an agent changes, a deployment starts, runs, fails or stops, a fine-tuning job finishes, or an alert fires."
      toc={toc}
    >
      <h2 id="events">Events</h2>
      <DocTable
        caption="Webhook events and their data"
        columns={[
          { key: "event", label: "Event" },
          { key: "when", label: "Sent when" },
          { key: "data", label: "data fields" },
        ]}
        rows={[
          { event: <code>agent.created</code>, when: "An agent is created.", data: <code>agentId, name, slug</code> },
          { event: <code>agent.updated</code>, when: "An agent is updated.", data: <code>agentId, name</code> },
          { event: <code>agent.deleted</code>, when: "An agent is deleted.", data: <code>agentId, name</code> },
          {
            event: <code>agent.deployed</code>,
            when: "The platform observes an agent's deployment reach running.",
            data: <code>agentId, name, slug, deploymentId, observedAt</code>,
          },
          { event: <code>deployment.started</code>, when: "A model deployment is created.", data: <code>deploymentId, name, slug</code> },
          {
            event: <code>deployment.running</code>,
            when: "The platform observes a deployment reach running.",
            data: <code>deploymentId, deploymentKind, fromStatus, toStatus, observedAt</code>,
          },
          {
            event: <code>deployment.failed</code>,
            when: "The platform observes a deployment fail.",
            data: <code>deploymentId, deploymentKind, fromStatus, toStatus, observedAt</code>,
          },
          {
            event: <code>deployment.stopped</code>,
            when: "You stop a deployment, or the platform observes it stopped.",
            data: (
              <>
                <code>deploymentId, name</code> when you stop it; the observed-transition fields otherwise
              </>
            ),
          },
          {
            event: <code>training.started</code>,
            when: "A fine-tuning job is admitted and its credits are held. Sent once.",
            data: <code>jobId, name, baseModelId, method, gpuTier</code>,
          },
          {
            event: <code>training.completed</code>,
            when: "A fine-tuning job completes and its fine-tuned model exists. Sent once.",
            data: <code>jobId, name, chargedCents, billedSeconds, fineTunedModelId, fineTunedModelSlug, partial</code>,
          },
          {
            event: <code>training.failed</code>,
            when: "A fine-tuning job fails. Sent once.",
            data: <code>jobId, name, chargedCents, billedSeconds, failureCode, message</code>,
          },
          {
            event: <code>training.cancelled</code>,
            when: "A fine-tuning job you cancelled has been stopped and settled. Sent once. A run that had completed before the cancel sends training.completed instead.",
            data: <><code>jobId, name, chargedCents, billedSeconds</code>, and <code>failureCode, message</code> when the run had already failed before the cancel</>,
          },
          {
            event: <code>alert.triggered</code>,
            when: "An alert rule's threshold is crossed.",
            data: <code>alertId, title, metric, value, threshold, severity</code>,
          },
          { event: <code>alert.resolved</code>, when: "An alert is resolved.", data: <code>alertId, title, severity</code> },
          {
            event: <code>workflow.completed</code>,
            when: "A workflow run completes.",
            data: <code>executionId, orchestrationId, workflowName, status, triggeredBy, durationMs, outputPreview</code>,
          },
          {
            event: <code>workflow.failed</code>,
            when: "A workflow run fails or times out. A cancelled run sends nothing.",
            data: <code>executionId, orchestrationId, workflowName, status, triggeredBy, durationMs, error</code>,
          },
          {
            event: <code>scheduled_task.failed</code>,
            when: "A scheduled task fails, once per firing, after its last attempt.",
            data: <>See <Link href="/docs/api/workflows#events">workflow and scheduler events</Link>.</>,
          },
          {
            event: <code>scheduled_task.completed</code>,
            when: "A scheduled task finishes with a result, whether its schedule or a person started it.",
            data: <><code>taskId, taskName, taskType, agentId, executionId, attempts, triggeredBy, durationMs, outputPreview</code>. <code>outputPreview</code> is the first 2,000 characters of the answer.</>,
          },
          {
            event: <><code>job.funded</code>, <code>job.submitted</code>, <code>job.completed</code>, <code>job.rejected</code>, <code>job.failed</code>, <code>job.expired</code>, <code>job.cancelled</code></>,
            when: "A paid job on an offering changes state. Sent to the buyer, the publisher or both.",
            data: <>See <Link href="/docs/api/jobs#events">job events</Link>.</>,
          },
          {
            event: <code>report.generated</code>,
            when: "A report task that asks for it finishes.",
            data: <>See <Link href="/docs/api/workflows#events">workflow and scheduler events</Link>.</>,
          },
        ]}
      />
      <p>
        <code>deploymentKind</code> is <code>model</code> or <code>agent</code>. An agent deployment that reaches running
        sends both <code>deployment.running</code> and <code>agent.deployed</code>. <code>GET /api/webhooks/events</code>{" "}
        returns the full list of event names you can subscribe to, with every one of them in a category:{" "}
        <code>agent</code>, <code>deployment</code>, <code>training</code>, <code>alert</code>, <code>billing</code>,{" "}
        <code>workflow</code>, <code>scheduled_task</code>, <code>report</code> and <code>job</code>. That list also contains{" "}
        <code>agent.version.created</code>, <code>billing.low_balance</code> and <code>billing.payment_received</code>:
        you can subscribe to them now, but the platform does not send them yet.
      </p>

      <h2 id="payload">Payload and headers</h2>
      <CodeBlock
        language="http"
        code={`POST /your/endpoint HTTP/1.1
Content-Type: application/json
X-Webhook-Event: agent.created
X-Webhook-Delivery: 5f0c...          (delivery id)
X-Webhook-Signature: sha256=9a3b...  (HMAC-SHA256 of the raw body)

{
  "id": "0b8f2a8e-...",               // event id, the same for every endpoint that receives it
  "type": "agent.created",
  "timestamp": "2026-10-01T09:30:00.000Z",
  "data": { "agentId": "...", "name": "Release notes helper", "slug": "release-notes-helper" }
}`}
      />
      <p>Any custom headers you configured on the webhook are added to every delivery.</p>

      <h2 id="verify">Verify the signature</h2>
      <p>
        Each webhook has its own secret, returned when you create it (and when you rotate it). Compute an HMAC-SHA256 of the{" "}
        <strong>raw request body</strong> with that secret, hex-encode it, and compare it to the value after{" "}
        <code>sha256=</code> in constant time. Parse the JSON only after the check passes.
      </p>
      <CodeBlock
        language="ts"
        title="Node.js (Express)"
        code={`import crypto from "node:crypto";
import express from "express";

const app = express();

app.post("/webhooks/wheelsai", express.raw({ type: "application/json" }), (req, res) => {
  const header = req.get("X-Webhook-Signature") ?? "";
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", process.env.WHEELSAI_WEBHOOK_SECRET!).update(req.body).digest("hex");

  const ok =
    header.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  if (!ok) return res.status(401).end();

  const event = JSON.parse(req.body.toString("utf8"));
  // Deduplicate on event.id: retries of the same delivery carry the same event.
  console.log(event.type, event.data);
  res.status(204).end();
});`}
      />

      <h2 id="delivery">Delivery and retries</h2>
      <ul>
        <li>Any 2xx response counts as delivered. Anything else, a timeout or a network error counts as a failure.</li>
        <li>
          Each attempt waits up to the webhook&apos;s timeout (30 seconds by default). Failed deliveries are retried with
          exponential backoff, 2<sup>attempt</sup> minutes apart, up to the webhook&apos;s retry count (3 by default).
        </li>
        <li>
          Every delivery, with its status code, response time and error, is kept and can be listed and retried by hand.
        </li>
        <li>
          Your URL must be publicly reachable. Addresses that resolve to private, loopback or internal networks are refused,
          and redirects are not followed blindly.
        </li>
      </ul>
      <Callout>
        <p>
          Respond quickly with a 2xx and do slow work afterwards. Handle the same event more than once safely, keyed on{" "}
          <code>id</code>.
        </p>
      </Callout>

      <h2 id="manage">Manage webhooks</h2>
      <p>All webhook endpoints accept an API key or a session and are scoped to your organization.</p>

      <Endpoint id="create-webhook" method="POST" path="/api/webhooks" auth="API key or session" title="Create a webhook">
        <Fields
          fields={[
            { name: "name", type: "string", required: true, description: "A label for you." },
            { name: "url", type: "string (URL)", required: true, description: "Where events are POSTed." },
            { name: "events", type: "string[]", required: true, description: "Event names to subscribe to." },
            { name: "description", type: "string", description: "Optional note." },
            { name: "resourceType", type: "string", description: <>Only events about this kind of resource, for example <code>agent</code> or <code>deployment</code>.</> },
            { name: "resourceId", type: "string", description: "Only events about this one resource." },
            { name: "headers", type: "object", description: "Extra string headers sent with every delivery." },
            { name: "retryCount", type: "integer", description: "Default 3." },
            { name: "timeoutSeconds", type: "integer", description: "Default 30." },
          ]}
        />
        <CodeBlock
          language="bash"
          code={`curl -s -X POST "$WHEELSAI_API_URL/api/webhooks" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Deploy notifications",
    "url": "https://example.com/webhooks/wheelsai",
    "events": ["deployment.running", "deployment.failed", "deployment.stopped"]
  }'`}
        />
        <p>
          Answers <code>201</code> with the webhook, including its <code>secret</code>. Store the secret; you need it to verify
          signatures.
        </p>
      </Endpoint>

      <h3 id="other-webhook-endpoints">Other endpoints</h3>
      <DocTable
        caption="Webhook management endpoints"
        columns={[
          { key: "ep", label: "Endpoint" },
          { key: "what", label: "What it does" },
        ]}
        rows={[
          { ep: <code>GET /api/webhooks/events</code>, what: "Subscribable event names, by category." },
          { ep: <code>GET /api/webhooks</code>, what: <>List webhooks; <code>limit</code>, <code>offset</code>, <code>isEnabled</code>.</> },
          { ep: <code>GET /api/webhooks/&#123;id&#125;</code>, what: "One webhook." },
          { ep: <code>PATCH /api/webhooks/&#123;id&#125;</code>, what: <>Change any create field, or <code>isEnabled</code>.</> },
          { ep: <code>DELETE /api/webhooks/&#123;id&#125;</code>, what: <>Delete it (<code>204</code>).</> },
          { ep: <code>POST /api/webhooks/&#123;id&#125;/regenerate-secret</code>, what: "Rotate the signing secret; returns the new one." },
          { ep: <code>POST /api/webhooks/&#123;id&#125;/test</code>, what: <>Send a test <code>agent.created</code> event with <code>data.test: true</code> and report the result.</> },
          { ep: <code>GET /api/webhooks/&#123;id&#125;/deliveries</code>, what: <>Delivery history; <code>limit</code>, <code>offset</code>, <code>status</code>.</> },
          { ep: <code>POST /api/webhooks/&#123;id&#125;/deliveries/&#123;deliveryId&#125;/retry</code>, what: "Re-send one delivery now." },
        ]}
      />
    </DocPage>
  );
}
