import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Callout, DocTable } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "SDK and CLI",
  description:
    "The WheelsAI TypeScript SDK (@wheelsai/sdk) and command-line tool (@wheelsai/cli): installation, authentication, resources and methods, and the login, deploy, publish, test and logs commands.",
};

const toc = [
  { id: "status", title: "Availability" },
  { id: "sdk", title: "TypeScript SDK" },
  { id: "sdk-auth", title: "Create a client", sub: true },
  { id: "sdk-methods", title: "Resources and methods", sub: true },
  { id: "sdk-create-agent", title: "Creating an agent", sub: true },
  { id: "sdk-run-task", title: "Running a task and sharing it", sub: true },
  { id: "sdk-schedule", title: "Running on a schedule", sub: true },
  { id: "sdk-jobs", title: "Hiring an offering", sub: true },
  { id: "sdk-errors", title: "Errors and timeouts", sub: true },
  { id: "sdk-agent-chat", title: "Talking to an agent", sub: true },
  { id: "openai", title: "Using the OpenAI SDK for /v1" },
  { id: "cli", title: "CLI" },
  { id: "cli-login", title: "wheelsai login", sub: true },
  { id: "cli-deploy", title: "wheelsai deploy", sub: true },
  { id: "cli-publish", title: "wheelsai publish", sub: true },
  { id: "cli-test", title: "wheelsai test", sub: true },
  { id: "cli-inspect", title: "agents, logs, whoami, config", sub: true },
  { id: "cli-errors", title: "Exit codes and errors", sub: true },
];

