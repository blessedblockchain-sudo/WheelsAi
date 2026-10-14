import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Endpoint, Fields } from "@/components/marketing/docs/endpoint";
import { Callout, DocTable } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Chat completions (/v1)",
  description:
    "The OpenAI-compatible WheelsAI API: one base URL for agents and model deployments (POST /v1/chat/completions routed on model), POST /v1/{deploymentSlug}/chat/completions, request fields, max_tokens cap, how requests to a dedicated deployment are covered by its per-second GPU billing, errors, paying an agent's use from a Solana wallet with x402, and paying a deployment per request from a wallet.",
};

const toc = [
  { id: "base-url", title: "One base URL" },
  { id: "chat-completions", title: "Create a chat completion" },
  { id: "streaming", title: "Streaming" },
  { id: "tools", title: "Function calling" },
  { id: "billing", title: "How a request is billed" },
  { id: "pricing", title: "Per-request token pricing" },
  { id: "errors", title: "Errors" },
  { id: "list-models", title: "List your models" },
  { id: "x402", title: "Pay an agent from a wallet, with x402" },
  { id: "x402-challenge", title: "The price", sub: true },
  { id: "x402-pay", title: "Pay", sub: true },
  { id: "x402-answer", title: "The answer", sub: true },
  { id: "x402-money", title: "Where the payment goes", sub: true },
  { id: "x402-limits", title: "Limits", sub: true },
  { id: "x402-refusals", title: "Refusals", sub: true },
  { id: "deployment-wallet", title: "Pay a deployment per request from a wallet" },
];

