import type { Metadata } from "next";
import Link from "next/link";

import { DocPage } from "@/components/marketing/docs/doc-page";
import { Callout, DocTable } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Plans and billing",
  description:
    "WheelsAI plans (Starter, Pro, Enterprise), what counts as an API call, credits and the ledger, and the three ways to pay: Stripe card checkout, Solana wallet top-ups and x402 micropayments.",
};

const toc = [
  { id: "plans", title: "Plans" },
  { id: "api-calls", title: "What counts as an API call" },
  { id: "limits", title: "When you hit a limit" },
  { id: "credits", title: "Credits and the ledger" },
  { id: "what-uses-credits", title: "What uses credits", sub: true },
  { id: "paid-use", title: "Paying to use an agent", sub: true },
  { id: "rails", title: "Ways to pay" },
  { id: "card", title: "Card (Stripe)", sub: true },
  { id: "wallet", title: "Wallet top-up", sub: true },
  { id: "x402", title: "x402 per request", sub: true },
  { id: "who", title: "Who can pay" },
];

export default function PlansBillingPage() {
  return (
    <DocPage
      href="/docs/guides/plans-and-billing"
      title="Plans and billing"
      lead="Your plan sets how much you can build and call; your credit balance pays for what you use. Both belong to your organization."
      toc={toc}
    >
      <h2 id="plans">Plans</h2>
      <DocTable
        caption="Plans and their limits"
        columns={[
          { key: "feature", label: "" },
          { key: "starter", label: "Starter" },
          { key: "pro", label: "Pro" },
          { key: "enterprise", label: "Enterprise" },
        ]}
        rows={[
          { feature: "Price", starter: "Free", pro: "$49 / month", enterprise: "Custom" },
          { feature: "Agents", starter: "Up to 3", pro: "Unlimited", enterprise: "Unlimited" },
          { feature: "API calls per month", starter: "1,000", pro: "100,000", enterprise: "No cap" },
          { feature: "Free-model rate limits", starter: "Base", pro: "10 × base", enterprise: "50 × base" },
          { feature: "Custom domains", starter: "No", pro: "Yes", enterprise: "Yes" },
          { feature: "Advanced analytics", starter: "No", pro: "Yes", enterprise: "Yes" },
          { feature: "Priority marketplace placement", starter: "No", pro: "Yes", enterprise: "Yes" },
          { feature: "SSO and white-label marketplace", starter: "No", pro: "No", enterprise: "Yes" },
        ]}
      />
      <p>
        Pro starts with a 14-day free trial the first time an organization subscribes. Paid features stay on while a subscription
        is trialing, active or past due. Enterprise also includes custom model hosting, audit logging, dedicated support and an
        SLA, and is set up with the team: <Link href="/contact">contact sales</Link>. Agents installed from the marketplace do
        not count toward the agent limit.
      </p>
      <p>
        &quot;Priority model access&quot; is the free-model rate limit multiplier. The base limits are 20 requests per minute and
        200 per day per organization.
      </p>

      <h2 id="api-calls">What counts as an API call</h2>
      <p>
        A request counts when it changes or runs something (any method other than <code>GET</code>, <code>HEAD</code> or{" "}
        <code>OPTIONS</code>) and is either:
      </p>
      <ul>
        <li>authenticated with an API key, to any endpoint, or</li>
        <li>
          made to the OpenAI-compatible <code>/v1</code> API, however it is authenticated (an API key or a signed-in session).
        </li>
      </ul>
      <p>
        So one chat completion is one API call. Reads are free everywhere: listing agents, polling a deployment&apos;s status,
        or an OpenAI client listing <code>/v1/models</code> does not use up calls, so a script or the CLI can wait on a
        deployment without spending the month&apos;s allowance. Reads are still subject to the{" "}
        <Link href="/docs/api#rate-limits">rate limits</Link>.
      </p>
      <p>
        Using the dashboard with your signed-in session does not count, except for <code>/v1</code> calls. Calls are counted per
        organization per calendar month in UTC and reset on the first of the month. The billing page (and{" "}
        <code>GET /api/billing/plan</code>) shows this month&apos;s count against your limit.
      </p>

      <h2 id="limits">When you hit a limit</h2>
      <p>
        Plan limits answer with the same body everywhere, with <code>403</code> for a feature or size limit (a fourth agent on
        Starter, a custom domain without Pro) and <code>429</code> when the monthly API calls are used up:
      </p>
      <pre className="mt-4 overflow-x-auto rounded-lg border border-border bg-muted/50 p-4 font-mono text-[13px] leading-6 text-foreground" tabIndex={0}>
{`{
  "error": "plan_limit_reached",
  "message": "The Starter plan includes 1,000 API calls per month, and this month's are used up. Upgrade for more.",
  "plan": "starter",
  "limit": "monthlyApiCalls",
  "upgradeUrl": "/dashboard/billing?upgrade=pro"
}`}
      </pre>

      <h2 id="credits">Credits and the ledger</h2>
      <p>
        Credits are a US dollar balance held in cents. Every change to it, whether a purchase, bonus, usage charge, hold, release
        or refund, is written as a ledger row that records the balance after the change, inside the same database transaction.
        You can see the most recent rows under <strong>Billing</strong> or with <code>GET /api/billing/transactions</code>.
      </p>
      <p>
        New organizations start at $0. Verifying the owner&apos;s email adds a one-time $5.00 bonus.
      </p>

      <h3 id="what-uses-credits">What uses credits</h3>
      <ul>
        <li>
          <strong>GPU time</strong> for running deployments, per second at the tier&apos;s rate, with one hour reserved when a
          deployment starts and returned when it ends. See <Link href="/docs/guides/deploy-a-model#billing">Deploy a model</Link>.
          Requests you send to a running deployment through <code>/v1</code> are included in that GPU time: they are not held
          or charged per token on top of it. See <Link href="/docs/api/inference#billing">how a request is billed</Link>.
        </li>
        <li>
          <strong>Marketplace purchases</strong>: per-request runs and monthly subscriptions of paid listings, whether
          you use the creator&apos;s agent or run a copy of your own.
        </li>
      </ul>
      <p>Chatting with your own agents on free models does not use credits; it is rate limited instead.</p>

      <h3 id="paid-use">Paying to use an agent</h3>
      <p>
        A marketplace listing can sell use of its creator&apos;s agent, per use or by the month. The price is the one you
        agreed to on the agent&apos;s page, and it is paid from your organization&apos;s credits. See{" "}
        <Link href="/docs/guides/marketplace#using">Using an agent</Link>.
      </p>
      <DocTable
        caption="What a paid use costs and when it is refunded"
        columns={[
          { key: "sold", label: "Sold" },
          { key: "charged", label: "Charged" },
          { key: "refunded", label: "Refunded" },
        ]}
        rows={[
          {
            sold: "Per message or per run",
            charged: "The price of one use, from your credits, when you send it. One use is one message or one run.",
            refunded:
              "In full when no answer is delivered: the agent could not answer, ran out of time, or its answer was withheld.",
          },
          {
            sold: "Monthly",
            charged: "The first 30 days when you subscribe, then the price you agreed to every 30 days.",
            refunded: "A month that has started is not refunded.",
          },
        ]}
      />
      <ul>
        <li>
          If your credits do not cover a use, the request answers <code>402</code>: nothing runs and nothing is charged.
          Add credits and send it again.
        </li>
        <li>
          If a renewal cannot be paid, the subscription is retried during a 3-day grace period and then ends. Add
          credits before then to keep access.
        </li>
        <li>
          <strong>Cancel renewal</strong> (under <strong>Marketplace → Installed</strong>) keeps your access until the
          end of the month you paid for and charges nothing more.
        </li>
        <li>
          <strong>Stop using</strong> a subscription from Installed ends it immediately, and the month you paid for is
          not refunded.
        </li>
        <li>
          If the creator raises the price or changes how the agent is sold, nothing is charged until you accept the new
          price. A subscription renews at the price you agreed to.
        </li>
      </ul>
      <p>
        Every charge and every refund is a ledger row. In your billing history they read &quot;Paid use&quot; and
        &quot;Paid use refunded&quot;, with the listing&apos;s name.
      </p>

      <h2 id="rails">Ways to pay</h2>
      <p>
        Every rail grants credits the same way, so the bonus ladder is identical whichever you use.{" "}
        <code>GET /api/billing/packages</code> lists the rails open to you in its <code>rails</code> field, and the billing page
        offers exactly those.
      </p>
      <DocTable
        caption="Credit packages and bonuses"
        columns={[
          { key: "pay", label: "You pay" },
          { key: "bonus", label: "Bonus" },
          { key: "get", label: "Credits" },
        ]}
        rows={[
          { pay: "$10", bonus: "none", get: "$10" },
          { pay: "$50", bonus: "+$5", get: "$55" },
          { pay: "$100", bonus: "+$15", get: "$115" },
          { pay: "$500", bonus: "+$100", get: "$600" },
        ]}
      />
      <p>
        Custom amounts from $5 to $10,000 are allowed and get the bonus of the highest package they reach.
      </p>

      <h3 id="card">Card (Stripe)</h3>
      <p>
        Buying credits by card opens Stripe Checkout. Credits are granted only when Stripe&apos;s signed webhook confirms the
        payment, exactly once per purchase. If a card payment is refunded, the credits it bought (and the matching share of its
        bonus) are taken back, never below zero. Pro subscriptions and invoices are managed in Stripe&apos;s billing portal from
        the billing page. WheelsAI never sees or stores your card number.
      </p>

      <h3 id="wallet">Wallet top-up</h3>
      <p>
        Pay with USDC from a connected Solana wallet. WheelsAI prepares the exact transfer transaction, your wallet signs it,
        and WheelsAI checks that what you signed is byte-for-byte what it prepared before broadcasting. Credits are granted
        only after the transaction is confirmed on-chain, and at most once, even if a confirmation is interrupted and later
        reconciled. The transfer is signed by the wallet on your session, so use this rail while signed in with your
        Solana wallet.
      </p>

      <h3 id="x402">x402 per request</h3>
      <p>
        Calls to a <code>/v1</code> deployment that is billed per request can be paid one request
        at a time with a signed Solana payment instead of from credits. A dedicated deployment is billed for GPU time and is
        never challenged for an x402 payment. The API answers <code>402 Payment Required</code> with the exact amount, asset and recipient;
        your client signs a matching transfer and retries with an <code>X-Payment</code> header. A payment transaction can be
        used once. See the <Link href="/docs/api/inference#x402">x402 flow</Link> for the headers and body.
      </p>
      <Callout>
        <p>x402 payments go to the platform treasury, not to a marketplace creator.</p>
      </Callout>

      <h2 id="who">Who can pay</h2>
      <p>
        Buying credits by card, starting Pro and opening the billing portal require a signed-in owner or admin of the
        organization. API keys cannot start payments.
      </p>
    </DocPage>
  );
}
