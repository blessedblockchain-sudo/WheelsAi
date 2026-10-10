import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Endpoint, Fields } from "@/components/marketing/docs/endpoint";
import { DocTable } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Marketplace API",
  description:
    "WheelsAI marketplace API: search listings, publish and manage your own, sell use of an agent or copies of it, start using an agent or install a copy, reviews, monthly subscriptions, revenue and payouts.",
};

const toc = [
  { id: "browse", title: "Browse (public)" },
  { id: "search", title: "Search listings", sub: true },
  { id: "get-listing", title: "Get a listing", sub: true },
  { id: "publish", title: "Publish" },
  { id: "create-listing", title: "Create a listing", sub: true },
  { id: "manage-listing", title: "Update, publish, archive", sub: true },
  { id: "buy", title: "Install and use" },
  { id: "use", title: "Start using an agent", sub: true },
  { id: "install", title: "Install a copy", sub: true },
  { id: "uninstall", title: "Stop using, or uninstall", sub: true },
  { id: "subscriptions", title: "Monthly subscriptions", sub: true },
  { id: "reviews", title: "Reviews", sub: true },
  { id: "earn", title: "Revenue and payouts" },
  { id: "revenue", title: "Revenue", sub: true },
  { id: "payouts", title: "Payouts", sub: true },
];

