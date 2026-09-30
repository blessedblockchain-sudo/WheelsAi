import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Callout, DocTable } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "SDK and CLI",
  description:
    "The WheelsAI TypeScript SDK (@wheelsai/sdk) and command-line tool (@wheelsai/cli): installation status, authentication, resources and methods, and CLI commands.",
};

const toc = [
  { id: "status", title: "Availability" },
  { id: "sdk", title: "TypeScript SDK" },
  { id: "sdk-auth", title: "Create a client", sub: true },
  { id: "sdk-methods", title: "Resources and methods", sub: true },
  { id: "sdk-gaps", title: "Methods not yet aligned", sub: true },
  { id: "sdk-errors", title: "Errors", sub: true },
  { id: "openai", title: "Using the OpenAI SDK for /v1" },
  { id: "cli", title: "CLI" },
  { id: "cli-login", title: "wheelsai login", sub: true },
  { id: "cli-agents", title: "wheelsai agents", sub: true },
  { id: "cli-test", title: "wheelsai test", sub: true },
  { id: "cli-deploy", title: "wheelsai deploy", sub: true },
  { id: "cli-logs", title: "wheelsai logs", sub: true },
];

const ok = "Works";

export default function SdkPage() {
  return (
    <DocPage
      href="/docs/sdk"
      title="SDK and CLI"
      lead="A typed TypeScript client for the WheelsAI API and a small command-line tool built on it. Both are thin: every method is one HTTP call to an endpoint documented in the API reference."
      toc={toc}
    >
      <h2 id="status">Availability</h2>
      <Callout variant="warning" title="Pre-release: not on npm yet">
        <p>
          <code>@wheelsai/sdk</code> and <code>@wheelsai/cli</code> (version 0.1.0) live in the WheelsAI monorepo under{" "}
          <code>packages/sdk</code> and <code>packages/cli</code> and have not been published to the npm registry. Until they
          are, use them from the monorepo as shown below, or call the <Link href="/docs/api">REST API</Link> directly with any
          HTTP client.
        </p>
      </Callout>
      <CodeBlock
        language="bash"
        title="From a checkout of the monorepo"
        code={`npm install
# SDK: depend on the workspace package from another workspace
#   "dependencies": { "@wheelsai/sdk": "*" }

# CLI: run it from source with tsx
npx tsx packages/cli/src/index.ts --help
alias wheelsai="npx tsx $PWD/packages/cli/src/index.ts"`}
      />

      <h2 id="sdk">TypeScript SDK</h2>
      <h3 id="sdk-auth">Create a client</h3>
      <p>
        The client needs the API base URL and a credential. Pass your API key (or a session token from{" "}
        <code>auth.login</code>) as <code>token</code>; the SDK sends it as <code>Authorization: Bearer ...</code>, which is how
        the API reads both.
      </p>
      <CodeBlock
        language="ts"
        code={`import { WheelsAI, WheelsAIError } from "@wheelsai/sdk";

const wheels = new WheelsAI({
  baseUrl: process.env.WHEELSAI_API_URL!,
  token: process.env.WHEELSAI_API_KEY, // wheels_live_...
});

const { agents } = await wheels.agents.list();
const reply = await wheels.agents.playgroundChat(agents[0]!.id, {
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(reply.content, reply.usage);`}
      />
      <Callout variant="warning">
        <p>
          Do not use the <code>apiKey</code> constructor option or <code>setApiKey()</code> yet: they send the key in an{" "}
          <code>X-API-Key</code> header, which the API does not accept. Use <code>token</code> or <code>setToken()</code>.
        </p>
      </Callout>
      <p>
        You can also sign in with a password and let the SDK hold the session: <code>const &#123; token &#125; = await
        wheels.auth.login(email, password); wheels.setToken(token);</code>. Pass <code>fetch</code> in the constructor to use a
        custom fetch implementation.
      </p>

      <h3 id="sdk-methods">Resources and methods</h3>
      <DocTable
        caption="SDK methods and the endpoints they call"
        columns={[
          { key: "method", label: "Method" },
          { key: "endpoint", label: "Endpoint" },
          { key: "state", label: "State" },
        ]}
        rows={[
          { method: <code>auth.register(email, password)</code>, endpoint: <code>POST /api/auth/register</code>, state: ok },
          { method: <code>auth.login(email, password)</code>, endpoint: <code>POST /api/auth/login</code>, state: ok },
          { method: <code>auth.logout()</code>, endpoint: <code>POST /api/auth/logout</code>, state: ok },
          { method: <code>auth.me()</code>, endpoint: <code>GET /api/auth/me</code>, state: ok },
          { method: <code>auth.walletNonce(address)</code>, endpoint: <code>POST /api/auth/wallet/nonce</code>, state: ok },
          { method: <code>auth.walletVerify(address, signature, nonce)</code>, endpoint: <code>POST /api/auth/wallet/verify</code>, state: ok },
          { method: <code>auth.refresh()</code>, endpoint: <code>POST /api/auth/refresh</code>, state: "Works with a session token" },
          { method: <code>agents.list()</code>, endpoint: <code>GET /api/agents</code>, state: ok },
          { method: <code>agents.get(id)</code>, endpoint: <code>GET /api/agents/&#123;id&#125;</code>, state: ok },
          { method: <code>agents.create(input)</code>, endpoint: <code>POST /api/agents</code>, state: ok },
          { method: <code>agents.delete(id)</code>, endpoint: <code>DELETE /api/agents/&#123;id&#125;</code>, state: ok },
          { method: <code>agents.deploy(id, &#123; gpuTier, replicas &#125;)</code>, endpoint: <code>POST /api/agents/&#123;id&#125;/deploy</code>, state: ok },
          { method: <code>agents.playgroundChat(id, body)</code>, endpoint: <code>POST /api/agents/&#123;id&#125;/playground/chat</code>, state: ok },
          { method: <code>agents.playgroundModels(id)</code>, endpoint: <code>GET /api/agents/&#123;id&#125;/playground/models</code>, state: ok },
          { method: <code>deployments.list()</code>, endpoint: <code>GET /api/deployments</code>, state: ok },
          { method: <code>deployments.get(id)</code>, endpoint: <code>GET /api/deployments/&#123;id&#125;</code>, state: ok },
          { method: <code>deployments.create(input)</code>, endpoint: <code>POST /api/deployments</code>, state: ok },
          { method: <code>deployments.update(id, &#123; replicas &#125;)</code>, endpoint: <code>PATCH /api/deployments/&#123;id&#125;</code>, state: ok },
          { method: <code>deployments.delete(id)</code>, endpoint: <code>DELETE /api/deployments/&#123;id&#125;</code>, state: ok },
          { method: <code>deployments.restart(id)</code>, endpoint: <code>POST /api/deployments/&#123;id&#125;/restart</code>, state: ok },
          { method: <code>deployments.metrics(id)</code>, endpoint: <code>GET /api/deployments/&#123;id&#125;/metrics</code>, state: ok },
          { method: <code>models.list(params?)</code>, endpoint: <code>GET /api/models</code>, state: ok },
          { method: <code>models.get(modelId)</code>, endpoint: <code>GET /api/models/&#123;modelId&#125;</code>, state: ok },
          { method: <code>models.free()</code>, endpoint: <code>GET /api/models/free</code>, state: ok },
          { method: <code>models.estimate(modelId, gpuTier, replicas, hours)</code>, endpoint: <code>POST /api/models/&#123;modelId&#125;/estimate</code>, state: ok },
          { method: <code>billing.getBalance()</code>, endpoint: <code>GET /api/billing/balance</code>, state: ok },
          { method: <code>billing.getTransactions()</code>, endpoint: <code>GET /api/billing/transactions</code>, state: "Works; returns the latest 50, paging params are ignored" },
          { method: <code>billing.getUsage()</code>, endpoint: <code>GET /api/billing/usage</code>, state: ok },
          { method: <code>inference.listModels()</code>, endpoint: <code>GET /v1/models</code>, state: ok },
          { method: <code>versioning.list(agentId)</code>, endpoint: <code>GET /api/versioning/agents/&#123;agentId&#125;/versions</code>, state: ok },
          { method: <code>versioning.get(agentId, version)</code>, endpoint: <code>GET .../versions/&#123;version&#125;</code>, state: ok },
          { method: <code>versioning.create(agentId, input)</code>, endpoint: <code>POST .../versions</code>, state: ok },
          { method: <code>versioning.rollback(agentId, version)</code>, endpoint: <code>POST .../versions/&#123;version&#125;/rollback</code>, state: ok },
          { method: <code>versioning.publish(agentId, version)</code>, endpoint: <code>POST .../versions/&#123;version&#125;/publish</code>, state: ok },
        ]}
      />

      <h3 id="sdk-gaps">Methods not yet aligned with the API</h3>
      <p>These methods exist in 0.1.0 but call a path or verb the API does not serve. Use the endpoint on the right instead.</p>
      <DocTable
        caption="SDK methods to avoid in 0.1.0"
        columns={[
          { key: "method", label: "Method" },
          { key: "instead", label: "Use instead" },
        ]}
        rows={[
          { method: <code>agents.update(id, updates)</code>, instead: <><code>PATCH /api/agents/&#123;id&#125;</code> (the SDK sends PUT)</> },
          { method: <code>agents.stop(id)</code>, instead: <><code>POST /api/agents/&#123;agentId&#125;/deployments/&#123;deploymentId&#125;/stop</code></> },
          { method: <code>billing.addCredits(amountCents)</code>, instead: <>Buy credits in the dashboard, or <code>POST /api/billing/checkout</code> with a session</> },
          { method: <code>marketplace.search / get / install / reviews / addReview</code>, instead: <>The <code>/api/marketplace/listings</code> endpoints in the <Link href="/docs/api/marketplace">marketplace reference</Link></> },
          { method: <code>inference.chatCompletion(request)</code>, instead: <><code>POST /v1/&#123;deploymentSlug&#125;/chat/completions</code>, or the OpenAI SDK as below</> },
          { method: <code>versioning.compare(agentId, from, to)</code>, instead: <><code>GET /api/versioning/agents/&#123;agentId&#125;/compare?from=&amp;to=</code></> },
        ]}
      />

      <h3 id="sdk-errors">Errors</h3>
      <p>
        Any non-2xx response throws a <code>WheelsAIError</code> with <code>status</code> (the HTTP status),{" "}
        <code>message</code> (the API&apos;s <code>message</code> or <code>error</code>) and <code>data</code> (the parsed body).
        See <Link href="/docs/api#errors">Errors</Link> for the shapes.
      </p>
      <CodeBlock
        language="ts"
        code={`try {
  await wheels.agents.create({ name: "Fourth agent", framework: "custom", sourceType: "github",
    sourceUrl: "https://github.com/owner/repo", modelConfig: {} });
} catch (err) {
  if (err instanceof WheelsAIError && err.status === 403) {
    console.log((err.data as { upgradeUrl?: string }).upgradeUrl); // plan limit reached
  }
}`}
      />

      <h2 id="openai">Using the OpenAI SDK for /v1</h2>
      <p>
        For chat completions against your deployments, the official OpenAI client works unchanged: set <code>baseURL</code> to{" "}
        <code>$WHEELSAI_API_URL/v1/&#123;deploymentSlug&#125;</code> and <code>apiKey</code> to your WheelsAI key. See{" "}
        <Link href="/docs/guides/deploy-a-model#call">Deploy a model</Link> for a full example.
      </p>

      <h2 id="cli">CLI</h2>
      <p>
        The <code>wheelsai</code> command stores its API URL and credentials in your user configuration directory (via{" "}
        <code>conf</code>, project name <code>wheelsai</code>). The default API URL is <code>http://localhost:4000</code>; set
        yours with <code>--url</code> on login.
      </p>

      <h3 id="cli-login">wheelsai login</h3>
      <CodeBlock
        language="bash"
        code={`wheelsai login --url "$WHEELSAI_API_URL" --email you@example.com --password '...'`}
      />
      <p>
        Signs in and saves the session token, which lasts 24 hours. Accounts with two-factor authentication cannot sign in from
        the CLI yet.
      </p>
      <Callout variant="warning">
        <p>
          <code>wheelsai login --api-key &lt;key&gt;</code> saves the key, but the CLI then sends it in the{" "}
          <code>X-API-Key</code> header the API does not accept, so commands answer <code>401</code>. Use email login for now.
        </p>
      </Callout>

      <h3 id="cli-agents">wheelsai agents</h3>
      <CodeBlock
        language="bash"
        code={`wheelsai agents list          # name, id, framework and version of each agent
wheelsai agents get <agent-id>  # configuration, tools, model and deployments
# add --json to either for machine-readable output`}
      />

      <h3 id="cli-test">wheelsai test</h3>
      <CodeBlock
        language="bash"
        code={`wheelsai test <agent-id> -m "Summarise what you can do" --model free/groq/llama-3.3-70b`}
      />
      <p>
        Sends one playground message and prints the reply, the model and token usage. Without <code>-m</code> it asks the agent
        to introduce itself; <code>--json</code> prints the raw response.
      </p>

      <h3 id="cli-deploy">wheelsai deploy</h3>
      <CodeBlock language="bash" code={`wheelsai deploy <agent-id> --gpu-tier 4090 --replicas 1`} />
      <p>
        Deploys an agent (<code>POST /api/agents/&#123;id&#125;/deploy</code>). Always pass <code>--gpu-tier</code> with a tier
        id from <code>GET /api/models</code> (<code>3060</code>, <code>4070</code>, <code>4090</code>, <code>a100</code>,{" "}
        <code>h100</code>): the built-in default, <code>rtx-4090</code>, is not a tier id.
      </p>

      <h3 id="cli-logs">wheelsai logs</h3>
      <CodeBlock language="bash" code={`wheelsai logs <deployment-id> [--json]`} />
      <p>
        Despite the name, prints a <strong>model</strong> deployment&apos;s status, model, engine, GPU tier, replicas, endpoint
        and per-node health (<code>GET /api/deployments/&#123;id&#125;</code>). Use a deployment id from{" "}
        <code>/api/deployments</code>; agent deployment ids from <code>wheelsai deploy</code> are not found there.
      </p>
    </DocPage>
  );
}
