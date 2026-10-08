import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { CardGrid, CardLink } from "@/components/marketing/docs/card-link";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Callout } from "@/components/marketing/prose";
import { API_BASE_URL } from "@/lib/api";

export const metadata: Metadata = {
  title: "Documentation",
  description:
    "What WheelsAI is, how its pieces fit together, and where to start: guides, the REST and OpenAI-compatible API, and the SDK and CLI.",
};

const toc = [
  { id: "start-here", title: "Start here" },
  { id: "concepts", title: "How the pieces fit" },
  { id: "base-url", title: "API base URL" },
  { id: "conventions", title: "Conventions" },
  { id: "help", title: "Getting help" },
];

export default function DocsHome() {
  return (
    <DocPage
      href="/docs"
      title="WheelsAI documentation"
      lead="WheelsAI is one platform to build, deploy and monetize AI agents, workflows and small language models. Agents run on any of six frameworks, models deploy to Nosana's decentralized GPU network, and earnings settle through a credit ledger and Solana."
      toc={toc}
    >
      <h2 id="start-here">Start here</h2>
      <CardGrid>
        <CardLink href="/docs/guides/getting-started" title="Getting started">
          Create an account, verify your email for $5 of credits, import or create an agent and chat with it.
        </CardLink>
        <CardLink href="/docs/guides/deploy-a-model" title="Deploy a model">
          Put an open-weight model on a Nosana GPU and call it through an OpenAI-compatible endpoint.
        </CardLink>
        <CardLink href="/docs/guides/marketplace" title="Publish to the marketplace">
          List an agent as free, per-request, monthly or tokenized, and get paid for every use.
        </CardLink>
        <CardLink href="/docs/guides/plans-and-billing" title="Plans and billing">
          Starter, Pro and Enterprise; credits by card, wallet top-up or x402 micropayments.
        </CardLink>
        <CardLink href="/docs/api" title="API reference">
          Authentication, errors, rate limits and every endpoint group, with the fields each one takes and returns.
        </CardLink>
        <CardLink href="/docs/sdk" title="SDK and CLI">
          The TypeScript client and the <code>wheelsai</code> command-line tool.
        </CardLink>
      </CardGrid>

      <h2 id="concepts">How the pieces fit</h2>
      <ul>
        <li>
          <strong>Organization.</strong> Everything you create belongs to an organization. Signing up creates one you own; you can
          invite teammates as admins or members and switch between the organizations you belong to. Credits, plans, API keys and
          limits are all per organization.
        </li>
        <li>
          <strong>Agent.</strong> Instructions, a model choice, tools and optional source code, tagged with one of six frameworks:
          Mastra, ElizaOS, LangChain, AutoGen, CrewAI or custom. An agent is made for one of three uses: people talk to it, people
          give it a task by filling in a short form, or it runs on its own at set times. Creating
          one needs only a name. Agents can be created in the dashboard, started from a template, or imported from a GitHub
          repository. Secrets you attach to an agent are encrypted at rest and never shown again.
        </li>
        <li>
          <strong>Playground.</strong> Chat with any agent, whichever way it is used, from the dashboard or the API. Free models are rate limited per
          organization; paid plans raise the limits.
        </li>
        <li>
          <strong>Deployment.</strong> A model from the catalog running on a Nosana GPU tier, reachable at{" "}
          <code>/v1/&#123;deploymentSlug&#125;/chat/completions</code>. GPU time is priced per second and paid from credits.
        </li>
        <li>
          <strong>Marketplace listing.</strong> A published agent that other organizations can install. Creators keep 90% of what
          buyers pay; the platform fee is 10%.
        </li>
        <li>
          <strong>Credits.</strong> A USD balance, kept in cents in a ledger where every change is a row. Inference, GPU time and
          marketplace purchases draw on it.
        </li>
      </ul>

      <h2 id="base-url">API base URL</h2>
      <p>
        The API this site talks to is at <code>{API_BASE_URL}</code>. REST endpoints live under <code>/api</code>; the
        OpenAI-compatible inference endpoints live under <code>/v1</code>. The examples in these docs read it from an
        environment variable:
      </p>
      <CodeBlock language="bash" code={`export WHEELSAI_API_URL="${API_BASE_URL}"\nexport WHEELSAI_API_KEY="wheels_live_..."   # from /dashboard/keys`} />
      <p>
        The API also serves a machine-generated OpenAPI explorer at{" "}
        <a href={`${API_BASE_URL}/docs`} rel="noopener">
          {API_BASE_URL}/docs
        </a>
        . These pages explain what the schema cannot, such as credit holds and plan limits.
      </p>

      <h2 id="conventions">Conventions</h2>
      <ul>
        <li>Request and response bodies are JSON. Send <code>Content-Type: application/json</code> with a body.</li>
        <li>
          Money is in US dollars. Ledger amounts are stored in cents; fields ending in <code>Cents</code> are integers of cents.
        </li>
        <li>Timestamps are ISO 8601 strings in UTC.</li>
        <li>
          A feature that is temporarily unavailable answers <code>501 Not Implemented</code> with an error code that names
          it, for example <code>card_payments_not_configured</code> for card checkout. Nothing is charged, and you can retry
          later or use another payment method.
        </li>
      </ul>
      <Callout title="Clear answers">
        <p>
          When a request cannot be served, the API says so with a named error code and a message, so your code can handle
          it.
        </p>
      </Callout>

      <h2 id="help">Getting help</h2>
      <p>
        Check the <Link href="/status">status page</Link> for live platform health, read the <Link href="/changelog">changelog</Link>{" "}
        for recent changes, or <Link href="/contact?topic=support">contact support</Link>.
      </p>
    </DocPage>
  );
}
