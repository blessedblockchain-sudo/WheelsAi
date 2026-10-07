import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Callout, DocTable } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Custom domains",
  description:
    "Serve a WheelsAI agent or model deployment on your own hostname over HTTPS: the TXT record that proves ownership, the CNAME or A/AAAA records that route the domain, how certificates are issued and checked, what a custom domain answers, and what is not supported.",
};

const toc = [
  { id: "what", title: "What a custom domain is" },
  { id: "requirements", title: "Before you start" },
  { id: "add", title: "1. Add the domain" },
  { id: "ownership", title: "2. Prove ownership (TXT)" },
  { id: "routing", title: "3. Point the domain (CNAME or A/AAAA)" },
  { id: "certificate", title: "4. The certificate" },
  { id: "use", title: "Use the domain" },
  { id: "states", title: "States and what changes them" },
  { id: "limits", title: "What is not supported" },
  { id: "api", title: "API" },
];

export default function CustomDomainsGuidePage() {
  return (
    <DocPage
      href="/docs/guides/custom-domains"
      title="Custom domains"
      lead="Put one agent or one model deployment on a hostname you own. The domain becomes an OpenAI-compatible base URL, served over HTTPS with a certificate issued for it automatically."
      toc={toc}
    >
      <h2 id="what">What a custom domain is</h2>
      <p>
        A custom domain such as <code>api.example.com</code> is bound to exactly one target: an agent or a model
        deployment in your organization. Once it is serving, <code>https://api.example.com/v1</code> is a base URL for an
        OpenAI client, and it answers for that target only. Nothing else in the WheelsAI API is reachable through your
        hostname.
      </p>
      <p>Three things have to be true, and each is observed, never assumed:</p>
      <ol>
        <li>
          <strong>Ownership</strong>: a TXT record with your verification token is found in DNS.
        </li>
        <li>
          <strong>Routing</strong>: every address the domain resolves to is the WheelsAI edge.
        </li>
        <li>
          <strong>Certificate</strong>: a TLS handshake with the edge presents a certificate for the domain that a browser
          would accept.
        </li>
      </ol>
      <p>
        The dashboard shows each of the three with what was last observed and when. A domain serves only while all three
        hold, it is switched on, your plan includes custom domains, and its target still exists.
      </p>

      <h2 id="requirements">Before you start</h2>
      <ul>
        <li>
          <strong>A plan that includes custom domains.</strong> They are part of Pro and Enterprise; Starter does not
          include them. The plan either includes custom domains or it does not: there is no per-plan count. See{" "}
          <Link href="/docs/guides/plans-and-billing">Plans and billing</Link>.
        </li>
        <li>
          <strong>Owner or admin role</strong> in the organization, to add, check, switch or delete a domain. Every member
          can view them.
        </li>
        <li>
          <strong>Access to the domain&apos;s DNS</strong>, and DNS records that are served directly (not through a CDN
          proxy).
        </li>
        <li>
          <strong>A server with the edge configured.</strong> The page <Link href="/dashboard/domains">Domains</Link> says
          so at the top when it is not, and the API answers <code>501 custom_domains_not_configured</code> with the
          reason. Until then no domain can be added and none is served.
        </li>
      </ul>

      <h2 id="add">1. Add the domain</h2>
      <p>
        In the dashboard open <Link href="/dashboard/domains">Domains</Link>, choose <strong>Add domain</strong>, enter the
        hostname and pick the agent or deployment it serves. The detail page that opens lists the exact records to
        publish. With the API:
      </p>
      <CodeBlock
        language="bash"
        code={`curl -s -X POST "$WHEELSAI_API_URL/api/domains" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"domain": "api.example.com", "targetType": "agent", "targetId": "<agent id>"}' | jq '.data.dnsRecords'`}
      />
      <p>
        The name is lowercased, a trailing dot is removed and an internationalized name is stored in its ASCII
        (punycode) form. WheelsAI&apos;s own hostnames, IP addresses, single-label names and wildcards are refused.
      </p>

      <h2 id="ownership">2. Prove ownership (TXT)</h2>
      <p>
        Publish one TXT record. Its name is <code>_wheels-verification.</code> followed by your domain, and its value is
        the token shown for the domain:
      </p>
      <DocTable
        caption="The ownership record"
        columns={[
          { key: "type", label: "Type" },
          { key: "name", label: "Name" },
          { key: "value", label: "Value" },
        ]}
        rows={[
          {
            type: "TXT",
            name: <code>_wheels-verification.api.example.com</code>,
            value: <code>wheels-verify-…</code>,
          },
        ]}
      />
      <p>
        Then choose <strong>Check now</strong>. You do not have to: a new domain is also checked on its own, a couple of
        minutes after it is added and regularly after that.
      </p>
      <ul>
        <li>
          <strong>Keep the record.</strong> It is looked up again on every check. If it disappears, the domain keeps
          serving for 72 hours, and the dashboard says when it will stop. Put the record back within that time and
          nothing changes.
        </li>
        <li>
          <strong>A domain that never verifies expires 14 days after it was added.</strong> Generate a new token to start
          again.
        </li>
        <li>
          <strong>A DNS outage is not a failure.</strong> If the resolver cannot be reached, the check answers{" "}
          <code>503 dns_unavailable</code> and leaves the domain as it was. Your token is never changed behind your back.
        </li>
        <li>
          <strong>One organization per name.</strong> Any organization may add a name, but only one can verify it. A name
          already verified elsewhere answers <code>409 domain_claimed</code>.
        </li>
      </ul>
      <Callout variant="warning" title="Generating a new token stops the domain">
        <strong>Generate new token</strong> replaces the token at once. The old TXT record stops counting, the
        verification is released and the domain stops serving until the new record is published and found.
      </Callout>

      <h2 id="routing">3. Point the domain (CNAME or A/AAAA)</h2>
      <p>The domain&apos;s detail page shows the record that fits the name, with the real values for this server:</p>
      <DocTable
        caption="Routing records"
        columns={[
          { key: "kind", label: "Your domain is" },
          { key: "publish", label: "Publish" },
        ]}
        rows={[
          {
            kind: <>A subdomain, such as <code>api.example.com</code></>,
            publish: <>One <code>CNAME</code> record pointing at the edge hostname shown in the dashboard.</>,
          },
          {
            kind: <>A root (apex) domain, such as <code>example.com</code></>,
            publish: (
              <>
                DNS does not allow a CNAME at the root of a zone. Publish every <code>A</code> and <code>AAAA</code> record
                shown, and no others.
              </>
            ),
          },
        ]}
      />
      <p>
        The domain counts as routed only when <em>every</em> address it resolves to is an address of the edge. One extra
        A record, or an AAAA record left over from a previous host, reads as &quot;DNS points elsewhere&quot;, and the
        dashboard lists the addresses that were found. A domain that is already serving is not paused by a single bad
        answer; it is looked up again two minutes later first.
      </p>

      <h2 id="certificate">4. The certificate</h2>
      <p>
        You do nothing here. Once ownership is verified and DNS points at the edge, the edge requests a certificate for
        the domain from a public certificate authority the first time an HTTPS connection for it arrives, and renews it
        before it expires. Before requesting one, the edge asks the API whether the hostname is a verified, switched-on,
        correctly routed domain on a plan that includes custom domains. Any other hostname gets no certificate.
      </p>
      <p>
        WheelsAI then makes its own TLS connection to the edge for your domain and records what it saw: the issuer, the
        validity dates and the SHA-256 fingerprint. <strong>The certificate is shown as valid only after that handshake
        succeeded</strong> with the checks a browser makes. The first check follows a few minutes after DNS is confirmed;{" "}
        <strong>Re-check certificate</strong> makes one on request (at most every 15 minutes while no certificate has
        been observed, so the certificate authority&apos;s limits on failed attempts are respected).
      </p>
      <ul>
        <li>
          If your zone has <code>CAA</code> records, they must allow the certificate authority the edge uses, or no
          certificate can be issued. When a CAA record forbids it, the certificate's last error on the detail page says so.
        </li>
        <li>HTTPS is always enforced. A plain-HTTP request to a serving domain is redirected with a 308.</li>
        <li>
          The domain is served with <code>Strict-Transport-Security</code> for that hostname only, never for its
          subdomains.
        </li>
      </ul>

      <h2 id="use">Use the domain</h2>
      <p>A serving domain answers two endpoints, for both kinds of target:</p>
      <DocTable
        caption="What a custom domain answers"
        columns={[
          { key: "endpoint", label: "Endpoint" },
          { key: "what", label: "Answers" },
        ]}
        rows={[
          {
            endpoint: <code>POST https://api.example.com/v1/chat/completions</code>,
            what: (
              <>
                The target&apos;s chat completions, exactly as <Link href="/docs/api/inference">on the platform URL</Link>{" "}
                (streaming included). <code>model</code> is accepted and not used for routing: the domain selects the
                target.
              </>
            ),
          },
          {
            endpoint: <code>GET https://api.example.com/v1/models</code>,
            what: "The one model the domain serves.",
          },
        ]}
      />
      <CodeBlock
        language="ts"
        code={`import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://api.example.com/v1",
  apiKey: process.env.WHEELSAI_API_KEY,
});

const reply = await client.chat.completions.create({
  model: "default", // not used for routing on a custom domain
  messages: [{ role: "user", content: "Hello" }],
});`}
      />
      <ul>
        <li>
          Authenticate with an API key of the organization that owns the domain. A key of any other organization is
          refused with <code>403 wrong_organization</code>; no key at all is a <code>401</code>.
        </li>
        <li>Requests are metered and billed exactly as on the platform URL. The domain adds no charge per request.</li>
        <li>
          Any other path answers <code>404 not_found</code>. A domain that is not serving answers{" "}
          <code>404 custom_domain_not_active</code>.
        </li>
        <li>
          You can set up to 20 response headers per domain (<code>PATCH /api/domains/{"{id}"}</code>,{" "}
          <code>headers</code>). Headers that would change how the response is delivered or secured, such as{" "}
          <code>set-cookie</code>, <code>location</code> and <code>strict-transport-security</code>, are refused.
        </li>
        <li>
          When a target has more than one serving domain, mark one <strong>primary</strong>: it is the{" "}
          <code>customEndpoint</code> a deployment reports.
        </li>
      </ul>

      <h2 id="states">States and what changes them</h2>
      <DocTable
        caption="When a domain stops serving"
        columns={[
          { key: "what", label: "What happened" },
          { key: "effect", label: "What the domain does" },
        ]}
        rows={[
          { what: "You switch it off", effect: "Stops serving at once. DNS and the verification are kept." },
          { what: "The TXT record disappears", effect: "Keeps serving for 72 hours, then stops and the verification is released." },
          { what: "DNS points somewhere else on two checks in a row", effect: "Stops serving until DNS points only at the edge again." },
          { what: "The edge stops presenting a valid certificate on three checks in a row", effect: "Stops serving until a valid certificate is observed again." },
          { what: "The edge cannot be reached at all", effect: "Nothing changes: an outage is not evidence about your domain." },
          { what: "Your plan no longer includes custom domains", effect: "Paused. It resumes by itself when the plan does." },
          { what: "The agent or deployment is deleted", effect: "Paused, and the domain says its target is missing." },
        ]}
      />
      <p>
        Every change is written to the domain&apos;s history with the time and the reason, and the detail page shows the
        last time each of the three checks was made.
      </p>

      <h2 id="limits">What is not supported</h2>
      <ul>
        <li>
          <strong>CDN-proxied records.</strong> A record proxied by a CDN (for example Cloudflare&apos;s proxied mode)
          resolves to the CDN&apos;s addresses, so the routing check reads it as pointing elsewhere. Set the record to
          DNS only.
        </li>
        <li>
          <strong>Wildcard domains.</strong> Each hostname is added, verified and certified on its own.
        </li>
        <li>
          <strong>An unbounded number of domains.</strong> Every organization shares one checker and one account with
          the certificate authority, so a server allows each organization a fixed number of domains (25 unless the
          operator changed it; <code>GET /api/domains/config</code> returns it as{" "}
          <code>limits.maxDomainsPerOrganization</code>). It is the same on every plan that includes custom domains,
          and every domain counts, whatever its state. New certificates are also paced: by default 30 per organization
          in any 3 hours, and 5 attempts per hostname per hour. A domain that is over the pace gets its certificate
          later; nothing needs to be done.
        </li>
        <li>
          <strong>Bringing your own certificate.</strong> Certificates are issued automatically.
        </li>
        <li>
          <strong>Serving over plain HTTP.</strong> HTTPS is always enforced.
        </li>
        <li>
          <strong>Calling the domain from a browser page.</strong> API keys belong on a server; the domain is not set up
          as a browser origin for your site.
        </li>
        <li>
          <strong>The dashboard or the rest of the API</strong> on your hostname. A custom domain serves the two endpoints
          above.
        </li>
      </ul>

      <h2 id="api">API</h2>
      <p>
        All under <code>/api/domains</code>, authenticated as described in{" "}
        <Link href="/docs/api">Overview and authentication</Link>. Writes need the owner or admin role.
      </p>
      <DocTable
        caption="Custom domain endpoints"
        columns={[
          { key: "endpoint", label: "Endpoint" },
          { key: "what", label: "Does" },
        ]}
        rows={[
          { endpoint: <code>GET /api/domains/config</code>, what: "Whether custom domains are configured on this server, the edge hostname and addresses, and whether your plan includes them." },
          { endpoint: <code>GET /api/domains</code>, what: <>Your domains, each with its DNS records and the observed <code>routing</code> and <code>certificate</code>.</> },
          { endpoint: <code>POST /api/domains</code>, what: <>Add a domain: <code>domain</code>, <code>targetType</code> (<code>agent</code> or <code>deployment</code>), <code>targetId</code>, optional <code>headers</code>.</> },
          { endpoint: <code>GET /api/domains/{"{id}"}</code>, what: "One domain." },
          { endpoint: <code>PATCH /api/domains/{"{id}"}</code>, what: <>Set <code>headers</code> or <code>isPrimary</code>.</> },
          { endpoint: <code>DELETE /api/domains/{"{id}"}</code>, what: "Delete it. Serving stops at once and the name is released." },
          { endpoint: <code>POST /api/domains/{"{id}"}/verify</code>, what: "Check now: look up the TXT record and the addresses and record what was found." },
          { endpoint: <code>POST /api/domains/{"{id}"}/reverify</code>, what: "Generate a new verification token." },
          { endpoint: <code>POST /api/domains/{"{id}"}/toggle</code>, what: <>Switch the domain on or off: <code>{`{ "isActive": true }`}</code>.</> },
          { endpoint: <code>GET /api/domains/{"{id}"}/ssl</code>, what: "The certificate as last observed." },
          { endpoint: <code>POST /api/domains/{"{id}"}/ssl/renew</code>, what: "Re-check the certificate with one TLS handshake." },
          { endpoint: <code>GET /api/domains/{"{id}"}/events</code>, what: "The domain's history." },
          { endpoint: <code>GET /api/domains/stats</code>, what: "Counts: total, verified, serving, pending, paused, certificates expiring within 14 days." },
        ]}
      />
      <DocTable
        caption="Errors specific to custom domains"
        columns={[
          { key: "status", label: "Status" },
          { key: "code", label: "error" },
          { key: "when", label: "When" },
        ]}
        rows={[
          { status: <code>400</code>, code: <><code>invalid_domain</code>, <code>reserved_domain</code>, <code>invalid_headers</code>, <code>target_not_found</code>, <code>https_required</code>, <code>not_verified</code>, <code>dns_not_routed</code></>, when: "The request cannot be done as asked; the message says why." },
          { status: <code>403</code>, code: <code>plan_limit_reached</code>, when: "Adding, checking, switching on or re-checking on a plan without custom domains." },
          { status: <code>403</code>, code: <code>domain_limit_reached</code>, when: <>The organization already has as many domains as the server allows (<code>limit</code> and <code>count</code> are in the body). Delete one to add another.</> },
          { status: <code>409</code>, code: <><code>domain_exists</code>, <code>domain_claimed</code>, <code>domain_changed</code></>, when: "Already added by you; verified by another organization; or changed while the request ran (try again)." },
          { status: <code>429</code>, code: <><code>checked_recently</code>, <code>reverified_recently</code></>, when: <>The certificate was checked, or a new verification token was generated (at most one per domain per 15 minutes), too recently; <code>Retry-After</code> says when to ask again.</> },
          { status: <code>501</code>, code: <code>custom_domains_not_configured</code>, when: "The server has no edge configured. Reads, switching off and deleting still work." },
          { status: <code>503</code>, code: <><code>dns_unavailable</code>, <code>plan_unavailable</code></>, when: "DNS or the plan could not be read just now. Nothing was changed; try again." },
        ]}
      />
    </DocPage>
  );
}
