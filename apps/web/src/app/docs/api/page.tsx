import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Fields } from "@/components/marketing/docs/endpoint";
import { Callout, DocTable } from "@/components/marketing/prose";
import { API_BASE_URL } from "@/lib/api";

export const metadata: Metadata = {
  title: "API reference",
  description:
    "WheelsAI API overview: base URL, API keys and sessions, wallet sign-in, errors, plan limits and rate limits, and an index of every endpoint group.",
};

const toc = [
  { id: "base-url", title: "Base URL" },
  { id: "authentication", title: "Authentication" },
  { id: "api-keys", title: "API keys", sub: true },
  { id: "sessions", title: "Sessions and tokens", sub: true },
  { id: "auth-endpoints", title: "Auth endpoints", sub: true },
  { id: "errors", title: "Errors" },
  { id: "rate-limits", title: "Rate limits" },
  { id: "index", title: "Endpoint index" },
  { id: "measured-latency", title: "Response times" },
];

export default function ApiOverviewPage() {
  return (
    <DocPage
      href="/docs/api"
      title="API reference"
      lead="WheelsAI exposes a JSON REST API under /api and an OpenAI-compatible inference API under /v1. Everything the dashboard does goes through this API."
      toc={toc}
    >
      <h2 id="base-url">Base URL</h2>
      <p>
        All paths in this reference are relative to the API origin, <code>{API_BASE_URL}</code> for this site. An interactive
        OpenAPI explorer is served at <a href={`${API_BASE_URL}/docs`}>{API_BASE_URL}/docs</a>.
      </p>
      <CodeBlock language="bash" code={`curl -s "$WHEELSAI_API_URL/api/models?tier=free"`} />

      <h2 id="authentication">Authentication</h2>
      <p>
        Most endpoints need a caller. There are two kinds: an <strong>API key</strong>, which belongs to an organization, and a{" "}
        <strong>user session</strong>, which belongs to a person acting inside one organization. Public endpoints (the model
        catalog, marketplace browsing, templates, public agent pages and status) need neither.
      </p>

      <h3 id="api-keys">API keys</h3>
      <p>
        Create keys in the dashboard at <Link href="/dashboard/keys">API Keys</Link>. A key looks like{" "}
        <code>wheels_live_</code> followed by 32 characters and is shown exactly once; WheelsAI stores only a keyed hash of it.
        Send it as a bearer token:
      </p>
      <CodeBlock
        language="bash"
        code={`curl -s "$WHEELSAI_API_URL/api/agents" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY"`}
      />
      <ul>
        <li>
          A key acts on behalf of its organization with access to all of that organization&apos;s resources. Treat it like a
          password, keep it server-side, and revoke it if it leaks.
        </li>
        <li>
          Requests made with a key count toward the plan&apos;s monthly API calls, except reads: <code>GET</code>,{" "}
          <code>HEAD</code> and <code>OPTIONS</code> are free, <code>/v1/models</code> included. A <code>/v1</code> chat
          completion counts once, with a key or a session. See{" "}
          <Link href="/docs/guides/plans-and-billing#api-calls">what counts as an API call</Link>.
        </li>
        <li>
          A key can be limited with scopes. Anything that spends your credits (hiring an offering, accepting or rejecting a
          job, installing a listing) needs its scope granted by name: a key with no scopes, or with <code>*</code>, cannot
          spend. See <Link href="/docs/api/jobs#keys">API keys that can spend</Link>.
        </li>
        <li>
          Some actions need a person, not a key: managing API keys, two-factor settings, switching organizations, buying credits
          or a plan, and requesting marketplace payouts. Those endpoints answer <code>401</code> to a key.
        </li>
      </ul>

      <h3 id="sessions">Sessions and tokens</h3>
      <p>
        Signing in (email and password, or a Solana wallet) sets an httpOnly, signed session cookie named{" "}
        <code>wheelsai_token</code> that lasts 24 hours, and also returns the same session as a <code>token</code> in the
        response body. Browser code relies on the cookie. Server-side scripts that sign in with a password can send the token as{" "}
        <code>Authorization: Bearer &lt;token&gt;</code> until it expires. <code>POST /api/auth/logout</code> clears the cookie
        and revokes the token.
      </p>
      <p>
        Wallet sign-in is two calls. First request a message for your address, then sign that exact message with the wallet and
        send the base58 signature back with the message. A message is valid for 5 minutes and can be used once.
      </p>
      <CodeBlock
        language="bash"
        code={`# 1. Get the Sign-In With Solana message to sign
curl -s -X POST "$WHEELSAI_API_URL/api/auth/wallet/nonce" \\
  -H "Content-Type: application/json" \\
  -d '{"walletAddress":"<your base58 address>"}'
# -> { "nonce": "<host> wants you to sign in with your Solana account: ...", "walletAddress": "..." }

# 2. Sign the nonce text with the wallet, then:
curl -s -X POST "$WHEELSAI_API_URL/api/auth/wallet/verify" \\
  -H "Content-Type: application/json" \\
  -d '{"walletAddress":"...","nonce":"<the exact message>","signature":"<base58 signature>"}'`}
      />
      <p>
        If the account has two-factor authentication on, password and wallet sign-in answer{" "}
        <code>&#123; &quot;requires2FA&quot;: true, &quot;challengeToken&quot;: &quot;...&quot; &#125;</code> instead of a
        session. Finish with <code>POST /api/auth/login/2fa</code> and the code from your authenticator app.
      </p>

      <h3 id="auth-endpoints">Auth endpoints</h3>
      <DocTable
        caption="Authentication endpoints"
        columns={[
          { key: "ep", label: "Endpoint" },
          { key: "what", label: "What it does" },
        ]}
        rows={[
          { ep: <code>POST /api/auth/register</code>, what: <>Body <code>email</code>, <code>password</code> (8+ characters). Creates the user and an organization they own, signs in, and sends the verification email.</> },
          { ep: <code>POST /api/auth/login</code>, what: <>Body <code>email</code>, <code>password</code>. Signs in, or starts a 2FA challenge.</> },
          { ep: <code>POST /api/auth/login/2fa</code>, what: <>Body <code>challengeToken</code>, <code>token</code>. Completes a 2FA sign-in.</> },
          { ep: <code>POST /api/auth/wallet/nonce</code>, what: <>Body <code>walletAddress</code>. Returns the message to sign.</> },
          { ep: <code>POST /api/auth/wallet/verify</code>, what: <>Body <code>walletAddress</code>, <code>nonce</code>, <code>signature</code>. Signs in with a wallet, creating the account on first use.</> },
          { ep: <code>POST /api/auth/email/verify/confirm</code>, what: <>Body <code>token</code> from the email link. Verifies the address; returns <code>bonusGrantedCents</code>.</> },
          { ep: <code>POST /api/auth/email/verify/request</code>, what: "Session only. Re-sends the verification email." },
          { ep: <code>POST /api/auth/password/forgot</code>, what: <>Body <code>email</code>. Always answers <code>202</code>, whether or not the account exists.</> },
          { ep: <code>POST /api/auth/password/reset</code>, what: <>Body <code>token</code>, <code>password</code>. Sets a new password.</> },
          { ep: <code>GET /api/auth/me</code>, what: <>The caller: user id, email, wallet, <code>emailVerified</code>, organization id and <code>authType</code> (<code>jwt</code> or <code>api_key</code>).</> },
          { ep: <code>GET /api/auth/orgs</code>, what: "Session only. Organizations you belong to, with your role in each." },
          { ep: <code>POST /api/auth/switch-org</code>, what: <>Session only. Body <code>orgId</code>. Re-issues the session inside another organization you belong to.</> },
          { ep: <code>POST /api/auth/refresh</code>, what: "Session only. Issues a fresh 24-hour session." },
          { ep: <code>POST /api/auth/logout</code>, what: "Clears the cookie and revokes the current token." },
          { ep: <code>GET /api/auth/keys</code>, what: "Session only. Lists API keys (prefix, name, last used, expiry; never the key)." },
          { ep: <code>POST /api/auth/keys</code>, what: <>Session only. Body <code>name</code> (optional). Returns the new <code>key</code> once.</> },
          { ep: <code>DELETE /api/auth/keys/&#123;keyId&#125;</code>, what: "Session only. Revokes a key immediately." },
        ]}
      />

      <h2 id="errors">Errors</h2>
      <p>
        Errors are JSON with an HTTP status that means what it says. The body always has <code>error</code> and usually a
        human-readable <code>message</code>; some carry extra fields you can act on.
      </p>
      <DocTable
        caption="Error statuses"
        columns={[
          { key: "status", label: "Status" },
          { key: "meaning", label: "Meaning" },
        ]}
        rows={[
          { status: <code>400</code>, meaning: <>Invalid input. Body validation failures return <code>&#123; &quot;error&quot;: &quot;validation_failed&quot;, &quot;message&quot;: &quot;...&quot;, &quot;fields&quot;: &#123;...&#125;, &quot;details&quot;: &#123; &quot;formErrors&quot;: [], &quot;fieldErrors&quot;: &#123;...&#125; &#125; &#125;</code>: <code>message</code> is the first problem as a sentence, and <code>fields</code> has one sentence per field, keyed by its path in the request.</> },
          { status: <code>401</code>, meaning: "No valid API key or session, or the endpoint needs a person and got a key." },
          { status: <code>402</code>, meaning: <>Not enough credits (with the amount required), or an x402 payment is required. See <Link href="/docs/api/inference#errors">chat completions</Link>.</> },
          { status: <code>403</code>, meaning: <>Not allowed: a role check (<code>insufficient_role</code>), a plan feature (<code>plan_limit_reached</code>), or a revoked marketplace licence.</> },
          { status: <code>404</code>, meaning: "Not found, or not yours. Resources in other organizations are reported as not found." },
          { status: <code>409</code>, meaning: "Conflict, for example a replayed payment or a payout already in progress." },
          { status: <code>429</code>, meaning: <>Too many requests: rate limits, the monthly API call quota (<code>plan_limit_reached</code>), the free-model limits, or the active deployment quota.</> },
          { status: <code>501</code>, meaning: "The feature is temporarily unavailable (for example card payments or email). The error code and message say which, and nothing is charged." },
          { status: <code>502</code>, meaning: "An upstream (a model provider, a GPU node, Nosana) failed. Any credits held for the request are released." },
          { status: <code>503</code>, meaning: "No healthy node is available for a deployment right now." },
        ]}
      />
      <p>
        Plan limits always look like this, so clients can show an upgrade path. <code>limit</code> names what was hit (
        <code>maxAgents</code>, <code>monthlyApiCalls</code> or a feature such as <code>customDomains</code>):
      </p>
      <CodeBlock
        language="json"
        code={`{
  "error": "plan_limit_reached",
  "message": "The Starter plan includes up to 3 agents. Upgrade to Pro for unlimited agents.",
  "plan": "starter",
  "limit": "maxAgents",
  "upgradeUrl": "/dashboard/billing?upgrade=pro"
}`}
      />
      <p>
        Internal failures answer <code>500</code> with a generic message. Error bodies are scrubbed before they are sent, so they
        never contain stack traces, file paths or query details.
      </p>

      <h2 id="rate-limits">Rate limits</h2>
      <ul>
        <li>
          <strong>Per IP:</strong> 100 requests per minute across the whole API. Responses carry{" "}
          <code>x-ratelimit-limit</code>, <code>x-ratelimit-remaining</code> and <code>x-ratelimit-reset</code>; a{" "}
          <code>429</code> also carries <code>retry-after</code>.
        </li>
        <li>
          <strong>Sign-in and account endpoints</strong> are tighter: register, login and 2FA 5 per minute; wallet nonce and
          verify 10 per minute; password reset request 5 per minute; resend verification 3 per minute. Separately, an account is
          locked for 15 minutes after 10 failed logins, and a 2FA challenge allows 5 wrong codes.
        </li>
        <li>
          <strong>Free models</strong> are limited per organization per minute and per day (see{" "}
          <Link href="/docs/guides/plans-and-billing#plans">plans</Link>). The playground returns{" "}
          <code>X-RateLimit-Remaining-RPM</code>, <code>X-RateLimit-Remaining-RPD</code> and their reset times.
        </li>
        <li>
          <strong>Monthly API calls</strong> per plan, and <strong>active deployments</strong> per organization.
        </li>
      </ul>
      <Callout>
        <p>
          Back off on <code>429</code> and honour <code>retry-after</code>. A <code>429</code> with{" "}
          <code>plan_limit_reached</code> will not clear until the next month or an upgrade.
        </p>
      </Callout>

      <h2 id="index">Endpoint index</h2>
      <DocTable
        caption="Documented endpoint groups"
        columns={[
          { key: "group", label: "Group" },
          { key: "prefix", label: "Prefix" },
        ]}
        rows={[
          { group: <Link href="/docs/api/inference">Chat completions (OpenAI-compatible)</Link>, prefix: <code>/v1</code> },
          { group: <Link href="/docs/api/agents">Agents, GitHub import, playground and the agent API</Link>, prefix: <><code>/api/agents</code>, <code>/v1/agents</code></> },
          { group: <Link href="/docs/api/deployments">Models and deployments</Link>, prefix: <><code>/api/models</code>, <code>/api/deployments</code></> },
          { group: <Link href="/docs/api/training">Fine-tuning: datasets, training jobs and fine-tuned models</Link>, prefix: <code>/api/training</code> },
          { group: <Link href="/docs/api/marketplace">Marketplace</Link>, prefix: <code>/api/marketplace</code> },
          { group: <Link href="/docs/api/jobs">Offerings and jobs</Link>, prefix: <><code>/api/offerings</code>, <code>/api/jobs</code></> },
          { group: <Link href="/docs/api/billing">Billing and plans</Link>, prefix: <code>/api/billing</code> },
          { group: <Link href="/docs/api/workflows">Workflows and scheduler</Link>, prefix: <><code>/api/orchestrations</code>, <code>/api/scheduler</code>, <code>/v1/workflows</code></> },
          { group: <Link href="/docs/api/webhooks">Webhooks</Link>, prefix: <code>/api/webhooks</code> },
          { group: <Link href="/docs/guides/templates#api">Templates</Link>, prefix: <code>/api/templates</code> },
          { group: <Link href="/docs/guides/web-chat-widget#api">Web chat widget and Try it</Link>, prefix: <><code>/api/channels/web</code>, <code>/api/widget</code>, <code>/api/marketplace/listings/:slug/try</code></> },
          { group: <Link href="/status">Platform status</Link>, prefix: <code>/api/status</code> },
          { group: <a href="#measured-latency">Platform facts and response times</a>, prefix: <code>/api/public/stats</code> },
        ]}
      />
      <p>
        Other groups used by the dashboard are available in the OpenAPI explorer and follow the same authentication and error
        rules: knowledge bases (<code>/api/knowledge</code>), agent memory (<code>/api/memory</code>), monitoring and alerts (
        <code>/api/monitoring</code>), agent versions (<code>/api/versioning</code>), analytics (<code>/api/analytics</code>),
        <Link href="/docs/guides/custom-domains#api">custom domains</Link> (<code>/api/domains</code>), integrations, agent tokens (
        <code>/api/tokens</code>), reputation (<code>/api/reputation</code>), two-factor authentication (<code>/api/2fa</code>)
        and settings (<code>/api/settings</code>).
      </p>
      <Fields
        title="Public endpoints (no authentication)"
        fields={[
          { name: "GET /api/models", type: "catalog", description: "Deployable and free models, and GPU tiers with prices." },
          { name: "GET /api/marketplace/listings", type: "catalog", description: "Published listings, with search and filters." },
          { name: "GET /api/templates", type: "catalog", description: "Published agent templates." },
          { name: "GET /api/a/{slug}", type: "receipts", description: "A public agent's transparency feed: treasury, compute paid, recent payment signatures." },
          { name: "GET /api/status", type: "health", description: "Live platform status (the data behind /status), including response times with their distribution and error share." },
          { name: "GET /api/public/stats", type: "facts", description: "Platform facts (frameworks, models, pricing models, chat channels) and response times. Always 200; cacheable for 5 minutes." },
        ]}
      />

      <h2 id="measured-latency">Response times</h2>
      <p>
        Every response time WheelsAI shows, on the landing page, on <Link href="/status#latency">/status</Link>, in the CLI
        and in your dashboards, is computed from one record per served chat request. When there are too few records to
        state a figure, the field is <code>null</code> and the page shows no number.
      </p>
      <CodeBlock
        language="bash"
        code={`curl -s "$WHEELSAI_API_URL/api/public/stats"`}
      />
      <CodeBlock
        language="json"
        code={`{
  "frameworks": 6, "models": 21, "pricingModels": 4, "channels": 3,
  "latency": {
    "status": "insufficient_data",
    "metric": "response_time",
    "definition": "Time the WheelsAI API took to produce the complete answer to a chat request, successful answers only; network time between the caller and the API is not included. Each organization counts for a bounded number of its most recent answers.",
    "windowHours": 24,
    "sampleCount": 12, "minSampleCount": 50, "minOrgCount": 3, "maxSamplesPerOrg": 17,
    "p50Ms": null, "p95Ms": null,
    "firstTokenP50Ms": null, "firstTokenSampleCount": 0,
    "computedAt": "2026-10-07T12:00:00.000Z"
  }
}`}
      />
      <Fields
        title="latency"
        fields={[
          {
            name: "status",
            type: "string",
            description: (
              <>
                <code>measured</code>: enough answered requests from enough organizations fall inside the window, and{" "}
                <code>p50Ms</code> and <code>p95Ms</code> are stated. <code>insufficient_data</code>: the measurements were
                read but are below a publication threshold; no latency is stated. <code>unavailable</code>: the measurements
                could not be read; every number is <code>null</code>.
              </>
            ),
          },
          {
            name: "p50Ms, p95Ms",
            type: "integer | null",
            description: (
              <>
                Milliseconds, non-null only when <code>status</code> is <code>measured</code>. Each is the time of a request
                that was actually served (<code>percentile_disc</code>), not an interpolation and not an average of averages.
              </>
            ),
          },
          {
            name: "sampleCount",
            type: "integer | null",
            description: (
              <>
                Answered requests in the window that count toward the figure: at most <code>maxSamplesPerOrg</code> from
                any one organization. <code>null</code> only when unavailable. If it reaches <code>minSampleCount</code>{" "}
                while the status is still <code>insufficient_data</code>, the requests come from fewer than{" "}
                <code>minOrgCount</code> organizations.
              </>
            ),
          },
          {
            name: "minSampleCount, minOrgCount, windowHours",
            type: "integer",
            description:
              "The publication rule: a figure is stated only above this many counted requests from this many organizations inside the rolling window.",
          },
          {
            name: "maxSamplesPerOrg",
            type: "integer",
            description:
              "How many of one organization's most recent requests count toward the figure, the distribution and the error share: an equal share of minSampleCount (minSampleCount / minOrgCount, rounded up). Sending more requests than this adds nothing, so one customer's timings are never published as the platform's.",
          },
          {
            name: "firstTokenP50Ms",
            type: "integer | null",
            description:
              "Median time to the first content of a streamed answer, held to the same thresholds on its own samples. Null without enough of them.",
          },
          { name: "computedAt", type: "string | null", description: "When the measurements were read. The figure is recomputed at most once a minute." },
        ]}
      />
      <ul>
        <li>
          <strong>What is timed.</strong> The time the API took to produce the complete answer to a chat request: agent chats
          and model deployments, called through <code>/v1</code>, the playground and the dashboard. The clock runs at the API,
          so the network between you and the API is not in it; your own measurement from a client will be higher.
        </li>
        <li>
          <strong>What counts.</strong> The headline counts successfully answered requests only. Requests that failed or
          timed out are reported next to it on <Link href="/status#latency">/status</Link> as a share of all recorded
          requests, with the distribution of response times. Scheduled runs, workflow steps and test runs are measured but
          are not part of the public figure. Each organization counts for its <code>maxSamplesPerOrg</code> most recent
          requests at most, so the figure describes the platform across its customers rather than its busiest one.
        </li>
        <li>
          <strong>Your own numbers.</strong> <Link href="/docs/api/deployments">Deployment metrics</Link> and{" "}
          <Link href="/docs/api/agents">agent usage</Link> return <code>avgLatencyMs</code>, <code>p50LatencyMs</code> and{" "}
          <code>p95LatencyMs</code> for your organization from the same records, and alert rules on{" "}
          <code>latency_p95</code> and <code>latency_avg</code> are evaluated against them, with the threshold in
          milliseconds.
        </li>
        <li>
          <strong>Retention.</strong> A timing record holds the organization, the agent or deployment, the model, the outcome
          and the times. It holds no message content. Records are deleted after a fixed retention period; see the{" "}
          <Link href="/privacy">privacy policy</Link>.
        </li>
      </ul>
    </DocPage>
  );
}
