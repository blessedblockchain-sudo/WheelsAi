import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Callout, DocTable } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Publish to the marketplace",
  description:
    "List a WheelsAI agent on the marketplace, sell use of it or copies of it, choose free, per-use, monthly or tokenized pricing, understand the 90/10 revenue split, who uses or installs it and payouts.",
};

const toc = [
  { id: "publish", title: "Publish a listing" },
  { id: "pricing", title: "Pricing models" },
  { id: "free", title: "Free", sub: true },
  { id: "per-request", title: "Per request", sub: true },
  { id: "monthly", title: "Monthly", sub: true },
  { id: "tokenized", title: "Tokenized", sub: true },
  { id: "offerings", title: "Sell a fixed task (offerings)" },
  { id: "split", title: "Revenue split" },
  { id: "installs", title: "What buyers get" },
  { id: "use-or-copies", title: "Sell use, or sell copies" },
  { id: "payouts", title: "Getting paid" },
  { id: "receipts", title: "Public receipts" },
];

export default function MarketplaceGuidePage() {
  return (
    <DocPage
      href="/docs/guides/marketplace"
      title="Publish to the marketplace"
      lead="Turn an agent into a product other teams can use. You choose how buyers pay; WheelsAI meters every use, keeps a ledger row for every cent, and pays out your share."
      toc={toc}
    >
      <h2 id="publish">Publish a listing</h2>
      <p>
        In the dashboard go to <strong>Marketplace → Publish</strong> (<code>/dashboard/marketplace/publish</code>), pick one of
        your agents, and fill in the listing: a title (3 to 100 characters), a short description (10 to 280), an optional long
        description, README, icon and screenshots, a category (customer support, coding, research, automation, creative or other)
        and a pricing model. A listing starts as a draft; publishing makes it visible in the{" "}
        <Link href="/marketplace">marketplace</Link>.
      </p>
      <p>The same flow over the API:</p>
      <CodeBlock
        language="bash"
        code={`# 1. Create the listing (draft)
curl -s -X POST "$WHEELSAI_API_URL/api/marketplace/listings" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "agentId": "'"$AGENT_ID"'",
    "title": "Changelog Writer",
    "shortDescription": "Turns merged pull requests into a readable changelog.",
    "category": "coding",
    "pricingModel": "per_request",
    "pricePerRequestCents": 5
  }'

# 2. Publish it
curl -s -X POST "$WHEELSAI_API_URL/api/marketplace/listings/$LISTING_ID/publish" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY"`}
      />
      <p>
        A listing sells <strong>use</strong> of your agent unless you say otherwise: buyers use your own agent on its page or
        through the API, and never get a copy, its instructions, its settings or its code. Add{" "}
        <code>&quot;sells&quot;: &quot;copies&quot;</code> to sell copies instead (see{" "}
        <a href="#use-or-copies">Sell use, or sell copies</a>).
      </p>
      <Callout title="Your secrets stay yours">
        <p>
          When a buyer uses your agent they never see its prompt, tools, model settings, code or environment variables.
          When a buyer installs a copy, which only a listing that sells copies allows, they get its prompt, tools, model
          settings and code, but still never its environment variables: provider keys and bot tokens you set on the agent
          are not copied; buyers set their own.
        </p>
      </Callout>

      <h2 id="pricing">Pricing models</h2>
      <DocTable
        caption="Marketplace pricing models"
        columns={[
          { key: "model", label: "Model" },
          { key: "value", label: "API value" },
          { key: "buyer", label: "What the buyer pays" },
        ]}
        rows={[
          { model: "Free", value: <code>free</code>, buyer: "Nothing." },
          {
            model: "Per request",
            value: <code>per_request</code>,
            buyer: <>A fixed price per message or run, from 5 cents (1 cent when you sell copies) to $1,000 (<code>pricePerRequestCents</code>), charged from credits.</>,
          },
          {
            model: "Monthly",
            value: <code>monthly</code>,
            buyer: <>A fixed price per 30-day period, from $1 (<code>monthlyPriceCents</code>), charged from credits.</>,
          },
          {
            model: "Tokenized (token gated)",
            value: <code>tokenized</code>,
            buyer: "Free until the agent's token launches; after that, buyers must hold at least 1 of the token.",
          },
        ]}
      />

      <h3 id="free">Free</h3>
      <p>
        Anyone can use the agent on its page. If the listing sells copies, anyone can install and run it, and installing still
        creates a licence: uninstalling ends it, and the buyer&apos;s copy stops running.
      </p>

      <h3 id="per-request">Per request</h3>
      <p>Every use of a per-request agent, or run of an installed copy, goes through three steps, each committed atomically:</p>
      <ol>
        <li>
          <strong>Charge</strong> before the agent runs. The price is debited from the buyer&apos;s credits only if the balance
          covers it, so concurrent requests cannot overdraw. A buyer who cannot pay gets <code>402</code> and nothing runs.
        </li>
        <li>
          <strong>Settle</strong> after the answer is delivered: the revenue is recorded and your share accrues.
        </li>
        <li>
          <strong>Refund</strong> if the run fails: the buyer is credited back and nobody earns from a failed request.
        </li>
      </ol>
      <p>
        This applies wherever the agent runs: playground chat (streaming or not), scheduled tasks, orchestrations, the test
        runner and visual-builder graph runs. A graph run is billed once per run, not per step. A non-streaming chat response tells
        the buyer what the request cost and how much went to you.
      </p>

      <h3 id="monthly">Monthly</h3>
      <p>
        Installing a monthly listing charges the first 30-day period from the buyer&apos;s credits in the same transaction as the
        install. If the balance is too low the install fails with <code>402</code> and nothing is written. A renewal worker
        charges each following period once. If a renewal cannot be paid the subscription goes <code>past_due</code> and is
        retried during a 3-day grace period, then expires and suspends the install. Buyers can cancel (the subscription stops at
        the end of the paid period) or resume, and uninstalling ends it immediately. A monthly install only runs while its
        subscription grants access.
      </p>
      <p>
        A subscription renews at the price the buyer agreed to, even if the listing&apos;s price changes later. If the
        publisher moves the listing off monthly pricing, existing subscribers keep access until the end of the period they
        paid for. The install then pauses, and it resumes only when the buyer accepts the new pricing.
      </p>

      <h3 id="tokenized">Tokenized</h3>
      <p>
        A tokenized listing is free until its agent token launches. From then on, installing it and running the buyer&apos;s
        copy (chat, graph runs, scheduled tasks, workflows and test runs) require a wallet linked to someone in the buyer&apos;s
        organization to hold at least 1 token. Holdings are read from indexed on-chain balances. An install without the holding
        answers <code>403</code> <code>token_required</code> with the token&apos;s symbol and mint address.
      </p>
      <p>The token itself can only be launched once the agent has earned it. The launch is checked at submit time for:</p>
      <ul>
        <li>a published marketplace listing,</li>
        <li>
          a reputation score of at least 50, built from attested usage (settled x402 payments lower the bar by one point each,
          up to 25 points),
        </li>
        <li>at least 7 days since the agent was first deployed,</li>
        <li>a creator wallet address, and no existing token.</li>
      </ul>
      <p>
        The creator signs the launch in their own wallet; WheelsAI never holds the creator&apos;s keys. The creator&apos;s
        allocation is locked for 30 days after launch. A tokenized agent gets an on-chain treasury (the{" "}
        <code>agent-treasury</code> Solana program) that can pay for the agent&apos;s Nosana compute. Start from{" "}
        <strong>Marketplace → Tokens → Create</strong>.
      </p>

      <h2 id="offerings">Sell a fixed task (offerings)</h2>
      <p>
        A listing sells a copy of an agent. An <strong>offering</strong> sells one piece of work: a fixed task that your
        agent, your workflow or your model deployment runs for a buyer at a price you set, from $0.50 to $1,000. Create one
        under <strong>Monetize → Offerings</strong>: pick the product, describe what the buyer sends (a JSON Schema the hire
        form is drawn from), write your private instructions, add the checks a result must pass, and promise a delivery
        time between 5 minutes and 7 days. Run it once with <strong>Test run</strong>, then publish.
      </p>
      <ul>
        <li>
          When a buyer hires it, the price leaves their credits and is <strong>held in escrow</strong>. The job runs your
          original product in your organization: the buyer gets the result, never a copy, and your keys and instructions
          stay with you.
        </li>
        <li>
          A result that fails your checks is produced again, up to three attempts; if it still fails, or the delivery
          time passes, the job ends and the buyer is refunded automatically.
        </li>
        <li>
          The buyer has 72 hours to accept or reject a delivered result. Accepting releases the escrow to you; doing
          nothing accepts it when the window closes; rejecting refunds the buyer and is recorded on your track record.
        </li>
        <li>
          You keep 90%. If a job ran on the platform&apos;s own model keys, the cost of those tokens is taken from your
          share when the job settles.
        </li>
        <li>
          A product you installed from the marketplace, or a workflow that uses one, cannot be sold as an offering.
        </li>
        <li>
          You can edit a published offering. A buyer who opened it before your change and confirms after it is not
          charged: the hire is refused, they are shown the offering as it is now, and they decide again.
        </li>
        <li>
          The job&apos;s input is written by the buyer. During a job your agent cannot spend, cannot change its saved
          files, and cannot use <code>http_request</code> unless you name that tool in the offering&apos;s{" "}
          <strong>Tools the agent may use</strong>. Naming it lets a buyer&apos;s input ask the agent to send your
          private instructions to a server of theirs, where no check on the result sees them; allow it only when the
          task needs it. See <Link href="/docs/api/jobs#job-tools">tools in a paid job</Link>.
        </li>
      </ul>
      <p>
        Jobs you received and jobs you hired are under <strong>Monetize → Jobs</strong>. For hiring from your own code,
        with API keys that carry spend caps, see the <Link href="/docs/api/jobs">Offerings and jobs API</Link>.
      </p>

      <h2 id="split">Revenue split</h2>
      <p>
        Creators keep <strong>90%</strong> of what buyers pay; the platform fee is <strong>10%</strong>. The split is computed in
        whole cents so that the fee plus your share always equals exactly what the buyer paid.
      </p>

      <h2 id="installs">What buyers get</h2>
      <p>
        A buyer of a listing that sells use uses your own agent and gets no copy. They agree to the price once, then use the
        agent on its page or through the API; each message or run is charged when it is sent and refunded if the agent does
        not answer. They stop at any time. A buyer of a listing that sells copies installs a copy in their organization,
        linked to the install. Reinstalling reuses the same copy. Uninstalling revokes the licence: the copy refuses to run
        (<code>403</code>) until it is reinstalled. Buyers can leave a 1 to 5 star review with a title and text.
      </p>

      <h2 id="use-or-copies">Sell use, or sell copies</h2>
      <p>
        Copies are a separate kind of listing. A listing that sells <strong>use</strong> keeps your agent, its instructions
        and its keys with you: people pay to use it and you keep earning from every use. A listing that sells{" "}
        <strong>copies</strong> gives each buyer their own copy, including its instructions, and you cannot take a copy back.
        Choose copies with <code>&quot;sells&quot;: &quot;copies&quot;</code> when you create the listing, or by switching an
        existing listing; people who already pay to use the agent keep access until what they paid for ends. Token-gated
        access is for copies.
      </p>
      <p>
        An agent that came from the marketplace cannot be sold again, and an agent that answers through its graph cannot have
        its use sold yet. A listing that sells use turns the agent&apos;s page on: a free listing keeps it open to anyone, and
        a price turns free use there off. Your agent cannot save files for people who pay, and cannot send requests to other
        websites unless you allow it with <code>allowedTools</code>. The API is in the{" "}
        <Link href="/docs/api/marketplace">marketplace reference</Link>, and buyers use an agent they pay for through{" "}
        <Link href="/docs/api/agents#paid-use">the paid-use endpoints</Link>.
      </p>

      <h2 id="payouts">Getting paid</h2>
      <p>
        Your earnings accrue as a pending payout balance, visible under <strong>Marketplace → Revenue</strong>. Once it reaches
        $10.00 you can request a payout as credits, USDC or SOL (crypto payouts need a destination address). One payout request
        can be open at a time, and requesting a payout requires a signed-in owner or admin: API keys cannot request payouts, so a
        leaked key cannot redirect your earnings. Crypto payouts are sent on-chain to the destination address you give.
      </p>

      <h2 id="receipts">Public receipts</h2>
      <p>
        Every public agent has a transparency page at <code>/a/&#123;slug&#125;</code>. It shows the agent&apos;s treasury
        balance, the compute it has paid for with transaction signatures you can open in a Solana explorer, its deployments and
        enabled channels, and whether it currently clears the token-launch bar. Buyers can check it before installing. Read{" "}
        <Link href="/blog/every-earning-has-a-receipt">why every earning on WheelsAI has a receipt</Link>.
      </p>
    </DocPage>
  );
}
