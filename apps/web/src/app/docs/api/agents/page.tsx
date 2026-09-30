import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Endpoint, Fields } from "@/components/marketing/docs/endpoint";
import { Callout } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Agents and playground",
  description:
    "WheelsAI agents API: import from GitHub, create, list, read, update and delete agents, encrypted environment variables, and playground chat with free or your own models.",
};

const toc = [
  { id: "agents", title: "Agents" },
  { id: "import-github", title: "Import from GitHub", sub: true },
  { id: "list-agents", title: "List agents", sub: true },
  { id: "get-agent", title: "Get an agent", sub: true },
  { id: "create-agent", title: "Create an agent", sub: true },
  { id: "update-agent", title: "Update an agent", sub: true },
  { id: "delete-agent", title: "Delete an agent", sub: true },
  { id: "deploy-agent", title: "Deploy an agent", sub: true },
  { id: "playground", title: "Playground" },
  { id: "playground-chat", title: "Chat with an agent", sub: true },
  { id: "playground-models", title: "Available models", sub: true },
];

export default function AgentsApiPage() {
  return (
    <DocPage
      href="/docs/api/agents"
      title="Agents and playground"
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
          <code>isPublic</code>, <code>latestDeployment</code> and timestamps.
        </p>
      </Endpoint>

      <Endpoint id="get-agent" method="GET" path="/api/agents/{agentId}" auth="API key or session" title="Get an agent">
        <p>
          Returns <code>&#123; agent &#125;</code> with its full configuration and deployments. Environment variables come back
          as their <strong>names only</strong>: values are encrypted at rest (AES-256-GCM) and never leave the API.
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
          are kept. Changing the source, system prompt or tools bumps the agent&apos;s patch version. Fires{" "}
          <code>agent.updated</code>.
        </p>
        <CodeBlock
          language="json"
          code={`{ "env": { "OPENAI_API_KEY": "sk-...", "OLD_TOKEN": null } }`}
        />
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

      <h2 id="playground">Playground</h2>

      <Endpoint id="playground-chat" method="POST" path="/api/agents/{agentId}/playground/chat" auth="API key or session" title="Chat with an agent">
        <Fields
          fields={[
            { name: "messages", type: "array", required: true, description: <>1 to 50 items of <code>&#123; role, content &#125;</code>; <code>role</code> is <code>user</code>, <code>assistant</code> or <code>system</code>; <code>content</code> 1 to 32,000 characters.</> },
            { name: "model", type: "string", description: <>Override the agent&apos;s model for this request. Defaults to the agent&apos;s <code>modelConfig.externalModel</code>, then the first available free model.</> },
            { name: "stream", type: "boolean", description: <>Default <code>false</code>. When <code>true</code> the answer streams as <code>text/event-stream</code>.</> },
          ]}
        />
        <p>The agent&apos;s system prompt, tools and model settings are applied. A non-streaming answer looks like:</p>
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
