import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Callout, DocTable } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Publish to the marketplace",
  description:
    "List a WheelsAI agent on the marketplace, sell use of it or copies of it, choose free, per-use, monthly or tokenized pricing, add plans with a number of uses, understand the 90/10 revenue split, who uses or installs it and payouts.",
};

const toc = [
  { id: "sell", title: "Sell from the agent's page" },
  { id: "who-can-use", title: "Who can use it?", sub: true },
  { id: "plans", title: "Plans", sub: true },
  { id: "earn", title: "What you earn", sub: true },
  { id: "guaranteed", title: "Guaranteed delivery", sub: true },
  { id: "model-stops", title: "When the model stops", sub: true },
  { id: "publish", title: "Publish a listing" },
  { id: "pricing", title: "Pricing models" },
  { id: "free", title: "Free", sub: true },
  { id: "per-request", title: "Per request", sub: true },
  { id: "monthly", title: "Monthly", sub: true },
  { id: "tokenized", title: "Tokenized", sub: true },
  { id: "offerings", title: "Sell a fixed task (offerings)" },
  { id: "split", title: "Revenue split" },
  { id: "installs", title: "What buyers get" },
  { id: "using", title: "Using an agent", sub: true },
  { id: "on-a-plan", title: "On a plan", sub: true },
  { id: "owning", title: "Owning a copy", sub: true },
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
      <h2 id="sell">Sell from the agent&apos;s page</h2>
      <p>
        Open one of your agents and choose its <strong>Sell</strong> tab. It asks one question,{" "}
        <strong>Who can use it?</strong>, and saving your answer puts the agent on sale. People use your agent on its page
        or through the API. They never get its instructions, its settings or its code. Buyers see it as sold by your
        organization&apos;s name, which an owner or admin can change under <strong>Account</strong>.
      </p>

      <h3 id="who-can-use">Who can use it?</h3>
      <p>Use is sold in three ways:</p>
      <DocTable
        caption="The three ways use is sold"
        columns={[
          { key: "choice", label: "Choice" },
          { key: "what", label: "What it means" },
          { key: "price", label: "Price" },
        ]}
        rows={[
          {
            choice: "Free",
            what: "Anyone with the link can use it. No sign-in. Their use counts toward your plan.",
            price: "None",
          },
          {
            choice: "Pay per use",
            what: "People pay for each message, or for each run of a task agent, from their WheelsAI credits. Charged when they send it. Refunded if your agent does not answer.",
            price: "From $0.05",
          },
          {
            choice: "Monthly",
            what: "People pay every 30 days and can use it up to 200 times a day. For an agent that runs on its own, they pay every 30 days to read its results on its page and through the API.",
            price: "From $1.00",
          },
        ]}
      />
      <p>
        An agent you talk to is sold free, per message or by the month. A task agent is sold free, per run or by the month.
        An agent that runs on its own is sold free or by the month. People sign in to pay, and they pay from WheelsAI
        credits. Setting a price turns off free use on the agent&apos;s page.
      </p>
      <p>
        Your agent cannot save files for people who pay, and cannot send requests to other websites unless you allow it
        on the Sell tab.
      </p>

      <h3 id="plans">Plans</h3>
      <p>
        An agent sold with <strong>Pay per use</strong> can also offer plans. A plan is one price for 30 days with a
        number of uses included. Buyers who use your agent often choose a plan; everybody else keeps paying per use.
        Under <strong>Plans</strong> on the Sell tab, choose <strong>Add a plan</strong> and fill in:
      </p>
      <DocTable
        caption="What a plan is made of"
        columns={[
          { key: "field", label: "Field" },
          { key: "what", label: "What it is" },
          { key: "rule", label: "Rule" },
        ]}
        rows={[
          { field: "Name", what: "What buyers see on the plan, such as Starter.", rule: "Up to 40 characters." },
          { field: "Price for 30 days", what: "Charged from the buyer's credits when they start, and every 30 days after that.", rule: "From $1.00." },
          { field: "Uses included", what: "How many messages or runs the 30 days include.", rule: "1 to 100,000, and at most 100 for each dollar of the price: $9.00 includes up to 900 uses." },
          { field: "When they run out", what: "Stop until the next 30 days, or charge for each extra use.", rule: "An extra use costs from $0.05." },
        ]}
      />
      <ul>
        <li>A listing can have up to four plans. Every plan has a count of uses.</li>
        <li>
          Buyers see your plans on the agent&apos;s page and on its API page, each as its price, its uses and what
          happens after them: &quot;$9.00 for 30 days&quot;, &quot;500 uses&quot;, &quot;then $0.05 a use&quot; or
          &quot;then it stops until it renews&quot;. Its listing and its card in the marketplace say the smallest plan
          price: &quot;Plans from $9.00 for 30 days.&quot;
        </li>
        <li>
          <strong>Changing a plan</strong> changes it for people who start it from then on. People already on it keep
          what they agreed to, and renew at the price and with the uses they agreed to.
        </li>
        <li>
          <strong>End plan</strong> takes a plan off offer. People on it finish the 30 days they paid for and are not
          charged again.
        </li>
        <li>
          Plans go with a listing sold per use. An agent that runs on its own is sold by the month and has no plans,
          and a listing that sells copies has none.
        </li>
        <li>
          You keep 90% of each plan payment and of each extra use, as for every other sale.
        </li>
      </ul>
      <p>
        Over the API, send the whole set with{" "}
        <Link href="/docs/api/marketplace#plans"><code>PUT /api/marketplace/listings/&#123;id&#125;/plans</code></Link>.
      </p>

      <h3 id="earn">What you earn</h3>
      <p>
        You keep 90% of each payment, worked out in whole cents: at $0.05 a message you earn $0.04, and at $9.00 a month
        or for a plan&apos;s 30 days you earn $8.10. When your agent runs on WheelsAI&apos;s models, the cost of the model comes out of your share. Each
        sale is a row under <strong>Earnings</strong>: a per-use sale reads <strong>Paid use</strong>, with its model
        cost beside it when there is one.
      </p>

      <h3 id="guaranteed">Guaranteed delivery</h3>
      <p>
        A task agent can also be sold with guaranteed delivery, under <strong>More options</strong> on the Sell tab: a
        fixed price per task, from $0.50, held until the result is delivered and checked, and refunded if it is late. The
        buyer fills in your agent&apos;s own form. If you change that form after putting the agent on sale, buyers still
        see the earlier form until you choose <strong>Show buyers the new form</strong>. This is an{" "}
        <a href="#offerings">offering</a> made from the agent&apos;s form.
      </p>
      <p>
        Copies are sold only when you ask for them. <strong>Sell copies instead</strong>, also under More options, gives
        each buyer their own copy, including its instructions, and you cannot take a copy back; see{" "}
        <a href="#use-or-copies">Sell use, or sell copies</a>.
      </p>

      <h3 id="model-stops">When the model stops</h3>
      <p>
        An agent can answer from a model your organization runs on a GPU. When that deployment stops, the agent cannot
        answer, and a listing that sells use of it is <strong>paused</strong> for as long as the model is not running.
        Agents on any other model are never paused.
      </p>
      <ul>
        <li>Nobody can start using the agent, and nobody is charged.</li>
        <li>
          People who pay monthly keep the days they paid for: no subscription is renewed while the listing is paused,
          and a month already paid for is made longer by that time.
        </li>
        <li>
          It goes back on sale by itself when the model runs again. Deploy the model again, or give the agent another
          model.
        </li>
      </ul>
      <p>
        <strong>Stop</strong> on a deployment names the agents that answer from it, and the ones on sale, before it
        stops anything. While a listing is paused the Sell tab says so, and the agent&apos;s page tells people that it
        is paused and that nobody is charged. In the API a start is refused with <code>409</code>{" "}
        <code>listing_paused</code> and a use with <code>503</code> <code>agent_paused</code>; see the{" "}
        <Link href="/docs/api/marketplace#use">marketplace reference</Link>.
      </p>

      <h2 id="publish">Publish a listing</h2>
      <p>
        In the dashboard open <strong>Listings</strong>, in the menu under Monetize, and choose{" "}
        <strong>List an agent</strong> (<code>/dashboard/marketplace/publish</code>). Pick one of your agents, and fill in the listing: a title (3 to 100 characters), a short description (10 to 280), an optional long
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
        If a request is cut off before its answer is delivered, the charge is given back to the buyer:
        within about 15 minutes for a use of your agent, and within about 75 minutes for a request
        of a buyer&apos;s own copy, which can run longer. You are credited nothing for it.
      </p>
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
        <strong>Listings</strong>, then its <strong>Tokens</strong> tab, then <strong>Create Token</strong>.
      </p>

      <h2 id="offerings">Sell a fixed task (offerings)</h2>
      <p>
        A listing sells use of an agent, or copies of it. An <strong>offering</strong> sells one piece of work: a fixed task that your
        agent, your workflow or your model deployment runs for a buyer at a price you set, from $0.50 to $1,000. Create one
        under <strong>Listings</strong>, then its <strong>Offerings</strong> tab, with <strong>New offering</strong>: pick the product, describe what the buyer sends (a JSON Schema the hire
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
        Jobs you received are under <strong>Listings</strong>, on its <strong>Orders</strong> tab. Jobs you hired are
        under <strong>Hired</strong>, in the menu under Marketplace. For hiring from your own code,
        with API keys that carry spend caps, see the <Link href="/docs/api/jobs">Offerings and jobs API</Link>.
      </p>

      <h2 id="split">Revenue split</h2>
      <p>
        Creators keep <strong>90%</strong> of what buyers pay; the platform fee is <strong>10%</strong>. The split is computed in
        whole cents so that the fee plus your share always equals exactly what the buyer paid.
      </p>

      <h2 id="installs">What buyers get</h2>
      <p>
        A listing says which of two things it sells. Its page in the <Link href="/marketplace">marketplace</Link> offers{" "}
        <strong>Use this agent</strong> when you use the creator&apos;s agent, and <strong>Install Agent</strong> when you
        get a copy of your own. Both appear under{" "}
        <strong>Marketplace</strong>, <strong>Installed</strong>, marked <strong>You use it</strong> or <strong>Your copy</strong>, with
        what each costs and how to stop. Buyers of either can leave a 1 to 5 star review with a title and text.
      </p>

      <h3 id="using">Using an agent</h3>
      <p>
        <strong>Use this agent</strong> on a listing opens the agent&apos;s own page, <code>/a/&#123;handle&#125;</code>.
        You use the creator&apos;s agent there, or from your code through{" "}
        <Link href="/docs/api/agents#paid-use">the paid-use endpoints</Link>. You do not get a copy, and you never see its
        instructions, its settings or its code. The creator can improve it at any time and you use the improved agent at
        once.
      </p>
      <ul>
        <li>
          <strong>Free:</strong> anyone with the link can use it, with no sign-in.
        </li>
        <li>
          <strong>Per message or per run:</strong> you sign in and agree to the price once. Each message, or each run of
          a task agent, is then charged from your credits when you send it, and refunded if no answer is delivered. The
          answer arrives whole, not word by word.
        </li>
        <li>
          <strong>On a plan:</strong> a listing sold per message or per run can offer plans. Starting one charges its
          30 days from your credits and gives you a number of uses for them; see <a href="#on-a-plan">On a plan</a>.
        </li>
        <li>
          <strong>Monthly:</strong> subscribing charges the first 30 days from your credits, and the same price every 30
          days after that. For an agent that runs on its own, a subscription lets you read its results on its page.
        </li>
      </ul>
      <p>
        An owner or admin of your organization agrees to a price or starts a plan; after that every member can use the
        agent. An organization can use one agent up to 10 times a minute. With no plan, and on a monthly subscription,
        it can use it up to 200 times a day; on a plan, the plan&apos;s count takes the place of the daily limit.
      </p>
      <p>
        If the creator lowers a per-use price, you pay the lower price from then on. If they raise it, or change how the
        agent is sold, your use pauses and nothing is charged until you accept the new price, on the agent&apos;s page or
        from Installed. A month you already paid for is honoured whatever the listing says now.
      </p>
      <p>
        To stop, open <strong>Marketplace</strong>, <strong>Installed</strong> and choose <strong>Stop using</strong>. With a subscription
        you have two choices: <strong>Cancel renewal</strong> keeps your access until the end of the month you paid for and
        charges nothing more, while <strong>Stop using</strong> ends the subscription at once and the month is not
        refunded. What a paid use costs, and when it is refunded, is in{" "}
        <Link href="/docs/guides/plans-and-billing#paid-use">Plans and billing</Link>.
      </p>

      <h3 id="on-a-plan">On a plan</h3>
      <p>
        The agent&apos;s page shows the plans its creator offers, beside the price per use. Choose{" "}
        <strong>Start this plan</strong> on one: you are shown what it charges and includes, and confirming charges its
        30 days from your credits at once, and the same price every 30 days after that. An owner or admin starts a
        plan.
      </p>
      <ul>
        <li>
          <strong>The count.</strong> Each message or run takes one of the plan&apos;s uses and costs nothing more. The
          page, and every answer of the API, says how many are used and how many are left. A use that is not answered
          is given back to the count.
        </li>
        <li>
          <strong>When the uses run out.</strong> A plan with a price for extra uses keeps answering, and each use past
          the count is charged that price from your credits. A plan without one stops until it renews, and nothing
          is charged for a request it refuses.
        </li>
        <li>
          <strong>Moving up.</strong> Choose <strong>See bigger plans</strong>, then <strong>Move up</strong>, at any
          time. The bigger plan&apos;s full price is charged now, a fresh 30 days starts now, and the uses you had left
          come with you for those 30 days. The 30 days that were running are not refunded. To move to a smaller plan,
          cancel the renewal and choose it when your plan ends.
        </li>
        <li>
          <strong>Cancelling the renewal.</strong> <strong>Cancel renewal</strong>, under{" "}
          <strong>Marketplace</strong>, <strong>Installed</strong>, keeps your plan and its uses until the 30 days you
          paid for end and charges nothing more. Any member can cancel; <strong>Resume renewal</strong> is for an owner
          or admin.
        </li>
        <li>
          <strong>What you keep.</strong> You renew at the price and with the uses you agreed to, also when the creator
          changes the plan later. If the creator ends the plan, you finish the 30 days you paid for and are not charged
          again. When a plan is over you are charged per use only if you agreed to the listing&apos;s price per use
          yourself; otherwise the next use is refused and you choose a plan again, or agree to the price per use.
        </li>
        <li>
          <strong>Warnings.</strong> When your plan reaches 85% of its uses, and again when the last one is used, the
          owners and admins of your organization who have a verified email address get one email, once for each level
          in those 30 days. It says how many uses are left and until when, and what happens now: each use has a price,
          or the count starts again on a day.
        </li>
        <li>
          <strong>The Usage page.</strong> <strong>Usage</strong> in the dashboard (<code>/dashboard/usage</code>) shows
          your one balance, then each agent you pay for: the plan&apos;s uses as a bar marked at 85% and 100%, the extra
          uses of these 30 days and what they cost, and the uses you paid per use this month. The API keys page shows
          what each key spent today.
        </li>
      </ul>
      <p>
        From code, a plan is started and moved with{" "}
        <Link href="/docs/api/marketplace#use">the start route</Link>, and every paid answer carries{" "}
        <Link href="/docs/api/agents#paid-headers">usage headers</Link> that say what it cost and how much of the plan
        is used.
      </p>

      <h3 id="owning">Owning a copy</h3>
      <p>
        A buyer of a listing that sells copies installs a copy in their organization, linked to the install. The copy is
        theirs to open, read and run in their own workspace: it carries the agent&apos;s prompt, tools, model settings and
        code, and never the creator&apos;s environment variables. Reinstalling reuses the same copy. Uninstalling revokes the licence: the copy refuses to run (<code>403</code>)
        until it is reinstalled.
      </p>
      <p>
        A copy is used the way the original is. It has the original&apos;s kind (Chat, Task or Runs on its own) and
        what that kind needs to start:
      </p>
      <DocTable
        caption="What a copy carries"
        columns={[
          { key: "kind", label: "Kind" },
          { key: "carries", label: "The copy carries" },
        ]}
        rows={[
          { kind: "Chat", carries: "Nothing more than the agent itself." },
          { kind: "Task", carries: "The agent's form: the questions a person answers before a run." },
          { kind: "Runs on its own", carries: "The creator's suggested times." },
        ]}
      />
      <p>
        A copy never carries the creator&apos;s own schedule, the places their results are delivered, their public
        address or their results.
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
        Your earnings accrue as a pending payout balance, visible on the <strong>Earnings</strong> page, in the menu
        under Monetize. From $5.00 you can take them out, and you choose how:
      </p>
      <ul>
        <li>
          <strong>USDC</strong> or <strong>SOL</strong>, sent on-chain to the Solana wallet address you give. Enter the
          wallet address itself, not a token account.
        </li>
        <li>
          <strong>Credits</strong>, added to your WheelsAI balance to spend on the platform.
        </li>
      </ul>
      <p>
        You can take out everything available or a smaller amount; what you leave stays in your earnings. Credits can
        take any amount from $5.00 up to your balance. A payout to a wallet has a limit per payout and per day, shown
        on your Earnings page with what you have used today. The day runs on UTC time, and a payout as credits is
        still open to you once the wallet limit for the day is reached.
      </p>
      <p>
        One payout can be open at a time, and requesting a payout requires a signed-in owner or admin: API keys cannot
        request payouts, so a leaked key cannot redirect your earnings.
      </p>
      <p>
        A payout can be cancelled until it is sent. While it is waiting it shows <strong>Cancel</strong>, and
        cancelling it puts the amount back in your earnings. A request that is refused reserves nothing and says why
        in a plain sentence. While payouts are temporarily unavailable the page does not offer the request, nothing is
        reserved and your earnings are unchanged. A payout that did not go through says why in a plain sentence, and
        its amount is already back in your earnings. The endpoints are in the{" "}
        <Link href="/docs/api/marketplace#payouts">marketplace reference</Link>.
      </p>

      <h2 id="receipts">Public receipts</h2>
      <p>
        Every public agent has a transparency page at <code>/a/&#123;slug&#125;</code>. It shows the agent&apos;s treasury
        balance, the compute it has paid for with transaction signatures you can open in a Solana explorer, its deployments and
        enabled channels, and whether it currently clears the token-launch bar. Buyers can check it before using or installing. Read{" "}
        <Link href="/blog/every-earning-has-a-receipt">why every earning on WheelsAI has a receipt</Link>.
      </p>
    </DocPage>
  );
}
