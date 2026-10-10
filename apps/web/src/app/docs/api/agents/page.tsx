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
  { id: "public-page", title: "Read a public page", sub: true },
  { id: "agent-management-errors", title: "Errors", sub: true },
  { id: "schedule-and-runs", title: "Schedule and runs" },
  { id: "get-schedule", title: "Read the schedule", sub: true },
  { id: "put-schedule", title: "Set the schedule", sub: true },
  { id: "run-schedule", title: "Run it now", sub: true },
  { id: "list-runs", title: "List the runs", sub: true },
  { id: "resend-run", title: "Send a result again", sub: true },
  { id: "where-results-go", title: "Where results go" },
  { id: "list-destinations", title: "List the places", sub: true },
  { id: "create-destination", title: "Add a place", sub: true },
  { id: "test-destination", title: "Send a test message", sub: true },
  { id: "agent-api", title: "Agent API (/v1)" },
  { id: "agent-completions", title: "Create a chat completion", sub: true },
  { id: "agent-streaming", title: "Streaming", sub: true },
  { id: "agent-tools", title: "Function calling and tools", sub: true },
  { id: "agent-errors", title: "Errors", sub: true },
  { id: "agent-models", title: "List the agent's model", sub: true },
  { id: "paid-use", title: "Use an agent you pay for" },
  { id: "paid-access", title: "Where you stand", sub: true },
  { id: "paid-chat", title: "Chat", sub: true },
  { id: "paid-run", title: "Run a task", sub: true },
  { id: "paid-results", title: "Read results", sub: true },
  { id: "paid-v1", title: "Through /v1", sub: true },
  { id: "paid-errors", title: "Refusals", sub: true },
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
            { name: "schedule", type: "object", description: <>The agent&apos;s own schedule, made with the agent. Only with <code>agentKind</code> <code>scheduled</code> (or a template of that kind). See <a href="#create-with-schedule">create with a schedule</a>.</> },
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
  "schedule": null,
  "message": "Agent created successfully"
}`}
        />
        <p>
          <code>schedule</code> is always there: <code>null</code> unless the request carried one, and the same for an agent
          made from a template. Fires the <code>agent.created</code> webhook. A request that cannot be accepted answers <code>400</code>{" "}
          <code>validation_failed</code> with a sentence for each field; see <a href="#agent-management-errors">errors</a>.
        </p>

        <h4 id="create-with-schedule">Create with a schedule</h4>
        <p>
          A scheduled agent can be made with its schedule in one request. The agent and the schedule are made together: if
          the schedule cannot be used, no agent is made.
        </p>
        <Fields
          title="schedule"
          fields={[
            { name: "cronExpression", type: "string", required: true, description: <>Five fields, for example <code>0 9 * * 1-5</code>.</> },
            { name: "timezone", type: "string", description: <>An IANA time zone such as <code>Europe/Berlin</code>. Default <code>UTC</code>.</> },
            { name: "prompt", type: "string | null", description: "What the agent is told at each run, up to 20,000 characters. Left out, it gets a short default line." },
            { name: "deliver", type: "object | null", description: <><code>&#123; channelId &#125;</code>: one of your <a href="#where-results-go">places</a>. <code>null</code> or left out, results are only saved on the agent&apos;s page.</> },
            { name: "enabled", type: "boolean", description: <>Default <code>true</code>.</> },
          ]}
        />
        <CodeBlock
          language="bash"
          code={`curl -s -X POST "$WHEELSAI_API_URL/api/agents" \
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Morning brief",
    "agentKind": "scheduled",
    "systemPrompt": "You write a short brief of what changed overnight.",
    "schedule": {
      "cronExpression": "0 9 * * 1-5",
      "timezone": "Europe/Berlin",
      "prompt": "Summarise the changes merged yesterday.",
      "deliver": { "channelId": "5b1c7e0a-..." }
    }
  }'`}
        />
        <p>The answer carries the schedule it made, without what the agent is told or where results go:</p>
        <CodeBlock
          language="json"
          code={`{
  "agent": { "id": "8f0c2a4e-...", "agentKind": "scheduled", "...": "..." },
  "schedule": {
    "id": "c2d9e1a7-...",
    "enabled": true,
    "cronExpression": "0 9 * * 1-5",
    "timezone": "Europe/Berlin",
    "nextRunAt": "2026-10-09T07:00:00.000Z"
  },
  "message": "Agent created successfully"
}`}
        />
        <p>
          A schedule made this way is on, reads its times in UTC unless you say otherwise, tells the agent the date and time at
          each run, tries once more after a failed run, and stops a run after five minutes. Change any of that with{" "}
          <a href="#put-schedule">the schedule route</a>. A schedule that cannot be used answers <code>400</code>{" "}
          <code>validation_failed</code> with a sentence under <code>schedule</code> or the part that is wrong:{" "}
          <code>schedule.cronExpression</code> (times that cannot be read, or that never come), <code>schedule.timezone</code>,{" "}
          <code>schedule.prompt</code>, <code>schedule.deliver.channelId</code> (a place that is not yours, or cannot receive
          results). A <code>schedule</code> sent with another kind is refused with &quot;To create an agent with a schedule, set agentKind to scheduled. For another kind, create the agent first and add its schedule afterwards.&quot; An agent of any kind can be given a schedule later with <a href="#put-schedule">the schedule route</a>.
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
          agent at set times, give it a schedule of its own: with <a href="#create-with-schedule">the create request</a> or{" "}
          <a href="#put-schedule">the schedule route</a>. Its other scheduled tasks live in the{" "}
          <Link href="/docs/api/workflows#scheduler">scheduler</Link>.
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
          Moving a scheduled agent&apos;s kind away from <code>scheduled</code> stops it running on its own: its schedule is
          turned off in the same change, and the answer carries <code>&quot;schedulePaused&quot;: true</code> beside{" "}
          <code>agent</code>. The schedule and its runs are kept, and setting the kind back turns nothing on. An agent with no
          schedule, or one that is already off, answers without it. Restoring an older version through{" "}
          <code>POST /api/versioning/agents/&#123;agentId&#125;/versions/&#123;version&#125;/rollback</code> follows the same
          rule and carries the same field.
        </p>
        <p>
          <code>entrypoint</code> chooses what answers a chat, in the playground and on <code>/v1</code>:{" "}
          <code>&quot;chat&quot;</code> (the default) is the agent&apos;s prompt, model and tools;{" "}
          <code>&quot;graph&quot;</code> is the graph saved in the builder. Setting <code>&quot;graph&quot;</code> on an agent
          with no saved graph, or an empty one, answers <code>400</code> <code>agent_graph_missing</code>. See{" "}
          <a href="#agent-graph">Graph agents</a>.
        </p>
        <p>
          While the agent&apos;s use is sold on the marketplace, some changes would break what people paid for and answer{" "}
          <code>409</code> <code>on_sale_for_use</code> with a plain <code>message</code>, before anything is written:{" "}
          <code>isPublic: false</code>, <code>entrypoint: &quot;graph&quot;</code>, and moving the kind to{" "}
          <code>scheduled</code> while the use is sold per use. Stop selling it first. Restoring an older version through{" "}
          <code>POST /api/versioning/agents/&#123;agentId&#125;/versions/&#123;version&#125;/rollback</code> answers the same{" "}
          <code>409</code> <code>on_sale_for_use</code> when the version would switch an agent that is on sale to answer
          through its graph, or to run on its own while it is sold per use. Nothing is restored.
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
          Stops the agent&apos;s running deployments and deletes it. Its own schedule goes with it, so nothing keeps firing.
          Fires <code>agent.deleted</code>.
        </p>
        <p>
          An agent whose listing has buyers cannot be deleted: it answers <code>409</code> <code>agent_has_buyers</code>. Stop
          selling it instead: it leaves the marketplace, and subscribers keep access until the month they paid for ends.
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
          caption="The five states"
          columns={[
            { key: "state", label: "state" },
            { key: "means", label: "What visitors get" },
          ]}
          rows={[
            { state: <code>on</code>, means: "The page shows and anyone with the link can use the agent, up to the daily limit." },
            { state: <code>paused</code>, means: "The page shows, with a note where the panel would be. Nobody can use the agent until you turn it back on." },
            { state: <code>off</code>, means: "The agent is not public. Its page does not exist. It keeps its address." },
            { state: <code>view_only</code>, means: <>The page shows and nobody can use the agent from it yet. This is where an agent starts when it was made public with <code>isPublic</code>: you turn it <code>on</code> when you are ready. It is read, never set.</> },
            { state: <code>paid</code>, means: <>A listing sells use of the agent at a price. The page shows its terms and people sign in and pay to use it, per message or run or per month, from <Link href="#paid-use">the paid-use endpoints</Link>. Free use there is off and the page&apos;s key is never sent. It is read, never set: it follows the listing.</> },
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
  "toolsOffForVisitors": true,
  "sale": { "paid": false, "listingSlug": "release-notes-helper" }
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
          <li>
            <code>sale</code> is there only while a published listing sells use of the agent: <code>paid</code> says whether
            a price is set (the state is then <code>paid</code>), and <code>listingSlug</code> names the listing.
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
            { status: <code>409</code>, code: <code>sold_as_paid</code>, when: <>Turning the link <code>on</code> while a listing sells use at a price. Free use on the page would undercut the people who pay; choose a free listing instead.</> },
            { status: <code>409</code>, code: <code>on_sale_for_use</code>, when: <>Turning the link <code>off</code>, or pausing it on a listing that sells free use. An agent on sale keeps its page on. Stop selling it first.</> },
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

      <Endpoint id="public-page" method="GET" path="/api/a/{handle}" auth="Public" title="Read a public page">
        <p>
          What an agent&apos;s page shows, found by its handle. <code>use</code> says how the page can be used right now and
          carries one panel for the agent&apos;s kind: <code>chat</code>, <code>task</code> or <code>scheduled</code>.
        </p>
        <CodeBlock
          language="json"
          code={`{
  "agent": { "name": "Morning brief", "handle": "morning-brief", "agentKind": "scheduled", "...": "..." },
  "use": {
    "state": "on",
    "key": "wheels_pub_...",
    "transcriptsStored": false,
    "scheduled": {
      "resultsPublic": true,
      "latest": [
        { "finishedAt": "2026-10-08T07:00:41.000Z", "text": "Yesterday: ..." }
      ]
    }
  },
  "...": "..."
}`}
        />
        <p>
          <code>latest</code> holds the agent&apos;s last results, newest first: at most 3, each cut at 8,000 characters, and
          only while the owner shows results (<code>showResults</code> on the <a href="#set-public-link">public link</a>).
          Otherwise <code>resultsPublic</code> is <code>false</code> and <code>latest</code> is empty. A result carries when
          it finished and its text and nothing else: never where it was sent, and never a run that did not finish.
        </p>
        <p>
          While <code>use.state</code> is <code>paid</code>, <code>use.key</code> is <code>null</code> and{" "}
          <code>use.paid</code> carries the terms a person sees before paying. <code>use.paid</code> is always present,{" "}
          <code>null</code> in the other states.
        </p>
        <CodeBlock
          language="json"
          code={`{
  "use": {
    "state": "paid",
    "key": null,
    "transcriptsStored": true,
    "paid": {
      "listingId": "…",
      "listingSlug": "support-bot",
      "pricingModel": "per_request",
      "priceCents": 5,
      "unit": "message",
      "perMinute": 10,
      "perDay": 200,
      "transcriptsStored": true,
      "sendsRequests": false
    },
    "chat": { "maxMessages": 20, "maxMessageChars": 4000, "maxTotalChars": 16000 }
  }
}`}
        />
        <p>
          <code>unit</code> is <code>message</code>, <code>run</code> or <code>month</code>. <code>transcriptsStored</code> says
          whether the owner keeps a copy of what buyers send and the agent answers, and <code>sendsRequests</code> whether
          the agent may send requests to other websites as part of its answers. A self-running agent that is sold shows when
          its results arrive and never what they say: <code>scheduled.latest</code> holds{" "}
          <code>finishedAt</code> dates only, <code>scheduled.lastResultAt</code> is the latest, and{" "}
          <code>scheduled.schedule</code> is <code>&#123; cronExpression, timezone &#125;</code> or <code>null</code>.
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

      <h2 id="schedule-and-runs">Schedule and runs</h2>
      <p>
        An agent owns one schedule: when it runs, what it is told, and where the result goes. Every run is kept, so you can
        read what the agent produced, why a run did not finish, and whether the result arrived. The schedule belongs to the
        agent, so deleting the agent leaves nothing firing. Other scheduled tasks that use the agent stay on the{" "}
        <Link href="/docs/api/workflows#scheduler">scheduler</Link>; <code>otherTasks</code> counts them.
      </p>

      <Endpoint id="get-schedule" method="GET" path="/api/agents/{agentId}/schedule" auth="API key or session" title="Read the schedule">
        <CodeBlock
          language="json"
          code={`{
  "schedule": {
    "id": "c2d9e1a7-...",
    "enabled": true,
    "cronExpression": "0 9 * * 1-5",
    "timezone": "Europe/Berlin",
    "prompt": "Summarise yesterday's merged changes.",
    "stampTime": true,
    "deliver": { "channelId": "5b1c7e0a-...", "name": "Team Slack", "type": "slack" },
    "timeoutSeconds": 300,
    "maxRetries": 1,
    "nextRunAt": "2026-10-09T07:00:00.000Z",
    "lastRunAt": "2026-10-08T07:00:00.000Z",
    "lastRunStatus": "success"
  },
  "suggested": { "schedule": { "cronExpression": "0 9 * * *", "timezone": "UTC" }, "prompt": "..." },
  "otherTasks": 0,
  "schedulerRunning": true
}`}
        />
        <ul>
          <li>
            <code>schedule</code> is <code>null</code> until the agent has one. <code>cronExpression</code> is{" "}
            <code>null</code> only for an older task that runs on an interval or once.
          </li>
          <li>
            <code>stampTime</code> says whether the date and time, in the schedule&apos;s time zone, are told to the agent
            ahead of its prompt at each run.
          </li>
          <li>
            <code>deliver</code> is the place results go to, as an id, a name and a type; never its link or its address. A
            place that was removed after it was chosen shows an empty <code>name</code> and the type <code>unknown</code>.
          </li>
          <li>
            <code>suggested</code> is the times and the line a template or the creator suggested, or <code>null</code>. It
            starts nothing.
          </li>
          <li>
            <code>schedulerRunning</code> is <code>false</code> while nothing here fires schedules. Runs can still be
            started by hand.
          </li>
        </ul>
        <p>
          An agent from another organization, or an id that is not an id, answers <code>404</code>.
        </p>
      </Endpoint>

      <Endpoint id="put-schedule" method="PUT" path="/api/agents/{agentId}/schedule" auth="API key or session" title="Set the schedule">
        <p>Creates the schedule when the agent has none, and changes it otherwise. It answers what the read answers.</p>
        <Fields
          fields={[
            { name: "enabled", type: "boolean", required: true, description: "Turn the schedule on or off." },
            { name: "cronExpression", type: "string", required: true, description: <>Five fields, for example <code>0 9 * * 1-5</code>.</> },
            { name: "timezone", type: "string", description: <>An IANA time zone such as <code>Europe/Berlin</code>. A new schedule uses <code>UTC</code>; an existing one keeps its zone.</> },
            { name: "prompt", type: "string", description: "What the agent is told at each run, up to 20,000 characters. A new schedule without one gets a short default line." },
            { name: "stampTime", type: "boolean", description: "Tell the agent the date and time at each run. On for a new schedule; an existing one keeps its setting." },
            { name: "deliver", type: "object | null", description: <><code>&#123; channelId &#125;</code>: a <a href="#where-results-go">place</a> to send each result to. <code>null</code> removes it. Left out, the place stays as it is.</> },
            { name: "timeoutSeconds", type: "integer", description: "A run is stopped after this long, 5 to 3,600. A new schedule uses 300, five minutes." },
            { name: "maxRetries", type: "integer", description: "Tries after a failed run, 0 to 5. A new schedule uses 1." },
          ]}
        />
        <CodeBlock
          language="bash"
          code={`curl -s -X PUT "$WHEELSAI_API_URL/api/agents/$AGENT_ID/schedule" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "enabled": true,
    "cronExpression": "0 9 * * 1-5",
    "timezone": "Europe/Berlin",
    "deliver": { "channelId": "5b1c7e0a-..." }
  }'`}
        />
        <DocTable
          caption="Schedule refusals"
          columns={[
            { key: "status", label: "Status" },
            { key: "code", label: "error" },
            { key: "when", label: "When" },
          ]}
          rows={[
            { status: <code>400</code>, code: <code>invalid_schedule</code>, when: <>The times cannot be read, the time zone is not one, or the schedule has no future run (turning it on needs one). <code>reason</code> and <code>field</code> say which.</> },
            { status: <code>400</code>, code: <code>validation_failed</code>, when: <><code>fields</code> says which part and why: a prompt that is too long, a time limit or number of tries out of range, a place that is not yours or cannot receive results, email while email is unavailable.</> },
            { status: <code>404</code>, code: <code>not_found</code>, when: "No agent with that id in your organization." },
            { status: <code>409</code>, code: <code>schedule_changed</code>, when: "The schedule was changed somewhere else since it was read. Nothing is written; read it again and retry." },
          ]}
        />
      </Endpoint>

      <Endpoint id="run-schedule" method="POST" path="/api/agents/{agentId}/schedule/run" auth="API key with the agents:invoke scope, or session" title="Run it now">
        <p>
          Starts one run now and waits for it. A run started here is billed, limited, recorded and delivered exactly as a
          timed run is, within the schedule&apos;s time limit, and is not tried again if it fails. Answers <code>201</code> with the run:
        </p>
        <CodeBlock
          language="json"
          code={`{
  "run": {
    "id": "e4a7b0c2-...",
    "status": "finished",
    "startedAt": "2026-10-08T12:00:00.000Z",
    "finishedAt": "2026-10-08T12:00:09.000Z",
    "durationMs": 9120,
    "startedBy": "person",
    "text": "Yesterday: ...",
    "failure": null,
    "delivery": []
  }
}`}
        />
        <p>
          <code>404</code> <code>schedule_not_found</code> when the agent has no schedule, and <code>409</code>{" "}
          <code>already_running</code> while a run is in flight. A key without <code>agents:invoke</code> answers{" "}
          <code>403</code> <code>missing_scope</code>.
        </p>
      </Endpoint>

      <Endpoint id="list-runs" method="GET" path="/api/agents/{agentId}/runs" auth="API key or session" title="List the runs">
        <p>
          The schedule&apos;s runs, newest first, whoever started them. <code>limit</code> is 1 to 100 (default 20).{" "}
          <code>before</code> is the id of the last run you already have: the page after it comes back. An agent with no
          schedule has no runs.
        </p>
        <CodeBlock
          language="json"
          code={`{
  "runs": [
    {
      "id": "e4a7b0c2-...",
      "status": "finished",
      "startedAt": "2026-10-08T07:00:00.000Z",
      "finishedAt": "2026-10-08T07:00:41.000Z",
      "durationMs": 41200,
      "startedBy": "schedule",
      "text": "Yesterday: ...",
      "failure": null,
      "delivery": [
        { "channelId": "5b1c7e0a-...", "name": "Team Slack", "type": "slack", "status": "sent", "at": "2026-10-08T07:00:42.000Z" }
      ]
    }
  ],
  "hasMore": true
}`}
        />
        <DocTable
          caption="A run's status"
          columns={[
            { key: "status", label: "status" },
            { key: "means", label: "Meaning" },
          ]}
          rows={[
            { status: <code>running</code>, means: <>It has not ended. <code>finishedAt</code> and <code>durationMs</code> are <code>null</code>.</> },
            { status: <code>finished</code>, means: <>It has a result, in <code>text</code>.</> },
            { status: <code>did_not_finish</code>, means: <><code>failure</code> says why in one sentence: it ran past its time limit, it was interrupted, a limit was reached, or no model was available.</> },
            { status: <code>stopped</code>, means: "Someone stopped it." },
          ]}
        />
        <ul>
          <li>
            <code>startedBy</code> is <code>schedule</code> for a timed run and <code>person</code> for a run started by hand.
          </li>
          <li>
            <code>delivery</code> lists every try to send the result, oldest first: the place&apos;s id, name and type, a{" "}
            <code>status</code> of <code>sent</code>, <code>failed</code> or <code>skipped</code>, a <code>reason</code>{" "}
            in plain words unless it was sent, and when it was tried. It never carries a link or an address.
          </li>
          <li>
            A delivery that fails never changes the run&apos;s <code>status</code> and never runs the agent again. The
            result stays on the run.
          </li>
        </ul>
      </Endpoint>

      <Endpoint id="resend-run" method="POST" path="/api/agents/{agentId}/runs/{runId}/deliver" auth="API key or session" title="Send a result again">
        <p>
          Posts the saved result of a finished run to the place the schedule names now, and adds how that went to the
          run&apos;s <code>delivery</code>. It runs nothing: no model is called and nothing is charged. Answers{" "}
          <code>200</code> with the run.
        </p>
        <DocTable
          caption="Send again refusals"
          columns={[
            { key: "status", label: "Status" },
            { key: "code", label: "error" },
            { key: "when", label: "When" },
          ]}
          rows={[
            { status: <code>400</code>, code: <code>no_place</code>, when: "The schedule names no place. Choose where results go first." },
            { status: <code>404</code>, code: <code>not_found</code>, when: "No such agent or run in your organization, or the run belongs to another schedule." },
            { status: <code>409</code>, code: <code>run_not_finished</code>, when: "Only a finished run has a result to send." },
            { status: <code>502</code>, code: <code>delivery_failed</code>, when: <>The place did not take it. The try is recorded all the same, and the answer carries <code>error</code>, <code>message</code> and the <code>run</code> as it now is.</> },
          ]}
        />
      </Endpoint>

      <h2 id="where-results-go">Where results go</h2>
      <p>
        A schedule sends each finished result to one place, and always keeps it on the run as well. A place is a Slack or
        Discord channel, which you add by pasting the link the service gave you, or your own email. A place is its id, its
        name and its type: no answer ever returns a link or an address.
      </p>

      <Endpoint id="list-destinations" method="GET" path="/api/destinations" auth="API key or session" title="List the places">
        <p>
          The places your organization has that results can go to, as an array of <code>&#123; channelId, name, type, mine &#125;</code>.{" "}
          <code>type</code> is <code>slack</code>, <code>discord</code>, <code>email</code> or <code>webhook</code>. <code>mine</code> is{" "}
          <code>true</code> only for an email place that goes to your own address, and always <code>false</code> for an API
          key and for Slack, Discord and webhook places. Pass a <code>channelId</code> as <code>deliver</code> on a schedule.
        </p>
      </Endpoint>

      <Endpoint id="create-destination" method="POST" path="/api/destinations" auth="API key or session" title="Add a place">
        <Fields
          fields={[
            { name: "type", type: "enum", required: true, description: <><code>slack</code>, <code>discord</code> or <code>email</code>.</> },
            { name: "link", type: "string", description: <>For <code>slack</code> and <code>discord</code>: the https link the service gave you for the channel. Not for <code>email</code>.</> },
            { name: "name", type: "string", description: <>Up to 80 characters. Left out, it is named after the service: <code>Slack</code>, then <code>Slack 2</code>; an email place is <code>Email to &lt;display name&gt;</code>, or <code>Email to a teammate</code>.</> },
          ]}
        />
        <CodeBlock
          language="bash"
          code={`curl -s -X POST "$WHEELSAI_API_URL/api/destinations" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "type": "slack", "link": "https://hooks.slack.com/services/T000/B000/XXXX", "name": "Team Slack" }'`}
        />
        <p>
          Answers <code>201</code> with <code>&#123; channelId, name, type, mine &#125;</code>. Email takes no address: it is the
          verified address of the person signed in, so it can only be chosen with a session, and choosing it again answers{" "}
          <code>200</code> with the place that already exists. The link is checked before anything is saved, and is never
          shown again.
        </p>
        <DocTable
          caption="Place refusals"
          columns={[
            { key: "status", label: "Status" },
            { key: "code", label: "error" },
            { key: "when", label: "When" },
          ]}
          rows={[
            { status: <code>400</code>, code: <code>invalid_link</code>, when: <>The link is not that service&apos;s channel link, or <code>email</code> was sent with one.</> },
            { status: <code>400</code>, code: <code>email_needs_sign_in</code>, when: "Email with an API key. Choose it in the dashboard." },
            { status: <code>400</code>, code: <code>email_not_verified</code>, when: "The signed-in person has not verified their email address." },
            { status: <code>400</code>, code: <code>validation_failed</code>, when: <>The request itself: another <code>type</code>, or a name that is empty or too long.</> },
            { status: <code>409</code>, code: <code>name_taken</code>, when: "A place with this name already exists." },
            { status: <code>501</code>, code: <code>email_not_configured</code>, when: "Email delivery is temporarily unavailable. Results are still saved on the run." },
          ]}
        />
      </Endpoint>

      <Endpoint id="test-destination" method="POST" path="/api/destinations/{channelId}/test" auth="API key or session" title="Send a test message">
        <p>
          Sends a short test message to the place and answers <code>&#123; sent: true &#125;</code>. Another
          organization&apos;s place, or an id that is not an id, answers <code>404</code>; a place that is turned off{" "}
          <code>400</code> <code>place_turned_off</code>; a place that did not take the message <code>502</code>{" "}
          <code>delivery_failed</code>, with nothing of the place&apos;s link in the answer.
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

      <h2 id="paid-use">Use an agent you pay for</h2>
      <p>
        A listing that sells use lets people use the creator&apos;s own agent, per message or run or per month, from their
        WheelsAI credits. They never get a copy, and no route returns its instructions, tools or model. Start by agreeing
        to the price (<Link href="/docs/api/marketplace#use"><code>POST /api/marketplace/listings/&#123;id&#125;/use</code></Link>),
        then use the agent here. All four routes need you signed in, with a session or an API key. A key needs the{" "}
        <code>agents:use</code> scope to chat or run, created with both caps (see{" "}
        <Link href="/docs/api/jobs#keys">API keys that can spend</Link>).
      </p>
      <ul>
        <li>One use is one message or one run. It is charged when it is sent and refunded if no answer is delivered.</li>
        <li>The answer arrives whole, not word by word, after the agent&apos;s reply has been checked.</li>
        <li>
          Limits are 10 uses a minute and 200 a day for your organization and the agent. After 10 answers in a day that
          could not be delivered, you wait until tomorrow.
        </li>
        <li>
          You cannot send tools, a model or a system message. An answer that repeats eight consecutive words of the
          agent&apos;s instructions is withheld and refunded; rewordings and translations are not caught.
        </li>
        <li>
          If the agent has a knowledge base, a paid use and the free sample of a listing that sells use give it the
          passages it needs without the titles of the documents they came from.
        </li>
        <li>
          Inside a paid month nothing is charged per use. The owner may keep a copy of what you send and what it answers;
          the agent&apos;s page says so (<code>transcriptsStored</code>).
        </li>
      </ul>

      <Endpoint id="paid-access" method="GET" path="/api/a/{handle}/access" auth="API key or session" title="Where you stand with an agent">
        <p>Answers what the listing asks, what you agreed to, and your credits.</p>
        <CodeBlock
          language="json"
          code={`{
  "access": "listing_pricing",
  "listingId": "…",
  "terms": {
    "pricingModel": "per_request",
    "pricePerRequestCents": 5,
    "monthlyPriceCents": null,
    "unit": "message",
    "keepsCopy": true
  },
  "accepted": { "pricingModel": "per_request", "pricePerRequestCents": 5, "monthlyPriceCents": null },
  "subscription": null,
  "balanceCents": 495,
  "canAccept": true,
  "startBlocked": null
}`}
        />
        <ul>
          <li>
            <code>access</code> is <code>none</code> (you have not started), <code>subscribed</code>,{" "}
            <code>listing_pricing</code> (the listing&apos;s price is what you agreed to, or lower),{" "}
            <code>pricing_changed</code> (the price went up; accept it to continue), <code>subscription_lapsed</code>,{" "}
            <code>not_offered</code> or <code>own_agent</code>.
          </li>
          <li>
            <code>terms</code> is what the listing asks now, or <code>null</code> when use is not on sale.{" "}
            <code>keepsCopy</code> is whether the owner keeps a copy of what is sent and answered.
          </li>
          <li>
            <code>subscription</code> is <code>&#123; status, currentPeriodEnd, cancelAtPeriodEnd &#125;</code> or{" "}
            <code>null</code>. <code>canAccept</code> is whether you may agree to a price: an owner or admin, or a key
            granted <code>marketplace:install</code> by name.
          </li>
          <li>
            <code>startBlocked</code> is <code>null</code>, or <code>&#123; code: &quot;copy_subscription_active&quot;, message, until &#125;</code>{" "}
            while your organization holds a copy of this agent with a month paid for. Starting waits until{" "}
            <code>until</code> (an ISO date): remove the copy, or cancel its renewal and start after that date. While it is
            set, <code>canAccept</code> is <code>false</code>.
          </li>
          <li>
            <code>404</code> <code>agent_not_found</code>.
          </li>
        </ul>
      </Endpoint>

      <Endpoint id="paid-chat" method="POST" path="/api/a/{handle}/chat" auth="Session, or an API key with agents:use" title="Chat with an agent you pay for">
        <Fields
          fields={[
            { name: "messages", type: "array", required: true, description: <>The conversation so far, each <code>&#123; role: &quot;user&quot; | &quot;assistant&quot;, content &#125;</code>.</> },
            { name: "sessionId", type: "string", description: "Keeps the turns of one conversation together." },
            { name: "stream", type: "boolean", description: <>Default <code>true</code>. <code>false</code> answers JSON.</> },
          ]}
        />
        <CodeBlock
          language="bash"
          code={`curl -s -X POST "$WHEELSAI_API_URL/api/a/support-bot/chat" \
  -H "Authorization: Bearer $WHEELSAI_API_KEY" -H "Content-Type: application/json" \
  -d '{ "messages": [{ "role": "user", "content": "How long do refunds take?" }], "stream": false }'`}
        />
        <CodeBlock
          language="json"
          code={`{
  "message": { "role": "assistant", "content": "Refunds take 3 to 5 business days." },
  "toolCalls": [],
  "billing": { "chargedCents": 5, "balanceCents": 495, "access": "listing_pricing" }
}`}
        />
        <p>
          <code>billing.chargedCents</code> is 0 inside a paid month, and <code>billing.balanceCents</code> is your credits
          after the use, or <code>null</code> when they could not be read just now. <code>toolCalls</code> lists each tool
          the agent used and whether it worked (<code>ok</code>, <code>unavailable</code> or <code>error</code>).
        </p>
        <p>
          With streaming, the response is <code>text/event-stream</code> and carries the whole checked answer in one go:
          first <code>data: &#123;&quot;wheelsai&quot;:&#123;&quot;billing&quot;:…&#125;&#125;</code>, then optionally{" "}
          <code>data: &#123;&quot;wheelsai&quot;:&#123;&quot;toolCalls&quot;:…&#125;&#125;</code>, then OpenAI-style{" "}
          <code>choices[0].delta.content</code> events, a finish event and <code>data: [DONE]</code>. A refusal is always
          plain JSON, also when a stream was asked for.
        </p>
      </Endpoint>

      <Endpoint id="paid-run" method="POST" path="/api/a/{handle}/run" auth="Session, or an API key with agents:use" title="Run a task you pay for">
        <Fields
          fields={[
            { name: "input", type: "object", required: true, description: <>One answer per question of the agent&apos;s form, as for <a href="#run-agent">the run route</a>.</> },
            { name: "stream", type: "boolean", description: <>Default <code>true</code>. <code>false</code> answers JSON.</> },
          ]}
        />
        <CodeBlock
          language="json"
          code={`{
  "output": { "format": "text", "text": "Brief: …" },
  "toolCalls": [],
  "billing": { "chargedCents": 10, "balanceCents": 485, "access": "listing_pricing" }
}`}
        />
        <p>
          Answers that do not fit the form answer <code>422</code> <code>input_invalid</code> with <code>details</code>, and
          nothing is charged.
        </p>
      </Endpoint>

      <Endpoint id="paid-results" method="GET" path="/api/a/{handle}/results" auth="API key or session" title="Read a self-running agent's results">
        <p>
          For an agent that runs on its own, a subscriber reads what it produced. Answers{" "}
          <code>&#123; results: [&#123; finishedAt, text &#125;], hasMore &#125;</code>, newest first, at most 30. While the agent&apos;s
          use is free, this shows what its public page shows: at most 3 results of up to 8,000 characters each, and none
          when its owner turned results off. Refusals:{" "}
          <code>401</code>; <code>402</code> <code>subscription_lapsed</code>; <code>403</code> <code>use_not_started</code>;{" "}
          <code>404</code>; <code>409</code> <code>not_a_scheduled_agent</code>, <code>pricing_changed</code>,{" "}
          <code>not_offered</code> or <code>not_for_sale</code>; <code>429</code>; <code>503</code>.
        </p>
      </Endpoint>

      <Endpoint id="paid-v1" method="POST" path="/v1/chat/completions" auth="API key with agents:use, or session" title="Use an agent you pay for through /v1">
        <p>
          Set <code>model</code> to <code>a/&lt;handle&gt;</code> and use any OpenAI client. A key needs <code>agents:use</code>{" "}
          and both caps; a session works too. The answer is OpenAI&apos;s shape plus{" "}
          <code>wheelsai: &#123; agent: &#123; handle &#125;, billing &#125;</code> and nothing else, and it has no{" "}
          <code>usage</code>. Every chunk&apos;s <code>model</code> is <code>a/&lt;handle&gt;</code>. Like the other paid routes it
          is charged when sent and refunded if no answer is delivered.
        </p>
        <ul>
          <li>
            A stream carries the whole checked answer in one go. Its first chunk has <code>choices: []</code> and the{" "}
            <code>wheelsai</code> object; then come the content chunks, a finish chunk and <code>data: [DONE]</code>.
          </li>
          <li>
            <code>tools</code>, <code>tool_choice</code>, and a system or tool message are refused with <code>400</code>{" "}
            <code>unsupported_parameter</code> before anything is charged. Sampling settings are accepted and not applied.
          </li>
          <li>
            The page&apos;s limits apply: 20 messages, 4,000 characters each and 16,000 in all, the last one from the user.
            Past them the answer is <code>400</code> <code>validation_failed</code>.
          </li>
          <li>
            <Link href="/docs/api/inference#list-models"><code>GET /v1/models</code></Link> also lists, for each agent your
            organization can use now,{" "}
            <code>&#123; id: &quot;a/&lt;handle&gt;&quot;, object: &quot;model&quot;, owned_by: &quot;wheelsai&quot;, wheelsai: &#123; kind: &quot;paid_agent&quot; &#125; &#125;</code>.
          </li>
        </ul>
        <p>
          Errors are OpenAI-shaped, <code>&#123; error: &#123; message, type, param, code &#125; &#125;</code>. Show{" "}
          <code>message</code> as it comes. The object may also carry <code>terms</code>, <code>priceCents</code>,{" "}
          <code>balanceCents</code> and <code>refundedCents</code>, and <code>reason</code>: the more exact code when{" "}
          <code>/v1</code> folds several into one, for example <code>not_offered</code> or <code>results_only</code> under{" "}
          <code>not_for_sale</code>. Errors that repeating cannot fix carry <code>x-should-retry: false</code>.
        </p>
        <DocTable
          caption="Errors of a paid agent on /v1"
          columns={[
            { key: "status", label: "Status" },
            { key: "code", label: "error.code" },
            { key: "when", label: "When" },
          ]}
          rows={[
            { status: <code>400</code>, code: <code>validation_failed</code>, when: "The request itself, or past the page's limits." },
            { status: <code>400</code>, code: <code>unsupported_parameter</code>, when: <>Tools, <code>tool_choice</code>, a system message or a tool message. Nothing was charged.</> },
            { status: <code>402</code>, code: <code>marketplace_payment_required</code>, when: <>Not enough credits for this use; <code>priceCents</code> and <code>balanceCents</code> say how much.</> },
            { status: <code>403</code>, code: <><code>insufficient_scope</code>, <code>use_not_started</code></>, when: <>A key without <code>agents:use</code>; or you have not started using this agent (<code>terms</code> says what it asks).</> },
            { status: <code>403</code>, code: <><code>api_key_use_price_cap_exceeded</code>, <code>api_key_daily_cap_exceeded</code>, <code>api_key_spend_caps_missing</code></>, when: "The key's own caps." },
            { status: <code>403</code>, code: <code>not_a_member</code>, when: "You are no longer a member of the organization that pays for this agent." },
            { status: <code>404</code>, code: <code>agent_not_found</code>, when: "No agent with that handle." },
            { status: <code>409</code>, code: <code>pricing_changed</code>, when: <>The price went up or the pricing model changed since you agreed; <code>terms</code> says what it is now.</> },
            { status: <code>409</code>, code: <><code>own_agent</code>, <code>not_for_sale</code></>, when: <>Your own agent; or an agent whose use is free, not offered, or read through results (<code>reason</code> says which).</> },
            { status: <code>429</code>, code: <code>rate_limit_exceeded</code>, when: <>Your limit or the agent&apos;s, with <code>retry-after</code>.</> },
            { status: <code>499</code>, code: <code>client_closed_request</code>, when: "You closed the connection before the answer arrived. The charge was refunded." },
            { status: <code>502</code>, code: <code>answer_withheld</code>, when: <>The answer could not be shown. The charge was refunded (<code>refundedCents</code>).</> },
            { status: <code>502</code>, code: <code>upstream_error</code>, when: <>The agent could not answer. The charge was refunded; a retry is a new charge, refunded again if it fails.</> },
            { status: <code>503</code>, code: <code>service_unavailable</code>, when: "The agent or the limit check is not available right now. Try again in a moment." },
          ]}
        />
      </Endpoint>

      <h3 id="paid-errors">Refusals</h3>
      <p>
        Chat, run and results answer <code>&#123; error, message &#125;</code>. Show <code>message</code> as it comes: it
        names the price and your credits where they matter. Other fields come only with the refusal they belong to.
      </p>
      <DocTable
        caption="Refusals of paid chat and run"
        columns={[
          { key: "status", label: "Status" },
          { key: "code", label: "error" },
          { key: "when", label: "When" },
        ]}
        rows={[
          { status: <code>400</code>, code: <code>invalid_request</code>, when: "The body is not what the route takes." },
          { status: <code>401</code>, code: "", when: "Not signed in." },
          { status: <code>402</code>, code: <code>insufficient_credits</code>, when: <>Not enough credits for this use. <code>priceCents</code> and <code>balanceCents</code> say how much. Nothing was charged.</> },
          { status: <code>402</code>, code: <code>subscription_lapsed</code>, when: "The subscription ended or its renewal did not go through." },
          { status: <code>403</code>, code: <code>missing_scope</code>, when: <>A key without <code>agents:use</code>.</> },
          { status: <code>403</code>, code: <code>use_not_started</code>, when: <>You have not started using this agent. <code>terms</code> and <code>access</code> say what it asks.</> },
          { status: <code>403</code>, code: <><code>api_key_use_price_cap_exceeded</code>, <code>api_key_daily_cap_exceeded</code>, <code>api_key_spend_caps_missing</code></>, when: "The key's own caps: the price of one use is over the most one use may cost, the day's allowance is used, or the key has no caps." },
          { status: <code>403</code>, code: <code>not_a_member</code>, when: "You are no longer a member of the organization that pays for this agent." },
          { status: <code>404</code>, code: <code>agent_not_found</code>, when: "No agent with that handle." },
          { status: <code>409</code>, code: <><code>own_agent</code>, <code>not_for_sale</code>, <code>not_offered</code>, <code>results_only</code>, <code>not_a_task_agent</code></>, when: "Your own agent; an agent whose use is free (use it on its page) or not on sale; a listing that is no longer offered; a self-running agent, which is read through results; the run route on an agent that is not a task agent." },
          { status: <code>409</code>, code: <code>pricing_changed</code>, when: <>The price went up or the pricing model changed since you agreed. <code>terms</code> says what it is now. Nothing is charged until you accept it.</> },
          { status: <code>413</code>, code: <code>input_too_large</code>, when: "Your answers are too long." },
          { status: <code>422</code>, code: <code>input_invalid</code>, when: <>Some answers need another look; <code>details</code> lists them.</> },
          { status: <code>429</code>, code: <code>rate_limited</code>, when: <>Your limit or the agent&apos;s, with <code>scope</code> (<code>org</code> or <code>agent</code>) and <code>retryAfterSeconds</code>.</> },
          { status: <code>429</code>, code: <code>too_many_refunds</code>, when: "Several of your answers could not be delivered today. Try again tomorrow." },
          { status: <code>499</code>, code: <code>client_closed_request</code>, when: "You closed the connection before the answer arrived. The charge was refunded." },
          { status: <code>502</code>, code: <><code>model_error</code>, <code>answer_withheld</code></>, when: <>The agent could not answer, or its answer could not be shown. <code>refundedCents</code> says what was given back.</> },
          { status: <code>503</code>, code: <><code>agent_unavailable</code>, <code>rate_limiter_unavailable</code></>, when: "The agent or the limit check is not available right now. Try again in a moment." },
        ]}
      />
      <p>
        <code>GET /api/capabilities</code> also answers <code>paidUse</code>:{" "}
        <code>&#123; perBuyerPerMinute, perBuyerPerDay, minPricePerUseCents, freeModelDailyAllowance &#125;</code>. These are the
        limits above, the smallest price of one use (5 cents), and how many answers a day your organization gets on
        WheelsAI&apos;s models (<code>null</code> when it cannot be read).
      </p>

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
