import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Endpoint, Fields } from "@/components/marketing/docs/endpoint";
import { Callout, DocTable } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Agents, playground and agent API",
  description:
    "WheelsAI agents API: import from GitHub, create, list, read, update and delete agents, encrypted environment variables, playground chat, and each agent's OpenAI-compatible /v1 endpoint with streaming, function calling and tool use.",
};

const toc = [
  { id: "agents", title: "Agents" },
  { id: "import-github", title: "Import from GitHub", sub: true },
  { id: "list-agents", title: "List agents", sub: true },
  { id: "get-agent", title: "Get an agent", sub: true },
  { id: "create-agent", title: "Create an agent", sub: true },
  { id: "update-agent", title: "Update an agent", sub: true },
  { id: "agent-usage", title: "Agent chat usage", sub: true },
  { id: "delete-agent", title: "Delete an agent", sub: true },
  { id: "deploy-agent", title: "Deploy an agent", sub: true },
  { id: "agent-api", title: "Agent API (/v1)" },
  { id: "agent-completions", title: "Create a chat completion", sub: true },
  { id: "agent-streaming", title: "Streaming", sub: true },
  { id: "agent-tools", title: "Function calling and tools", sub: true },
  { id: "agent-errors", title: "Errors", sub: true },
  { id: "agent-models", title: "List the agent's model", sub: true },
  { id: "playground", title: "Playground" },
  { id: "playground-chat", title: "Chat with an agent", sub: true },
  { id: "playground-models", title: "Available models", sub: true },
];

