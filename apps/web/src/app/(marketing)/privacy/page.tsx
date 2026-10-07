import type { Metadata } from "next";
import Link from "next/link";

import { LegalPage } from "@/components/marketing/legal-page";
import { DocTable, Founder } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "What WheelsAI collects, why, who processes it, what is public on Solana, the one cookie we set, and your choices. Draft pending legal review.",
};

const sections = [
  { id: "who", title: "Who we are" },
  { id: "collect", title: "What we collect" },
  { id: "use", title: "How we use it" },
  { id: "ai", title: "AI models and GPU hosts" },
  { id: "blockchain", title: "Solana: public and permanent" },
  { id: "public", title: "What is public on WheelsAI" },
  { id: "sharing", title: "Who we share it with" },
  { id: "cookies", title: "Cookies and local storage" },
  { id: "widget", title: "The chat widget and Try it" },
  { id: "security", title: "Security" },
  { id: "retention", title: "How long we keep it" },
  { id: "rights", title: "Your choices and rights" },
  { id: "transfers", title: "International transfers" },
  { id: "children", title: "Children" },
  { id: "changes", title: "Changes to this policy" },
  { id: "contact", title: "Contact" },
];

export default function PrivacyPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Privacy Policy"
      description="What we collect when you use WheelsAI, why we collect it, who else processes it, and what you can do about it."
      sections={sections}
    >
      <h2 id="who">1. Who we are</h2>
      <p>
        WheelsAI (&quot;WheelsAI&quot;, &quot;we&quot;, &quot;us&quot;) is operated by <Founder>legal entity name</Founder>,{" "}
        <Founder>registered address</Founder>. This policy covers the WheelsAI website, dashboard, API, marketplace, SDK and CLI
        (together, the &quot;Service&quot;). For the purposes of data protection law, we are the controller of the personal data
        described here, except where we process content on behalf of your organization, in which case we act on your
        organization&apos;s instructions.
      </p>

      <h2 id="collect">2. What we collect</h2>
      <h3>Account information</h3>
      <ul>
        <li>Your email address and a password, which we store only as an Argon2id hash.</li>
        <li>Your Solana wallet address, if you sign in with a wallet or link one.</li>
        <li>An optional display name, your two-factor authentication settings if you enable them, and your organizations, roles and team invitations (including the email address of anyone you invite).</li>
      </ul>
      <h3>Content you create</h3>
      <ul>
        <li>
          Agent configurations: names, descriptions, system prompts, tools, model settings, source code or repository URLs,
          workflows and graphs, knowledge-base documents and the embeddings we compute from them, agent memory, and datasets you
          upload for fine-tuning.
        </li>
        <li>
          Environment variables you attach to agents, such as provider API keys and bot tokens. These are encrypted at rest with
          AES-256-GCM; the API returns only their names and decrypts them only to call the provider they are for.
        </li>
        <li>Marketplace listings, reviews and publisher profiles.</li>
      </ul>
      <h3>Prompts and outputs</h3>
      <p>
        Messages you or your users send to agents and models, and the responses. Most chat requests are processed and not
        stored. Some features keep them so you can review them: visual-builder run traces, test runs, scheduled task and
        workflow results, agent memory, messages received through connected chat channels while they are being processed, and
        web chat widget conversations when the site&apos;s owner turned on saving (see{" "}
        <a href="#widget">the chat widget and Try it</a>).
      </p>
      <h3>Usage and billing records</h3>
      <ul>
        <li>
          Per-deployment usage (request counts, token counts, latency and GPU seconds, by hour), your monthly API call count, and
          free-model usage counts.
        </li>
        <li>
          A timing record for each chat request that reaches a model: the organization, the agent or deployment and the model
          it was for, how it ended, how long it took and how many tokens the answer had. It holds no message content. We use
          these records for your latency analytics and alerts, and to publish a platform-wide response-time figure that is
          computed across organizations and identifies none of them.{" "}
          <Founder>legal review: per-request timing records</Founder>
        </li>
        <li>
          Your credit ledger (every purchase, bonus, charge, hold, release and refund), subscriptions, marketplace installs,
          revenue, payouts and payout addresses.
        </li>
      </ul>
      <h3>Payment information</h3>
      <p>
        Card payments are processed by Stripe. We receive Stripe identifiers, amounts and payment status, and the email you
        check out with; we never receive or store your card number. For wallet top-ups and x402 payments we record the paying
        wallet address, amounts and transaction signatures.
      </p>
      <h3>Integrations</h3>
      <p>
        When you connect GitHub, Slack, Discord or Telegram, we store what is needed to act for you: a GitHub App installation
        id (access tokens are created on demand and not stored), and channel credentials such as bot tokens and signing
        secrets, which are encrypted at rest. Webhook URLs and their signing secrets are stored with your webhooks.
      </p>
      <h3>Messages to us</h3>
      <p>If you use the contact form we store your name, email, company, topic and message.</p>
      <h3>Technical data</h3>
      <ul>
        <li>
          IP addresses, used for rate limiting in short-lived counters, recorded in our server logs, and stored with your user
          agent in audit logs of security-relevant actions.
        </li>
        <li>Error reports from our servers, which may include request details.</li>
      </ul>
      <p>
        We do not use advertising trackers, and the website does not load third-party analytics scripts.
      </p>

      <h2 id="use">3. How we use it</h2>
      <ul>
        <li>To provide the Service: run your agents, models, deployments, workflows and marketplace listings.</li>
        <li>To authenticate you and keep accounts secure, including rate limits, sign-in lockouts and abuse prevention.</li>
        <li>To bill: meter usage, hold and settle credits, process purchases, subscriptions, marketplace charges and payouts.</li>
        <li>
          To send service email through our email provider: verification links, password resets, team invitations and replies
          to your messages.
        </li>
        <li>To understand and improve the Service, using usage records in aggregate.</li>
        <li>To meet legal obligations and enforce our <Link href="/terms">Terms of Service</Link>.</li>
      </ul>
      <p>We do not sell personal data, and we do not use your content to advertise to you.</p>
      <p>
        Where the law requires a legal basis, we rely on performance of our contract with you, our legitimate interests in
        securing and improving the Service, your consent where we ask for it, and legal obligations.
      </p>

      <h2 id="ai">4. AI models and GPU hosts</h2>
      <p>Running AI necessarily means sending your prompts to whatever runs the model:</p>
      <ul>
        <li>
          <strong>Free models</strong> are served by third-party providers (currently Groq, Google and Together AI) using our
          accounts. Prompts and outputs are processed by those providers under their terms.
        </li>
        <li>
          <strong>Your own provider keys.</strong> If you set a key for OpenAI, Anthropic, Google, Together or Groq on an agent,
          requests go to that provider under your own account and its terms.
        </li>
        <li>
          <strong>Deployments on Nosana.</strong> Models and agents you deploy run on GPU hosts in the Nosana network, which are
          operated by independent third parties. Requests to your deployment&apos;s <code>/v1</code> endpoint are forwarded to
          those hosts, which process the prompts and outputs. Your WheelsAI credentials are never forwarded to them.
        </li>
        <li>
          <strong>Deployment definitions are public.</strong> The job definition submitted to Nosana (container image, model,
          and configuration) is published to the network and may be stored on public IPFS. Agent secrets are not included in
          it. Do not put personal data in deployment names or configuration.
        </li>
      </ul>

      <h2 id="blockchain">5. Solana: public and permanent</h2>
      <p>
        Some features write to the Solana blockchain: wallet top-ups, x402 payments, crypto payouts, agent token launches,
        agent treasury payments and usage attestations. Anything written to a public blockchain, including wallet addresses,
        amounts and timestamps, is visible to anyone and cannot be changed or deleted by us or anyone else. Linking a wallet
        address to your account may allow others to associate on-chain activity with you if they learn the connection. Your
        rights to deletion cannot apply to on-chain records.
      </p>

      <h2 id="public">6. What is public on WheelsAI</h2>
      <ul>
        <li>Published marketplace listings, publisher profiles and reviews.</li>
        <li>
          For agents you make public, a transparency page at <code>/a/&#123;slug&#125;</code> showing the agent&apos;s name,
          framework, treasury balance, compute paid, recent payment signatures, deployments (tier, replicas, status) and enabled
          channel types. It does not show your organization or internal error messages.
        </li>
        <li>Published templates.</li>
      </ul>

      <h2 id="sharing">7. Who we share it with</h2>
      <p>We share personal data only with service providers that help us run the Service, and only what they need:</p>
      <DocTable
        caption="Service providers"
        columns={[
          { key: "who", label: "Provider" },
          { key: "why", label: "Purpose" },
        ]}
        rows={[
          { who: "Stripe", why: "Card payments, subscriptions, invoices and the billing portal." },
          { who: "Resend", why: "Sending service email." },
          { who: "Nosana network and its GPU hosts", why: "Running the models and agents you deploy." },
          { who: "Model providers (Groq, Google, Together AI; OpenAI and Anthropic with your own keys)", why: "Running model inference." },
          { who: "Solana RPC providers", why: "Submitting and reading blockchain transactions." },
          { who: "GitHub, Slack, Discord, Telegram", why: "Only when you connect them, to import code and exchange messages." },
          { who: <>Hosting, database and storage providers <Founder>confirm hosting providers</Founder></>, why: "Running our servers, database, cache and file storage." },
          { who: "Error tracking (Sentry, when enabled)", why: "Diagnosing server errors." },
          {
            who: <>Cloudflare Turnstile <Founder>legal review: Turnstile as a processor</Founder></>,
            why: "Only on a marketplace listing's Try it tab, for visitors who are not signed in and only when the check is switched on: telling people from bots before a free preview.",
          },
        ]}
      />
      <p>
        We may also disclose information if required by law or to protect the rights, property or safety of our users or others,
        and to a successor if WheelsAI is involved in a merger, acquisition or sale of assets, with notice to you.
      </p>

      <h2 id="cookies">8. Cookies and local storage</h2>
      <p>
        We set one cookie, <code>wheelsai_token</code>, when you sign in. It is strictly necessary: it keeps you signed in for up
        to 24 hours. It is httpOnly (scripts cannot read it), signed, sent only over HTTPS in production, and cleared when you
        sign out.
      </p>
      <p>
        Your browser&apos;s local storage keeps your light or dark theme preference, and, if you connect a Solana wallet, the
        wallet adapter may remember which wallet you chose so it can reconnect. Neither is sent to us. We use no advertising or
        analytics cookies.
      </p>
      <p>
        The embeddable chat widget sets no cookie. On the site that embeds it, it uses that site&apos;s session storage for the
        current conversation; see <a href="#widget">the chat widget and Try it</a>.
      </p>

      <h2 id="widget">9. The chat widget and Try it</h2>
      <p>
        <Founder>legal review: this whole section, written from how the features work</Founder>
      </p>
      <h3>The chat widget on other people&apos;s sites</h3>
      <p>
        A WheelsAI customer can put one of their agents on their own website as a chat widget. If you chat with a widget, that
        site&apos;s owner decides what it is for and is responsible for telling you about it in their own privacy notice; we
        process the conversation for them.
      </p>
      <ul>
        <li>
          Your messages are sent to our API and to the model that answers. The widget sends no cookies and does not identify
          you: there is no account, name or email involved.
        </li>
        <li>
          The widget keeps the conversation and a random session id in that site&apos;s <code>sessionStorage</code> for your
          browser tab, so the chat survives moving between pages. It is cleared when you close the tab or press the
          widget&apos;s new-conversation button.
        </li>
        <li>
          Conversations are not stored on our servers unless the site&apos;s owner turned on saving. When it is on, the
          widget says so under the message box, and your messages and the agent&apos;s answers are stored in the
          owner&apos;s WheelsAI organization, with the address of the site the chat came from. No retention period is
          applied to saved conversations today. <Founder>legal review: a retention period for saved widget conversations, and how a visitor asks for deletion</Founder>
        </li>
        <li>
          To enforce message limits we count requests per network in short-lived counters. The counter is keyed by a keyed
          hash of your IP address (for IPv6, of its /64 network), not by the address itself, and expires within a day.
        </li>
      </ul>
      <h3>Try it on marketplace listings</h3>
      <ul>
        <li>
          Try it is a free, limited chat with a listed agent. Your messages go to our API and to a free model we provide. Try
          it conversations are not stored; we keep counts (how many messages a listing received in a day) and usage records
          that hold no message content.
        </li>
        <li>
          If you are signed in, the preview is tied to your organization so limits can be applied. If you are not, and the
          human check is switched on, Cloudflare Turnstile runs in your browser: Cloudflare receives your IP address and
          signals from your browser to decide whether you are a person, and we receive only its yes-or-no answer. Turnstile
          is loaded only on the Try it tab and only for visitors who are not signed in. While the check is not switched on,
          Try it requires signing in and Turnstile is not loaded at all.
        </li>
        <li>
          A preview session is bound to the same hashed network bucket described above, so it stops working if your network
          changes.
        </li>
      </ul>

      <h2 id="security">10. Security</h2>
      <p>
        We use HTTPS, hash passwords with Argon2id, store API keys only as keyed hashes, encrypt agent secrets and channel
        credentials at rest, make email links single-use and short-lived, support two-factor authentication, and scope every
        request to your organization. No system is perfectly secure; if you find a vulnerability, please report it to{" "}
        <Founder>security contact email</Founder>.
      </p>

      <h2 id="retention">11. How long we keep it</h2>
      <ul>
        <li>Account data and content: for as long as your account is open, and deleted after you close it, except as below.</li>
        <li>
          Ledger, billing, payout and tax-relevant records: for as long as we must keep them for accounting and legal purposes.
        </li>
        <li>Verification links expire after 24 hours and password reset links after 30 minutes.</li>
        <li>
          Per-request timing records: deleted on a schedule after a fixed number of days.{" "}
          <Founder>legal review: the retention period of timing records (the configured default is 30 days)</Founder>
        </li>
        <li>Server logs and backups: <Founder>log and backup retention periods</Founder>.</li>
        <li>On-chain records: permanent, and outside our control.</li>
      </ul>

      <h2 id="rights">12. Your choices and rights</h2>
      <p>
        You can view and update your account information in the dashboard, revoke API keys, disconnect integrations, delete
        agents and other content, and close your account. Depending on where you live, you may also have the right to access,
        correct, delete or export your personal data, to object to or restrict certain processing, and to withdraw consent. To
        exercise these rights, contact us at <Founder>privacy contact email</Founder> or through the{" "}
        <Link href="/contact?topic=other">contact form</Link>. You may also complain to your local data protection authority.
      </p>

      <h2 id="transfers">13. International transfers</h2>
      <p>
        Our service providers, and the independent GPU hosts in the Nosana network, may process data in countries other than
        yours. Where the law requires it, we use appropriate safeguards for those transfers. Our primary data location is{" "}
        <Founder>primary data hosting region</Founder>.
      </p>

      <h2 id="children">14. Children</h2>
      <p>
        The Service is not directed to children, and you must be at least <Founder>minimum age</Founder> to use it. If you
        believe a child has given us personal data, contact us and we will delete it.
      </p>

      <h2 id="changes">15. Changes to this policy</h2>
      <p>
        We will post any changes on this page. If a change is material, we will tell you by email or in the dashboard before it
        takes effect.
      </p>

      <h2 id="contact">16. Contact</h2>
      <p>
        <Founder>legal entity name</Founder>, <Founder>registered address</Founder>. Email: <Founder>privacy contact email</Founder>.
        You can also reach us through the <Link href="/contact?topic=other">contact form</Link>.
      </p>
    </LegalPage>
  );
}
