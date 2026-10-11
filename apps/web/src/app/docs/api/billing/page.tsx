import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Endpoint, Fields } from "@/components/marketing/docs/endpoint";
import { DocTable } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Billing and plans API",
  description:
    "WheelsAI billing API: credit balance, ledger transactions, usage, credit packages and live payment rails, plan and limits, Stripe checkout and portal, Solana wallet top-ups in USDC or SOL, your organization's deposit address for transfers from an exchange or any wallet, and linking a wallet.",
};

const toc = [
  { id: "credits", title: "Credits" },
  { id: "balance", title: "Balance", sub: true },
  { id: "transactions", title: "Transactions", sub: true },
  { id: "usage", title: "Usage", sub: true },
  { id: "packages", title: "Packages and rails", sub: true },
  { id: "plan", title: "Plan" },
  { id: "get-plan", title: "Current plan and usage", sub: true },
  { id: "payments", title: "Card payments" },
  { id: "checkout", title: "Buy credits by card", sub: true },
  { id: "subscription", title: "Start Pro", sub: true },
  { id: "portal", title: "Billing portal", sub: true },
  { id: "topups", title: "Wallet top-ups" },
  { id: "topup-prepare", title: "Prepare a top-up", sub: true },
  { id: "topup-submit", title: "Send the signed transfer", sub: true },
  { id: "topup-reconcile", title: "Check a top-up", sub: true },
  { id: "topup-get", title: "Read one top-up", sub: true },
  { id: "topup-list", title: "List recent top-ups", sub: true },
  { id: "deposits", title: "Deposit address" },
  { id: "deposit-address-get", title: "Read the address", sub: true },
  { id: "deposit-address-issue", title: "Issue the address", sub: true },
  { id: "deposit-address-usdc", title: "Prepare the address for USDC", sub: true },
  { id: "deposit-address-check", title: "Check for transfers now", sub: true },
  { id: "deposit-list", title: "List recent deposits", sub: true },
  { id: "link-wallet", title: "Link a wallet" },
  { id: "link-wallet-nonce", title: "Ask for a nonce", sub: true },
  { id: "link-wallet-verify", title: "Link the wallet", sub: true },
];

