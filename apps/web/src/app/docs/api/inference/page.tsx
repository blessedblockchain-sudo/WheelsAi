import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Endpoint, Fields } from "@/components/marketing/docs/endpoint";
import { Callout, DocTable } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Chat completions (/v1)",
  description:
    "The OpenAI-compatible WheelsAI inference API: POST /v1/{deploymentSlug}/chat/completions, request fields, max_tokens cap, how requests to a dedicated deployment are covered by its per-second GPU billing, errors and the x402 pay-per-request flow.",
};

const toc = [
  { id: "chat-completions", title: "Create a chat completion" },
  { id: "billing", title: "How a request is billed" },
  { id: "pricing", title: "Per-request token pricing" },
  { id: "errors", title: "Errors" },
  { id: "list-models", title: "List your models" },
  { id: "x402", title: "Paying per request with x402" },
];

export default function InferenceApiPage() {
  return (
    <DocPage
      href="/docs/api/inference"
      title="Chat completions (/v1)"
      lead="Each running model deployment is reachable through an OpenAI-compatible chat completions endpoint on the WheelsAI API. Requests are authenticated and metered against your plan. A request to a dedicated deployment is covered by that deployment's per-second GPU billing: it is not charged again per token."
      toc={toc}
    >
      <Endpoint
        id="chat-completions"
        method="POST"
        path="/v1/{deploymentSlug}/chat/completions"
        auth="API key or session"
        title="Create a chat completion"
        as="h2"
      >
        <p>
          <code>deploymentSlug</code> is the slug of a deployment in your organization whose status is <code>running</code>.
          The request is forwarded to one of the deployment&apos;s healthy GPU nodes, chosen with a preference for lower
          latency. Your credentials are never forwarded to the node.
        </p>
        <Fields
          fields={[
            {
              name: "messages",
              type: "array",
              required: true,
              description: (
                <>
                  Conversation so far. Each item is <code>&#123; role, content &#125;</code> with <code>role</code> one of{" "}
                  <code>system</code>, <code>user</code>, <code>assistant</code> and <code>content</code> a string.
                </>
              ),
            },
            {
              name: "max_tokens",
              type: "integer",
              description: (
                <>
                  Completion cap, 1 to <strong>8192</strong>. Defaults to <strong>4096</strong> when omitted. It is always sent
                  to the model server, so every request does a bounded amount of work.
                </>
              ),
            },
            { name: "temperature", type: "number", description: "0 to 2." },
            { name: "top_p", type: "number", description: "0 to 1." },
            { name: "stop", type: "string | string[]", description: "Stop sequence or sequences." },
            {
              name: "model",
              type: "string",
              description: "Accepted for OpenAI SDK compatibility and ignored: the slug in the path selects the deployment.",
            },
            {
              name: "stream",
              type: "boolean",
              description: "Not supported yet. Omit it or send false; the endpoint returns a complete JSON response.",
            },
          ]}
        />
        <CodeBlock
          language="bash"
          code={`curl -s "$WHEELSAI_API_URL/v1/support-llm/chat/completions" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "X-Request-Id: order-4711" \\
  -d '{
    "messages": [{"role": "user", "content": "Summarise our refund policy in one line."}],
    "max_tokens": 200,
    "temperature": 0.2
  }'`}
        />
        <p>
          The response is the model server&apos;s OpenAI-format chat completion, including <code>choices</code> and{" "}
          <code>usage</code> (<code>prompt_tokens</code>, <code>completion_tokens</code>). Every response carries an{" "}
          <code>X-Request-Id</code> header: yours if you sent one, otherwise a generated id.
        </p>
      </Endpoint>

      <h2 id="billing">How a request is billed</h2>
      <p>
        A request to a running deployment is <strong>included in that deployment&apos;s GPU bill</strong>. The deployment is
        charged per second of GPU time for as long as it runs, whether it serves one request or a million, so a request to it:
      </p>
      <ul>
        <li>takes no hold from your credit balance and is not charged per token;</li>
        <li>writes no ledger row of its own (the GPU time appears as <code>gpu_usage</code> rows for the deployment);</li>
        <li>is not checked against your credit balance and is never answered with an x402 payment challenge.</li>
      </ul>
      <p>
        Token counts are still returned in <code>usage</code> and recorded in the deployment&apos;s metrics. What ends service
        is the GPU bill: when your credits can no longer cover the deployment&apos;s GPU time it is stopped, and its endpoint
        answers <code>404</code> until you restart it. If the GPU time has gone unpaid for several billing intervals and the
        deployment could not be stopped yet, requests are refused in the meantime: <code>402</code> when your credits do not
        cover what is owed, <code>503</code> (<code>gpu_billing_stalled</code>) when they do and billing itself is behind. If
        per-second GPU billing is switched off on a self-hosted server, dedicated deployments do not serve requests at all (
        <code>503</code>, <code>gpu_billing_disabled</code>) rather than serving them unbilled.
      </p>
      <p>
        Each <code>/v1</code> request also counts as one API call toward your plan&apos;s monthly quota, including{" "}
        <code>GET</code> requests such as <code>/v1/models</code> and requests made with a signed-in session. GPU time for the
        deployment itself is what you pay for; see{" "}
        <Link href="/docs/guides/deploy-a-model#billing">How GPU time is billed</Link>.
      </p>

      <h2 id="pricing">Per-request token pricing</h2>
      <Callout variant="warning" title="Does not apply to dedicated deployments">
        <p>
          Every deployment you create runs on dedicated GPUs and is billed per second of GPU time, so the per-token prices and
          the x402 flow on this page are not charged for it. They apply only to a deployment that is billed per request instead
          of per GPU-second.
        </p>
      </Callout>
      <p>
        Every catalog model has a <code>pricingTier</code> (shown by <code>GET /api/models</code>). Where a deployment is billed
        per request, the worst-case cost (estimated prompt tokens plus the full <code>max_tokens</code>) is held from your
        credits before the request reaches the GPU, settled to the actual <code>usage</code> afterwards, and returned in full
        if the node cannot serve it. Prices per million tokens:
      </p>
      <DocTable
        caption="Token prices by pricing tier, US dollars per million tokens"
        columns={[
          { key: "tier", label: "Pricing tier" },
          { key: "input", label: "Input" },
          { key: "output", label: "Output" },
        ]}
        rows={[
          { tier: <code>small</code>, input: "$0.15", output: "$0.60" },
          { tier: <code>medium</code>, input: "$0.30", output: "$1.20" },
          { tier: <code>large</code>, input: "$0.90", output: "$3.60" },
        ]}
      />
      <p>A per-request charge is rounded up to the next whole cent.</p>

      <h2 id="errors">Errors</h2>
      <DocTable
        caption="Chat completion errors"
        columns={[
          { key: "status", label: "Status" },
          { key: "when", label: "When" },
        ]}
        rows={[
          { status: <code>400</code>, when: <>Invalid body, for example <code>max_tokens</code> above 8192 or an unknown role.</> },
          { status: <code>401</code>, when: "Missing or invalid API key or session." },
          {
            status: <code>402</code>,
            when: (
              <>
                Not enough credits,{" "}
                <code>&#123; &quot;error&quot;: &quot;Payment Required&quot;, &quot;message&quot;: ..., &quot;requiredCents&quot;: n &#125;</code>
                . For a dedicated deployment this means its GPU time has gone unpaid and your balance does not cover it; a
                single request is never the reason. For a deployment billed per request it is the request&apos;s own cost, or,
                where x402 is enabled, a payment challenge (below).
              </>
            ),
          },
          { status: <code>404</code>, when: "No deployment with that slug in your organization, or it is not running." },
          { status: <code>409</code>, when: "The x402 payment transaction was already used for another request." },
          { status: <code>429</code>, when: <>Monthly API calls used up (<code>plan_limit_reached</code>) or a rate limit.</> },
          {
            status: <code>502</code>,
            when: "The GPU node could not be reached, or it answered with an error or a redirect. Nothing is charged for the request.",
          },
          {
            status: <code>503</code>,
            when: (
              <>
                The deployment has no healthy node right now, per-second GPU billing is not running on this server (
                <code>gpu_billing_disabled</code>), or it is running but has not collected this deployment&apos;s GPU time for
                several intervals (<code>gpu_billing_stalled</code>).
              </>
            ),
          },
        ]}
      />

      <Endpoint id="list-models" method="GET" path="/v1/models" auth="API key or session" title="List your models" as="h2">
        <p>
          OpenAI-style list of your organization&apos;s running deployments. Each entry&apos;s <code>id</code> is the
          deployment slug to use in the chat completions path, and <code>root</code> is the underlying Hugging Face model id.
        </p>
        <CodeBlock
          language="json"
          code={`{
  "object": "list",
  "data": [
    { "id": "support-llm", "object": "model", "created": 1790000000, "owned_by": "wheelsai",
      "permission": [], "root": "<hugging face model id>", "parent": null }
  ]
}`}
        />
      </Endpoint>

      <h2 id="x402">Paying per request with x402</h2>
      <p>
        A dedicated deployment is never challenged for an x402 payment: its requests are already paid for by its GPU time (see{" "}
        <a href="#billing">How a request is billed</a>). For a deployment billed per request, on servers where x402 is
        enabled, <code>/v1</code> requests can be paid individually with a Solana payment, following
        the HTTP 402 pattern. The server runs in one of two modes: <strong>fallback</strong> (use credits when the balance covers
        the request, otherwise ask for payment) or <strong>required</strong> (every request is paid). When x402 is off, requests
        use credits only. You still authenticate as usual; x402 replaces the credit charge, not the API key.
      </p>
      <p>
        <strong>1. The challenge.</strong> A request that needs payment answers <code>402</code> with an{" "}
        <code>X-Payment-Required</code> header (the requirement as JSON) and this body:
      </p>
      <CodeBlock
        language="json"
        code={`{
  "error": "Payment Required",
  "message": "This request requires payment via X-402 protocol",
  "payment": {
    "scheme": "exact",
    "network": "solana:mainnet",
    "asset": "USDC",
    "amount": "<amount in the asset's base units, as a string>",
    "amountUsd": 0.0012,
    "payTo": "<recipient address>",
    "memo": "deployment:<id>;request:<requestId>",
    "validUntil": 1790000000
  },
  "requestId": "x402_...",
  "reason": "optional detail, e.g. why a previous payment was refused"
}`}
      />
      <p>
        <code>network</code> is <code>solana:mainnet</code> or <code>solana:devnet</code> depending on the server, and{" "}
        <code>asset</code> is the server&apos;s configured asset (USDC by default). The quote is based on the request&apos;s
        estimated tokens with a 20% buffer and expires at <code>validUntil</code> (Unix seconds).
      </p>
      <p>
        <strong>2. Pay.</strong> Build a Solana transaction that transfers at least <code>amount</code> of <code>asset</code> to{" "}
        <code>payTo</code>, sign it with the paying wallet as fee payer, and serialize it as base64.
      </p>
      <p>
        <strong>3. Retry</strong> the same request body with the payment attached, and the <code>X-Request-Id</code> from the
        challenge so the payment and request are correlated:
      </p>
      <CodeBlock
        language="bash"
        code={`curl -s "$WHEELSAI_API_URL/v1/support-llm/chat/completions" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "X-Request-Id: $REQUEST_ID" \\
  -H 'X-Payment: {"signature":"<base64 signed transaction>","network":"solana:mainnet"}' \\
  -d @request.json`}
      />
      <p>
        The server checks the network, expiry, signatures, recipient and amount before running the request. An invalid payment
        gets a fresh <code>402</code> with the <code>reason</code>. A transaction can pay for one request only; reusing it
        returns <code>409</code>. Verified payments are then settled on-chain by a background worker.
      </p>
      <Callout>
        <p>
          x402 payments go to the platform treasury. To earn from your own agent per request, list it on the marketplace with{" "}
          <Link href="/docs/guides/marketplace#per-request">per-request pricing</Link>.
        </p>
      </Callout>
    </DocPage>
  );
}
