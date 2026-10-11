import type { Metadata } from "next";
import Link from "next/link";

import { DocPage } from "@/components/marketing/docs/doc-page";
import { Callout, DocTable } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Plans and billing",
  description:
    "WheelsAI plans (Starter, Pro, Enterprise), what counts as an API call, credits and the ledger, and the ways to pay: Stripe card checkout, Solana wallet top-ups in USDC or SOL, a transfer to your own deposit address from an exchange or any wallet, and x402 micropayments.",
};

const toc = [
  { id: "plans", title: "Plans" },
  { id: "api-calls", title: "What counts as an API call" },
  { id: "limits", title: "When you hit a limit" },
  { id: "credits", title: "Credits and the ledger" },
  { id: "billing-page", title: "What the Billing page shows", sub: true },
  { id: "what-uses-credits", title: "What uses credits", sub: true },
  { id: "paid-use", title: "Paying to use an agent", sub: true },
  { id: "rails", title: "Ways to pay" },
  { id: "card", title: "Card (Stripe)", sub: true },
  { id: "wallet", title: "Wallet top-up", sub: true },
  { id: "deposit-address", title: "Send from an exchange or another wallet", sub: true },
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
      <p>
        Use of an agent&apos;s public link counts too, toward the plan of the agent&apos;s owner. When you turn the link
        on, on the agent&apos;s <strong>Share</strong> tab, anyone can use the agent on its page without signing in, and
        each use (one message, or one run of a task agent) is one API call on your plan. The visitor pays nothing; use
        that people pay for is described under <a href="#paid-use">Paying to use an agent</a>. The same counting holds for each message sent to a <Link href="/docs/guides/web-chat-widget">chat box on your website</Link>.
      </p>
      <ul>
        <li>
          An agent on a free model also draws on your organization&apos;s free-model allowance, as it does when you use
          it yourself.
        </li>
        <li>
          Each visitor is limited, by the minute and by the day, so one person cannot use up your month. See the{" "}
          <Link href="/docs/guides/web-chat-widget#limits">limits</Link>.
        </li>
        <li>
          The link has a daily limit of its own: 100 uses a day to start with, and you can set it from 1 to 100,000 on
          the Share tab.
        </li>
        <li>
          <strong>Pause link</strong> stops public use at once and keeps the page and its address.{" "}
          <strong>Turn link off</strong> closes the page.
        </li>
      </ul>
      <p>
        When your month&apos;s calls are used up, a visitor is told only that the agent has reached its usage limit for
        now.
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
        You can read every row under <strong>Billing</strong> or with <code>GET /api/billing/transactions</code>.
      </p>
      <p>
        New organizations start at $0. Verifying the owner&apos;s email adds a one-time $5.00 bonus.
      </p>

      <h3 id="billing-page">What the Billing page shows</h3>
      <p>
        <strong>Billing</strong> in the dashboard is where you read your credits. Every figure on it is added up from
        what your organization bought, used and set aside, and the month it speaks of is the calendar month in UTC.
      </p>
      <ul>
        <li>
          <strong>Available Credits</strong> is what you can spend now.
        </li>
        <li>
          <strong>Held</strong> is what is set aside for things that are running or awaited. It is not spent, and it is
          not part of what is available until it comes back.
        </li>
        <li>
          <strong>Spent This Month</strong> is what you were charged this month, less what came back.
        </li>
        <li>
          <strong>GPU Hours This Month</strong> is the GPU time you were charged for this month.
        </li>
      </ul>
      <p>
        When anything is held, <strong>What is held</strong> lists each hold with its name, its amount and a sentence
        that says when it comes back.
      </p>
      <DocTable
        caption="What can hold credits"
        columns={[
          { key: "what", label: "Held for" },
          { key: "back", label: "When it comes back" },
        ]}
        rows={[
          { what: "A model deployment that is running", back: "When the deployment stops." },
          { what: "An agent running on its own GPU", back: "When it stops." },
          { what: "A fine-tuning run", back: "What the run does not use comes back when it ends." },
          { what: "A job you hired", back: "It is paid when the work is accepted, by you or when the review window closes, or comes back when the job is refunded." },
          { what: "A Try it message you pay for on your own listing", back: "Within a few minutes, once the message is answered." },
        ]}
      />
      <p>
        <strong>Spending this month</strong> splits the month by kind, one line for each kind you spent on: GPU time,
        inference, fine-tuning, paid use of listings, subscriptions, jobs, and Try it messages you paid for. A refund
        counts against the kind it belongs to in the month it arrives, so a line reads as returned when more came back
        than was charged. A job counts when its work is accepted, not when you hire it: until then its price is held.
      </p>
      <p>
        <strong>Transaction History</strong> lists the ledger, newest first. Each row shows what it is, its date and
        time, its amount with its own sign (a plus for credits arriving, a minus for credits leaving) and your balance
        after it. You can show everything, only credits added, only spending, or only holds, and{" "}
        <strong>Load more</strong> reads further back.
      </p>
      <p>
        <strong>Export</strong> downloads the ledger as a CSV file for this month, last month or the last 90 days. The
        file holds every row of the range you choose, oldest first, with the balance after each one. For other dates,
        use <Link href="/docs/api/billing#transactions-export">the export endpoint</Link>.
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
        Add credits by paying USDC or SOL from a Solana wallet. Any wallet you connect can pay. It does not have to be
        the wallet you sign in with, and an account that signs in with email can pay this way too.
      </p>
      <ol>
        <li>
          Open <strong>Billing</strong>. Under <strong>Add Credits</strong>, choose what to pay with, USDC or SOL, when
          both are offered.
        </li>
        <li>
          Choose <strong>Pay with Wallet</strong> on a credit pack. If no wallet is connected yet, pick one from the list
          and the payment carries on.
        </li>
        <li>
          Confirm the transfer in your wallet. WheelsAI prepares the exact transfer and your wallet signs it; WheelsAI
          never holds your wallet&apos;s keys.
        </li>
        <li>
          Your credits appear as soon as the network confirms the transfer, usually within a minute. You can leave the
          page while it is being confirmed, and the credits are still added.
        </li>
      </ol>
      <DocTable
        caption="Paying with USDC or SOL"
        columns={[
          { key: "asset", label: "You pay in" },
          { key: "amount", label: "What your wallet sends" },
          { key: "time", label: "Time to confirm in your wallet" },
        ]}
        rows={[
          {
            asset: "USDC",
            amount: "Exactly the dollar amount, in USDC.",
            time: "120 seconds",
          },
          {
            asset: "SOL",
            amount: "The dollar amount in SOL, at the price shown before you confirm.",
            time: "60 seconds, while the price holds",
          },
        ]}
      />
      <ul>
        <li>
          If the time runs out before you confirm, nothing is taken. Start the top-up again; a SOL top-up gets a fresh
          price.
        </li>
        <li>
          If a current SOL price cannot be read, SOL is not prepared and nothing is taken. USDC is not affected.
        </li>
        <li>
          Your organization&apos;s first USDC payment also opens its USDC account, which costs your wallet about 0.002 SOL
          once.
        </li>
        <li>
          Your wallet also pays the network&apos;s fee for the transfer, so keep a little SOL in it.
        </li>
        <li>
          When WheelsAI can see that the wallet holds less than the top-up needs, it says so before anything is signed.
          Choose a smaller amount or another wallet.
        </li>
        <li>
          Credits are added once per transfer. If a transfer fails on the network, no payment is taken and the top-up
          says so.
        </li>
      </ul>
      <p>
        From code, the same steps are <Link href="/docs/api/billing#topups">the wallet top-up endpoints</Link>, which
        take an API key or a session.
      </p>

      <h3 id="deposit-address">Send from an exchange or another wallet</h3>
      <p>
        Your organization has its own address for USDC and SOL on Solana. Anything you send to it is added to your
        credits, so you can pay straight from an exchange or from any wallet, with nothing to connect and nothing to
        sign in your browser.
      </p>
      <ol>
        <li>
          Open <strong>Billing</strong>. Under <strong>Add Credits</strong>, find{" "}
          <strong>Send from an exchange or another wallet</strong> and choose <strong>Show my deposit address</strong>.
        </li>
        <li>
          Copy the address. It belongs to your organization only and stays the same, so you can save it at your exchange
          and use it again.
        </li>
        <li>
          At your exchange or in your wallet, send USDC or SOL to that address. Choose <strong>Solana</strong> as the
          network.
        </li>
        <li>
          Your credits appear on their own, usually within a few minutes. <strong>Check now</strong> looks for your
          transfer at once.
        </li>
      </ol>
      <DocTable
        caption="How a transfer to your address is credited"
        columns={[
          { key: "asset", label: "You send" },
          { key: "credited", label: "What is credited" },
        ]}
        rows={[
          { asset: "USDC", credited: "One dollar for one USDC." },
          { asset: "SOL", credited: "Its dollar value when WheelsAI sees your transfer." },
        ]}
      />
      <Callout>
        <p>
          Send on the Solana network only. A transfer on another network cannot be recovered. Only USDC and SOL are
          credited.
        </p>
      </Callout>
      <ul>
        <li>
          The page says which of USDC and SOL you can send. When SOL is not offered, send USDC only.
        </li>
        <li>
          If your exchange says the address cannot receive USDC yet, press <strong>Prepare address</strong> and send
          again once the page says the address can receive USDC. Preparing needs a verified email or one earlier
          purchase.
        </li>
        <li>
          A transfer earns the same bonus as any other way to pay, and the page shows what was sent and what the bonus
          was.
        </li>
        <li>
          If a current SOL price cannot be read when your SOL arrives, the transfer is shown as seen and is credited as
          soon as a price can be read. USDC is not affected.
        </li>
        <li>
          Each transfer is credited once. Your recent transfers are listed on the page, each with where it
          stands. A transfer too small to credit is listed as such.
        </li>
      </ul>
      <p>
        From code, the same steps are <Link href="/docs/api/billing#deposits">the deposit address endpoints</Link>,
        which take an API key or a session.
      </p>

      <h3 id="x402">x402 per request</h3>
      <p>
        Calls to a <code>/v1</code> deployment that is billed per request can be paid one request
        at a time with a signed Solana payment, in USDC or SOL, instead of from credits. A dedicated deployment is billed for GPU time and is
        never challenged for an x402 payment. The API answers <code>402 Payment Required</code> with the exact amount, asset and destination;
        your client signs a matching transfer and retries with an <code>X-Payment</code> header. USDC goes to the token account
        the answer names, and a SOL price is held for you by the <code>quote</code> in the answer. A payment transaction can be
        used once. If a paid request then fails, the payment is returned to your credit balance: amounts under a cent add up
        and appear, as <strong>Paid request returned as credits</strong>, once they reach a cent. See the{" "}
        <Link href="/docs/api/inference#x402">x402 flow</Link> for the headers and body.
      </p>
      <Callout>
        <p>x402 payments go to the platform treasury, not to a marketplace creator.</p>
      </Callout>

      <h2 id="who">Who can pay</h2>
      <p>
        Buying credits by card, starting Pro and opening the billing portal require a signed-in owner or admin of the
        organization, and an API key cannot start them. Adding credits from a wallet is open to any signed-in account
        and to an API key: the wallet that signs the transfer is the one that pays. Your organization&apos;s deposit
        address is open to any signed-in account and to an API key too, and whatever is sent to it is credited to the
        organization.
      </p>
    </DocPage>
  );
}