export default function BillingApiPage() {
  return (
    <DocPage
      href="/docs/api/billing"
      title="Billing and plans"
      lead="Read your credit balance, ledger and plan with an API key or session. Card payments need a signed-in owner or admin. Wallet top-ups and your deposit address, both in USDC or SOL, work with an API key or a session."
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
    "walletAssets": ["USDC", "SOL"],
    "deposits": true,
    "network": "mainnet-beta"
  }
}`}
        />
        <p>
          <code>rails</code> lists the payment paths open to you, so a client never offers one the API would refuse.{" "}
          <code>walletAssets</code> is present when <code>wallet</code> is true: <code>USDC</code>, followed by{" "}
          <code>SOL</code> when SOL is offered. <code>deposits</code> is true when your organization can be paid at{" "}
          <a href="#deposits">its deposit address</a>. The values above are an example; read them from the API.
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

      <h2 id="payments">Card payments</h2>
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

      <h2 id="topups">Wallet top-ups</h2>
      <p>
        Add credits by paying USDC or SOL from a Solana wallet. These endpoints take an <strong>API key or a session</strong>.
        A top-up has three steps: WheelsAI prepares the transfer, the wallet signs it, and you send the signed transfer
        back. Credits are added once the network confirms the transfer, and only once.
      </p>
      <p>
        <code>rails.wallet</code> in <a href="#packages">the packages answer</a> says whether wallet top-ups are open, and{" "}
        <code>rails.walletAssets</code> lists the assets you can pay in. Every answer about a top-up, a refusal included,
        carries <code>message</code>: a plain sentence you can show to the person paying.
      </p>
      <DocTable
        caption="The statuses of a top-up"
        columns={[
          { key: "status", label: "Status" },
          { key: "meaning", label: "What it means" },
        ]}
        rows={[
          { status: <code>prepared</code>, meaning: "The transfer is ready to sign. Nothing has been sent." },
          {
            status: (
              <>
                <code>submitting</code>, <code>submitted</code>
              </>
            ),
            meaning: "The signed transfer was received and is being confirmed on the network.",
          },
          { status: <code>credited</code>, meaning: "The transfer was confirmed and the credits are in your balance. Final." },
          { status: <code>failed</code>, meaning: "The transfer failed on the network, so no payment was taken. Final." },
          { status: <code>expired</code>, meaning: "The top-up ran out of time, or the network never took the transfer. Nothing was taken. Final." },
        ]}
      />

      <Endpoint id="topup-prepare" method="POST" path="/api/billing/topups/prepare" auth="API key or session" title="Prepare a top-up">
        <Fields
          fields={[
            { name: "amountUsd", type: "number", required: true, description: "US dollars, 5 to 10,000." },
            {
              name: "asset",
              type: "\"USDC\" | \"SOL\"",
              required: true,
              description: <>An asset listed in <code>rails.walletAssets</code>.</>,
            },
            {
              name: "payerAddress",
              type: "string",
              description: (
                <>
                  The Solana wallet that signs and pays. It does not have to be linked to your account. When it is left
                  out, the wallet your session signed in with pays.
                </>
              ),
            },
          ]}
        />
        <CodeBlock
          language="json"
          code={`{
  "topupId": "...",
  "unsignedTxBase64": "...",
  "depositAddress": "...",
  "payerAddress": "...",
  "asset": "USDC",
  "amountUsd": 50,
  "bonusUsd": 5,
  "amountRaw": "50000000",
  "quote": null,
  "opensUsdcAccount": false,
  "expiresAt": "...",
  "message": "Confirm the transfer in your wallet."
}`}
        />
        <ul>
          <li>
            <code>unsignedTxBase64</code> is the whole transfer, from the paying wallet to your organization&apos;s{" "}
            <code>depositAddress</code>, ready to sign.
          </li>
          <li>
            <code>amountRaw</code> is the amount the wallet sends in the asset&apos;s base units, as a string. One USDC is
            1,000,000 base units, so a USDC amount is exactly the dollar amount.
          </li>
          <li>
            For SOL, <code>quote</code> is <code>&#123; solPriceUsd, validUntil &#125;</code> and{" "}
            <code>quotedSolPriceUsd</code> repeats the price. The price holds for 60 seconds. For USDC,{" "}
            <code>quote</code> is <code>null</code> and the top-up can be sent for 120 seconds. <code>expiresAt</code> is
            the moment either one runs out.
          </li>
          <li>
            <code>opensUsdcAccount</code> is true when this is your organization&apos;s first USDC payment. That transfer
            also opens your organization&apos;s USDC account, which costs the paying wallet about 0.002 SOL once.
          </li>
          <li>
            <code>bonusUsd</code> is the bonus this amount earns, added with the credits.
          </li>
        </ul>
        <p>You can prepare at most 10 top-ups a minute. Nothing is taken by a refusal:</p>
        <DocTable
          caption="Refusals of prepare"
          columns={[
            { key: "status", label: "Status" },
            { key: "error", label: "error" },
            { key: "when", label: "When" },
          ]}
          rows={[
            { status: "400", error: <code>invalid_payload</code>, when: "The body is not the one described above." },
            { status: "400", error: <code>invalid_amount</code>, when: "The amount is outside $5 to $10,000." },
            { status: "400", error: <code>wallet_required</code>, when: "No payerAddress was sent and the session has no wallet." },
            { status: "400", error: <code>invalid_payer_address</code>, when: "The payer is not a Solana wallet address that can pay." },
            { status: "400", error: <code>asset_unavailable</code>, when: "SOL was asked for and is not offered. Pay with USDC." },
            { status: "409", error: <code>wallet_balance_short</code>, when: "The wallet holds less than the top-up needs." },
            { status: "501", error: <code>wallet_topups_not_enabled</code>, when: "Wallet top-ups are not open." },
            {
              status: "502, 503",
              error: (
                <>
                  <code>rpc_unavailable</code>, <code>chain_unavailable</code>
                </>
              ),
              when: "Wallet payments are paused for a moment. Try again shortly.",
            },
            {
              status: "503",
              error: <code>price_unavailable</code>,
              when: "No current SOL price could be read, so nothing was prepared. USDC is not affected.",
            },
          ]}
        />
      </Endpoint>

      <Endpoint id="topup-submit" method="POST" path="/api/billing/topups/{topupId}/submit" auth="API key or session" title="Send the signed transfer">
        <Fields
          fields={[
            {
              name: "signedTxBase64",
              type: "string",
              required: true,
              description: "The prepared transfer, signed by the paying wallet, as base64.",
            },
          ]}
        />
        <p>
          Sign the transfer as it was prepared. A wallet may add its own fee setting; any other change is refused and
          nothing is sent. The answer is <code>200</code> when the transfer was confirmed during the call:
        </p>
        <CodeBlock
          language="json"
          code={`{
  "status": "credited",
  "message": "Added $55.00 in credits: $50.00 paid and a $5.00 bonus.",
  "txSignature": "...",
  "grantedUsd": 55,
  "balanceUsd": 67.5
}`}
        />
        <p>
          and <code>202</code> when it was sent and is still being confirmed, with <code>status</code>{" "}
          <code>submitting</code> or <code>submitted</code>:
        </p>
        <CodeBlock
          language="json"
          code={`{
  "status": "submitted",
  "message": "Your transfer was sent and is being confirmed. Your credits appear as soon as it is, usually within a minute. You can leave this page.",
  "txSignature": "...",
  "pendingConfirmation": true
}`}
        />
        <p>
          After a <code>202</code> you do not have to do anything: the credits are added when the network confirms the
          transfer. To follow it, call <a href="#topup-reconcile">reconcile</a> or read{" "}
          <a href="#topup-get">the top-up</a> until its status is final. A <code>202</code> can also say that WheelsAI
          could not confirm the network took the transfer. If it goes through, your credits are added within a few
          minutes. If it does not, nothing is taken.
        </p>
        <p>
          Sending the same signed transfer again is safe. It is not sent to the network twice, and the answer is where the
          top-up stands now, with <code>alreadyCredited: true</code> once the credits were added by an earlier call.
        </p>
        <DocTable
          caption="Refusals of submit"
          columns={[
            { key: "status", label: "Status" },
            { key: "error", label: "error" },
            { key: "when", label: "When" },
          ]}
          rows={[
            { status: "400", error: <code>unreadable_transaction</code>, when: "The signed transfer could not be read. It was not sent." },
            { status: "400", error: <code>message_mismatch</code>, when: "The signed transfer is not the one that was prepared. It was not sent." },
            { status: "404", error: <code>topup_not_found</code>, when: "No top-up of your organization has this id." },
            {
              status: "409",
              error: (
                <>
                  <code>in_flight</code>, <code>duplicate_signature</code>
                </>
              ),
              when: "This top-up is already being confirmed. You do not need to send it again.",
            },
            { status: "410", error: <code>topup_expired</code>, when: "The top-up ran out of time. Prepare a new one." },
            { status: "410", error: <code>topup_failed</code>, when: "The top-up has already failed. Prepare a new one." },
            { status: "501", error: <code>wallet_topups_not_enabled</code>, when: "Wallet top-ups are not open." },
            { status: "503", error: <code>chain_unavailable</code>, when: "Wallet payments are paused for a moment. Try again shortly." },
          ]}
        />
      </Endpoint>

      <Endpoint id="topup-reconcile" method="POST" path="/api/billing/topups/{topupId}/reconcile" auth="API key or session" title="Check a top-up against the network">
        <p>
          Send an empty JSON object. WheelsAI checks the network for this top-up and answers where it stands:{" "}
          <code>status</code> and <code>message</code>, with <code>txSignature</code>, <code>grantedUsd</code> and{" "}
          <code>balanceUsd</code> once it is credited, and <code>pendingConfirmation: true</code> while the transfer is
          still being confirmed. It is safe to call as often as you like and never adds credits twice.
        </p>
      </Endpoint>

      <Endpoint id="topup-get" method="GET" path="/api/billing/topups/{topupId}" auth="API key or session" title="Read one top-up">
        <CodeBlock
          language="json"
          code={`{
  "id": "...",
  "status": "credited",
  "message": "Added $55.00 in credits: $50.00 paid and a $5.00 bonus.",
  "asset": "USDC",
  "amountUsd": 50,
  "bonusUsd": 5,
  "txSignature": "...",
  "depositAddress": "...",
  "payerAddress": "...",
  "createdAt": "...",
  "expiresAt": "..."
}`}
        />
        <p>
          <code>txSignature</code> is present once a signed transfer was received. <code>message</code> says in a
          sentence where the top-up stands, including why one failed or expired.
        </p>
      </Endpoint>

      <Endpoint id="topup-list" method="GET" path="/api/billing/topups" auth="API key or session" title="List recent top-ups">
        <p>
          Returns <code>&#123; topups &#125;</code>: your organization&apos;s last 20 top-ups, newest first, each in the
          shape above. Read it when a page opens to pick up a top-up that is still being confirmed.
        </p>
      </Endpoint>

      <h2 id="deposits">Deposit address</h2>
      <p>
        Your organization has its own address for USDC and SOL on Solana. Send to it from an exchange or from any
        wallet: there is no top-up to prepare and nothing to sign with WheelsAI. Each transfer is added to your credits
        once. These endpoints take an <strong>API key or a session</strong>.
      </p>
      <p>
        <code>rails.deposits</code> in <a href="#packages">the packages answer</a> says whether the deposit address is
        open. Every answer here, a refusal included, carries <code>message</code>: a plain sentence you can show as it
        is.
      </p>
      <ul>
        <li>
          Send on the Solana network only, on the network named in <code>network</code>. A transfer on another network
          cannot be recovered.
        </li>
        <li>Only USDC and SOL are credited, and SOL only while it is offered.</li>
        <li>
          USDC is credited one dollar for one USDC. SOL is credited at its dollar value when WheelsAI sees your
          transfer.
        </li>
        <li>
          Transfers are usually credited within a few minutes, with no call from you.{" "}
          <a href="#deposit-address-check">Check now</a> looks at once.
        </li>
      </ul>
      <p>While deposits are not open, or are paused for a moment, every endpoint here answers with one of:</p>
      <DocTable
        caption="Refusals of every deposit endpoint"
        columns={[
          { key: "status", label: "Status" },
          { key: "error", label: "error" },
          { key: "when", label: "When" },
        ]}
        rows={[
          { status: "501", error: <code>deposits_not_enabled</code>, when: "The deposit address is not open." },
          {
            status: "503",
            error: (
              <>
                <code>deposit_address_unavailable</code> or <code>deposits_unavailable</code>
              </>
            ),
            when: "Deposits are paused for a moment. Nothing sent to your address is lost. Try again shortly.",
          },
        ]}
      />

      <Endpoint id="deposit-address-get" method="GET" path="/api/billing/deposit-address" auth="API key or session" title="Read the address">
        <CodeBlock
          language="json"
          code={`{
  "address": "...",
  "network": "mainnet-beta",
  "assets": [
    { "asset": "USDC", "accountOpen": true },
    { "asset": "SOL", "offered": true }
  ],
  "message": "Send USDC or SOL on Solana to this address. It belongs to your organization only. USDC is credited one dollar for one USDC. SOL is credited at its dollar value when we see your transfer, usually within a few minutes."
}`}
        />
        <ul>
          <li>
            <code>address</code> is <code>null</code> until the address is <a href="#deposit-address-issue">issued</a>,
            and <code>message</code> then says that your organization has no deposit address yet. Reading never creates
            or changes anything.
          </li>
          <li>
            <code>network</code> is <code>mainnet-beta</code> or <code>devnet</code>.
          </li>
          <li>
            The USDC entry of <code>assets</code> has <code>accountOpen</code>: whether the USDC account at the address
            exists. If a sender says the address cannot receive USDC yet,{" "}
            <a href="#deposit-address-usdc">prepare the address</a>.
          </li>
          <li>
            The SOL entry has <code>offered</code>. While it is false, send USDC only.
          </li>
        </ul>
      </Endpoint>

      <Endpoint id="deposit-address-issue" method="POST" path="/api/billing/deposit-address" auth="API key or session" title="Issue the address">
        <p>
          Send no body. Issues your organization&apos;s address and answers in the shape above, with the address. It is
          safe to repeat: an organization has one address, and every call answers with it.
        </p>
      </Endpoint>

      <Endpoint id="deposit-address-usdc" method="POST" path="/api/billing/deposit-address/usdc-account" auth="API key or session" title="Prepare the address for USDC">
        <p>
          Send no body. Opens the USDC account at your address, for a sender that says the address cannot receive USDC
          yet. The answer can take up to a minute, so give the call time.
        </p>
        <CodeBlock language="json" code={`{ "accountOpen": true, "message": "Your address can now receive USDC." }`} />
        <p>
          The answer is the same when the account was already open. You can call this at most 3 times a minute.
        </p>
        <DocTable
          caption="Refusals of preparing the address"
          columns={[
            { key: "status", label: "Status" },
            { key: "error", label: "error" },
            { key: "when", label: "When" },
          ]}
          rows={[
            { status: "404", error: <code>deposit_address_not_issued</code>, when: "Your organization has no deposit address yet. Issue it first." },
            { status: "403", error: <code>not_eligible</code>, when: "Verify your email or make one purchase first, then prepare the address." },
            {
              status: "429, 503",
              error: (
                <>
                  <code>daily_limit</code>, <code>unavailable</code>
                </>
              ),
              when: "The address cannot be prepared right now. Send SOL when it is offered, or try again later.",
            },
          ]}
        />
      </Endpoint>

      <Endpoint id="deposit-address-check" method="POST" path="/api/billing/deposit-address/check" auth="API key or session" title="Check for transfers now">
        <p>
          Send no body. WheelsAI looks for new transfers to your address now and answers what this call credited and
          what is still waiting:
        </p>
        <CodeBlock
          language="json"
          code={`{
  "credited": [
    { "asset": "USDC", "amount": "50.00", "creditedUsd": 50, "bonusUsd": 5, "txSignature": "..." }
  ],
  "waiting": [],
  "message": "Credited $55.00 from your transfer: $50.00 sent and a $5.00 bonus."
}`}
        />
        <ul>
          <li>
            <code>amount</code> is the transfer in whole units, as a string. USDC has two decimals (<code>50.00</code>),
            or up to six when it is not whole cents. SOL has no trailing zeros (<code>0.5</code>).
          </li>
          <li>
            <code>creditedUsd</code> and <code>bonusUsd</code> are US dollars: what the transfer itself added, and the
            bonus added with it.
          </li>
          <li>
            <code>waiting</code> lists every transfer of your organization that was seen and is not credited yet, each
            with <code>asset</code>, <code>amount</code> and <code>txSignature</code>. A SOL transfer waits while no
            current SOL price can be read, and is credited as soon as one can.
          </li>
          <li>
            When nothing new has arrived, both lists are empty and <code>message</code> says so.
          </li>
        </ul>
        <p>
          It is safe to call again: a transfer is never credited twice. You can call this at most 6 times a minute.
        </p>
        <DocTable
          caption="Refusals of the check"
          columns={[
            { key: "status", label: "Status" },
            { key: "error", label: "error" },
            { key: "when", label: "When" },
          ]}
          rows={[
            { status: "404", error: <code>deposit_address_not_issued</code>, when: "Your organization has no deposit address yet. Issue it first." },
            {
              status: "503",
              error: <code>chain_unavailable</code>,
              when: "Deposits are paused for a moment. Nothing sent to your address is lost. Try again shortly.",
            },
          ]}
        />
      </Endpoint>

      <Endpoint id="deposit-list" method="GET" path="/api/billing/deposits" auth="API key or session" title="List recent deposits">
        <CodeBlock
          language="json"
          code={`{
  "deposits": [
    {
      "id": "...",
      "asset": "USDC",
      "amount": "50.00",
      "status": "credited",
      "creditedUsd": 50,
      "bonusUsd": 5,
      "txSignature": "...",
      "createdAt": "...",
      "creditedAt": "...",
      "message": "Credited $55.00: $50.00 sent and a $5.00 bonus."
    }
  ]
}`}
        />
        <p>
          The last 20 transfers sent straight to your organization&apos;s address, newest first. A transfer you prepared
          as a <a href="#topups">wallet top-up</a> is listed with <a href="#topup-list">the top-ups</a> instead.{" "}
          <code>creditedUsd</code> is <code>null</code> until the transfer is credited.
        </p>
        <DocTable
          caption="The statuses of a deposit"
          columns={[
            { key: "status", label: "Status" },
            { key: "meaning", label: "What it means" },
          ]}
          rows={[
            { status: <code>credited</code>, meaning: "The transfer is in your credit balance." },
            {
              status: <code>waiting</code>,
              meaning: "The transfer was seen. It is credited as soon as a current SOL price can be read.",
            },
            { status: <code>ignored</code>, meaning: "The transfer was too small to credit." },
          ]}
        />
      </Endpoint>

      <h2 id="link-wallet">Link a wallet</h2>
      <p>
        Linking adds a Solana wallet to your account, so your session carries it. You do not need a linked wallet to pay:
        a top-up takes the paying wallet in <code>payerAddress</code>, and a transfer to{" "}
        <a href="#deposits">your deposit address</a> needs no wallet here at all. Linking is two calls: ask for a nonce, then send
        the wallet&apos;s signature of it.
      </p>

      <Endpoint id="link-wallet-nonce" method="POST" path="/api/settings/link-wallet/nonce" auth="Session" title="Ask for a nonce">
        <Fields fields={[{ name: "walletAddress", type: "string", required: true, description: "The Solana wallet to link." }]} />
        <p>
          Returns <code>&#123; nonce, walletAddress &#125;</code>. The wallet signs the <code>nonce</code> text exactly as
          it is. A nonce works once, and only for the wallet it was issued to.
        </p>
      </Endpoint>

      <Endpoint id="link-wallet-verify" method="POST" path="/api/settings/link-wallet" auth="Session" title="Link the wallet">
        <Fields
          fields={[
            { name: "walletAddress", type: "string", required: true, description: "The wallet the nonce was issued to." },
            { name: "signature", type: "string", required: true, description: "The wallet's signature of the nonce text, base58 encoded." },
            { name: "nonce", type: "string", required: true, description: "The nonce from the call above." },
          ]}
        />
        <p>
          Returns <code>&#123; walletAddress, message &#125;</code> and issues your session cookie again, so the session
          carries the wallet at once.
        </p>
        <DocTable
          caption="Refusals of linking a wallet"
          columns={[
            { key: "status", label: "Status" },
            { key: "error", label: "error" },
            { key: "when", label: "When" },
          ]}
          rows={[
            { status: "400", error: <code>invalid_wallet_address</code>, when: "The address is not a Solana wallet address." },
            { status: "400", error: <code>invalid_signature</code>, when: "The signature could not be checked against the wallet and the nonce." },
            { status: "401", error: <code>invalid_nonce</code>, when: "The nonce has expired, was already used, or was issued to another wallet. Ask for a new one." },
            { status: "409", error: <code>wallet_in_use</code>, when: "The wallet already signs in to another WheelsAI account. Nothing is changed." },
          ]}
        />
      </Endpoint>
    </DocPage>
  );
}
