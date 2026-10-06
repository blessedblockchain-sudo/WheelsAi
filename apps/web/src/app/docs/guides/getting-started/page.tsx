import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Callout, DocTable } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Getting started",
  description:
    "Create a WheelsAI account, verify your email for $5 of credits, create or import an agent, chat with it in the playground and call it from code.",
};

const toc = [
  { id: "account", title: "1. Create an account" },
  { id: "verify", title: "2. Verify your email" },
  { id: "agent", title: "3. Create or import an agent" },
  { id: "import", title: "Import from GitHub", sub: true },
  { id: "scratch", title: "Build from scratch", sub: true },
  { id: "playground", title: "4. Chat in the playground" },
  { id: "api-key", title: "5. Call it from code" },
  { id: "next", title: "Where to go next" },
];

export default function GettingStartedPage() {
  return (
    <DocPage
      href="/docs/guides/getting-started"
      title="Getting started"
      lead="From a new account to an agent answering you, in the dashboard and from code. You need an email address or a Solana wallet; no card is required to start."
      toc={toc}
    >
      <h2 id="account">1. Create an account</h2>
      <p>
        Go to <Link href="/register">Get started</Link> and sign up with an email and a password of at least 8 characters, or sign
        in with a Solana wallet. Wallet sign-in asks your wallet to sign a Sign-In With Solana message that names this site, the
        purpose, the chain and an expiry; each message can be used once.
      </p>
      <p>
        Signing up creates an organization that you own. You start on the free <strong>Starter</strong> plan with a credit
        balance of $0. Session cookies last 24 hours; you can turn on two-factor authentication under{" "}
        <strong>Settings → Security</strong>.
      </p>

      <h2 id="verify">2. Verify your email</h2>
      <p>
        Email sign-ups receive a verification link (valid for 24 hours). Opening it verifies the address and adds{" "}
        <strong>$5.00 of credits</strong> to your organization. The bonus is granted once per organization, and only for the
        organization owner&apos;s address. If the email did not arrive, the dashboard banner can resend it.
      </p>
      <Callout>
        <p>
          The $5 is real credit: it pays for inference, GPU time and marketplace purchases like any other credit. It arrives on
          verification rather than at sign-up so that throwaway accounts cannot collect it.
        </p>
      </Callout>

      <h2 id="agent">3. Create or import an agent</h2>
      <p>
        Open <strong>Agents → New agent</strong> (<code>/dashboard/agents/new</code>). There are three ways to start:
      </p>
      <ul>
        <li>
          <strong>Import from GitHub</strong> for an existing project.
        </li>
        <li>
          <strong>Choose a framework</strong> and configure the agent from scratch.
        </li>
        <li>
          <strong>Start from a template</strong> in the <Link href="/templates">template gallery</Link>.
        </li>
      </ul>
      <p>WheelsAI accepts six frameworks:</p>
      <DocTable
        caption="Supported agent frameworks"
        columns={[
          { key: "name", label: "Framework" },
          { key: "id", label: "API value" },
        ]}
        rows={[
          { name: "Mastra", id: <code>mastra</code> },
          { name: "ElizaOS", id: <code>elizaos</code> },
          { name: "LangChain", id: <code>langchain</code> },
          { name: "AutoGen", id: <code>autogen</code> },
          { name: "CrewAI", id: <code>crewai</code> },
          { name: "Custom", id: <code>custom</code> },
        ]}
      />

      <h3 id="import">Import from GitHub</h3>
      <p>
        Paste a repository URL such as <code>https://github.com/owner/repo</code> (a <code>/tree/branch</code> URL reads that
        branch). WheelsAI reads the repository&apos;s <code>package.json</code>, <code>requirements.txt</code> or{" "}
        <code>pyproject.toml</code> to detect the framework, and pre-fills the agent&apos;s name, description and source URL. You
        review the configuration before anything is created.
      </p>
      <p>
        Public repositories work without setup. For private repositories, install the WheelsAI GitHub App for your organization
        from <strong>Integrations</strong> and grant it access to the repository; imports then use that installation&apos;s
        access, which only reaches the repositories you granted.
      </p>

      <h3 id="scratch">Build from scratch</h3>
      <p>
        Pick a framework, then set a name, description, system prompt, model and temperature, choose tools, and optionally add
        source code. Environment variables you add (provider keys, bot tokens) are encrypted at rest with AES-256-GCM. After you
        save them, the API only ever returns their names, never their values.
      </p>
      <p>
        The Starter plan includes up to 3 agents. Agents installed from the marketplace do not count toward that limit.
      </p>

      <h2 id="playground">4. Chat in the playground</h2>
      <p>
        Open the agent and choose <strong>Playground</strong>. Free models run on WheelsAI&apos;s own provider keys, so you can
        chat without adding any key of your own. The free catalog currently includes GPT-OSS 120B, GPT-OSS 20B and Qwen3.8 27B on
        Groq, Gemini 2.5 Flash, and Llama 3.1 8B Turbo on Together; a model only appears when the server has that provider
        configured. To use your own provider account instead, set <code>OPENAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>,{" "}
        <code>GOOGLE_API_KEY</code>, <code>TOGETHER_API_KEY</code> or <code>GROQ_API_KEY</code> in the agent&apos;s environment
        variables and pick a model id of the form <code>provider/model</code>, for example <code>openai/gpt-4</code>.
      </p>
      <p>
        Free-model use is rate limited per organization. By default the limits are 20 requests per minute and 200 per day on
        Starter; Pro multiplies them by 10 and Enterprise by 50. When the limit is reached the playground answers{" "}
        <code>429</code> with the time it resets.
      </p>
      <p>
        If the agent is bound to a knowledge base, the playground retrieves relevant passages first and returns the sources it
        used alongside the answer.
      </p>

      <h2 id="api-key">5. Call it from code</h2>
      <p>
        Create an API key at <strong>API Keys</strong> (<code>/dashboard/keys</code>). The full key starts with{" "}
        <code>wheels_live_</code> and is shown once. Send it as a bearer token:
      </p>
      <CodeBlock
        language="bash"
        code={`curl -s "$WHEELSAI_API_URL/api/agents/$AGENT_ID/playground/chat" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"messages":[{"role":"user","content":"Hello! What can you do?"}]}'`}
      />
      <p>
        The response carries the reply, the model used and token usage. This request counts toward your plan&apos;s
        monthly API calls (1,000 on Starter, 100,000 on Pro), as does every API-key request that is not a read;{" "}
        <code>GET</code> requests with a key are free outside <code>/v1</code> (
        <Link href="/docs/guides/plans-and-billing#api-calls">what counts</Link>). See{" "}
        <Link href="/docs/api/agents#playground-chat">playground chat</Link> for the full contract.
      </p>

      <h2 id="next">Where to go next</h2>
      <ul>
        <li>
          <Link href="/docs/guides/deploy-a-model">Deploy a model</Link> to a Nosana GPU and call it through the OpenAI-compatible
          API.
        </li>
        <li>
          <Link href="/docs/guides/marketplace">Publish your agent</Link> and choose how buyers pay.
        </li>
        <li>
          <Link href="/docs/api/webhooks">Subscribe to webhooks</Link> for agent, deployment, training and alert events.
        </li>
      </ul>
    </DocPage>
  );
}