export default function MarketplaceApiPage() {
  return (
    <DocPage
      href="/docs/api/marketplace"
      title="Marketplace"
      lead="Browsing is public. Publishing, using or installing, reviewing and getting paid act on behalf of your organization. Pricing models and the revenue split are explained in the marketplace guide. Selling a fixed task on an agent, a workflow or a model, and hiring one through escrow, is the Offerings and jobs reference."
      toc={toc}
    >
      <h2 id="browse">Browse (public)</h2>

      <Endpoint id="search" method="GET" path="/api/marketplace/listings" auth="Public" title="Search published listings">
        <Fields
          title="Query"
          fields={[
            { name: "query", type: "string", description: "Free-text search." },
            { name: "category", type: "string", description: <><code>customer-support</code>, <code>coding</code>, <code>research</code>, <code>automation</code>, <code>creative</code>, <code>other</code>.</> },
            { name: "pricingModel", type: "string", description: <><code>free</code>, <code>per_request</code>, <code>monthly</code> or <code>tokenized</code>.</> },
            { name: "minRating", type: "number", description: "0 to 5." },
            { name: "sortBy", type: "enum", description: <><code>popular</code> (default), <code>rating</code>, <code>newest</code>, <code>price_low</code>, <code>price_high</code>. Pro and Enterprise publishers rank first within popularity, rating and recency sorts; price sorts are pure price order.</> },
            { name: "page", type: "integer", description: "Default 1." },
            { name: "limit", type: "integer", description: "1 to 100, default 20." },
          ]}
        />
        <p>
          Returns <code>&#123; listings, pagination: &#123; page, limit, total, totalPages &#125; &#125;</code>.
        </p>
        <CodeBlock language="bash" code={`curl -s "$WHEELSAI_API_URL/api/marketplace/listings?category=coding&sortBy=rating&limit=10"`} />
      </Endpoint>

      <Endpoint id="get-listing" method="GET" path="/api/marketplace/listings/{slugOrId}" auth="Public" title="Get a listing">
        <p>
          Returns <code>&#123; listing &#125;</code>. Besides its title, description and pricing, a listing says what it sells:{" "}
          <code>sells</code> is <code>use</code> (buyers use the creator&apos;s own agent and never get a copy) or{" "}
          <code>copies</code> (buyers install their own copy). <code>unit</code> is what one payment buys:{" "}
          <code>message</code>, <code>run</code> or <code>month</code>, and <code>null</code> for a free listing or a copy.{" "}
          <code>agent.handle</code> is the name in the agent&apos;s page address, <code>/a/&#123;handle&#125;</code>, where a
          listing that sells use is used (<code>null</code> when the agent has no page). Other public reads:
        </p>
        <DocTable
          caption="Other public marketplace endpoints"
          columns={[
            { key: "ep", label: "Endpoint" },
            { key: "what", label: "Returns" },
          ]}
          rows={[
            { ep: <code>GET /api/marketplace/listings/&#123;id&#125;/reviews</code>, what: <>Reviews, paged by <code>page</code> and <code>limit</code> (1 to 50, default 10).</> },
            { ep: <code>GET /api/marketplace/categories</code>, what: "Categories with listing counts." },
            { ep: <code>GET /api/marketplace/featured</code>, what: <>Featured listings; <code>limit</code> 1 to 20, default 6.</> },
            { ep: <code>GET /api/marketplace/publishers/&#123;slug&#125;</code>, what: "A publisher's public profile." },
            { ep: <code>GET /api/marketplace/pricing-models</code>, what: "The pricing model ids and labels." },
          ]}
        />
      </Endpoint>

      <h2 id="publish">Publish</h2>

      <Endpoint id="create-listing" method="POST" path="/api/marketplace/listings" auth="API key or session" title="Create a listing (draft)">
        <Fields
          fields={[
            { name: "agentId", type: "uuid", required: true, description: "One of your agents." },
            { name: "title", type: "string", required: true, description: "3 to 100 characters." },
            { name: "shortDescription", type: "string", required: true, description: "10 to 280 characters." },
            { name: "category", type: "enum", required: true, description: "One of the categories above." },
            { name: "pricingModel", type: "enum", required: true, description: <><code>free</code>, <code>per_request</code>, <code>monthly</code> or <code>tokenized</code>.</> },
            { name: "pricePerRequestCents", type: "integer", description: <>Required for <code>per_request</code>: 1 to 100,000, and at least 5 when the listing sells use.</> },
            { name: "monthlyPriceCents", type: "integer", description: <>Required for <code>monthly</code>: 100 to 10,000,000.</> },
            { name: "sells", type: "enum", description: <><code>use</code> or <code>copies</code>. Left out, a new listing sells use of the agent and an update keeps what it sells. <code>copies</code> gives buyers their own copy, including its instructions, and you cannot take a copy back.</> },
            { name: "allowedTools", type: "string[]", description: <>Up to 50 tool names (such as <code>http_request</code>) that your agent may use for people who pay to use it. Each must be one of the agent&apos;s own tools. Left out, a paying user&apos;s requests run without tools that send requests out.</> },
            { name: "publish", type: "boolean", description: <><code>true</code> publishes the listing in the same request.</> },
            { name: "longDescription", type: "string", description: "Up to 10,000 characters." },
            { name: "readme", type: "string", description: "Up to 50,000 characters." },
            { name: "iconUrl", type: "string (URL)", description: "Listing icon." },
            { name: "screenshots", type: "string[] (URLs)", description: "Up to 10." },
          ]}
        />
        <p>
          Answers <code>201</code> with <code>&#123; listing &#125;</code>, which for you also carries{" "}
          <code>allowedTools</code>. Free and tokenized listings ignore prices. Refusals carry a plain{" "}
          <code>message</code>; show it as it comes.
        </p>
        <ul>
          <li>
            <code>409</code> <code>marketplace_copy</code>: the agent came from the marketplace, so it cannot be sold again,
            as use or as copies.
          </li>
          <li>
            <code>409</code> <code>graph_agent_not_supported</code>: an agent that answers through its graph cannot have its
            use sold yet. Sell it as a task with guaranteed delivery, or sell copies.
          </li>
          <li>
            <code>400</code> <code>token_access_not_available</code>: use of an agent cannot be sold to token holders. Choose{" "}
            <code>free</code>, <code>per_request</code> or <code>monthly</code>, or sell copies.
          </li>
          <li>
            <code>409</code> <code>listing_exists</code>: the agent already has a listing; edit that one. <code>409</code>{" "}
            <code>listing_name_taken</code> and <code>409</code> <code>handle_taken</code>: another listing or page took the
            name at the same moment; try again.
          </li>
          <li>
            <code>400</code> <code>validation_failed</code> with <code>message</code> (the first problem) and{" "}
            <code>fields</code> (each field and its sentence): <code>pricePerRequestCents</code> under 5 for a listing that
            sells use, <code>monthlyPriceCents</code> under 100, <code>pricingModel</code> when an agent that runs on its own
            is priced per use (it can be free or monthly), and <code>allowedTools</code> naming a tool the agent does not
            have.
          </li>
        </ul>
        <p>
          Selling use turns the agent&apos;s page on for that listing: free use keeps the page open to anyone, and a price
          closes free use there so people pay to use it.
        </p>
      </Endpoint>

      <Endpoint id="manage-listing" method="PATCH" path="/api/marketplace/listings/{id}" auth="API key or session" title="Update, publish or archive">
        <p>
          <code>PATCH</code> accepts any create field except <code>agentId</code>; pricing is re-validated as a whole.{" "}
          <code>sells</code>, <code>allowedTools</code> and <code>publish</code> work the same on update, with the same
          refusals. <code>POST /api/marketplace/listings/&#123;id&#125;/publish</code> makes a draft visible (a listing that is
          already published answers <code>200</code>) and{" "}
          <code>POST /api/marketplace/listings/&#123;id&#125;/archive</code> withdraws it. <code>GET /api/marketplace/my-listings</code>{" "}
          lists your organization&apos;s listings in every state; each carries <code>allowedTools</code> and{" "}
          <code>buyers</code>: <code>&#123; copies, using, subscribed &#125;</code>, how many people have a copy, use the agent,
          or hold a subscription.
        </p>
      </Endpoint>

      <h2 id="buy">Install and use</h2>
      <p>
        What a listing sells decides what a buyer does. A listing that sells <code>use</code> is used: you start using it, then
        use the creator&apos;s own agent on its page, with{" "}
        <Link href="/docs/api/agents#paid-use">the paid-use endpoints</Link>, or through <code>POST /v1/chat/completions</code>.
        You never get a copy or its instructions. A listing that sells <code>copies</code> is installed: you get your own copy
        of the agent to run. To have a publisher&apos;s agent, workflow or model do one
        fixed task for you instead, with the price held in escrow until you accept the result, see{" "}
        <Link href="/docs/api/jobs">Offerings and jobs</Link>.
      </p>

      <Endpoint id="use" method="POST" path="/api/marketplace/listings/{id}/use" auth="Owner or admin, or a key granted marketplace:install" title="Start using an agent">
        <p>
          Agrees to the price of a listing that sells use. Nothing is copied: you use the creator&apos;s own agent at{" "}
          <code>/a/&#123;handle&#125;</code>. A price per use charges nothing now; each use is charged when it is sent. A monthly
          price charges the first 30 days from your credits now. An API key needs the <code>marketplace:install</code> scope
          granted by name (<code>403</code> otherwise); see <Link href="/docs/api/jobs#keys">API keys that can spend</Link>.
        </p>
        <Fields
          fields={[
            { name: "expected", type: "object", required: true, description: <>The pricing you were shown: <code>pricingModel</code> and, as it applies, <code>pricePerRequestCents</code> or <code>monthlyPriceCents</code>. It is your consent: without it nothing is agreed to.</> },
            { name: "acceptNewPricing", type: "boolean", description: "Send true to continue on new terms after the creator changed the price." },
          ]}
        />
        <p>
          Answers <code>201</code> when this request started or accepted something, and <code>200</code> when you were already
          using the agent or the listing is free, with{" "}
          <code>&#123; access, acceptedPricing, subscription, agent: &#123; handle, name, agentKind &#125; &#125;</code>.{" "}
          <code>acceptedPricing</code> is <code>&#123; pricingModel, pricePerRequestCents, acceptedAt &#125;</code>, or{" "}
          <code>null</code> when no price was agreed.
        </p>
        <ul>
          <li><code>400</code> <code>expected_terms_required</code>: send the price you were shown.</li>
          <li>
            <code>402</code> <code>insufficient_credits</code> with <code>requiredCents</code>: a monthly price your balance
            cannot cover. Nothing is written.
          </li>
          <li><code>404</code> <code>listing_not_found</code>.</li>
          <li><code>409</code> <code>sells_copies</code>: the listing sells copies; install it instead.</li>
          <li><code>409</code> <code>own_agent</code>: it is your organization&apos;s own agent.</li>
          <li><code>409</code> <code>not_offered</code>: the listing is not on sale.</li>
          <li>
            <code>409</code> <code>copy_subscription_active</code> with <code>until</code> (an ISO date): your organization
            holds a copy of this agent with a month paid for. Remove the copy, or cancel its renewal and start after that
            date. Nothing is written, cancelled or charged.
          </li>
          <li>
            <code>409</code> <code>pricing_changed</code> with the listing&apos;s current <code>pricing</code>: the listing is not
            what you were shown, or not what you agreed to. Nothing is charged until you send{" "}
            <code>acceptNewPricing: true</code>.
          </li>
          <li>
            <code>409</code> <code>subscription_claim_lost</code>: another request for the same start was processed first.
            Nothing was charged by this one; retry.
          </li>
        </ul>
        <CodeBlock
          language="bash"
          code={`curl -s -X POST "$WHEELSAI_API_URL/api/marketplace/listings/$LISTING_ID/use" \
  -H "Authorization: Bearer $WHEELSAI_API_KEY" -H "Content-Type: application/json" \
  -d '{ "expected": { "pricingModel": "per_request", "pricePerRequestCents": 5 } }'`}
        />
      </Endpoint>

      <Endpoint id="install" method="POST" path="/api/marketplace/listings/{id}/install" auth="API key or session" title="Install a copy">
        <p>
          An API key needs the <code>marketplace:install</code> scope granted by name (<code>403</code>{" "}
          <code>missing_scope</code> otherwise); see <Link href="/docs/api/jobs#keys">API keys that can spend</Link>.{" "}
          For a listing that sells copies. Creates (or, on reinstall, reuses) a copy of the agent in your organization and answers <code>201</code> with{" "}
          <code>install</code>, <code>clonedAgent</code> (<code>id</code>, <code>name</code>, <code>slug</code>) and, for
          monthly listings, <code>subscription</code>. Chat with the copy through the{" "}
          <Link href="/docs/api/agents#playground-chat">playground endpoint</Link>. The publisher&apos;s environment variables are
          never copied.
        </p>
        <p>
          A graph agent is copied with its graph. In the copy, the request of an <code>api</code> node (URL, headers, body), the
          source of a <code>code</code> node and the input of an <code>http_request</code> or <code>code_interpreter</code> tool
          node are kept only where they are built from template references alone; literal text in them, which is where a
          publisher&apos;s keys and endpoints live, is not copied. <code>clonedAgent.needsConfiguration</code> lists each such node
          (<code>nodeId</code>, <code>label</code>, <code>type</code>, <code>fields</code>); set your own values in the builder
          before running the copy.
        </p>
        <ul>
          <li>
            <code>402</code> <code>insufficient_credits</code> with <code>requiredCents</code>: a monthly listing whose first
            period your balance cannot cover. Nothing is written.
          </li>
          <li>
            <code>403</code> <code>token_required</code> with <code>tokenSymbol</code>, <code>mintAddress</code> and{" "}
            <code>requiredBalance</code>: a tokenized listing whose token has launched, and no linked wallet in your
            organization holds enough of it.
          </li>
          <li>
            <code>409</code> <code>pricing_changed</code> with the listing&apos;s new <code>pricing</code>: the publisher changed it after you
            agreed to it. A subscription runs to the end of its paid period at the agreed price first. A free or
            per-request install records the pricing you accepted: a per-request price above it, or a different pricing
            model, pauses the install and charges nothing, while a lower price (or a move to free) applies at once.
            Send <code>{`{ "acceptNewPricing": true }`}</code> to continue on the new terms.
          </li>
          <li>
            Send <code>expectedPricing</code> (<code>pricingModel</code>, <code>pricePerRequestCents</code>,{" "}
            <code>monthlyPriceCents</code>) with an install or an acceptance to name the pricing you were shown. If the
            listing no longer matches it you get the same <code>409</code> with the current pricing, and nothing is
            installed, accepted or charged.
          </li>
          <li>
            <code>409</code> <code>subscription_claim_lost</code>: another request for the same install was processed
            first. Nothing was charged by this one; retry.
          </li>
          <li>
            <code>409</code> <code>sells_use</code> with <code>handle</code>: the listing sells use of the creator&apos;s agent, so
            there is no copy to install. Start using it instead, at <code>/a/&#123;handle&#125;</code>.
          </li>
          <li>
            <code>409</code> <code>already_using</code> with <code>handle</code>: you already use this agent. A copy is not
            installed over it.
          </li>
        </ul>
        <p>
          <code>GET /api/marketplace/listings/&#123;id&#125;/install-status</code> tells you whether you have it installed, and{" "}
          <code>GET /api/marketplace/my-installs</code> lists your installs, including lapsed ones and their subscriptions. Both
          describe a copy and a use the same way: <code>kind</code> is <code>copy</code> or <code>use</code>;{" "}
          <code>agent</code> is <code>&#123; handle, name, agentKind &#125;</code>; <code>clonedAgentId</code> is the copy&apos;s id
          for a copy and <code>null</code> for a use, which has no copy. <code>access</code> says where it stands:{" "}
          <code>subscribed</code>, <code>listing_pricing</code>, <code>subscription_lapsed</code> and{" "}
          <code>pricing_changed</code> for either; <code>none</code> (not started) and <code>not_offered</code> (the listing no
          longer sells use) for a use. A subscription&apos;s <code>endReason</code> is <code>pricing_changed</code>,{" "}
          <code>listing_archived</code>, or <code>use_ended</code> when the listing stopped selling use: it then ends at the
          close of the month already paid for.
        </p>
      </Endpoint>

      <Endpoint id="uninstall" method="POST" path="/api/marketplace/listings/{id}/uninstall" auth="API key or session" title="Stop using, or uninstall">
        <p>
          Ends the licence. For a copy, the copy stays in your organization but refuses to run (<code>403</code>) until you
          reinstall. For an agent you use, you stop using it. Either way a monthly subscription ends immediately and the
          current period is not refunded. To keep access until the month you paid for ends, cancel the subscription instead
          (below).
        </p>
      </Endpoint>

      <Endpoint id="subscriptions" method="GET" path="/api/marketplace/subscriptions" auth="API key or session" title="Monthly subscriptions">
        <p>
          Lists your organization&apos;s monthly subscriptions with their status and current period.{" "}
          <code>POST /api/marketplace/subscriptions/&#123;listingId&#125;/cancel</code> stops renewal at the end of the paid
          period, and <code>.../resume</code> undoes that. Renewals are charged from credits once per 30-day period; an unpaid
          renewal is <code>past_due</code> and retried for 3 days before the install is suspended.
        </p>
      </Endpoint>

      <Endpoint id="reviews" method="POST" path="/api/marketplace/listings/{id}/reviews" auth="API key or session" title="Review a listing">
        <Fields
          fields={[
            { name: "rating", type: "integer", required: true, description: "1 to 5." },
            { name: "title", type: "string", description: "Up to 200 characters." },
            { name: "content", type: "string", description: "Up to 5,000 characters." },
          ]}
        />
      </Endpoint>

      <h2 id="earn">Revenue and payouts</h2>

      <Endpoint id="revenue" method="GET" path="/api/marketplace/revenue" auth="API key or session" title="Publisher revenue">
        <p>
          Your revenue across listings and jobs, and your pending payout balance. A job&apos;s row carries{" "}
          <code>jobId</code> and <code>escrow</code> (<code>held</code>, <code>released</code> or <code>refunded</code>);
          only a released row is an earning, and <code>heldInEscrow</code> totals what buyers have paid that is not yours
          yet. <code>unlistedJobRevenue</code> is settled job revenue on products with no listing. Your share is 90% of what buyers paid; each revenue row
          splits the gross exactly into the creator share and the 10% platform fee, in whole cents.
        </p>
      </Endpoint>

      <Endpoint id="payouts" method="POST" path="/api/marketplace/payouts" auth="Session only, owner or admin" title="Request a payout">
        <Fields
          fields={[
            { name: "payoutMethod", type: "enum", required: true, description: <><code>credits</code>, <code>crypto_usdc</code> or <code>crypto_sol</code>.</> },
            { name: "payoutAddress", type: "string", description: "Required for crypto payouts: the Solana address to pay." },
          ]}
        />
        <p>
          Pays out your whole pending balance, which must be at least $10.00. Only one payout can be open at a time; a
          concurrent request that loses the race gets <code>409</code> <code>payout_reservation_conflict</code> and writes
          nothing. API keys are refused, so a leaked key cannot redirect earnings. <code>GET /api/marketplace/payouts</code>{" "}
          lists your payout history.
        </p>
      </Endpoint>
    </DocPage>
  );
}