export default function SdkPage() {
  return (
    <DocPage
      href="/docs/sdk"
      title="SDK and CLI"
      lead="A typed TypeScript client for the WheelsAI API and a command-line tool built on it. Both are thin: every SDK method is one HTTP call to an endpoint documented in the API reference, and everything the CLI prints is something the API returned."
      toc={toc}
    >
      <h2 id="status">Availability</h2>
      <Callout variant="warning" title="Pre-release: not on npm yet">
        <p>
          <code>@wheelsai/sdk</code> and <code>@wheelsai/cli</code> (version 0.1.0) live in the WheelsAI monorepo under{" "}
          <code>packages/sdk</code> and <code>packages/cli</code> and have not been published to the npm registry. Until they
          are, build them from a checkout as shown below, or call the <Link href="/docs/api">REST API</Link> directly with any
          HTTP client.
        </p>
      </Callout>
      <CodeBlock
        language="bash"
        title="From a checkout of the monorepo"
        code={`npm install
npm run build -w @wheelsai/sdk   # the SDK is consumed compiled, from packages/sdk/dist
npm run build -w @wheelsai/cli

node packages/cli/bin/wheelsai.js --help
alias wheelsai="node $PWD/packages/cli/bin/wheelsai.js"`}
      />
      <p>
        To use the SDK from another workspace in the monorepo, add <code>&quot;@wheelsai/sdk&quot;: &quot;*&quot;</code> to its
        dependencies and build the SDK first: the package&apos;s entry point is its compiled <code>dist/</code>, which{" "}
        <code>npm install</code> alone does not create. The SDK has no runtime dependencies and needs Node 18 or newer (for the
        global <code>fetch</code>).
      </p>

      <h2 id="sdk">TypeScript SDK</h2>
      <h3 id="sdk-auth">Create a client</h3>
      <p>
        The client needs the API base URL and a credential: an API key (<code>apiKey</code>) or a session token from{" "}
        <code>auth.login</code> (<code>token</code>). Both are sent as <code>Authorization: Bearer ...</code>, which is how the
        API reads them; if both are set, the session token is used.
      </p>
      <CodeBlock
        language="ts"
        code={`import { WheelsAI, WheelsAIError } from "@wheelsai/sdk";

const wheels = new WheelsAI({
  baseUrl: process.env.WHEELSAI_API_URL!,
  apiKey: process.env.WHEELSAI_API_KEY, // wheels_live_...
});

// Only a name is needed. The agent's OpenAI-compatible API is on as soon as it exists.
const { agent } = await wheels.agents.create({ name: "My support bot" });
console.log(agent.apiEndpoint, agent.openaiBaseUrl, agent.openaiModel);

const reply = await wheels.agents.chatCompletion(agent.slug, {
  messages: [{ role: "user", content: "How long do refunds take?" }],
});
console.log(reply.choices[0]?.message.content);

// A dedicated GPU is optional. Ask what the server can do before starting one.
const { agentGpu } = await wheels.platform.capabilities();
if (agentGpu.available) {
  const tiers = await wheels.models.gpuTiers();              // the tiers this API can deploy now
  const { deployment } = await wheels.agents.deploy(agent.id, { gpuTier: tiers[0]!.id });

  // The deploy answer is immediate (status "pending"): poll for progress.
  const { deployment: row } = await wheels.agents.getDeployment(agent.id, deployment.id);
  console.log(row.status, row.endpoint);
}`}
      />
      <p>
        When <code>agentGpu.available</code> is <code>false</code>, <code>agents.deploy</code> throws a{" "}
        <code>WheelsAIError</code> with status <code>501</code> and code <code>agent_gpu_unavailable</code>. Nothing is
        reserved or charged, and the agent keeps answering on its API. <code>agents.resolve(&quot;my-support-bot&quot;)</code>{" "}
        finds an existing agent by slug or id, or returns <code>null</code>.
      </p>
      <p>
        To sign in with a password instead, call <code>auth.login(email, password)</code> and pass the returned token to{" "}
        <code>wheels.setToken(token)</code>. An account with two-factor authentication answers with a challenge: check with{" "}
        <code>isTwoFactorChallenge(result)</code> and finish with <code>auth.login2fa(result.challengeToken, code)</code>.{" "}
        <code>setApiKey()</code> and <code>setToken()</code> change the credential on an existing client; pass{" "}
        <code>fetch</code> in the constructor to use a custom fetch implementation.
      </p>
      <Callout>
        <p>
          Some routes need a session rather than an API key and answer <code>401</code> to a key: <code>auth.listApiKeys</code>,{" "}
          <code>auth.createApiKey</code>, <code>auth.revokeApiKey</code>, <code>auth.refresh</code>,{" "}
          <code>auth.organizations</code>, <code>auth.switchOrg</code>, <code>billing.checkout</code> and{" "}
          <code>billing.portal</code>. The agent graph routes (<code>agents.getGraph</code>, <code>agents.saveGraph</code>)
          authorize by user as well.
        </p>
      </Callout>

      <h3 id="sdk-methods">Resources and methods</h3>
      <p>
        Ids and slugs are percent-encoded into the path. An empty one, <code>.</code> and <code>..</code> are refused, because
        they would name a different route.
      </p>
      <DocTable
        caption="SDK resources, their main methods and the endpoints they call"
        columns={[
          { key: "resource", label: "Resource" },
          { key: "methods", label: "Methods" },
          { key: "endpoint", label: "Endpoints" },
        ]}
        rows={[
          {
            resource: <code>auth</code>,
            methods: (
              <>
                <code>register</code>, <code>login</code>, <code>login2fa</code>, <code>logout</code>, <code>me</code>,{" "}
                <code>refresh</code>, <code>organizations</code>, <code>switchOrg</code>, <code>walletNonce</code>,{" "}
                <code>walletVerify</code>, <code>listApiKeys</code>, <code>createApiKey</code>, <code>revokeApiKey</code>
              </>
            ),
            endpoint: <code>/api/auth/...</code>,
          },
          {
            resource: <code>agents</code>,
            methods: (
              <>
                <code>list</code>, <code>resolve</code>, <code>findBySlug</code>, <code>get</code>, <code>create</code>,{" "}
                <code>update</code> (PATCH; <code>entrypoint</code> switches between the agent&apos;s prompt and its graph),{" "}
                <code>usage(id, period)</code>, <code>delete</code>, <code>deploy</code>, <code>getDeployment</code>,{" "}
                <code>stopDeployment</code>, <code>deploymentLogs</code>, <code>chatCompletion(agentSlug, request)</code>,{" "}
                <code>run(id, input, options?)</code>, <code>publicLink.get(id)</code>,{" "}
                <code>publicLink.set(id, body)</code>, <code>schedule.get(id)</code>, <code>schedule.set(id, body)</code>,{" "}
                <code>schedule.runNow(id)</code>, <code>runs.list(id, params?)</code>, <code>runs.resend(id, runId)</code>,{" "}
                <code>playgroundChat</code>, <code>playgroundModels</code>,{" "}
                <code>getGraph</code>, <code>saveGraph</code>, <code>validateGraph</code>
              </>
            ),
            endpoint: (
              <>
                <code>/api/agents</code>, <code>/api/agents/&#123;id&#125;/usage</code>,{" "}
                <code>/api/agents/&#123;id&#125;/deploy</code>,{" "}
                <code>/api/agents/&#123;id&#125;/deployments/&#123;deploymentId&#125;</code>,{" "}
                <code>POST /api/agents/&#123;id&#125;/run</code>,{" "}
                <code>/api/agents/&#123;id&#125;/public-link</code>,{" "}
                <code>/api/agents/&#123;id&#125;/schedule</code>, <code>/api/agents/&#123;id&#125;/runs</code>,{" "}
                <code>POST /v1/agents/&#123;slug&#125;/chat/completions</code>
              </>
            ),
          },
          {
            resource: <code>destinations</code>,
            methods: (
              <>
                <code>list</code>, <code>create(&#123; type, link?, name? &#125;)</code>, <code>test(channelId)</code>
              </>
            ),
            endpoint: <code>/api/destinations</code>,
          },
          {
            resource: <code>deployments</code>,
            methods: (
              <>
                Model deployments: <code>list</code>, <code>get</code>, <code>create</code>, <code>update</code>,{" "}
                <code>delete</code> (stops it), <code>restart</code>, <code>logs</code>, <code>metrics</code>
              </>
            ),
            endpoint: <code>/api/deployments</code>,
          },
          {
            resource: <code>models</code>,
            methods: (
              <>
                <code>list</code>, <code>gpuTiers</code>, <code>get</code>, <code>free</code>, <code>engines</code>,{" "}
                <code>estimate</code>
              </>
            ),
            endpoint: <code>/api/models</code>,
          },
          {
            resource: <code>billing</code>,
            methods: (
              <>
                <code>getBalance</code>, <code>getHolds</code>, <code>getTransactions</code>,{" "}
                <code>exportTransactions</code>, <code>getUsage</code>, <code>plan</code>, <code>packages</code>,{" "}
                <code>checkout</code>, <code>subscriptionCheckout</code>, <code>portal</code>,{" "}
                <code>topups.prepare</code>, <code>topups.submit</code>, <code>topups.reconcile</code>,{" "}
                <code>topups.get</code>, <code>topups.list</code>, <code>depositAddress.get</code>,{" "}
                <code>depositAddress.issue</code>, <code>depositAddress.prepareUsdc</code>,{" "}
                <code>depositAddress.check</code>, <code>deposits.list</code>
              </>
            ),
            endpoint: <code>/api/billing/...</code>,
          },
          {
            resource: <code>marketplace</code>,
            methods: (
              <>
                <code>search</code>, <code>get</code>, <code>featured</code>, <code>categories</code>, <code>reviews</code>,{" "}
                <code>addReview</code>, <code>myListings</code>, <code>createListing</code>, <code>updateListing</code>,{" "}
                <code>publishListing</code>, <code>archiveListing</code>, <code>install</code>, <code>startUsing</code>,{" "}
                <code>stopUsing</code>, <code>uninstall</code>,{" "}
                <code>installStatus</code>, <code>myInstalls</code>, <code>subscriptions</code>,{" "}
                <code>cancelSubscription</code>, <code>resumeSubscription</code>, <code>revenue</code>, <code>payouts</code>
              </>
            ),
            endpoint: <code>/api/marketplace/...</code>,
          },
          {
            resource: <code>use</code>,
            methods: (
              <>
                <code>access(handle)</code>, <code>chat(handle, &#123; messages, sessionId? &#125;)</code>,{" "}
                <code>run(handle, &#123; input &#125;)</code>, <code>results(handle)</code>
              </>
            ),
            endpoint: <code>/api/a/&#123;handle&#125;/...</code>,
          },
          {
            resource: <code>inference</code>,
            methods: (
              <>
                <code>chat(request)</code>, <code>chatCompletion(deploymentSlug, request)</code>, <code>listModels</code>
              </>
            ),
            endpoint: (
              <>
                <code>POST /v1/chat/completions</code>, <code>POST /v1/&#123;deploymentSlug&#125;/chat/completions</code>,{" "}
                <code>GET /v1/models</code>
              </>
            ),
          },
          {
            resource: <code>workflows</code>,
            methods: (
              <>
                <code>list</code>, <code>get</code>, <code>run</code>, <code>getRun</code>, <code>cancelRun</code>,{" "}
                <code>chatCompletion(slug, request)</code>
              </>
            ),
            endpoint: (
              <>
                <code>/api/orchestrations</code>, <code>POST /v1/workflows/&#123;slug&#125;/chat/completions</code>
              </>
            ),
          },
          {
            resource: <code>offerings</code>,
            methods: (
              <>
                <code>search</code>, <code>get(slug)</code>, <code>hire(id, input, &#123; idempotencyKey &#125;)</code>,{" "}
                <code>listMine</code>, <code>getMine</code>, <code>create</code>, <code>update</code>, <code>validate</code>,{" "}
                <code>testRun</code>, <code>activate</code>, <code>pause</code>, <code>archive</code>
              </>
            ),
            endpoint: <code>/api/offerings</code>,
          },
          {
            resource: <code>jobs</code>,
            methods: (
              <>
                <code>list</code>, <code>summary</code>, <code>get</code>, <code>accept</code>, <code>reject</code>,{" "}
                <code>cancel</code>, <code>rate</code>
              </>
            ),
            endpoint: <code>/api/jobs</code>,
          },
          {
            resource: <code>versioning</code>,
            methods: (
              <>
                <code>list</code>, <code>latest</code>, <code>get</code>, <code>create</code>, <code>compare</code>,{" "}
                <code>history</code>, <code>rollback</code>, <code>tag</code>, <code>publish</code>, <code>delete</code>
              </>
            ),
            endpoint: <code>/api/versioning/agents/&#123;agentId&#125;/...</code>,
          },
          {
            resource: (
              <>
                <code>openclaw</code>, <code>platform</code>, <code>skills</code>
              </>
            ),
            methods: (
              <>
                <code>openclaw.list</code>, <code>openclaw.get</code> (chat channels), <code>platform.status</code>,{" "}
                <code>platform.stats</code>, <code>platform.capabilities</code>, <code>skills.list</code>
              </>
            ),
            endpoint: (
              <>
                <code>/api/openclaw</code>, <code>/api/status</code>, <code>/api/public/stats</code>,{" "}
                <code>/api/capabilities</code>, <code>/api/skills</code>
              </>
            ),
          },
        ]}
      />
      <p>
        A <code>Workflow</code> carries <code>slug</code>, <code>apiEndpoint</code>, <code>openaiBaseUrl</code> and{" "}
        <code>openaiModel</code> (<code>workflow/&lt;slug&gt;</code>). <code>workflows.run</code> queues a run and returns
        at once; <code>workflows.chatCompletion</code> runs the workflow and waits for its answer, so give it a{" "}
        <code>timeoutMs</code> at least as long as the workflow&apos;s time limit: a client that gives up first
        disconnects, and a disconnect cancels the run. See{" "}
        <Link href="/docs/api/workflows#openai">the workflow endpoint</Link>.
      </p>
      <p>
        Billing amounts are dollars, as the API returns them. There is no <code>agents.stop</code> or{" "}
        <code>billing.addCredits</code>: use <code>agents.stopDeployment(agentId, deploymentId)</code> and{" "}
        <code>billing.checkout</code>.
      </p>

      <h3 id="sdk-create-agent">Creating an agent</h3>
      <p>
        <code>agents.create</code> needs only a name. An agent is one of three kinds: <code>conversation</code> (people talk
        to it; the default), <code>task</code> (made for one request in and one result back, with a form that says what a request holds) or{" "}
        <code>scheduled</code> (made to run on its own at set times). The kind&apos;s settings go in <code>kindConfig</code>; see{" "}
        <Link href="/docs/api/agents#agent-kinds">kinds of agent</Link> and{" "}
        <Link href="/docs/api/agents#task-form">task forms</Link>.
      </p>
      <CodeBlock
        language="ts"
        code={`const { agent } = await wheels.agents.create({ name: "Release notes helper" });
console.log(agent.slug, agent.agentKind, agent.openaiModel); // "release-notes-helper" "conversation" "agent/release-notes-helper"

// A task agent with its form. A question's key is made from its label unless you send one.
await wheels.agents.create({
  name: "Code review",
  agentKind: "task",
  systemPrompt: "Review the code you are given and list the problems, most serious first.",
  kindConfig: {
    task: {
      fields: [
        { label: "Code to review", type: "long_text", required: true, help: "Paste the code or the diff." },
        { label: "What to look for", type: "choice", options: ["Everything", "Bugs", "Security"] },
      ],
    },
  },
});

// From a template: its values are the defaults, and what you send replaces them.
await wheels.agents.create({ name: "Support desk", templateId });

// Change the kind later. Settings are kept per kind, so changing back loses nothing.
// The schedule here is a suggestion stored with the agent: saving it starts no runs.
await wheels.agents.update(agent.id, {
  agentKind: "scheduled",
  kindConfig: { scheduled: { schedule: { cronExpression: "0 9 * * *", timezone: "UTC" } } },
});`}
      />
      <p>
        <code>agents.list</code> and <code>agents.get</code> return each agent&apos;s <code>agentKind</code>;{" "}
        <code>agents.get</code> also returns its <code>kindConfig</code>. Marketplace listings carry{" "}
        <code>listing.agent.agentKind</code>, and each version records the kind and its settings, which a rollback restores.{" "}
        <code>platform.capabilities()</code> says what the server can do right now: the models an agent can answer on (
        <code>chat.models</code>, <code>chat.defaultModel</code>) and whether <code>payouts</code>,{" "}
        <code>emailDelivery</code>, <code>agentGpu</code> and <code>paidTasks</code> are <code>available</code>.
      </p>

      <h3 id="sdk-run-task">Running a task and sharing it</h3>
      <p>
        <code>agents.run(id, input, options?)</code> runs a task agent on one filled-in form and waits for its result. It
        asks the API for the JSON answer: <code>input</code> holds one answer per question, keyed by the question&apos;s{" "}
        <code>key</code>. A run can take up to two minutes, so the call waits 130 seconds unless{" "}
        <code>&#123; timeoutMs &#125;</code> says otherwise. See <Link href="/docs/api/agents#run-agent">run a task</Link>.
      </p>
      <CodeBlock
        language="ts"
        code={`const { output, durationMs, billing } = await wheels.agents.run(agent.id, {
  code_to_review: "def total(items): return sum(items) / len(items)",
  what_to_look_for: "Bugs",
});
console.log(output.text);

// Answers that do not fit the form: a WheelsAIError with status 422 and code "input_invalid".
try {
  await wheels.agents.run(agent.id, {});
} catch (err) {
  if (err instanceof WheelsAIError && err.code === "input_invalid") {
    for (const issue of (err.data as { details: TaskInputIssue[] }).details) {
      console.log(\`\${issue.label}: \${issue.message}\`);
    }
  }
}

// The agent's public page, /a/<handle>.
const link = await wheels.agents.publicLink.set(agent.id, { state: "on", dailyCap: 200 });
console.log(link.url, link.usedToday);`}
      />
      <p>
        <code>agents.publicLink.get(id)</code> and <code>agents.publicLink.set(id, body)</code> read and change the switch
        that lets anyone with the agent&apos;s address use it. <code>state</code> is <code>on</code>, <code>paused</code> or{" "}
        <code>off</code> (a read can also give <code>view_only</code>); <code>set</code> also takes <code>dailyCap</code>,{" "}
        <code>handle</code> and <code>showResults</code>, and answers <code>409</code> <code>handle_taken</code> when another
        agent has the address. See <Link href="/docs/api/agents#public-link">the public link</Link>.
      </p>

      <h3 id="sdk-schedule">Running on a schedule</h3>
      <p>
        A <code>scheduled</code> agent runs on its own and keeps every run. <code>agents.create</code> takes a{" "}
        <code>schedule</code> (with <code>agentKind: &quot;scheduled&quot;</code>) and answers with the schedule it made, or{" "}
        <code>null</code>; <code>agents.schedule.get</code> and <code>agents.schedule.set</code> read and change it;{" "}
        <code>agents.schedule.runNow</code> runs it once now; <code>agents.runs.list</code> pages through its runs, newest
        first; <code>agents.runs.resend</code> posts a finished run&apos;s saved result again and runs nothing.{" "}
        <code>destinations</code> holds the places results can go to. See{" "}
        <Link href="/docs/api/agents#schedule-and-runs">schedule and runs</Link>.
      </p>
      <CodeBlock
        language="ts"
        code={`// Slack or Discord by the link the service gave you. Email is the signed-in person's own
// verified address, so an API key cannot choose it.
const place = await wheels.destinations.create({ type: "slack", link: slackLink, name: "Team Slack" });
await wheels.destinations.test(place.channelId); // { sent: true }

const { agent, schedule } = await wheels.agents.create({
  name: "Morning brief",
  agentKind: "scheduled",
  schedule: { cronExpression: "0 9 * * 1-5", timezone: "Europe/Berlin", deliver: { channelId: place.channelId } },
});
console.log(schedule?.nextRunAt);

await wheels.agents.schedule.set(agent.id, { enabled: true, cronExpression: "0 8 * * *", maxRetries: 2 });

const { run } = await wheels.agents.schedule.runNow(agent.id); // a key needs agents:invoke
const { runs, hasMore } = await wheels.agents.runs.list(agent.id, { limit: 20 });
for (const r of runs) console.log(r.status, r.text ?? r.failure, r.delivery.map((d) => d.status));

try {
  await wheels.agents.runs.resend(agent.id, run.id);
} catch (err) {
  // 502 delivery_failed: the place did not take it. The run is in err.data.run.
  if (err instanceof WheelsAIError && err.code === "delivery_failed") console.log(err.message);
}`}
      />
      <p>
        A run&apos;s <code>status</code> is <code>running</code>, <code>finished</code>, <code>did_not_finish</code> or{" "}
        <code>stopped</code>. A failed delivery never changes a run and never runs the agent again.{" "}
        <code>agents.update</code> and <code>versioning.rollback</code> answer <code>schedulePaused: true</code> when they
        turned the agent&apos;s schedule off by moving its kind away from <code>scheduled</code>.
      </p>

      <h3 id="sdk-jobs">Hiring an offering</h3>
      <p>
        <code>offerings.hire</code> pays an offering&apos;s price into escrow and queues the job; poll{" "}
        <code>jobs.get</code> until it is <code>submitted</code>, then <code>jobs.accept</code> or{" "}
        <code>jobs.reject</code>. Pass an <code>idempotencyKey</code> so a retried hire is the same job, charged once. Pass
        the offering you read, not just its id: its price, delivery time and <code>termsVersion</code> are sent as{" "}
        <code>expected</code>, and if the publisher changed the offering since, the hire throws <code>409</code>{" "}
        <code>offering_terms_changed</code> with <code>data.current</code> and charges nothing. Hiring by id sends no
        expected terms unless you pass <code>&#123; expected: &#123; priceCents &#125; &#125;</code>. An
        API key needs <code>jobs:hire</code> (with both spend caps) and <code>jobs:review</code> granted by name; see the{" "}
        <Link href="/docs/api/jobs">Offerings and jobs API</Link>.
      </p>
      <CodeBlock
        language="ts"
        code={`const { offerings } = await wheels.offerings.search({ productKind: "agent", query: "brief" });

const { job } = await wheels.offerings.hire(
  offerings[0], // the offering as read: held to its price, delivery time and termsVersion
  { topic: "GPU rental prices" },
  { idempotencyKey: "order-42" },
);

let current = (await wheels.jobs.get(job.id)).job;
while (current.status === "funded" || current.status === "running") {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  current = (await wheels.jobs.get(job.id)).job;
}
if (current.status === "submitted") {
  console.log(current.output?.text);
  await wheels.jobs.accept(job.id, { rating: 5 });
}`}
      />

      <h3 id="sdk-errors">Errors and timeouts</h3>
      <p>
        Every failure throws a <code>WheelsAIError</code> with <code>status</code> (the HTTP status, or <code>0</code> for a
        network error or timeout), <code>message</code> (the API&apos;s <code>message</code> or <code>error</code>, with
        validation errors spelled out), <code>code</code> (the API&apos;s <code>error</code> code, such as{" "}
        <code>insufficient_credits</code>) and <code>data</code> (the parsed body). A request the API cannot accept answers{" "}
        <code>400</code> <code>validation_failed</code>: <code>message</code> is the first problem as a sentence, and{" "}
        <code>data.fields</code> has one sentence per field, keyed by its path (<code>name</code>,{" "}
        <code>kindConfig.task.fields[0].label</code>). See{" "}
        <Link href="/docs/api#errors">Errors</Link> for the shapes. The <code>/v1</code> agent API answers in OpenAI&apos;s
        shape, <code>&#123; error: &#123; message, type, param, code &#125; &#125;</code>; <code>message</code> and{" "}
        <code>code</code> are read from there too (for example <code>agent_not_found</code>).
      </p>
      <CodeBlock
        language="ts"
        code={`try {
  await wheels.agents.deploy(agentId, { gpuTier: "3060" });
} catch (err) {
  if (err instanceof WheelsAIError && err.code === "insufficient_credits") {
    console.log(err.status, err.message); // 402 and how much is needed
  } else {
    throw err;
  }
}`}
      />
      <p>
        Requests time out after 30 seconds (<code>timeoutMs</code> in the constructor; <code>0</code> disables it). A playground
        turn with tools, or a long completion, can take longer: <code>agents.chatCompletion</code>,{" "}
        <code>agents.playgroundChat</code>, <code>agents.run</code> (130 seconds by default), <code>inference.chat</code> and{" "}
        <code>inference.chatCompletion</code> accept <code>&#123; timeoutMs &#125;</code> as a last argument for that one call.
      </p>

      <h3 id="sdk-agent-chat">Talking to an agent</h3>
      <p>
        Every agent has an OpenAI-compatible endpoint on the API, on as soon as the agent exists. An agent row says where:{" "}
        <code>apiEndpoint</code>, <code>openaiBaseUrl</code> and <code>openaiModel</code> (<code>agent/&lt;slug&gt;</code>).
        The two URLs are <code>null</code> when they cannot be determined.
      </p>
      <CodeBlock
        language="ts"
        code={`// One call, in OpenAI's response shape. It takes the agent's slug.
const reply = await wheels.agents.chatCompletion(
  "my-support-bot",
  { messages: [{ role: "user", content: "How long do refunds take?" }] },
  { timeoutMs: 120_000 },
);
console.log(reply.choices[0]?.message.content);
console.log(reply.wheelsai?.model, reply.wheelsai?.tool_calls); // what answered, and the agent's own tool calls

// The unified base: model picks an agent or a running model deployment.
const { data: models } = await wheels.inference.listModels();   // free: not a metered call
await wheels.inference.chat({ model: "agent/my-support-bot", messages: [{ role: "user", content: "Hi" }] });`}
      />
      <p>
        Pass your own functions in <code>tools</code>: when the model calls one, the reply has{" "}
        <code>finish_reason: &quot;tool_calls&quot;</code> and <code>message.tool_calls</code>; run it and call again with the
        assistant message and a <code>tool</code> message per call. See{" "}
        <Link href="/docs/api/agents#agent-tools">function calling</Link>.
      </p>

      <h2 id="openai">Using the OpenAI SDK for /v1</h2>
      <p>
        The official OpenAI clients work unchanged against <code>/v1</code>, and they are how you stream. Set{" "}
        <code>apiKey</code> to your WheelsAI key and <code>baseURL</code> to <code>$WHEELSAI_API_URL/v1</code>; then{" "}
        <code>model</code> picks what answers: <code>agent/&lt;slug&gt;</code> for an agent,{" "}
        <code>workflow/&lt;slug&gt;</code> for a workflow (one request is one run; see{" "}
        <Link href="/docs/api/workflows#openai">the workflow endpoint</Link>), or the slug of a running model
        deployment. <code>client.models.list()</code> returns all three.
      </p>
      <CodeBlock
        language="ts"
        code={`import OpenAI from "openai";

const client = new OpenAI({
  baseURL: \`\${process.env.WHEELSAI_API_URL}/v1\`,
  apiKey: process.env.WHEELSAI_API_KEY,
});

const stream = await client.chat.completions.create({
  model: "agent/my-support-bot",
  messages: [{ role: "user", content: "How long do refunds take?" }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}`}
      />
      <p>
        Agents support streaming, function calling and their own server-side tools on this API; see{" "}
        <Link href="/docs/api/agents#agent-api">the agent API</Link>. A client that is tied to one model name can use the
        per-agent base URL instead, <code>$WHEELSAI_API_URL/v1/agents/&#123;slug&#125;</code> (an agent&apos;s{" "}
        <code>openaiBaseUrl</code>), or <code>$WHEELSAI_API_URL/v1/&#123;deploymentSlug&#125;</code> for a model deployment.
        Model deployments speak the same format: they stream, and <code>tools</code> and <code>tool_choice</code> are
        forwarded to the model server (see <Link href="/docs/api/inference#tools">which models parse tool calls</Link>). See{" "}
        <Link href="/docs/guides/deploy-a-model#call">Deploy a model</Link> for a full example.
      </p>

      <h2 id="cli">CLI</h2>
      <p>
        The <code>wheelsai</code> command signs in, deploys an agent to GPU, lists it on the marketplace and reads deployment
        status and logs. Progress goes to stderr and results to stdout; most commands take <code>--json</code>.
      </p>

      <h3 id="cli-login">wheelsai login</h3>
      <CodeBlock
        language="bash"
        code={`# API key: you are asked for it, and nothing is echoed
wheelsai login --url "$WHEELSAI_API_URL"

# Scripts and CI: read the key from stdin
wheelsai login --url "$WHEELSAI_API_URL" --api-key-stdin < key.txt

# Email and password (asked for; --password-stdin reads it from stdin; --code for two-factor)
wheelsai login --url "$WHEELSAI_API_URL" --email you@example.com

wheelsai whoami
wheelsai logout`}
      />
      <p>
        The key or password is read from a prompt or from stdin, so it stays out of your shell history and out of the process
        list. The key is checked against the API before anything is saved. In CI you can skip <code>login</code> altogether and
        set <code>WHEELSAI_API_URL</code> and <code>WHEELSAI_API_KEY</code>.
      </p>
      <Callout title="A saved credential belongs to one API URL">
        <p>
          The API URL is saved together with the credential, and the credential is only ever sent to that URL. If the URL
          later points somewhere else (<code>wheelsai config set apiUrl</code>, <code>login --url</code> or{" "}
          <code>WHEELSAI_API_URL</code>), the credential is withheld and the command stops and says so. There is no default
          URL: <code>login</code> needs <code>--url</code> the first time. Use <code>https://</code>; plain{" "}
          <code>http://</code> to anything but your own machine prints a warning, because the credential then travels
          unencrypted. Settings are stored in your user configuration directory with mode 0600.
        </p>
      </Callout>

      <h3 id="cli-deploy">wheelsai deploy</h3>
      <CodeBlock
        language="bash"
        code={`wheelsai deploy --agent my-support-bot                      # slug or id
wheelsai deploy --agent my-support-bot --gpu-tier 3060 --replicas 2
wheelsai deploy --agent my-support-bot --publish --price-per-request 5`}
      />
      <p>In order, stopping at the first failure, the command:</p>
      <ol>
        <li>finds the agent in your organization by slug or id;</li>
        <li>
          checks its graph with the API&apos;s validator, if it has one (<code>--no-validate</code> skips this; with an API key
          the graph cannot be read, so the check is skipped with a warning);
        </li>
        <li>
          chooses a GPU tier from the tiers the API can deploy right now: <code>--gpu-tier</code> must be one of them, and
          without it the cheapest is used;
        </li>
        <li>
          starts the deployment (<code>POST /api/agents/&#123;id&#125;/deploy</code>), which reserves credits. When the
          server cannot start a dedicated GPU for an agent right now (<code>agentGpu.available</code> is{" "}
          <code>false</code> in <code>GET /api/capabilities</code>), the command stops here with the API&apos;s answer,{" "}
          <code>501</code> <code>agent_gpu_unavailable</code>: nothing is reserved or charged, and the agent keeps
          answering on its API;
        </li>
        <li>
          waits until it is running, showing each status the API reports. Status is checked after 5, 10 and 20 seconds and then
          every <code>--interval</code> seconds (default 30) up to <code>--timeout</code> seconds (default 600);
        </li>
        <li>
          prints the endpoint and channels exactly as the API returned them, or says that none was returned. The endpoint is
          the agent&apos;s OpenAI-compatible URL on the API (<code>&lt;api&gt;/v1/agents/&lt;slug&gt;/chat/completions</code>),
          followed by the OpenAI base URL and the model id (<code>agent/&lt;slug&gt;</code>);
        </li>
        <li>
          prints <code>Latency</code>: the platform&apos;s <Link href="/docs/api#measured-latency">response time</Link>,
          read from <code>GET /api/public/stats</code>, for example <code>612 ms p50 (platform-wide, last 24 h)</code>. It is
          the platform&apos;s figure, not this agent&apos;s, which has answered nothing yet. A number appears only when the
          API measured one: below the publication thresholds the line reads <code>measuring (12 of 50 requests)</code>, and
          when the figure cannot be read it reads <code>live figure unavailable</code>. This step never fails the deploy;
        </li>
        <li>
          with <code>--publish</code>, lists the agent on the marketplace.
        </li>
      </ol>
      <Callout variant="warning" title="A deployment that exists keeps running">
        <p>
          Once the deployment is created it keeps running and its credits stay reserved, whatever happens to the command.
          Every later error, including a timeout, names the deployment id, and <code>--json</code> still prints a document with{" "}
          <code>deployment.id</code>. To keep waiting, use{" "}
          <code>wheelsai deploy --agent my-support-bot --resume &lt;deployment-id&gt;</code>, which starts nothing new. Running{" "}
          <code>deploy</code> again without <code>--resume</code> starts a second, separately billed deployment.
        </p>
      </Callout>

      <h3 id="cli-publish">wheelsai publish</h3>
      <CodeBlock
        language="bash"
        code={`wheelsai publish --agent my-support-bot                          # free listing
wheelsai publish --agent my-support-bot --price-per-request 5    # cents per use, at least 5
wheelsai publish --agent my-support-bot --monthly 900            # cents per month
wheelsai publish --agent my-support-bot --copies --price-per-request 1   # sell copies instead of use
wheelsai publish --agent my-support-bot --title "Support Pro" --category customer-support`}
      />
      <p>
        Creates and publishes the agent&apos;s marketplace listing and prints its URL. An agent has one listing, so running it
        again reuses it and changes only what you pass. A new listing sells use of the agent, so buyers use it on its page and never get a copy; it is free unless you choose a price, and a price per use is at least 5 cents. <code>--copies</code> sells copies instead, which buyers install with the agent&apos;s instructions.{" "}
        <code>deploy --publish</code> does the same after the deployment is running, and checks the price, title, description
        and category against the API&apos;s limits before any GPU is requested. A <code>--tokenized</code> listing needs{" "}
        <code>--copies</code>, and is gated only once a token has been launched for it; until then it installs free.
      </p>

      <h3 id="cli-test">wheelsai test</h3>
      <CodeBlock
        language="bash"
        code={`wheelsai test my-support-bot -m "Summarise what you can do" --model free/groq/llama-3.3-70b`}
      />
      <p>
        Sends one playground message (no GPU deployment needed) and prints the reply, the model and token usage. Without{" "}
        <code>-m</code> it asks the agent to introduce itself. If the agent is an installed marketplace listing priced per
        request, the message is charged and the charge the API reports is printed. <code>--timeout</code> (default 120 seconds)
        sets how long to wait for the reply.
      </p>

      <h3 id="cli-inspect">wheelsai agents, logs, whoami, config</h3>
      <CodeBlock
        language="bash"
        code={`wheelsai agents list                  # slug, name, latest deployment status, kind
wheelsai agents get my-support-bot    # kind, configuration, secret names, every deployment
wheelsai agents run code-review --input '{"code_to_review": "def f(): ..."}'   # a task agent, one result
wheelsai logs <deployment-id>         # an agent deployment: status and the logs the API has
wheelsai logs <deployment-id> --model # a model deployment and its lifecycle events
wheelsai whoami                       # who the credentials belong to
wheelsai config show                  # effective API URL, web URL and where each comes from`}
      />
      <p>
        <code>agents list</code> and <code>agents get</code> say how each agent is used: <code>Chat</code>,{" "}
        <code>Task</code> or <code>Runs on its own</code>. <code>agents get</code> also lists the questions of a task
        agent&apos;s form.
      </p>
      <p>
        <code>agents run &lt;agent&gt;</code> runs a task agent on one filled-in form and prints its result. Pass the answers
        as one JSON object with <code>--input</code>, or pipe them in with <code>--input-stdin</code>; <code>--timeout</code>{" "}
        (default 150 seconds) sets how long to wait. Each answer that does not fit the form is printed as{" "}
        <code>&lt;question&gt;: &lt;what to do&gt;</code>, and a per-request marketplace charge is shown.
      </p>
      <p>
        <code>logs</code> accepts the id that <code>wheelsai deploy</code> prints; <code>--agent &lt;slug-or-id&gt;</code> skips
        the search for the agent that owns it. An endpoint is shown as an address only while its deployment is running. Text
        from the API is printed with control characters removed; <code>--json</code> output is exact.
      </p>

      <h3 id="cli-errors">Exit codes and errors</h3>
      <p>
        <code>0</code> on success, <code>1</code> on any failure, <code>130</code> when interrupted. A failure prints the
        API&apos;s own message, then its HTTP status and error code, then what to do next:
      </p>
      <CodeBlock
        language="text"
        code={`✖ Deploying requires a reservation of $0.37 in credits. Add credits and retry.
  HTTP 402 insufficient_credits
  Add credits at https://your-app.example.com/dashboard/billing`}
      />
    </DocPage>
  );
}
