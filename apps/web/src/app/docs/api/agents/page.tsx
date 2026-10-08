import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Endpoint, Fields } from "@/components/marketing/docs/endpoint";
import { Callout, DocTable } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Agents, playground and agent API",
  description:
    "WheelsAI agents API: import from GitHub, create, list, read, update and delete agents, the three kinds of agent and task forms, encrypted environment variables, playground chat, and each agent's OpenAI-compatible /v1 endpoint with streaming, function calling and tool use.",
};

const toc = [
  { id: "agents", title: "Agents" },
  { id: "import-github", title: "Import from GitHub", sub: true },
  { id: "list-agents", title: "List agents", sub: true },
  { id: "get-agent", title: "Get an agent", sub: true },
  { id: "create-agent", title: "Create an agent", sub: true },
  { id: "agent-kinds", title: "Kinds of agent", sub: true },
  { id: "task-form", title: "Task forms", sub: true },
  { id: "update-agent", title: "Update an agent", sub: true },
  { id: "agent-usage", title: "Agent chat usage", sub: true },
  { id: "delete-agent", title: "Delete an agent", sub: true },
  { id: "deploy-agent", title: "Deploy an agent", sub: true },
  { id: "run-agent", title: "Run a task", sub: true },
  { id: "public-link", title: "Public link", sub: true },
  { id: "public-run", title: "Run from a public page", sub: true },
  { id: "agent-management-errors", title: "Errors", sub: true },
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
          <code>isPublic</code>, <code>publicHandle</code> (the name in its <a href="#public-link">public address</a>,{" "}
          <code>null</code> until it has been public), <code>agentKind</code> (<a href="#agent-kinds">how people use it</a>),{" "}
          <code>latestDeployment</code> and timestamps, plus where its API is:{" "}
          <code>apiEndpoint</code> (the agent&apos;s chat-completions URL), <code>openaiBaseUrl</code> (the{" "}
          <code>base_url</code> for an OpenAI client) and <code>openaiModel</code> (<code>agent/&lt;slug&gt;</code>). The two
          URLs are <code>null</code> when they cannot be determined.
        </p>
      </Endpoint>

      <Endpoint id="get-agent" method="GET" path="/api/agents/{agentId}" auth="API key or session" title="Get an agent">
        <p>
          Returns <code>&#123; agent &#125;</code> with its full configuration, its <code>agentKind</code> and{" "}
          <code>kindConfig</code> (<code>null</code> when it has no settings), <code>publicHandle</code>,{" "}
          <code>publicResults</code> (whether a self-running agent&apos;s latest results show on its public page),
          deployments and the same{" "}
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
            { name: "description", type: "string", description: "Up to 500 characters." },
            { name: "systemPrompt", type: "string", description: "What the agent should do. Up to 10,000 characters." },
            { name: "agentKind", type: "enum", description: <><code>conversation</code> (the default), <code>task</code> or <code>scheduled</code>. See <a href="#agent-kinds">kinds of agent</a>.</> },
            { name: "kindConfig", type: "object | null", description: <>The settings of the kind: <code>task</code> holds the <a href="#task-form">form</a>, <code>scheduled</code> holds a suggested schedule and what the agent is told at each run. Up to 16 KB.</> },
            { name: "templateId", type: "uuid", description: <>Start from a published <Link href="/docs/guides/templates">template</Link>. Its values are the defaults, and each field you send replaces the template&apos;s.</> },
            { name: "modelConfig", type: "object", description: <><code>externalModel</code> (a free model id such as <code>free/groq/llama-3.3-70b</code>, or <code>provider/model</code>), <code>modelId</code> (a catalog model), <code>temperature</code> 0 to 2 (default 0.7), <code>maxTokens</code> 1 to 32768 (default 4096). Without a model, the agent answers on the platform&apos;s default free model.</> },
            { name: "framework", type: "enum", description: <><code>mastra</code>, <code>elizaos</code>, <code>langchain</code>, <code>autogen</code>, <code>crewai</code> or <code>custom</code> (the default).</> },
            { name: "sourceType", type: "enum", description: <><code>inline</code> (the default), <code>github</code> or <code>ipfs</code>. The last two need <code>sourceUrl</code>.</> },
            { name: "sourceCode", type: "string", description: "Up to 100,000 characters." },
            { name: "sourceUrl", type: "string (URL)", description: "Repository or IPFS URL." },
            { name: "slug", type: "string", description: "Up to 100 characters. Left out, it is made from the name. Either way it is made unique in your organization." },
            { name: "tools", type: "array", description: <>Items <code>&#123; name, type, description?, config? &#125;</code>, <code>type</code> one of <code>function</code>, <code>api</code>, <code>mcp</code>.</> },
            { name: "env", type: "object", description: "String values, for example provider keys. Encrypted at rest; write-only." },
            { name: "tags", type: "string[]", description: "Free-form tags." },
            { name: "isPublic", type: "boolean", description: <>Default <code>false</code>. A public agent has a page at <code>/a/&#123;handle&#125;</code>; making it public gives it a handle. Nobody can use the agent from that page until you turn its <a href="#public-link">public link</a> on.</> },
            { name: "knowledgeBaseId", type: "uuid | null", description: "Ground the agent's answers in one of your knowledge bases." },
          ]}
        />
        <CodeBlock
          language="bash"
          code={`curl -s -X POST "$WHEELSAI_API_URL/api/agents" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "name": "Release notes helper" }'`}
        />
        <p>
          Only a name is needed: that request creates an agent people can talk to. Add what you want it to do and anything
          else from the table:
        </p>
        <CodeBlock
          language="bash"
          code={`curl -s -X POST "$WHEELSAI_API_URL/api/agents" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Release notes helper",
    "systemPrompt": "You turn commit messages into short, user-facing release notes.",
    "modelConfig": { "externalModel": "free/groq/llama-3.3-70b", "temperature": 0.3 },
    "agentKind": "task",
    "kindConfig": {
      "task": {
        "fields": [
          { "label": "Commit messages", "type": "long_text", "required": true, "help": "One per line." },
          { "label": "Audience", "type": "choice", "options": ["Customers", "Developers"] }
        ]
      }
    }
  }'`}
        />
        <p>Answers <code>201</code>:</p>
        <CodeBlock
          language="json"
          code={`{
  "agent": {
    "id": "8f0c2a4e-...",
    "name": "Release notes helper",
    "slug": "release-notes-helper",
    "framework": "custom",
    "agentKind": "task",
    "apiEndpoint": "https://api.example.com/v1/agents/release-notes-helper/chat/completions",
    "openaiBaseUrl": "https://api.example.com/v1/agents/release-notes-helper",
    "openaiModel": "agent/release-notes-helper"
  },
  "message": "Agent created successfully"
}`}
        />
        <p>
          Fires the <code>agent.created</code> webhook. A request that cannot be accepted answers <code>400</code>{" "}
          <code>validation_failed</code> with a sentence for each field; see <a href="#agent-management-errors">errors</a>.
        </p>

        <h4 id="agent-kinds">Kinds of agent</h4>
        <p>
          <code>agentKind</code> says how people use the agent. It chooses what they see first; every agent still answers
          a chat on its <a href="#agent-api">API</a>.
        </p>
        <DocTable
          caption="The three kinds of agent"
          columns={[
            { key: "kind", label: "agentKind" },
            { key: "use", label: "How it is used" },
            { key: "settings", label: "Its settings in kindConfig" },
          ]}
          rows={[
            { kind: <code>conversation</code>, use: "People talk to it, one message after another.", settings: "None." },
            { kind: <code>task</code>, use: "Made for one request in and one result back. Its form says what a request holds.", settings: <><code>task.fields</code>: the questions of the form. Without one, the form is a single long-text question, &quot;Your request&quot;.</> },
            { kind: <code>scheduled</code>, use: "Made to run on its own at set times.", settings: <><code>scheduled.schedule</code>: suggested times as <code>&#123; cronExpression, timezone? &#125;</code> (a five-part cron expression and an IANA time zone). <code>scheduled.prompt</code>: what the agent is told at each run, up to 2,000 characters.</> },
          ]}
        />
        <p>
          <code>kindConfig</code> has one key per kind, so changing an agent&apos;s kind and changing it back loses nothing.
          Keys other than <code>task</code> and <code>scheduled</code> are refused.
        </p>
        <p>
          The kind and its settings are stored with the agent, copied to a buyer&apos;s copy and recorded on each version.{" "}
          <code>scheduled.schedule</code> is a suggestion that travels with the agent: saving it starts no runs. To run an
          agent at set times, create a scheduled task with the <Link href="/docs/api/workflows#scheduler">scheduler</Link>.
        </p>

        <h4 id="task-form">Task forms</h4>
        <p>
          A task agent&apos;s form is <code>kindConfig.task.fields</code>: 1 to 12 questions, shown in the order you send them.
        </p>
        <Fields
          title="A question"
          fields={[
            { name: "label", type: "string", required: true, description: "What the person is asked. Up to 120 characters." },
            { name: "type", type: "enum", description: <><code>short_text</code> (the default), <code>long_text</code>, <code>number</code>, <code>choice</code>, <code>yes_no</code>, <code>link</code> or <code>list</code>.</> },
            { name: "required", type: "boolean", description: <>Default <code>false</code>.</> },
            { name: "help", type: "string", description: "One line shown under the question. Up to 300 characters." },
            { name: "options", type: "string[]", description: <>For <code>choice</code>: 2 to 50 options of up to 100 characters each.</> },
            { name: "key", type: "string", description: <>The question&apos;s name in code: a lowercase letter, then up to 39 lowercase letters, digits or underscores. Left out, it is made from the label (<code>Code to review</code> becomes <code>code_to_review</code>). Send it back when you edit the form and it stays the same, so renaming or reordering questions never breaks a caller.</> },
          ]}
        />
        <DocTable
          caption="What each type of question accepts"
          columns={[
            { key: "type", label: "type" },
            { key: "answer", label: "Answer" },
          ]}
          rows={[
            { type: <code>short_text</code>, answer: "Text of up to 200 characters." },
            { type: <code>long_text</code>, answer: "Text of up to 20,000 characters." },
            { type: <code>number</code>, answer: "A number." },
            { type: <code>choice</code>, answer: <>One of the question&apos;s <code>options</code>.</> },
            { type: <code>yes_no</code>, answer: <><code>true</code> or <code>false</code>.</> },
            { type: <code>link</code>, answer: "A URL of up to 2,048 characters." },
            { type: <code>list</code>, answer: "Up to 50 items of up to 500 characters each." },
          ]}
        />
      </Endpoint>

      <Endpoint id="update-agent" method="PATCH" path="/api/agents/{agentId}" auth="API key or session" title="Update an agent">
        <p>
          Send any subset of the create fields. <code>modelConfig</code> is merged into the existing one. <code>env</code> is
          merged key by key: a string sets or replaces a variable, <code>null</code> deletes it, and variables you do not mention
          are kept. Changing the source, system prompt, tools, entrypoint, kind or kind settings bumps the agent&apos;s patch
          version. Fires <code>agent.updated</code>.
        </p>
        <p>
          <code>agentKind</code> and <code>kindConfig</code> stay as they are unless you send them. Inside{" "}
          <code>kindConfig</code>, a key you send (<code>task</code> or <code>scheduled</code>) replaces that key and the
          other is kept; a key set to <code>null</code> removes it, and <code>kindConfig: null</code> clears all settings. A
          task agent always has a form: with none of its own it gets the single &quot;Your request&quot; question.
        </p>
        <CodeBlock
          language="json"
          code={`{
  "agentKind": "scheduled",
  "kindConfig": {
    "scheduled": {
      "schedule": { "cronExpression": "0 9 * * *", "timezone": "Europe/Berlin" },
      "prompt": "Summarise yesterday's merged changes."
    }
  }
}`}
        />
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
        <p>
          An agent answers on its <a href="#agent-api">API</a> without a deployment. This call gives it a dedicated GPU.
          Ask <code>GET /api/capabilities</code> first: when <code>agentGpu.available</code> is <code>false</code>, the
          call answers <code>501</code> <code>agent_gpu_unavailable</code> whatever is sent. Nothing is reserved or
          charged, and the agent keeps answering on its API.
        </p>
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

      <Endpoint id="run-agent" method="POST" path="/api/agents/{agentId}/run" auth="API key with the agents:invoke scope, or session" title="Run a task">
        <p>
          A <a href="#task-form">task agent&apos;s form</a>, filled in, gives one result. Call this from your code with an
          API key that holds the <code>agents:invoke</code> scope, or from the dashboard with a session. The agent must be in
          your organization.
        </p>
        <Fields
          fields={[
            { name: "input", type: "object", required: true, description: <>One answer per question, keyed by the question&apos;s <code>key</code>. Up to 8,000 characters of answers in all. A question that is not required may be left out.</> },
            { name: "stream", type: "boolean", description: <>Default <code>true</code>: the result streams as it is written. <code>false</code> waits and answers JSON.</> },
          ]}
        />
        <CodeBlock
          language="bash"
          code={`curl -s -X POST "$WHEELSAI_API_URL/api/agents/$AGENT_ID/run" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "input": { "commit_messages": "fix: refund total\\nfeat: export to CSV", "audience": "Customers" },
    "stream": false
  }'`}
        />
        <p>With <code>&quot;stream&quot;: false</code> the answer is:</p>
        <CodeBlock
          language="json"
          code={`{
  "output": { "format": "text", "text": "This week: refunds now show the right total, and you can export to CSV." },
  "toolCalls": [],
  "durationMs": 1840,
  "billing": null
}`}
        />
        <ul>
          <li>
            <code>toolCalls</code> lists every tool the agent called and how each call ended (<code>ok</code>,{" "}
            <code>unavailable</code>, <code>error</code> or <code>unknown</code>).
          </li>
          <li>
            <code>billing</code> is <code>&#123; listingTitle, chargedCents, creatorCents &#125;</code> when the agent is a
            paid marketplace install billed per request, and <code>null</code> when nothing was charged. A run that does not
            produce a result is refunded.
          </li>
          <li>
            Streamed, the response is <code>text/event-stream</code>, in the same format as the{" "}
            <a href="#playground-chat">playground</a>&apos;s: <code>data:</code> frames of chat-completion chunks (the text
            is <code>choices[0].delta.content</code>), tool calls under <code>wheelsai.toolCalls</code>, and a final{" "}
            <code>data: [DONE]</code>.
          </li>
          <li>
            The answers are checked against the form before anything else happens. A refused form is never counted against a
            free-model limit and never charged. A run stops after two minutes. Nothing is saved as history: the answer is
            the result.
          </li>
        </ul>
        <p>A form that does not fit answers <code>422</code> with every answer that needs another look, in the order of the form:</p>
        <CodeBlock
          language="json"
          code={`{
  "error": "input_invalid",
  "message": "Some answers need another look.",
  "details": [
    { "path": "/commit_messages", "field": "commit_messages", "label": "Commit messages", "message": "This question needs an answer." }
  ]
}`}
        />
        <p>
          <code>path</code> is a JSON pointer into <code>input</code>; <code>field</code> and <code>label</code> are the
          question&apos;s key and label, and are <code>null</code> when the answer is not for a question of the form.
        </p>
        <DocTable
          caption="Run refusals"
          columns={[
            { key: "status", label: "Status" },
            { key: "code", label: "error" },
            { key: "when", label: "When" },
          ]}
          rows={[
            { status: <code>400</code>, code: <code>validation_failed</code>, when: <>The request itself: a field other than <code>input</code> and <code>stream</code>, or an agent id that is not an id. Also an agent whose model cannot be used; the message says what to set.</> },
            { status: <code>402</code>, code: <code>PaymentRequired</code>, when: <>A per-request marketplace install and not enough credits; with <code>requiredCents</code> and <code>balanceCents</code>.</> },
            { status: <code>403</code>, code: <><code>LicenceRevoked</code>, <code>missing_scope</code></>, when: <>The install was removed, its subscription lapsed or its token is no longer held; or an API key without <code>agents:invoke</code>.</> },
            { status: <code>404</code>, code: <code>Not Found</code>, when: "No agent with that id in your organization." },
            { status: <code>409</code>, code: <code>not_a_task_agent</code>, when: <>The agent&apos;s kind is not <code>task</code>. Chat with it instead.</> },
            { status: <code>413</code>, code: <code>input_too_large</code>, when: "The answers are too long: over 8,000 characters in all, or a request of over 64 KB." },
            { status: <code>422</code>, code: <code>input_invalid</code>, when: <>Some answers do not fit the form; <code>details</code> lists them.</> },
            { status: <code>429</code>, code: <><code>RateLimitExceeded</code>, <code>plan_limit_reached</code></>, when: "The free-model limit, or the plan's monthly API calls, are used up." },
            { status: <code>501</code>, code: <code>model_provider_not_configured</code>, when: "The agent's free model is temporarily unavailable." },
            { status: <code>502</code>, code: <code>run_failed</code>, when: "The run produced no result, or took longer than its time limit. A paid run is refunded." },
            { status: <code>503</code>, code: <><code>hosted_model_not_running</code>, <code>ServiceUnavailable</code></>, when: "The agent's hosted model has no deployment that can serve right now, or the API is restarting." },
          ]}
        />
      </Endpoint>

      <Endpoint id="public-link" method="GET" path="/api/agents/{agentId}/public-link" auth="API key or session" title="Read an agent's public link">
        <p>
          Every agent has one public address, <code>/a/&#123;handle&#125;</code>, unique across WheelsAI. The page shows what
          the agent is and does, and a panel for its kind: a chat, the task form, or the latest results of a self-running
          agent. The public link is the switch that lets anyone with the address use the agent.
        </p>
        <DocTable
          caption="The four states"
          columns={[
            { key: "state", label: "state" },
            { key: "means", label: "What visitors get" },
          ]}
          rows={[
            { state: <code>on</code>, means: "The page shows and anyone with the link can use the agent, up to the daily limit." },
            { state: <code>paused</code>, means: "The page shows, with a note where the panel would be. Nobody can use the agent until you turn it back on." },
            { state: <code>off</code>, means: "The agent is not public. Its page does not exist. It keeps its address." },
            { state: <code>view_only</code>, means: <>The page shows and nobody can use the agent from it yet. This is where an agent starts when it was made public with <code>isPublic</code>: you turn it <code>on</code> when you are ready. It is read, never set.</> },
          ]}
        />
        <CodeBlock
          language="json"
          code={`{
  "state": "on",
  "handle": "release-notes-helper",
  "url": "https://wheelsai.example/a/release-notes-helper",
  "dailyCap": 100,
  "usedToday": 12,
  "showResults": false,
  "toolsOffForVisitors": true
}`}
        />
        <ul>
          <li>
            <code>handle</code> is the agent&apos;s address; it is kept while the link is <code>off</code> and is{" "}
            <code>null</code> until the agent has one. <code>url</code> is the full address, or <code>null</code> without a
            handle.
          </li>
          <li>
            <code>dailyCap</code> is how many uses a day the page allows, from 1 to 100,000 (100 to begin with).{" "}
            <code>usedToday</code> is today&apos;s count (UTC), or <code>null</code> when it cannot be read.
          </li>
          <li>
            <code>showResults</code> is whether a self-running agent&apos;s latest results show on its page.{" "}
            <code>toolsOffForVisitors</code> is <code>true</code> when the agent has a tool that visitors do not get.
          </li>
        </ul>
        <p>
          Any member of the organization can read it. Another organization&apos;s agent answers <code>404</code>{" "}
          <code>agent_not_found</code>.
        </p>
      </Endpoint>

      <Endpoint id="set-public-link" method="PUT" path="/api/agents/{agentId}/public-link" auth="API key, or session (owner or admin)" title="Turn an agent's public link on, pause it or turn it off">
        <Fields
          fields={[
            { name: "state", type: "enum", required: true, description: <><code>on</code>, <code>paused</code> or <code>off</code>.</> },
            { name: "dailyCap", type: "integer", description: "Uses a day the page allows, 1 to 100,000." },
            { name: "handle", type: "string", description: "The address, 3 to 40 lower-case letters, digits and hyphens, starting and ending with a letter or a digit. Left out, the agent keeps the address it has or gets one made from its slug." },
            { name: "showResults", type: "boolean", description: "Show a self-running agent's latest results on its page." },
          ]}
        />
        <CodeBlock
          language="bash"
          code={`curl -s -X PUT "$WHEELSAI_API_URL/api/agents/$AGENT_ID/public-link" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "state": "on", "dailyCap": 200 }'`}
        />
        <p>Answers the link as it now is, the same shape as the read above.</p>
        <DocTable
          caption="Public link refusals"
          columns={[
            { key: "status", label: "Status" },
            { key: "code", label: "error" },
            { key: "when", label: "When" },
          ]}
          rows={[
            { status: <code>400</code>, code: <code>validation_failed</code>, when: <>The request itself; <code>fields</code> says which part and why. A handle that breaks the rules or is reserved is refused here.</> },
            { status: <code>403</code>, code: "", when: "A member who is not an owner or admin." },
            { status: <code>404</code>, code: <code>agent_not_found</code>, when: "No agent with that id in your organization." },
            { status: <code>409</code>, code: <code>handle_taken</code>, when: "Another agent has that address." },
          ]}
        />
      </Endpoint>

      <Endpoint id="public-run" method="POST" path="/api/widget/{publicKey}/run" auth="Public: the page's key, no sign-in" title="Run a task from a public page">
        <p>
          The form on an agent&apos;s public page sends its answers here with the page&apos;s publishable key, which{" "}
          <code>GET /api/a/&#123;handle&#125;</code> gives while the page is <code>on</code>. It takes no cookies and needs an{" "}
          <code>Origin</code> header that the key allows, which a browser sends and a script does not, so{" "}
          <strong>code should call <a href="#run-agent">the run route</a> with an API key instead</strong>.
        </p>
        <Fields
          fields={[
            { name: "input", type: "object", required: true, description: "One answer per question of the form, as for the run route." },
            { name: "stream", type: "boolean", description: <>Default <code>true</code>. <code>false</code> answers JSON.</> },
          ]}
        />
        <CodeBlock
          language="json"
          code={`{
  "output": { "format": "text", "text": "This week: refunds now show the right total." },
  "toolCalls": [{ "name": "web_search", "status": "ok" }]
}`}
        />
        <p>
          A refusal is <code>&#123; error, message &#125;</code>, with <code>reason</code>, <code>scope</code> and{" "}
          <code>retryAfterSeconds</code> (also the <code>Retry-After</code> header) when waiting helps, and{" "}
          <code>details</code> for <code>input_invalid</code>, as above. The messages are written for a visitor and say
          nothing about the agent&apos;s setup. <code>400</code> is a body that is not <code>&#123; input, stream? &#125;</code>;{" "}
          <code>403</code> is an <code>Origin</code> the key does not allow; <code>404</code> is a key that is unknown or whose
          page is not <code>on</code>; <code>409</code>, <code>413</code> and <code>422</code> are the form&apos;s, as for the run
          route; <code>429</code> is the visitor&apos;s, the page&apos;s or the agent&apos;s limit; <code>503</code> is an agent that is
          not available right now.
        </p>
      </Endpoint>

      <h3 id="agent-management-errors">Errors</h3>
      <p>
        The endpoints above answer errors as <code>&#123; error, message &#125;</code>. A request that cannot be accepted
        also says what to change, field by field:
      </p>
      <CodeBlock
        language="json"
        code={`{
  "error": "validation_failed",
  "message": "Give your agent a name of at least 3 characters.",
  "fields": {
    "name": "Give your agent a name of at least 3 characters.",
    "kindConfig.task.fields[1].options": "Add at least two options."
  },
  "details": { "formErrors": [], "fieldErrors": { "name": ["..."], "kindConfig": ["..."] } }
}`}
      />
      <p>
        <code>message</code> is the first problem. <code>fields</code> has one sentence per field, keyed by its path in the
        request. Show these two to people. <code>details</code> is the earlier shape, kept for clients that already read
        it: the validator&apos;s own wording, grouped under the top-level field.
      </p>
      <DocTable
        caption="Agent management errors"
        columns={[
          { key: "status", label: "Status" },
          { key: "code", label: "error" },
          { key: "when", label: "When" },
        ]}
        rows={[
          { status: <code>400</code>, code: <code>validation_failed</code>, when: <>The request itself; <code>fields</code> says which part and why.</> },
          { status: <code>400</code>, code: <code>agent_graph_missing</code>, when: <>Setting <code>entrypoint</code> to <code>graph</code> on an agent with no saved graph.</> },
          { status: <code>402</code>, code: <code>insufficient_credits</code>, when: "A deployment needs more credits than the balance holds." },
          { status: <code>403</code>, code: <code>plan_limit_reached</code>, when: "The plan's number of agents is used up." },
          { status: <code>404</code>, code: <code>template_not_found</code>, when: <>The <code>templateId</code> is not a published template.</> },
          { status: <code>501</code>, code: <code>agent_gpu_unavailable</code>, when: <>A dedicated GPU for the agent cannot be started right now (<code>agentGpu.available</code> is <code>false</code> in <code>GET /api/capabilities</code>). Nothing is reserved or charged, and the agent keeps answering on its API.</> },
        ]}
      />

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