export default function InferenceApiPage() {
  return (
    <DocPage
      href="/docs/api/inference"
      title="Chat completions (/v1)"
      lead="Agents, workflows and running model deployments are reachable through OpenAI-compatible chat completions endpoints on the WheelsAI API, under one base URL. Requests are authenticated and metered against your plan. A request to a dedicated deployment is covered by that deployment's per-second GPU billing: it is not charged again per token."
      toc={toc}
    >
      <Endpoint
        id="base-url"
        method="POST"
        path="/v1/chat/completions"
        auth="API key or session"
        title="One base URL for agents, workflows and deployments"
        as="h2"
      >
        <p>
          Point an OpenAI client at <code>$WHEELSAI_API_URL/v1</code> and choose what answers with <code>model</code>:
        </p>
        <ul>
          <li>
            <code>agent/&lt;slug&gt;</code>: one of your agents. Streaming, function calling and the agent&apos;s own tools
            and knowledge base apply; see <Link href="/docs/api/agents#agent-api">the agent API</Link>.
          </li>
          <li>
            <code>workflow/&lt;slug&gt;</code>: one of your workflows. One request is one run, and the run&apos;s output is
            the answer; see <Link href="/docs/api/workflows#openai">the workflow endpoint</Link>.
          </li>
          <li>
            <code>a/&lt;handle&gt;</code>: an agent another organization sells that you pay to use; see{" "}
            <Link href="/docs/api/agents#paid-v1">an agent you pay for</Link>. Where its creator allows it, it can also
            be called with no key and each use paid from a Solana wallet; see <a href="#x402">x402</a>.
          </li>
          <li>
            <code>w/&lt;slug&gt;</code>: a workflow another organization sells that you pay to run, by the slug of its
            listing; see <Link href="/docs/api/workflows#w-v1">a workflow you pay for</Link>.
          </li>
          <li>
            any other value is the slug of a running model deployment, handled and billed exactly as{" "}
            <a href="#chat-completions">its own endpoint</a> below.
          </li>
        </ul>
        <CodeBlock
          language="ts"
          code={`import OpenAI from "openai";

const client = new OpenAI({
  baseURL: \`\${process.env.WHEELSAI_API_URL}/v1\`,
  apiKey: process.env.WHEELSAI_API_KEY,
});

const models = await client.models.list();          // agents, workflows and running deployments
const fromAgent = await client.chat.completions.create({
  model: "agent/support-bot",
  messages: [{ role: "user", content: "Hello" }],
});
const fromModel = await client.chat.completions.create({
  model: "support-llm",
  messages: [{ role: "user", content: "Hello" }],
  max_tokens: 256,
});`}
        />
        <p>
          Every error under <code>/v1</code> is in OpenAI&apos;s shape,{" "}
          <code>&#123; &quot;error&quot;: &#123; message, type, param, code &#125; &#125;</code>, so SDKs report it properly.
          A <code>model</code> that names nothing you can call answers <code>404</code> <code>model_not_found</code>; a
          missing <code>model</code> answers <code>400</code>. A <code>workflow/&lt;slug&gt;</code> that is not one of your
          workflows answers <code>404</code> <code>workflow_not_found</code>. Paths this API does not have, such as{" "}
          <code>/v1/responses</code> and <code>/v1/embeddings</code>, answer an OpenAI-shaped <code>404</code>.
        </p>
      </Endpoint>

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
          latency. Your credentials are never forwarded to the node. This is the same handler, with the same request,
          response, stream and error format, as the deployment branch of the <a href="#base-url">unified base URL</a>.
        </p>
        <Fields
          fields={[
            {
              name: "messages",
              type: "array",
              required: true,
              description: (
                <>
                  Conversation so far, 1 to 256 messages. <code>role</code> is <code>system</code>,{" "}
                  <code>developer</code> (sent to the model as <code>system</code>), <code>user</code>,{" "}
                  <code>assistant</code> (which may carry <code>tool_calls</code>) or <code>tool</code> (which needs{" "}
                  <code>tool_call_id</code>). <code>content</code> is a string or an array of text parts; image and audio
                  parts answer <code>400</code>.
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
            { name: "stop", type: "string | string[]", description: "Stop sequence, or up to four." },
            {
              name: "seed, presence_penalty, frequency_penalty, response_format, user",
              type: "various",
              description: "Forwarded to the model server as sent.",
            },
            {
              name: "tools",
              type: "array",
              description: (
                <>
                  Up to 64 functions, <code>&#123; type: &quot;function&quot;, function: &#123; name, description, parameters &#125; &#125;</code>
                  , forwarded to the model server with <code>tool_choice</code> and <code>parallel_tool_calls</code>. The
                  model&apos;s calls come back as <code>message.tool_calls</code> (<code>delta.tool_calls</code> when
                  streamed) for you to run; see <a href="#tools">Function calling</a>.
                </>
              ),
            },
            {
              name: "tool_choice",
              type: "string | object",
              description: (
                <>
                  <code>none</code>, <code>auto</code>, <code>required</code> or{" "}
                  <code>&#123; type: &quot;function&quot;, function: &#123; name &#125; &#125;</code> naming one of{" "}
                  <code>tools</code>.
                </>
              ),
            },
            {
              name: "model",
              type: "string",
              description:
                "Accepted for OpenAI SDK compatibility and not used for routing: the slug in the path selects the deployment. Whatever you send, the model server is asked for the model it actually serves.",
            },
            {
              name: "stream",
              type: "boolean",
              description: (
                <>
                  <code>true</code> answers with server-sent events: OpenAI <code>chat.completion.chunk</code> objects as
                  the model produces them, then <code>data: [DONE]</code>. See <a href="#streaming">Streaming</a>.
                </>
              ),
            },
            {
              name: "stream_options",
              type: "object",
              description: (
                <>
                  <code>&#123; include_usage: true &#125;</code> adds one final chunk with <code>usage</code> and{" "}
                  <code>choices: []</code>, when the model server reported its token counts.
                </>
              ),
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
          <code>usage</code> (<code>prompt_tokens</code>, <code>completion_tokens</code>), with <code>model</code> set to the
          deployment&apos;s slug. Every response carries an <code>X-Request-Id</code> header: yours if you sent one,
          otherwise a generated id. <code>n</code> other than 1, <code>logprobs</code>, <code>logit_bias</code>, audio output
          and the legacy <code>functions</code> parameter are refused with a <code>400</code> that names the parameter; other
          unknown fields are ignored.
        </p>
      </Endpoint>

      <h2 id="streaming">Streaming</h2>
      <p>
        With <code>stream: true</code> the model server&apos;s stream is passed to you as it arrives. Every chunk carries one{" "}
        <code>id</code>, the deployment&apos;s slug as <code>model</code>, and only the fields an OpenAI client reads (
        <code>role</code>, <code>content</code>, <code>tool_calls</code>, <code>finish_reason</code>). A successful stream ends
        with exactly one <code>data: [DONE]</code>. A stream that fails after it started ends with one{" "}
        <code>data: &#123; &quot;error&quot;: &#123; message, type, code &#125; &#125;</code> event and <strong>no</strong>{" "}
        <code>[DONE]</code>, so a client that stops reading at <code>[DONE]</code> cannot mistake a failure for an answer. A
        comment line (<code>: keep-alive</code>) is sent every 15 seconds while the model is quiet.
      </p>
      <CodeBlock
        language="ts"
        code={`const stream = await client.chat.completions.create({
  model: "support-llm",
  messages: [{ role: "user", content: "Write a haiku about GPUs." }],
  stream: true,
  stream_options: { include_usage: true },
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
  if (chunk.usage) console.log("\n", chunk.usage);
}`}
      />
      <p>
        The model has 30 seconds to start answering and the same time between chunks; a model that goes silent for longer
        ends the request with <code>504</code>, or with an error event if the stream had started. Closing the connection stops the generation.
      </p>

      <h2 id="tools">Function calling</h2>
      <p>
        <code>tools</code> and <code>tool_choice</code> are forwarded to the model server, which decides whether the model
        calls one. Whether <code>tool_choice: &quot;auto&quot;</code> works depends on the model: deployments of the model
        families below are started with the model server&apos;s tool-call parser, so the model&apos;s calls come back as{" "}
        <code>tool_calls</code>.
      </p>
      <DocTable
        caption="Model families started with automatic tool choice (vLLM engine)"
        columns={[
          { key: "family", label: "Model family" },
          { key: "parser", label: "Tool-call parser" },
        ]}
        rows={[
          { family: "Llama 3.1 and 3.2 Instruct", parser: <code>llama3_json</code> },
          { family: "Qwen 2.5 (including Coder)", parser: <code>hermes</code> },
          { family: "Mistral 7B Instruct v0.3", parser: <code>mistral</code> },
        ]}
      />
      <p>
        A deployment keeps the settings it was started with, so restart an older deployment of these families to turn the
        parser on. For any other model, and on the Ollama engine, the request is still forwarded
        and the model server answers for itself: where it cannot do what was asked, its <code>400</code> and its message are
        returned to you unchanged in meaning (<code>provider_rejected_request</code>). Calls are returned for{" "}
        <strong>you</strong> to run; a model deployment has no server-side tools. For tools that run on the platform, call
        an <Link href="/docs/api/agents#agent-api">agent</Link>.
      </p>

      <h2 id="billing">How a request is billed</h2>
      <p>
        A request to a running deployment is <strong>included in that deployment&apos;s GPU bill</strong>. The deployment is
        charged per second of GPU time for as long as it runs, whether it serves one request or a million, so a request to it:
      </p>
      <ul>
        <li>takes no hold from your credit balance and is not charged per token;</li>
        <li>writes no ledger row of its own (the GPU time appears as <code>gpu_usage</code> rows for the deployment);</li>
        <li>is not checked against your credit balance and is never asked for a payment from a wallet.</li>
      </ul>
      <p>
        Token counts are still returned in <code>usage</code> and recorded in the deployment&apos;s metrics, streamed or not.
        What ends service
        is the GPU bill: when your credits can no longer cover the deployment&apos;s GPU time it is stopped, and its endpoint
        answers <code>404</code> until you restart it. If the GPU time has gone unpaid for several billing intervals and the
        deployment could not be stopped yet, requests are refused in the meantime: <code>402</code> when your credits do not
        cover what is owed, <code>503</code> (<code>gpu_billing_stalled</code>) when they do and billing itself is behind. If
        GPU billing is temporarily unavailable, dedicated deployments answer <code>503</code> (
        <code>gpu_billing_disabled</code>) rather than serving requests unbilled.
      </p>
      <p>
        Each chat completion also counts as one API call toward your plan&apos;s monthly quota, whether it is made with an API
        key or a signed-in session. Reads such as <code>GET /v1/models</code> are free. GPU time for the deployment itself is
        what you pay for; see <Link href="/docs/guides/deploy-a-model#billing">How GPU time is billed</Link>.
      </p>

      <h2 id="pricing">Per-request token pricing</h2>
      <Callout variant="warning" title="Does not apply to dedicated deployments">
        <p>
          Every deployment you create runs on dedicated GPUs and is billed per second of GPU time, so the per-token prices and
          the payment from a wallet on this page are not charged for it. They apply only to a deployment that is billed per request instead
          of per GPU-second.
        </p>
      </Callout>
      <p>
        Every catalog model has a <code>pricingTier</code> (shown by <code>GET /api/models</code>). Where a deployment is billed
        per request, the worst-case cost (estimated prompt tokens plus the full <code>max_tokens</code>) is held from your
        credits before the request reaches the GPU, settled to the actual <code>usage</code> afterwards, and returned in full
        if the node cannot serve it. A streamed request is settled the same way when the stream ends. If the model server
        reports no token counts, the charge is priced on the size of the text it generated rather than on zero; and a
        stream you disconnect from part-way is charged for the part that was generated. Prices per million tokens:
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
      <p>
        Every error is <code>&#123; &quot;error&quot;: &#123; message, type, param, code &#125; &#125;</code>. When the model
        server itself answers with an error, its status is passed through: a <code>400</code> from the model server is a{" "}
        <code>400</code> here, with its message, and a <code>500</code> or <code>503</code> is that status. Three statuses
        are not passed through, because an SDK would misread them on this API: a node that answers <code>401</code>,{" "}
        <code>403</code> or <code>404</code> is reported as <code>502</code>, since your key was accepted and the deployment
        was found. Errors that repeating the request cannot fix carry <code>x-should-retry: false</code>.
      </p>
      <DocTable
        caption="Chat completion errors"
        columns={[
          { key: "status", label: "Status" },
          { key: "when", label: "When" },
        ]}
        rows={[
          {
            status: <code>400</code>,
            when: (
              <>
                Invalid body (<code>validation_failed</code>, <code>unsupported_parameter</code>,{" "}
                <code>unsupported_content</code>), for example <code>max_tokens</code> above 8192; or the model server
                rejected the request (<code>provider_rejected_request</code>), for example <code>tools</code> on a model
                it cannot parse tool calls for.
              </>
            ),
          },
          { status: <code>401</code>, when: "Missing or invalid API key or session." },
          {
            status: <code>402</code>,
            when: (
              <>
                Not enough credits: <code>insufficient_credits</code>, with <code>requiredCents</code> inside the error
                object. For a dedicated deployment this means its GPU time has gone unpaid and your balance does not cover it; a
                single request is never the reason. For a deployment billed per request it is the request&apos;s own cost, or a
                request for <a href="#deployment-wallet">a payment from a wallet</a>. An agent called with no key at its{" "}
                <a href="#x402">x402 door</a> answers <code>402</code> with its own codes, listed there.
              </>
            ),
          },
          { status: <code>404</code>, when: <>No deployment with that slug in your organization, or it is stopped or failed (<code>model_not_found</code>).</> },
          { status: <code>409</code>, when: <>The wallet payment transaction was already used for another request (<code>payment_already_used</code>). Sent with <code>x-should-retry: false</code>, so OpenAI SDKs do not retry it.</> },
          { status: <code>429</code>, when: <>Monthly API calls used up (<code>plan_limit_reached</code>), a rate limit, or the model server is at capacity (<code>provider_rate_limited</code>, with its <code>retry-after</code>).</> },
          {
            status: <code>502</code>,
            when: "The GPU node could not be reached, answered with a redirect, refused the request with 401, 403 or 404, answered a streaming request without a stream, or answered 200 with a body that is not a completion. Nothing is charged for the request, and a request to a deployment paid from a wallet has its payment returned to your credit balance.",
          },
          { status: <code>504</code>, when: <>The model server did not start answering, or stopped sending, within the timeout (<code>upstream_timeout</code>).</> },
          { status: <>other <code>5xx</code></>, when: "The model server's own status. Nothing is charged for the request, and a request to a deployment paid from a wallet has its payment returned to your credit balance." },
          {
            status: <code>503</code>,
            when: (
              <>
                The deployment exists and is not serving at this moment: it is still starting, or it has no healthy GPU
                node right now (<code>service_unavailable</code>); OpenAI SDKs retry it, and it answers once the deployment
                is running. Also when GPU billing is temporarily unavailable (<code>gpu_billing_disabled</code>), or billing
                has not collected this deployment&apos;s GPU time for several intervals (<code>gpu_billing_stalled</code>).
              </>
            ),
          },
        ]}
      />

      <Endpoint id="list-models" method="GET" path="/v1/models" auth="API key or session" title="List your models" as="h2">
        <p>
          OpenAI-style list of everything you can pass as <code>model</code> on the{" "}
          <a href="#base-url">unified base URL</a>: your organization&apos;s running deployments (<code>id</code> is the
          deployment slug, <code>root</code> the underlying Hugging Face model id) and your agents (<code>id</code> is{" "}
          <code>agent/&lt;slug&gt;</code>). It also lists your enabled workflows (<code>workflow/&lt;slug&gt;</code>), and
          the agents (<code>a/&lt;handle&gt;</code>) and workflows (<code>w/&lt;slug&gt;</code>) of other organizations
          that yours has started and pays for, on a plan that is running or at a price it agreed to.{" "}
          <code>wheelsai.kind</code> says which is which:{" "}
          <code>deployment</code>, <code>agent</code>, <code>workflow</code>, <code>paid_agent</code> or{" "}
          <code>paid_workflow</code>. Listing is free: it does not count as an API call.
        </p>
        <CodeBlock
          language="json"
          code={`{
  "object": "list",
  "data": [
    { "id": "support-llm", "object": "model", "created": 1790000000, "owned_by": "wheelsai",
      "permission": [], "root": "<hugging face model id>", "parent": null,
      "wheelsai": { "kind": "deployment" } },
    { "id": "agent/support-bot", "object": "model", "created": 1790000000, "owned_by": "wheelsai",
      "wheelsai": { "kind": "agent" } }
  ]
}`}
        />
      </Endpoint>

      <h2 id="x402">Pay an agent from a wallet, with x402</h2>
      <p>
        An agent whose creator allows it can be called with no account and no key, and each use paid in USDC from a
        Solana wallet. The agent speaks the published x402 format, version 2, with the Solana <code>exact</code> scheme,
        so an x402 client for Solana can pay it. It works on the agent&apos;s three use addresses:
      </p>
      <ul>
        <li>
          <code>POST /api/a/&#123;handle&#125;/chat</code>: one message (see{" "}
          <Link href="/docs/api/agents#paid-chat">chat with an agent you pay for</Link>);
        </li>
        <li>
          <code>POST /api/a/&#123;handle&#125;/run</code>: one run of a task agent (see{" "}
          <Link href="/docs/api/agents#paid-run">run a task you pay for</Link>);
        </li>
        <li>
          <code>POST /v1/chat/completions</code> with <code>model</code> <code>a/&lt;handle&gt;</code>: one message.
        </li>
      </ul>
      <p>
        A call is paid from a wallet only when it carries no credential at all: no <code>Authorization</code> header, not
        even an empty one, and no session cookie. A call with an API key or a session is billed to your organization as
        always, and a <code>PAYMENT-SIGNATURE</code> sent beside it is ignored. An agent takes payments from a wallet while
        WheelsAI offers paying from a wallet (<code>x402.available</code> in <code>GET /api/capabilities</code>) and its
        creator has turned them on for a published listing sold per use, its page is public, and it answers when it is
        called (a chat or a task agent). Any other agent answers a call with no key with <code>401</code>, as it always did. The
        agent&apos;s API data, <code>GET /api/a/&#123;handle&#125;/api</code> (no sign-in), carries <code>x402</code> while
        it takes them: <code>&#123; priceCents, unit, network, asset, answerWithinSeconds, limits &#125;</code>, and{" "}
        <code>null</code> otherwise. Pay from your server or a script: a page in a browser on another website cannot read
        the <code>PAYMENT-REQUIRED</code> and <code>PAYMENT-RESPONSE</code> headers.
      </p>

      <h3 id="x402-challenge">1. The price</h3>
      <p>
        Send the call with no key. The body is the address&apos;s own (for chat,{" "}
        <code>&#123; messages, stream &#125;</code>) and is checked first: a body the address does not take is{" "}
        <code>400</code>, before any price is asked. Then the answer is <code>402</code> with a{" "}
        <code>PAYMENT-REQUIRED</code> header, the base64 of this JSON:
      </p>
      <CodeBlock
        language="bash"
        code={`curl -i "$WHEELSAI_API_URL/api/a/support-bot/chat" \\
  -H "Content-Type: application/json" \\
  -d '{ "messages": [{ "role": "user", "content": "How long do refunds take?" }], "stream": false }'`}
      />
      <CodeBlock
        language="json"
        code={`{
  "x402Version": 2,
  "resource": {
    "url": "<the address you called>",
    "description": "<the listing's short description>",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "<the network, as CAIP-2>",
      "amount": "50000",
      "asset": "<the USDC mint of that network>",
      "payTo": "<WheelsAI's treasury wallet>",
      "maxTimeoutSeconds": 180,
      "extra": {
        "feePayer": "<WheelsAI's fee payer>",
        "memo": "<24 characters>"
      }
    }
  ]
}`}
      />
      <DocTable
        caption="What one use asks for"
        columns={[
          { key: "field", label: "Field" },
          { key: "means", label: "What it means" },
        ]}
        rows={[
          {
            field: <code>network</code>,
            means: (
              <>
                The Solana network the API runs on, named as CAIP-2: <code>solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp</code>{" "}
                for mainnet, <code>solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1</code> for devnet.
              </>
            ),
          },
          {
            field: <code>amount</code>,
            means: "The price of one use in USDC atomic units (6 decimals): the listing's price in cents times 10,000, so 50000 is $0.05.",
          },
          {
            field: <code>asset</code>,
            means: (
              <>
                The USDC mint of that network: <code>EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v</code> on mainnet,{" "}
                <code>4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU</code> on devnet.
              </>
            ),
          },
          {
            field: <code>payTo</code>,
            means: "The wallet paid. The transfer goes to its USDC account, the associated token account of this wallet and the mint.",
          },
          { field: <code>maxTimeoutSeconds</code>, means: "180: the longest one whole call can take, payment included." },
          {
            field: <code>extra.feePayer</code>,
            means: "The wallet that pays the network fee and signs last. Your wallet pays no fee and needs no SOL.",
          },
          {
            field: <code>extra.memo</code>,
            means: "The text your payment must carry as its one memo. It ties the payment to this agent and this price.",
          },
        ]}
      />
      <p>
        The body says the same in words. On <code>/api/a</code>:
      </p>
      <CodeBlock
        language="json"
        code={`{
  "error": "x402_payment_required",
  "message": "Pay $0.05 in USDC from a Solana wallet for one message, as the PAYMENT-REQUIRED header of this answer says, or send an API key.",
  "priceCents": 5,
  "unit": "message"
}`}
      />
      <p>
        <code>unit</code> is <code>message</code> or <code>run</code>. On <code>/v1</code> the body is OpenAI&apos;s error,
        with <code>code</code> <code>x402_payment_required</code>, <code>type</code> <code>payment_required</code>, and{" "}
        <code>priceCents</code> and <code>unit</code> on the error object. It carries <code>x-should-retry: false</code>,
        so an OpenAI client hands it to you instead of sending the call again.
      </p>

      <h3 id="x402-pay">2. Pay</h3>
      <p>
        Your x402 client builds one Solana transaction from <code>accepts[0]</code> and signs it with your wallet only:
      </p>
      <ul>
        <li>
          Its fee payer is <code>extra.feePayer</code>, whose signature is left empty: WheelsAI adds it, and only after the
          answer is ready.
        </li>
        <li>
          Its instructions, in this order: set the compute unit limit (at most 200,000); set the compute unit price (at
          most 50,000 microlamports a unit); one <code>TransferChecked</code> of the SPL Token program (not Token-2022), of exactly{" "}
          <code>amount</code> with 6 decimals, from your USDC account to <code>payTo</code>&apos;s USDC account, signed by
          your wallet as its owner; and one memo whose text is exactly <code>extra.memo</code>. A wallet may add its own
          Lighthouse instructions after the memo; six instructions at most, and nothing else.
        </li>
        <li>
          Legacy or version 0, with no address lookup tables. The fee payer is in none of its instructions.
        </li>
        <li>Your wallet needs a USDC account holding at least the amount. It needs no SOL.</li>
      </ul>
      <p>
        The client then sends the same request again, with the payment in a <code>PAYMENT-SIGNATURE</code> header: the
        base64 of <code>&#123; &quot;x402Version&quot;: 2, &quot;accepted&quot;: &lt;accepts[0] as it came&gt;,
        &quot;payload&quot;: &#123; &quot;transaction&quot;: &lt;the base64 transaction&gt; &#125; &#125;</code>. A
        header that cannot be read, or of another version, is no payment: the answer is a fresh <code>402</code> whose{" "}
        <code>error</code> is <code>invalid_payload</code> or <code>invalid_x402_version</code>.
      </p>
      <CodeBlock
        language="bash"
        code={`curl -i "$WHEELSAI_API_URL/api/a/support-bot/chat" \\
  -H "Content-Type: application/json" \\
  -H "PAYMENT-SIGNATURE: <the payment your x402 client made>" \\
  -d '{ "messages": [{ "role": "user", "content": "How long do refunds take?" }], "stream": false }'`}
      />

      <h3 id="x402-answer">3. The answer</h3>
      <p>The order is what keeps your payment safe:</p>
      <ol>
        <li>
          The payment is checked before the agent runs: it asks for what this agent asks now (a price changed since the{" "}
          <code>402</code> is refused), the transaction is built as above, and it would go through on Solana.
        </li>
        <li>The agent makes its answer, and the answer is checked whole. Nothing of it is sent yet.</li>
        <li>Only then does WheelsAI sign as the fee payer and send your payment to Solana.</li>
        <li>
          The answer is released once Solana confirms the payment: <code>200</code>, with a <code>PAYMENT-RESPONSE</code>{" "}
          header and <code>x-wheelsai-charged-cents</code>.
        </li>
      </ol>
      <p>
        When there is no answer, the payment is never sent and nothing is charged. An answer paid this way must be ready
        within 30 seconds of the call, or it is stopped and nothing is sent. Allow up to 3 minutes for the whole call while
        the payment is confirmed; a confirmation usually comes within seconds.
      </p>
      <CodeBlock
        language="http"
        code={`HTTP/1.1 200 OK
content-type: application/json; charset=utf-8
PAYMENT-RESPONSE: <base64>
x-wheelsai-charged-cents: 5

{
  "message": { "role": "assistant", "content": "Refunds take 3 to 5 business days." },
  "toolCalls": [],
  "billing": { "chargedCents": 5, "balanceCents": null, "access": "listing_pricing" }
}`}
      />
      <p>
        <code>PAYMENT-RESPONSE</code> is the base64 of{" "}
        <code>&#123; &quot;success&quot;: true, &quot;payer&quot;, &quot;transaction&quot;, &quot;network&quot;, &quot;amount&quot; &#125;</code>:
        your wallet, the transaction&apos;s signature, the network as CAIP-2 and the atomic units paid.{" "}
        <code>billing.balanceCents</code> is <code>null</code>: there is no balance, the payment is the charge. A chat on{" "}
        <code>/api/a</code> answers as a stream unless <code>stream</code> is <code>false</code>, as for a buyer; on{" "}
        <code>/v1</code> it answers whole unless <code>stream</code> is <code>true</code>, with{" "}
        <code>wheelsai.billing</code> beside OpenAI&apos;s fields. Either way the headers come before the first byte.
      </p>
      <p>
        One payment pays for one use. The same <code>PAYMENT-SIGNATURE</code> sent again is refused as presented once, and
        the agent does not run again.
      </p>

      <h3 id="x402-money">Where the payment goes</h3>
      <p>
        The payment goes to WheelsAI&apos;s treasury, and WheelsAI pays the network fee. The agent&apos;s creator earns
        90% of each use, as with any sale. It appears in the creator&apos;s earnings as <strong>Paid from a wallet</strong>,
        never with your wallet&apos;s address.
      </p>

      <h3 id="x402-limits">Limits</h3>
      <ul>
        <li>Each address can call one agent 10 times a minute, counted on every call, the first one included.</li>
        <li>Each wallet can pay for 10 uses a minute and 200 a day of one agent; each address, for 200 uses a day.</li>
        <li>One payment from a wallet at a time: while one is going through, the next is refused until it is answered.</li>
        <li>
          After 3 answers in a day made for payments from a wallet, or from an address, that then did not go through, that
          wallet or address is refused until tomorrow.
        </li>
      </ul>

      <h3 id="x402-refusals">Refusals</h3>
      <p>
        On <code>/api/a</code> a refusal is <code>&#123; error, message &#125;</code> with <code>priceCents</code> and{" "}
        <code>unit</code> where a payment is asked for, <code>retryAfterSeconds</code> with <code>retry-after</code> on a
        limit, and <code>transaction</code> where a payment was sent. On <code>/v1</code> it is OpenAI&apos;s error, with
        the code below and <code>reason</code> carrying the code of the first column where <code>/v1</code> folds several
        into one. Every <code>402</code> of a use paid from a wallet carries <code>x-should-retry: false</code> on{" "}
        <code>/v1</code>. Once your payment is taken up for its answer, after its checks, the limits and a read of Solana,
        every refusal on <code>/v1</code> carries <code>x-should-retry: false</code>: the same payment sent again would only
        be refused as presented once.
      </p>
      <DocTable
        caption="Refusals of a use paid from a wallet"
        columns={[
          { key: "status", label: "Status" },
          { key: "code", label: "error (/api/a)" },
          { key: "v1", label: "error.code (/v1)" },
          { key: "when", label: "When" },
        ]}
        rows={[
          { status: <code>400</code>, code: <code>invalid_request</code>, v1: <><code>validation_failed</code>, <code>unsupported_parameter</code></>, when: "The body is not what the address takes. Checked before the price is asked." },
          { status: <code>409</code>, code: <code>not_a_task_agent</code>, v1: "", when: "The run address, on an agent that is not a task agent." },
          { status: <code>413</code>, code: <code>input_too_large</code>, v1: "", when: "The answers of a run are too long." },
          { status: <code>422</code>, code: <code>input_invalid</code>, v1: "", when: <>Some answers of a run need another look; <code>details</code> lists them.</> },
          { status: <code>401</code>, code: "", v1: <code>invalid_api_key</code>, when: "The agent does not take payments from a wallet: the answer of any call with no key." },
          { status: <code>402</code>, code: <code>x402_payment_required</code>, v1: <code>x402_payment_required</code>, when: <>No payment, or one that could not be read. <code>PAYMENT-REQUIRED</code> says what to pay.</> },
          { status: <code>402</code>, code: <code>x402_payment_invalid</code>, v1: <code>x402_payment_required</code>, when: <>The payment cannot be accepted. Either it does not match what was asked or it would not go through (for example too little USDC), so it was not sent and nothing was charged. Or it was presented before: a payment pays for one answer only, so it was not sent again. A fresh <code>PAYMENT-REQUIRED</code> says why in its <code>error</code>, in the published words, such as <code>invalid_exact_svm_payload_amount_mismatch</code>, <code>transaction_simulation_failed</code> or <code>duplicate_settlement</code>.</> },
          { status: <code>402</code>, code: <code>x402_payment_failed</code>, v1: <code>x402_payment_required</code>, when: <>The payment expired before it could go through, or Solana refused it, so the answer was not released. Nothing was taken from your wallet. <code>PAYMENT-RESPONSE</code> says <code>success</code> <code>false</code> with <code>errorReason</code> <code>transaction_failed</code>. Pay again with a new transaction.</> },
          { status: <code>429</code>, code: <code>rate_limited</code>, v1: <code>rate_limit_exceeded</code>, when: <>A limit above, or a payment from this wallet still going through. Nothing was sent; <code>retry-after</code> says how long to wait.</> },
          { status: <code>429</code>, code: <code>x402_too_many_unpaid</code>, v1: <code>rate_limit_exceeded</code>, when: "Too many answers today for payments from this wallet or address that did not go through. Try again tomorrow." },
          { status: <code>499</code>, code: <code>client_closed_request</code>, v1: <code>client_closed_request</code>, when: "You closed the call before the answer was ready. Your payment was not sent." },
          { status: <code>502</code>, code: <><code>model_error</code>, <code>answer_withheld</code></>, v1: <><code>upstream_error</code>, <code>answer_withheld</code></>, when: "The agent could not answer, or its answer could not be released. Your payment was not sent and nothing was charged." },
          { status: <code>502</code>, code: <code>x402_payment_unserved</code>, v1: <code>x402_payment_unserved</code>, when: <>Your payment went through but the answer could not be released. <code>transaction</code> names the payment.</> },
          { status: <code>503</code>, code: <><code>x402_unavailable</code>, <code>agent_paused</code>, <code>rate_limiter_unavailable</code></>, v1: <code>service_unavailable</code>, when: "Paying from a wallet is not available right now, the agent is paused, or calls cannot be counted. Nothing was sent and nothing was charged." },
          { status: <code>504</code>, code: <code>answer_timed_out</code>, v1: <code>upstream_timeout</code>, when: "The answer was not ready within 30 seconds, so it was stopped. Your payment was not sent and nothing was charged." },
          { status: <code>504</code>, code: <code>x402_payment_unconfirmed</code>, v1: <code>x402_payment_unconfirmed</code>, when: <>Your payment was sent but could not be confirmed in time, so the answer was not released. <code>transaction</code> names the payment: look it up on Solana before you pay again.</> },
        ]}
      />
      <p>
        From code, an x402 client library for Solana does steps 1 and 2 for you; give it the wallet that pays. Before you
        start, read the agent&apos;s API page at <code>/a/&#123;handle&#125;/api</code>: it shows the first call with no key,
        filled in for that agent, while the agent takes payments from a wallet.
      </p>

      <h2 id="deployment-wallet">Pay a deployment per request from a wallet</h2>
      <p>
        A dedicated deployment is never asked for a payment from a wallet: its requests are already paid for by its GPU time
        (see <a href="#billing">How a request is billed</a>). For a deployment billed per request, <code>/v1</code> requests
        can be paid one at a time with a Solana payment, following the HTTP 402 pattern, in WheelsAI&apos;s own headers{" "}
        <code>X-Payment-Required</code> and <code>X-Payment</code>. This is not the published x402 format of{" "}
        <a href="#x402">an agent&apos;s door</a>: an x402 client does not pay it. It works in one of two modes:{" "}
        <strong>fallback</strong> (use credits when the balance covers the request, otherwise ask for payment) or{" "}
        <strong>required</strong> (every request is paid). When it is not on, requests use credits only. You still
        authenticate as usual; the payment replaces the credit charge, not the API key.
      </p>
      <p>
        <strong>1. The challenge.</strong> A request that needs payment answers <code>402</code> with an{" "}
        <code>X-Payment-Required</code> header (the requirement as JSON) and this body:
      </p>
      <CodeBlock
        language="json"
        code={`{
  "error": {
    "message": "This request needs a payment from a Solana wallet. The X-Payment-Required header says how much and where to send it.",
    "type": "payment_required",
    "param": null,
    "code": "x402_payment_required"
  },
  "payment": {
    "scheme": "exact",
    "network": "solana:mainnet",
    "asset": "USDC",
    "amount": "<amount in the asset's base units, as a string>",
    "amountUsd": 0.0012,
    "payTo": "<the treasury wallet>",
    "payToTokenAccount": "<the treasury's USDC token account>",
    "mint": "<the USDC mint>",
    "memo": "deployment:<id>;request:<requestId>",
    "validUntil": 1790000000,
    "quote": null
  },
  "requestId": "x402_...",
  "reason": "<set when a payment was presented and refused, see below>"
}`}
      />
      <p>
        <code>network</code> names the Solana network to pay on (<code>solana:mainnet</code>), and <code>asset</code> the
        asset to pay with: <code>USDC</code> or <code>SOL</code>. The price is based on the request&apos;s estimated tokens
        with a 20% buffer. <code>validUntil</code> (Unix seconds) is when the challenge expires: a SOL price is held until
        then.
      </p>
      <DocTable
        caption="What the payment object asks for, by asset"
        columns={[
          { key: "field", label: "Field" },
          { key: "usdc", label: "USDC" },
          { key: "sol", label: "SOL" },
        ]}
        rows={[
          {
            field: <code>amount</code>,
            usdc: "USDC base units (6 decimals), so 1200 is $0.0012.",
            sol: "Lamports, worked out from the SOL price at the moment of the challenge.",
          },
          {
            field: <code>payTo</code>,
            usdc: "The treasury wallet. Do not send USDC to this address itself.",
            sol: "The treasury wallet. The transfer goes to this address.",
          },
          {
            field: <code>payToTokenAccount</code>,
            usdc: "The treasury's USDC token account. The transfer must go to this account.",
            sol: <code>null</code>,
          },
          { field: <code>mint</code>, usdc: "The USDC mint on this network.", sol: <code>null</code> },
          {
            field: <code>quote</code>,
            usdc: <code>null</code>,
            sol: "A token that holds the SOL price the amount was worked out at. Send it back with the payment.",
          },
        ]}
      />
      <p>
        When SOL is the asset and no current SOL price can be read, the challenge asks for USDC instead. USDC can always be
        used.
      </p>
      <p>
        <strong>2. Pay.</strong> Build one Solana transaction with a single transfer that carries at least{" "}
        <code>amount</code>, sign it with the paying wallet as fee payer, and serialize it as base64. Do not send it to the
        network yourself: WheelsAI sends it when you retry.
      </p>
      <ul>
        <li>
          <strong>USDC:</strong> a token transfer (<code>transfer</code> or <code>transferChecked</code>) to{" "}
          <code>payToTokenAccount</code>. A checked transfer must name <code>mint</code> and 6 decimals. A transfer to{" "}
          <code>payTo</code> itself, or to any other account, is refused.
        </li>
        <li>
          <strong>SOL:</strong> a System Program transfer to <code>payTo</code>.
        </li>
        <li>
          One transfer must carry the whole amount: two smaller transfers are not added together. Pay the amount asked; no
          change is given for a larger transfer on a request that is served.
        </li>
        <li>
          Legacy and version 0 transactions are both accepted, with every required signature in place. A transaction that
          uses address lookup tables is refused. Other instructions a wallet adds, such as a compute budget or a memo, are
          fine.
        </li>
      </ul>
      <p>
        <strong>3. Retry</strong> the same request body with the payment attached, and the <code>X-Request-Id</code> from the
        challenge so the payment and request are correlated. For SOL, include the <code>quote</code> from the challenge; for
        USDC it can be left out.
      </p>
      <CodeBlock
        language="bash"
        code={`curl -s "$WHEELSAI_API_URL/v1/support-llm/chat/completions" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "X-Request-Id: $REQUEST_ID" \\
  -H 'X-Payment: {"signature":"<base64 signed transaction>","network":"solana:mainnet","quote":"<quote from the challenge, for SOL>"}' \\
  -d @request.json`}
      />
      <p>
        WheelsAI reads the transaction, checks its signatures, destination, asset and amount against the request&apos;s
        price, sends it to the network and waits for it to land before running the request. For SOL the price is worked out
        again from the retried body at the price held in <code>quote</code>, so the amount in the challenge is the amount
        that is checked. A transaction can pay for one request only; presenting it again returns <code>409</code> (
        <code>payment_already_used</code>).
      </p>
      <p>
        <strong>When a payment is refused.</strong> The answer is a fresh <code>402</code> with a new challenge.{" "}
        <code>error.message</code> says why in a sentence, and <code>reason</code> is one of:
      </p>
      <DocTable
        caption="Reasons a presented payment is refused"
        columns={[
          { key: "reason", label: "reason" },
          { key: "meaning", label: "What it means" },
          { key: "money", label: "Your payment" },
        ]}
        rows={[
          {
            reason: <code>quote_expired</code>,
            meaning:
              "SOL only. The quote is missing, has expired, or was issued for another organization or deployment. Send the request again to get a new price.",
            money: "Not sent. Nothing was taken.",
          },
          {
            reason: <code>payment_invalid</code>,
            meaning:
              "The transaction could not be read, or it does not pay the right address, asset or amount. Check all three and send the request again.",
            money: "Not sent. Nothing was taken.",
          },
          {
            reason: <code>payment_failed_on_chain</code>,
            meaning: "The transaction reached the network and failed there. Send the request again.",
            money: "Nothing was taken.",
          },
          {
            reason: <code>payment_not_confirmed</code>,
            meaning: "The transaction was sent and did not confirm in time. Send the request again with a new payment.",
            money: "If it lands later, it is returned to your credit balance.",
          },
        ]}
      />
      <p>
        <strong>When a paid request fails.</strong> If your payment landed and the request then produced no answer (the GPU
        node failed, timed out or answered with an error), the payment is returned to your organization&apos;s credit
        balance, once. You get the error the request would have had, with a <code>payment</code> object added to the body:
      </p>
      <CodeBlock
        language="json"
        code={`{
  "error": { "message": "...", "type": "...", "param": null, "code": "..." },
  "payment": {
    "status": "returned",
    "amountUsd": 0.0012,
    "message": "Your payment for this request was returned to your credit balance. Amounts under a cent add up and appear once they reach a cent."
  }
}`}
      />
      <p>
        What is returned is the value of what you sent, in US dollars; for SOL, at the price in your quote. The transfer
        itself is not sent back to your wallet. A single request usually costs less than a cent, so returned amounts add up
        and move to your balance in whole cents, each time as a ledger row labelled{" "}
        <strong>Paid request returned as credits</strong> (type <code>x402_refund</code>). A request that is refused before
        the payment is looked at, for example <code>503</code> when the deployment has no healthy GPU node, does not touch
        your transaction at all.
      </p>
      <Callout>
        <p>
          A payment for a deployment&apos;s request goes to WheelsAI&apos;s treasury and pays for that request in place of
          credits: it is nobody&apos;s earnings. A use of an agent paid at its <a href="#x402">x402 door</a> goes to the
          treasury too, and its creator earns 90% of it. To earn from your own agent per request, list it on the marketplace
          with <Link href="/docs/guides/marketplace#per-request">per-request pricing</Link>, and let people with no account
          pay each use from a wallet.
        </p>
      </Callout>
    </DocPage>
  );
}
