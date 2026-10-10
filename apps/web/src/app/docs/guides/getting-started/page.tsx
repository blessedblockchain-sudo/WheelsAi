import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Callout, DocTable } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Getting started",
  description:
    "Create a WheelsAI account, verify your email for $5 of credits, create an agent that answers at once, share it, sell it and call it from code.",
};

const toc = [
  { id: "account", title: "1. Create an account" },
  { id: "verify", title: "2. Verify your email" },
  { id: "agent", title: "3. Create an agent" },
  { id: "scratch", title: "Start from a template", sub: true },
  { id: "import", title: "Import your code", sub: true },
  { id: "playground", title: "4. Try it" },
  { id: "share", title: "5. Share it" },
  { id: "sell", title: "6. Sell it" },
  { id: "api-key", title: "7. Call it from code" },
  { id: "next", title: "Where to go next" },
];

export default function GettingStartedPage() {
  return (
    <DocPage
      href="/docs/guides/getting-started"
      title="Getting started"
      lead="From a new account to an agent that answers you, that other people can reach and that can earn, in the dashboard and from code. You need an email address or a Solana wallet; no card is required to start."
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

      <h2 id="agent">3. Create an agent</h2>
      <p>
        Open <strong>Agents</strong> and choose <strong>New agent</strong> (<code>/dashboard/agents/new</code>). Creating
        an agent is one screen:
      </p>
      <ol>
        <li>
          <strong>How will people use it?</strong> Pick one of three.
        </li>
        <li>
          <strong>What should it do?</strong> One or two sentences. This becomes your agent&apos;s instructions, and you
          can change it later.
        </li>
        <li>
          <strong>Name.</strong> At least 3 characters.
        </li>
        <li>
          Choose <strong>Create agent</strong>.
        </li>
      </ol>
      <DocTable
        caption="The three ways an agent is used"
        columns={[
          { key: "choice", label: "Choice" },
          { key: "what", label: "What it means" },
          { key: "asks", label: "What the screen also asks" },
          { key: "tab", label: "Its first tab" },
        ]}
        rows={[
          {
            choice: "Talk to it",
            what: "People chat with it and it answers. Good for support, advice and questions.",
            asks: "Nothing more.",
            tab: "Chat",
          },
          {
            choice: "Give it a task",
            what: "People fill in a short form and get one result back. Good for writing, summaries and reviews.",
            asks: "What do you need from people? These are the questions of its form.",
            tab: "Run",
          },
          {
            choice: "It runs on its own",
            what: "It works on a schedule and sends you what it produced. Good for daily briefings, checks and reports.",
            asks: "When should it run? Where should results go? Results are always saved on the agent's page.",
            tab: "Runs",
          },
        ]}
      />
      <p>
        There is no deploy step. Creating the agent opens its page on its first tab, and it answers there at once. In
        lists an agent carries a badge for its use: <strong>Chat</strong>, <strong>Task</strong> or{" "}
        <strong>Runs on its own</strong>.
      </p>
      <p>
        <strong>Advanced</strong>, at the foot of the screen, holds the model, creativity, tools, knowledge and secrets.
        You can leave it closed. Secrets (provider keys, bot tokens) are encrypted at rest with AES-256-GCM. After you save them, the API only ever returns their names, never their values.
      </p>
      <p>
        The Starter plan includes up to 3 agents. Agents installed from the marketplace do not count toward that limit.
      </p>

      <h3 id="scratch">Start from a template</h3>
      <p>
        Under <strong>Start from a template</strong> the same screen lists templates as chips, each marked Chat, Task or
        Runs on its own. Choosing one fills in the screen, and choosing it again puts back what you had. The public{" "}
        <Link href="/templates">template gallery</Link> shows the same templates; see{" "}
        <Link href="/docs/guides/templates">Templates</Link>.
      </p>

      <h3 id="import">Import your code</h3>
      <p>
        If your agent is a project you already have, choose <strong>Import your code</strong> at the top of the create
        screen. It offers three starts: <strong>Import from GitHub</strong>, <strong>Choose a Framework</strong> and
        configure the agent yourself, or <strong>Start from Template</strong>. WheelsAI accepts six frameworks:
      </p>
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
      <p>
        To import, paste a repository URL such as <code>https://github.com/owner/repo</code> (a <code>/tree/branch</code>{" "}
        URL reads that branch). WheelsAI reads the repository&apos;s <code>package.json</code>,{" "}
        <code>requirements.txt</code> or <code>pyproject.toml</code> to detect the framework, and pre-fills the
        agent&apos;s name, description and source URL. You review the configuration before anything is created.
      </p>
      <p>
        Public repositories work without setup. For private repositories, install the WheelsAI GitHub App for your
        organization and grant it access to the repository; imports then use that installation&apos;s access, which only
        reaches the repositories you granted.
      </p>
      <p>
        Choosing a framework instead takes you through its steps: a name, description, system prompt, model and
        temperature, then tools, then optional source code, then a review. <strong>Create without code</strong> returns
        to the one-screen form.
      </p>

      <h2 id="playground">4. Try it</h2>
      <p>Your new agent&apos;s page opens on the tab for its use:</p>
      <ul>
        <li>
          <strong>Chat</strong>: type a message and read the answer.
        </li>
        <li>
          <strong>Run</strong>: fill in the agent&apos;s form and get one result back.
        </li>
        <li>
          <strong>Runs</strong>: see when it runs next and where its results go, start one with{" "}
          <strong>Run now</strong>, and read every run it has made.
        </li>
      </ul>
      <p>
        Free models run on WheelsAI&apos;s own provider keys, so your agent answers without any key of your own. The free
        catalog includes GPT-OSS 120B, GPT-OSS 20B and Qwen3.8 27B on Groq, Gemini 2.5 Flash, and Llama 3.1 8B Turbo on
        Together; the model picker lists the ones available to you. To use your own provider account instead, set{" "}
        <code>OPENAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>, <code>GOOGLE_API_KEY</code>,{" "}
        <code>TOGETHER_API_KEY</code> or <code>GROQ_API_KEY</code> as a secret when you create the agent, or under{" "}
        <strong>Environment variables</strong> on its <strong>Settings</strong> tab, and pick a model id of the form{" "}
        <code>provider/model</code>, for example <code>openai/gpt-4</code>.
      </p>
      <p>
        Free-model use is rate limited per organization. By default the limits are 20 requests per minute and 200 per day on
        Starter; Pro multiplies them by 10 and Enterprise by 50. When the limit is reached the agent answers{" "}
        <code>429</code> with the time it resets.
      </p>
      <p>
        If the agent is bound to a knowledge base, it retrieves relevant passages first and returns the sources it used
        alongside the answer.
      </p>

      <h2 id="share">5. Share it</h2>
      <p>
        The agent&apos;s <strong>Share</strong> tab has three ways for other people to reach it:
      </p>
      <ul>
        <li>
          <strong>Public link.</strong> Turn the link on and the agent gets its own page at{" "}
          <code>/a/&#123;handle&#125;</code>. Anyone with the link can use it there, with no sign-in. Their use counts
          toward your plan, each visitor is limited, and you can pause the link at any time or change how many uses a day
          it allows. See <Link href="/docs/guides/plans-and-billing#api-calls">what counts as an API call</Link>.
        </li>
        <li>
          <strong>On a website.</strong> For an agent people talk to, a chat box you paste into your own site. For a task
          agent or one that runs on its own, a button that opens its public page. See{" "}
          <Link href="/docs/guides/web-chat-widget">Web chat widget</Link>.
        </li>
        <li>
          <strong>Use from code.</strong> The agent&apos;s address on the API and a call you can copy.
        </li>
      </ul>

      <h2 id="sell">6. Sell it</h2>
      <p>
        The agent&apos;s <strong>Sell</strong> tab asks one question, <strong>Who can use it?</strong> Choose{" "}
        <strong>Free</strong>, <strong>Pay per use</strong> (by the message or by the run, from $0.05) or{" "}
        <strong>Monthly</strong> (from $1.00), then <strong>Put it on sale</strong>. An agent that runs on its own is
        Free or Monthly: people pay by the month to read its results. People use your agent on its page or
        through the API. They never get its instructions, its settings or its code, and you keep 90% of what they pay. See{" "}
        <Link href="/docs/guides/marketplace">Publish to the marketplace</Link>.
      </p>

      <h2 id="api-key">7. Call it from code</h2>
      <p>
        Create an API key under <strong>API keys</strong> (<code>/dashboard/keys</code>). The full key starts with{" "}
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