export default function AgentsApiPage() {
  return (
    <DocPage
      href="/docs/api/agents"
      title="Agents, playground and agent API"
      lead="Agents belong to your organization. Every endpoint on this page accepts an API key or a session, and only ever sees your organization's agents: an id from another organization answers 404."
      toc={toc}
    >
      <h2 id="agents">Agents</h2>

      <Endpoint id="import-github" method="POST" path="/api/agents/import-github" auth="API key or session" title="Detect an agent's configuration from a GitHub repository">
        <Fields fields={[{ name: "githubUrl", type: "string (URL)", required: true, description: <>A repository URL, optionally with <code>/tree/&lt;branch&gt;</code>.</> }]} />
        <p>
          Reads <code>package.json</code>, <code>requirements.txt</code> or <code>pyproject.toml</code> and returns a suggested
          configuration. Nothing is created; pass the result to <a href="#create-agent">create an agent</a>. Private
          repositories are read through your organization&apos;s GitHub App installation.
        </p>
        <CodeBlock
          language="json"
          code={`{
  "config": {
    "framework": "mastra",
    "name": "repo-name",
    "description": "From the repository description",
    "sourceUrl": "https://github.com/owner/repo",
    "branch": "main",
    "detectedFiles": ["package.json"]
  },
  "repoInfo": { "owner": "owner", "repo": "repo" }
}`}
        />
        <p>
          A repository that does not exist, or that the installation cannot see, answers <code>404</code> with a message saying
          what to do about it.
        </p>
      </Endpoint>

      <Endpoint id="list-agents" method="GET" path="/api/agents" auth="API key or session" title="List agents">
        <p>
          Returns <code>&#123; agents, total &#125;</code>, newest first. Each agent has <code>id</code>, <code>name</code>,{" "}
          <code>slug</code>, <code>description</code>, <code>framework</code>, <code>version</code>, <code>tags</code>,{" "}
          <code>isPublic</code>, <code>latestDeployment</code> and timestamps, plus where its API is:{" "}
          <code>apiEndpoint</code> (the agent&apos;s chat-completions URL), <code>openaiBaseUrl</code> (the{" "}
          <code>base_url</code> for an OpenAI client) and <code>openaiModel</code> (<code>agent/&lt;slug&gt;</code>). The two
          URLs are <code>null</code> when they cannot be determined.
        </p>
      </Endpoint>

      <Endpoint id="get-agent" method="GET" path="/api/agents/{agentId}" auth="API key or session" title="Get an agent">
        <p>
          Returns <code>&#123; agent &#125;</code> with its full configuration, deployments and the same{" "}
          <code>apiEndpoint</code>, <code>openaiBaseUrl</code> and <code>openaiModel</code> as the list. A deployment&apos;s{" "}
          <code>endpoint</code> is the agent&apos;s <code>/v1</code> URL while it is <code>running</code> and{" "}
          <code>null</code> otherwise. Environment variables come back as their <strong>names only</strong>: values are
          encrypted at rest (AES-256-GCM) and never leave the API.
        </p>
      </Endpoint>

      <Endpoint id="create-agent" method="POST" path="/api/agents" auth="API key or session" title="Create an agent">
        <Fields
          fields={[
            { name: "name", type: "string", required: true, description: "3 to 100 characters. A unique slug is derived from it." },
            { name: "framework", type: "enum", required: true, description: <><code>mastra</code>, <code>elizaos</code>, <code>langchain</code>, <code>autogen</code>, <code>crewai</code> or <code>custom</code>.</> },
            { name: "modelConfig", type: "object", required: true, description: <><code>externalModel</code> (a free model id such as <code>free/groq/llama-3.3-70b</code>, or <code>provider/model</code>), <code>modelId</code> (a catalog model), <code>temperature</code> 0 to 2 (default 0.7), <code>maxTokens</code> 1 to 32768 (default 4096).</> },
            { name: "sourceType", type: "enum", required: true, description: <><code>inline</code> (requires <code>sourceCode</code>), <code>github</code> or <code>ipfs</code> (require <code>sourceUrl</code>).</> },
            { name: "sourceCode", type: "string", description: "Up to 100,000 characters." },
            { name: "sourceUrl", type: "string (URL)", description: "Repository or IPFS URL." },
            { name: "description", type: "string", description: "Up to 500 characters." },
            { name: "systemPrompt", type: "string", description: "Up to 10,000 characters." },
            { name: "tools", type: "array", description: <>Items <code>&#123; name, type, description?, config? &#125;</code>, <code>type</code> one of <code>function</code>, <code>api</code>, <code>mcp</code>.</> },
            { name: "env", type: "object", description: "String values, for example provider keys. Encrypted at rest; write-only." },
            { name: "tags", type: "string[]", description: "Free-form tags." },
            { name: "isPublic", type: "boolean", description: <>Default <code>false</code>. Public agents get a transparency page at <code>/a/&#123;slug&#125;</code>.</> },
            { name: "knowledgeBaseId", type: "uuid | null", description: "Ground the agent's answers in one of your knowledge bases." },
          ]}
        />
        <CodeBlock
          language="bash"
          code={`curl -s -X POST "$WHEELSAI_API_URL/api/agents" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Release notes helper",
    "framework": "custom",
    "systemPrompt": "You turn commit messages into short, user-facing release notes.",
    "modelConfig": { "externalModel": "free/groq/llama-3.3-70b", "temperature": 0.3 },
    "sourceType": "github",
    "sourceUrl": "https://github.com/owner/repo"
  }'`}
        />
        <p>
          Answers <code>201</code> with <code>&#123; agent: &#123; id, name, slug, framework &#125;, message &#125;</code>. Over
          the plan&apos;s agent limit it answers <code>403</code> with <code>plan_limit_reached</code>. Fires the{" "}
          <code>agent.created</code> webhook.
        </p>
      </Endpoint>

      <Endpoint id="update-agent" method="PATCH" path="/api/agents/{agentId}" auth="API key or session" title="Update an agent">
        <p>
          Send any subset of the create fields. <code>modelConfig</code> is merged into the existing one. <code>env</code> is
          merged key by key: a string sets or replaces a variable, <code>null</code> deletes it, and variables you do not mention
          are kept. Changing the source, system prompt, tools or entrypoint bumps the agent&apos;s patch version. Fires{" "}
          <code>agent.updated</code>.
        </p>
        <CodeBlock
          language="json"
          code={`{ "env": { "OPENAI_API_KEY": "sk-...", "OLD_TOKEN": null } }`}
        />
        <p>
          <code>entrypoint</code> chooses what answers a chat, in the playground and on <code>/v1</code>:{" "}
          <code>&quot;chat&quot;</code> (the default) is the agent&apos;s prompt, model and tools;{" "}
          <code>&quot;graph&quot;</code> is the graph saved in the builder. Setting <code>&quot;graph&quot;</code> on an agent
          with no saved graph, or an empty one, answers <code>400</code> <code>agent_graph_missing</code>. See{" "}
          <a href="#agent-graph">Graph agents</a>.
        </p>
      </Endpoint>

      <Endpoint id="agent-usage" method="GET" path="/api/agents/{agentId}/usage" auth="API key or session" title="Agent chat usage">
        <p>
          Requests, errors, tokens and latency of the agent&apos;s chats, playground and <code>/v1</code> together, from an
          hourly rollup. <code>?period=</code> is <code>24h</code> (default), <code>7d</code> or <code>30d</code>.
        </p>
        <CodeBlock
          language="json"
          code={`{
  "usage": {
    "period": "24h",
    "since": "2026-10-05T12:00:00.000Z",
    "total": {
      "requests": 128, "errors": 2, "streamed": 97, "answered": 124,
      "inputTokens": 51234, "outputTokens": 9120, "usageUnreported": 3, "toolCalls": 41,
      "avgLatencyMs": 1840, "p50LatencyMs": 1512, "p95LatencyMs": 6240, "errorRate": 0.015625
    },
    "bySource": { "api": { "requests": 110, "...": "..." }, "playground": { "requests": 18, "...": "..." } },
    "series": [{ "periodStart": "2026-10-06T10:00:00.000Z", "requests": 12, "errors": 0, "inputTokens": 4410, "outputTokens": 803 }]
  }
}`}
        />
        <ul>
          <li>
            Tokens are summed only for chats whose model provider reported them. <code>usageUnreported</code> counts answered
            chats that reported none; they are not in the sums and nothing is estimated.
          </li>
          <li>
            Latency covers answered chats only and is measured per request, in milliseconds, at the API.{" "}
            <code>p50LatencyMs</code> and <code>p95LatencyMs</code> are the times of actual requests (not interpolated),
            and all three latency fields are <code>null</code> when no answered chat was measured in the period.
          </li>
          <li>
            <code>errors</code> are chats that were admitted and produced no answer. A caller that disconnected is a request,
            not an error; a refused request (a 4xx before the chat started) is not counted at all.
          </li>
        </ul>
      </Endpoint>

      <Endpoint id="delete-agent" method="DELETE" path="/api/agents/{agentId}" auth="API key or session" title="Delete an agent">
        <p>
          Stops the agent&apos;s running deployments and deletes it. Fires <code>agent.deleted</code>.
        </p>
      </Endpoint>

      <Endpoint id="deploy-agent" method="POST" path="/api/agents/{agentId}/deploy" auth="API key or session" title="Deploy an agent to a GPU tier">
        <Fields
          fields={[
            { name: "gpuTier", type: "string", required: true, description: <>A tier id from <code>GET /api/models</code>, for example <code>4090</code>.</> },
            { name: "replicas", type: "integer", description: "1 to 5, default 1." },
            { name: "modelDeploymentId", type: "uuid", description: "A running model deployment in your organization for the agent to use." },
            { name: "externalModelUrl", type: "string (URL)", description: "Or an external OpenAI-compatible model URL." },
          ]}
        />
        <p>
          One of <code>modelDeploymentId</code>, <code>externalModelUrl</code> or the agent&apos;s{" "}
          <code>modelConfig.externalModel</code> is required. Admission works as for{" "}
          <Link href="/docs/guides/deploy-a-model#admission">model deployments</Link>: an active-deployment quota (
          <code>429</code>) and a one-hour credit reservation (<code>402</code>). Answers <code>201</code> with the agent
          deployment&apos;s <code>id</code> and <code>status</code>. Follow it with{" "}
          <code>GET /api/agents/&#123;agentId&#125;/deployments/&#123;deploymentId&#125;</code>, read build output with{" "}
          <code>.../logs</code>, and stop it with <code>POST .../stop</code>. The agent&apos;s secrets are not included in the
          GPU job definition.
        </p>
      </Endpoint>

      <h2 id="agent-api">Agent API (/v1)</h2>
      <p>
        Every agent has an OpenAI-compatible endpoint, served by the WheelsAI API itself. It is on as soon as the agent
        exists: no GPU deployment is needed for it. A request runs the agent as the playground does, with its system prompt,
        its model, its enabled tools and its knowledge base.
      </p>
      <DocTable
        caption="Two ways to address an agent"
        columns={[
          { key: "base", label: "OpenAI base URL" },
          { key: "model", label: "model" },
          { key: "use", label: "Use it when" },
        ]}
        rows={[
          {
            base: <code>$WHEELSAI_API_URL/v1</code>,
            model: <code>agent/&lt;slug&gt;</code>,
            use: <>One client for several agents and <Link href="/docs/api/inference#base-url">model deployments</Link>.</>,
          },
          {
            base: <code>$WHEELSAI_API_URL/v1/agents/&lt;slug&gt;</code>,
            model: "anything (ignored)",
            use: "A client that is hard-wired to one model name, or one agent per integration.",
          },
        ]}
      />

      <Endpoint id="agent-completions" method="POST" path="/v1/agents/{slug}/chat/completions" auth="API key or session" title="Create a chat completion">
        <p>
          <code>slug</code> is the agent&apos;s slug in your organization; any other organization&apos;s slug answers{" "}
          <code>404</code>. The same request sent to <code>POST /v1/chat/completions</code> with{" "}
          <code>&quot;model&quot;: &quot;agent/&lt;slug&gt;&quot;</code> behaves identically.
        </p>
        <Fields
          fields={[
            { name: "messages", type: "array", required: true, description: <>1 to 256 items, 400,000 characters in total. Roles <code>system</code>, <code>developer</code> (treated as system), <code>user</code>, <code>assistant</code> (may carry <code>tool_calls</code>) and <code>tool</code> (needs <code>tool_call_id</code>). <code>content</code> is a string or an array of text parts; image and audio parts are refused.</> },
            { name: "model", type: "string", description: <>Ignored on this path: the agent is the model, and it answers on the model its owner configured. The response says <code>agent/&lt;slug&gt;</code>.</> },
            { name: "stream", type: "boolean", description: <>Stream the answer as server-sent events. With <code>stream_options.include_usage</code>, a final usage chunk is sent.</> },
            { name: "tools, tool_choice, parallel_tool_calls", type: "", description: <>Your own functions; see <a href="#agent-tools">function calling</a>.</> },
            { name: "temperature, top_p, max_completion_tokens / max_tokens, stop, seed, presence_penalty, frequency_penalty, response_format, user", type: "", description: <>Passed to the model. <code>temperature</code> and the token cap (1 to 32,768) override the agent&apos;s own for this request.</> },
          ]}
        />
        <p>
          Parameters that would change what the answer is and cannot be honoured are refused by name with <code>400</code>{" "}
          rather than ignored: <code>n</code> other than 1, <code>logprobs</code>, <code>logit_bias</code>,{" "}
          <code>audio</code>, non-text <code>modalities</code> and the legacy <code>functions</code> /{" "}
          <code>function_call</code>. Unknown fields are ignored.
        </p>
        <CodeBlock
          language="bash"
          code={`curl -s "$WHEELSAI_API_URL/v1/agents/support-bot/chat/completions" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "messages": [{"role": "user", "content": "How long do refunds take?"}] }'`}
        />
        <CodeBlock
          language="json"
          code={`{
  "id": "chatcmpl-6f0c...",
  "object": "chat.completion",
  "created": 1790000000,
  "model": "agent/support-bot",
  "system_fingerprint": null,
  "choices": [
    { "index": 0,
      "message": { "role": "assistant", "content": "Refunds take 5 business days.", "refusal": null },
      "logprobs": null,
      "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 412, "completion_tokens": 9, "total_tokens": 421 },
  "wheelsai": {
    "agent": { "slug": "support-bot", "version": "1.0.3" },
    "model": "free/groq/llama-3.3-70b",
    "runtime": "platform",
    "tool_calls": [{ "round": 1, "name": "knowledge_search", "status": "ok", "detail": null }],
    "billing": null,
    "retrieval": null
  }
}`}
        />
        <ul>
          <li>
            <code>usage</code> is what the model provider reported. When a provider reports none, the field is left out; it is
            never filled with zeros.
          </li>
          <li>
            <code>wheelsai</code> carries what OpenAI&apos;s shape has no field for: the model that actually answered, the
            agent&apos;s own tool calls and how each ended, <code>billing</code> for a paid marketplace install (
            <code>&#123; listingTitle, chargedCents, creatorCents &#125;</code>) and <code>retrieval</code> for an agent bound
            to a knowledge base. OpenAI SDKs ignore it.
          </li>
          <li>
            <code>runtime</code> is <code>platform</code> when the answer comes from the platform&apos;s chat runtime using
            the agent&apos;s prompt, model, tools and knowledge base, and <code>graph</code> when the agent answered by
            running its saved graph (below). An agent&apos;s uploaded source code is not executed on this endpoint.
          </li>
        </ul>
        <h4 id="agent-hosted-models">Agents on a model you host</h4>
        <p>
          An agent whose model is <code>wheelsai/&lt;model id&gt;</code> (the &quot;WheelsAI Hosted&quot; choice in the agent
          wizard) answers on your organization&apos;s own running deployment of that model, through one of its healthy
          nodes. Its chats are included in the deployment&apos;s per-second GPU bill, as a{" "}
          <Link href="/docs/api/inference#billing">direct request to the deployment</Link> is: no per-token charge and no
          free-model rate limit. When no deployment of the model is running, none of its nodes is healthy, or its GPU time
          is unpaid, the chat answers <code>503</code> <code>hosted_model_not_running</code> with the reason, and is not
          retried by SDKs. An agent with tools needs a model family that{" "}
          <Link href="/docs/api/inference#tools">supports tool calling</Link>.
        </p>
        <h4 id="agent-graph">Graph agents</h4>
        <p>
          An agent whose <code>entrypoint</code> is <code>graph</code> answers every chat by running the graph saved in the
          builder: one chat is one run, stored with its trace. What differs from a chat on the agent&apos;s prompt:
        </p>
        <ul>
          <li>
            The graph receives one input string. A single user message is passed as it is; with earlier turns, the
            conversation is written out ahead of the current message, so the graph does not answer each message as if it
            were the first.
          </li>
          <li>
            <code>tools</code> in the request answer <code>400</code> <code>unsupported_parameter</code>: a graph has no
            turn in which to hand a function call back and resume. Tools belong in the graph&apos;s own nodes.
          </li>
          <li>
            The response has no <code>usage</code>: a run spans several model calls and none reports for the whole.{" "}
            <code>wheelsai.graph</code> is <code>&#123; executionId, durationMs, steps &#125;</code>, each step with its node,
            status and duration. Inputs and outputs of the nodes stay in the stored run.
          </li>
          <li>
            A streamed answer is produced in full and then sent as chunks, as a tool-using agent&apos;s is.
          </li>
          <li>
            A run that fails answers <code>502</code> <code>graph_run_failed</code> with <code>executionId</code> and{" "}
            <code>failedStep</code>, and a paid marketplace run is refunded. An agent set to <code>graph</code> whose graph
            was deleted answers <code>400</code> <code>agent_graph_missing</code>.
          </li>
        </ul>
        <p>
          Each request counts as one API call on your plan. On a free model it also draws on your organization&apos;s
          free-model rate limit, and responses carry <code>x-ratelimit-remaining-requests</code>,{" "}
          <code>x-ratelimit-reset-requests</code> and the <code>X-RateLimit-*-RPM</code> / <code>-RPD</code> headers. A
          per-request marketplace install is charged before the model runs and refunded if no answer is delivered. Every
          response has an <code>X-Request-Id</code>: yours if you sent one.
        </p>
        <Callout>
          <p>
            An API key acts for its whole organization. A key created with <code>scopes</code> must include{" "}
            <code>agents:invoke</code> (or <code>*</code>) to call an agent; a key with no scopes, which is what the dashboard
            creates, can call any of them. Scopes are not enforced on the other endpoints yet, so they are not a way to make
            a key that can only chat.
          </p>
        </Callout>
      </Endpoint>

      <h3 id="agent-streaming">Streaming</h3>
      <p>
        With <code>&quot;stream&quot;: true</code> the response is <code>text/event-stream</code>: <code>data:</code> frames of{" "}
        <code>chat.completion.chunk</code> objects, all under one id and <code>model: agent/&lt;slug&gt;</code>, ending with{" "}
        <code>data: [DONE]</code>. The first chunk carries the assistant role and the <code>wheelsai</code> object. Every
        chunk has a choice, except the usage chunk you get by asking for it with{" "}
        <code>stream_options: &#123; include_usage: true &#125;</code>.
      </p>
      <CodeBlock
        language="ts"
        code={`import OpenAI from "openai";

const client = new OpenAI({
  baseURL: \`\${process.env.WHEELSAI_API_URL}/v1\`,
  apiKey: process.env.WHEELSAI_API_KEY,
});

const stream = await client.chat.completions.create({
  model: "agent/support-bot",
  messages: [{ role: "user", content: "How long do refunds take?" }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}`}
      />
      <ul>
        <li>
          A failure before the first byte is an ordinary HTTP error. A failure after it is one{" "}
          <code>data: &#123; &quot;error&quot;: ... &#125;</code> frame and <strong>no</strong> <code>[DONE]</code>; a paid
          request is refunded.
        </li>
        <li>
          An agent with tools runs its tool rounds first and then streams the finished answer, so the first token arrives
          after the tools have run. Keep-alive comments are sent while a stream is quiet.
        </li>
        <li>Closing the connection cancels the run.</li>
      </ul>

      <h3 id="agent-tools">Function calling and tools</h3>
      <p>
        Two kinds of tools can take part in one request. The agent&apos;s <strong>own tools</strong> (the skills enabled on
        it, and its knowledge base) run on the platform and never need anything from you; what ran is reported in{" "}
        <code>wheelsai.tool_calls</code>. <strong>Your functions</strong>, sent in <code>tools</code>, are never run by the
        platform: when the model calls one, the response ends with <code>finish_reason: &quot;tool_calls&quot;</code> and{" "}
        <code>message.tool_calls</code>, exactly as with OpenAI. Run the function, then send the conversation back with the
        assistant message and a <code>tool</code> message per call.
      </p>
      <CodeBlock
        language="python"
        code={`import json, os
from openai import OpenAI

client = OpenAI(base_url=os.environ["WHEELSAI_API_URL"] + "/v1", api_key=os.environ["WHEELSAI_API_KEY"])

tools = [{
    "type": "function",
    "function": {
        "name": "get_order_status",
        "description": "Look up an order by id",
        "parameters": {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]},
    },
}]
messages = [{"role": "user", "content": "Where is order 1042?"}]

first = client.chat.completions.create(model="agent/support-bot", messages=messages, tools=tools)
reply = first.choices[0].message

if reply.tool_calls:
    messages.append(reply)
    for call in reply.tool_calls:
        args = json.loads(call.function.arguments)
        messages.append({
            "role": "tool",
            "tool_call_id": call.id,
            "content": json.dumps(get_order_status(args["order_id"])),  # your code
        })
    final = client.chat.completions.create(model="agent/support-bot", messages=messages, tools=tools)
    print(final.choices[0].message.content)`}
      />
      <ul>
        <li>Up to 64 functions; names match <code>^[a-zA-Z0-9_-]&#123;1,64&#125;$</code>.</li>
        <li>
          A function may not have the name of a built-in agent tool (<code>400</code> <code>tool_name_conflict</code>), and{" "}
          <code>tool_choice</code> can only name one of your functions (<code>400</code> <code>unknown_tool_choice</code>):
          the agent&apos;s own tools run on the agent&apos;s terms.
        </li>
        <li>
          When one model turn mixes the agent&apos;s tools with yours, the agent&apos;s run first and only your calls are
          handed back. Send back the assistant message unchanged: its call ids are how the platform puts its own half of the
          turn back together (kept for one hour).
        </li>
        <li>Each round trip is one request: one API call and, for a per-request marketplace install, one charge.</li>
      </ul>

      <h3 id="agent-errors">Errors</h3>
      <p>
        Errors on <code>/v1/agents/...</code> and <code>/v1/chat/completions</code> are in OpenAI&apos;s shape,{" "}
        <code>&#123; &quot;error&quot;: &#123; message, type, param, code &#125; &#125;</code>. Where repeating the same request
        cannot succeed, the response carries <code>x-should-retry: false</code> so OpenAI SDKs do not retry it (each retry
        would be another metered call).
      </p>
      <DocTable
        caption="Agent chat completion errors"
        columns={[
          { key: "status", label: "Status" },
          { key: "code", label: "error.code" },
          { key: "when", label: "When" },
        ]}
        rows={[
          { status: <code>400</code>, code: <><code>validation_failed</code>, <code>unsupported_parameter</code>, <code>unsupported_content</code>, <code>messages_too_large</code>, <code>tool_name_conflict</code>, <code>unknown_tool_choice</code></>, when: <>The request itself; <code>param</code> names the field.</> },
          { status: <code>400</code>, code: <><code>agent_model_key_missing</code>, <code>unknown_model</code>, <code>provider_rejected_request</code></>, when: "The agent's model needs a provider key that is not in its environment variables, is not a known model, or the provider refused the request." },
          { status: <code>400</code>, code: <code>agent_graph_missing</code>, when: "The agent answers through its graph and has none saved. Not retried." },
          { status: <code>401</code>, code: <code>invalid_api_key</code>, when: "Missing or invalid API key or session." },
          { status: <code>402</code>, code: <code>marketplace_payment_required</code>, when: <>A per-request marketplace install and not enough credits; with <code>requiredCents</code>, <code>balanceCents</code> and <code>listingTitle</code>.</> },
          { status: <code>403</code>, code: <><code>licence_revoked</code>, <code>insufficient_scope</code></>, when: <>The install was removed, its subscription lapsed or its token is no longer held (<code>reason</code>, and <code>tokenSymbol</code> / <code>mintAddress</code> for a token gate); or a scoped key without <code>agents:invoke</code>.</> },
          { status: <code>404</code>, code: <><code>agent_not_found</code>, <code>not_found</code></>, when: "No agent with that slug in your organization, or a /v1 path that does not exist." },
          { status: <code>413</code>, code: <code>request_too_large</code>, when: "The body is over 4 MiB." },
          { status: <code>429</code>, code: <code>rate_limit_exceeded</code>, when: <>The free-model limit per minute or per day, with <code>retry-after</code>; or the API&apos;s general rate limit.</> },
          { status: <code>429</code>, code: <code>plan_limit_reached</code>, when: <>The plan&apos;s monthly API calls are used up (<code>type</code> is <code>insufficient_quota</code>).</> },
          { status: <code>429</code>, code: <code>provider_rate_limited</code>, when: <>The model provider&apos;s own limit; its <code>retry-after</code> is passed on.</> },
          { status: <code>501</code>, code: <code>model_provider_not_configured</code>, when: "The agent's free model is temporarily unavailable. Pick another free model, or add your own provider key to the agent." },
          { status: <code>502</code>, code: <><code>upstream_error</code>, <code>provider_auth_failed</code>, <code>provider_model_not_found</code>, <code>empty_answer</code>, <code>tool_loop_exhausted</code>, <code>graph_run_failed</code></>, when: "The model provider failed, rejected the credentials configured for it, or produced no answer; or the agent's graph run failed. A paid request is refunded." },
          { status: <code>503</code>, code: <><code>hosted_model_not_running</code>, <code>service_unavailable</code></>, when: <>The agent&apos;s WheelsAI-hosted model has no deployment that can serve right now (not retried); or the API is restarting, in which case nothing was charged and <code>retry-after</code> says when to try again.</> },
          { status: <code>504</code>, code: <code>upstream_timeout</code>, when: "The model did not answer within the chat time limit." },
        ]}
      />

      <Endpoint id="agent-models" method="GET" path="/v1/agents/{slug}/models" auth="API key or session" title="List the agent's model">
        <p>
          So that <code>client.models.list()</code> works with the per-agent base URL. Returns one entry,{" "}
          <code>agent/&lt;slug&gt;</code>. Free: it does not count as an API call.{" "}
          <Link href="/docs/api/inference#list-models"><code>GET /v1/models</code></Link> lists all of your agents and running
          deployments.
        </p>
      </Endpoint>

      <h2 id="playground">Playground</h2>

      <Endpoint id="playground-chat" method="POST" path="/api/agents/{agentId}/playground/chat" auth="API key or session" title="Chat with an agent">
        <Fields
          fields={[
            { name: "messages", type: "array", required: true, description: <>1 to 50 items of <code>&#123; role, content &#125;</code>; <code>role</code> is <code>user</code>, <code>assistant</code> or <code>system</code>; <code>content</code> 1 to 32,000 characters.</> },
            { name: "model", type: "string", description: <>Override the agent&apos;s model for this request. Defaults to the agent&apos;s <code>modelConfig.externalModel</code>, then the first available free model.</> },
            { name: "stream", type: "boolean", description: <>Default <code>false</code>. When <code>true</code> the answer streams as <code>text/event-stream</code>.</> },
          ]}
        />
        <p>
          The dashboard&apos;s own chat endpoint, in its own response shape. It runs through the same service as the{" "}
          <a href="#agent-api">agent API</a>; use that one from your code. The agent&apos;s system prompt, tools and model
          settings are applied. A non-streaming answer looks like:
        </p>
        <CodeBlock
          language="json"
          code={`{
  "content": "Here is what I can do...",
  "model": "free/groq/llama-3.3-70b",
  "usage": { "inputTokens": 42, "outputTokens": 118 },
  "billing": null,
  "retrieval": null
}`}
        />
        <ul>
          <li>
            <code>billing</code> is set when the agent is a paid marketplace install billed per request:{" "}
            <code>&#123; listingTitle, chargedCents, creatorCents &#125;</code>. The charge is taken before the model runs and
            refunded if it fails.
          </li>
          <li>
            <code>retrieval</code> is set when the agent is bound to a knowledge base: the retrieval <code>mode</code> and the{" "}
            <code>sources</code> used (document title, chunk id and score).
          </li>
        </ul>
        <p>Errors specific to this endpoint:</p>
        <ul>
          <li>
            <code>429</code> <code>RateLimitExceeded</code>: the organization&apos;s free-model limit per minute or per day.
            Responses on free models carry <code>X-RateLimit-Remaining-RPM</code>, <code>X-RateLimit-Remaining-RPD</code>,{" "}
            <code>X-RateLimit-Reset-RPM</code> and <code>X-RateLimit-Reset-RPD</code>.
          </li>
          <li>
            <code>400</code>: the model cannot be used, for example a <code>provider/model</code> whose key is not set in the
            agent&apos;s environment variables. The message names the variable to set.
          </li>
          <li>
            <code>501</code>: the free model is temporarily unavailable (<code>model_provider_not_configured</code>). Pick
            another free model, or add your own provider key to the agent.
          </li>
          <li>
            <code>503</code>: the agent&apos;s WheelsAI-hosted model has no deployment that can serve right now (
            <code>hosted_model_not_running</code>), or the API is restarting.
          </li>
          <li>
            <code>402</code> <code>PaymentRequired</code>: a per-request marketplace install and not enough credits (with{" "}
            <code>requiredCents</code> and <code>balanceCents</code>).
          </li>
          <li>
            <code>403</code> <code>LicenceRevoked</code>: a marketplace install that was uninstalled.
          </li>
          <li>
            <code>502</code> <code>ModelError</code>: the model provider failed.
          </li>
        </ul>
        <Callout>
          <p>
            Playground chat does not draw on your credits for your own agents on free models; it is limited by rate instead. It
            does count as an API call when made with an API key.
          </p>
        </Callout>
      </Endpoint>

      <Endpoint id="playground-models" method="GET" path="/api/agents/{agentId}/playground/models" auth="API key or session" title="Models available to an agent">
        <p>
          Returns <code>freeModels</code> (the free catalog, each with its provider and context length) and{" "}
          <code>externalModels</code> (models that need your own provider key, with the environment variable to set, such as{" "}
          <code>OPENAI_API_KEY</code>).
        </p>
      </Endpoint>
    </DocPage>
  );
}
