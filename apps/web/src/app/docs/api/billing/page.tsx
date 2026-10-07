import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Endpoint, Fields } from "@/components/marketing/docs/endpoint";

export const metadata: Metadata = {
  title: "Billing and plans API",
  description:
    "WheelsAI billing API: credit balance, ledger transactions, usage, credit packages and live payment rails, plan and limits, Stripe checkout and portal, and Solana wallet top-ups.",
};

const toc = [
  { id: "credits", title: "Credits" },
  { id: "balance", title: "Balance", sub: true },
  { id: "transactions", title: "Transactions", sub: true },
  { id: "usage", title: "Usage", sub: true },
  { id: "packages", title: "Packages and rails", sub: true },
  { id: "plan", title: "Plan" },
  { id: "get-plan", title: "Current plan and usage", sub: true },
  { id: "payments", title: "Payments" },
  { id: "checkout", title: "Buy credits by card", sub: true },
  { id: "subscription", title: "Start Pro", sub: true },
  { id: "portal", title: "Billing portal", sub: true },
  { id: "topups", title: "Wallet top-ups", sub: true },
];

export default function BillingApiPage() {
  return (
    <DocPage
      href="/docs/api/billing"
      title="Billing and plans"
      lead="Read your credit balance, ledger and plan with an API key or session. Starting a payment always needs a signed-in owner or admin."
      toc={toc}
    >
      <h2 id="credits">Credits</h2>

      <Endpoint id="balance" method="GET" path="/api/billing/balance" auth="API key or session" title="Credit balance">
        <CodeBlock language="json" code={`{ "balance": { "available": 12.5, "pending": 0, "total": 12.5 } }`} />
        <p>Amounts are US dollars.</p>
      </Endpoint>

      <Endpoint id="transactions" method="GET" path="/api/billing/transactions" auth="API key or session" title="Ledger transactions">
        <p>
          The 50 most recent ledger rows, newest first: <code>id</code>, <code>amount</code> (USD, negative for charges),{" "}
          <code>type</code>, <code>description</code> and <code>createdAt</code>. Types include purchases, bonuses, usage,
          holds and their releases, and refunds.
        </p>
      </Endpoint>

      <Endpoint id="usage" method="GET" path="/api/billing/usage" auth="API key or session" title="This month's usage">
        <p>
          Totals since the start of the month for your <code>/v1</code> traffic: <code>requests</code>,{" "}
          <code>inputTokens</code>, <code>outputTokens</code>, GPU hours and cost, with the metered compute seconds under{" "}
          <code>metered</code>.
        </p>
      </Endpoint>

      <Endpoint id="packages" method="GET" path="/api/billing/packages" auth="API key or session" title="Credit packages and live payment rails">
        <CodeBlock
          language="json"
          code={`{
  "packages": [
    { "amount": 10, "bonus": 0 },
    { "amount": 50, "bonus": 5, "popular": true },
    { "amount": 100, "bonus": 15 },
    { "amount": 500, "bonus": 100 }
  ],
  "minPurchase": 5,
  "maxPurchase": 10000,
  "rails": {
    "stripeCheckout": true,
    "proSubscription": true,
    "wallet": true,
    "walletAssets": ["USDC"],
    "network": "mainnet-beta"
  }
}`}
        />
        <p>
          <code>rails</code> lists the payment paths open to you, so a client never offers one the API would refuse. The
          values above are an example; read them from the API.
        </p>
      </Endpoint>

      <h2 id="plan">Plan</h2>

      <Endpoint id="get-plan" method="GET" path="/api/billing/plan" auth="API key or session" title="Current plan, limits and usage">
        <CodeBlock
          language="json"
          code={`{
  "plan": "starter",
  "limits": { "maxAgents": 3, "monthlyApiCalls": 1000, "customDomains": false, "...": "..." },
  "status": "none",
  "trialEndsAt": null,
  "trialAvailable": true,
  "currentPeriodEnd": null,
  "cancelAtPeriodEnd": false,
  "hasBillingAccount": false,
  "usage": { "agents": 2, "apiCallsThisMonth": 118 },
  "plans": { "starter": { }, "pro": { }, "enterprise": { } },
  "proSubscriptionAvailable": true
}`}
        />
        <p>
          <code>limits</code> uses <code>null</code> for unlimited. <code>status</code> is the subscription&apos;s billing status
          (<code>none</code> when you have never subscribed). See <Link href="/docs/guides/plans-and-billing">Plans and billing</Link>{" "}
          for what each plan includes.
        </p>
      </Endpoint>

      <h2 id="payments">Payments</h2>
      <p>
        These endpoints need a signed-in <strong>owner or admin</strong> session; API keys and members are refused. While card
        payments are temporarily unavailable, card endpoints answer <code>501</code>{" "}
        <code>card_payments_not_configured</code> and nothing is charged.
      </p>

      <Endpoint id="checkout" method="POST" path="/api/billing/checkout" auth="Session only, owner or admin" title="Buy credits by card">
        <Fields fields={[{ name: "amount", type: "number", required: true, description: "US dollars, 5 to 10,000." }]} />
        <p>
          Returns <code>&#123; checkoutUrl &#125;</code>, a Stripe Checkout page. Credits (plus any bonus) are granted when
          Stripe&apos;s signed webhook confirms payment, not when this call returns.
        </p>
      </Endpoint>

      <Endpoint id="subscription" method="POST" path="/api/billing/subscription/checkout" auth="Session only, owner or admin" title="Start Pro">
        <Fields fields={[{ name: "plan", type: "\"pro\"", required: true, description: "The plan to start." }]} />
        <p>
          Returns <code>&#123; checkoutUrl, trialDays &#125;</code>. The first Pro subscription of an organization starts with a
          14-day trial. <code>501</code> <code>pro_not_configured</code> while Pro subscriptions are temporarily unavailable.
        </p>
      </Endpoint>

      <Endpoint id="portal" method="POST" path="/api/billing/portal" auth="Session only, owner or admin" title="Open the billing portal">
        <p>Returns a Stripe billing portal session URL for payment methods, invoices and cancellation.</p>
      </Endpoint>

      <Endpoint id="topups" method="POST" path="/api/billing/topups/prepare" auth="Session signed in with a wallet" title="Prepare a wallet top-up">
        <Fields
          fields={[
            { name: "amountUsd", type: "number", required: true, description: "US dollars, within the purchase limits." },
            { name: "asset", type: "enum", required: true, description: <>An asset listed in <code>rails.walletAssets</code>, normally <code>USDC</code>.</> },
          ]}
        />
        <p>
          Returns <code>topupId</code>, <code>unsignedTxBase64</code> (the complete transfer from your wallet to your
          organization&apos;s deposit address), <code>depositAddress</code>, <code>bonusUsd</code> and{" "}
          <code>expiresAt</code>. Then:
        </p>
        <ol>
          <li>
            Sign the transaction in your wallet without changing it, and send it to{" "}
            <code>POST /api/billing/topups/&#123;topupId&#125;/submit</code> as <code>&#123; &quot;signedTxBase64&quot;: &quot;...&quot; &#125;</code>.
            WheelsAI rejects anything that is not byte-for-byte the transaction it prepared, then broadcasts it.
          </li>
          <li>
            Credits are granted once the transaction is confirmed. If confirmation was interrupted,{" "}
            <code>POST /api/billing/topups/&#123;topupId&#125;/reconcile</code> checks the chain and settles the top-up; it is
            safe to call repeatedly and never credits twice.
          </li>
          <li>
            <code>GET /api/billing/topups/&#123;topupId&#125;</code> returns its status.
          </li>
        </ol>
        <p>
          The whole rail answers <code>501</code> while wallet top-ups are temporarily unavailable, and <code>400</code>{" "}
          <code>wallet_required</code> when your session was not signed in with a wallet.
        </p>
      </Endpoint>
    </DocPage>
  );
}
