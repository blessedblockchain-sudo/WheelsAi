import type { Metadata } from "next";
import Link from "next/link";

import { CodeBlock } from "@/components/marketing/code-block";
import { DocPage } from "@/components/marketing/docs/doc-page";
import { Endpoint, Fields } from "@/components/marketing/docs/endpoint";
import { DocTable } from "@/components/marketing/prose";

export const metadata: Metadata = {
  title: "Marketplace API",
  description:
    "WheelsAI marketplace API: search listings, publish and manage your own, sell use of an agent or copies of it, set a listing's plans, start using an agent or a plan, install a copy, reviews, subscriptions, what you use and spend, revenue and payouts.",
};

const toc = [
  { id: "browse", title: "Browse (public)" },
  { id: "search", title: "Search listings", sub: true },
  { id: "get-listing", title: "Get a listing", sub: true },
  { id: "publish", title: "Publish" },
  { id: "create-listing", title: "Create a listing", sub: true },
  { id: "manage-listing", title: "Update, publish, archive", sub: true },
  { id: "plans", title: "Set a listing's plans", sub: true },
  { id: "buy", title: "Install and use" },
  { id: "use", title: "Start using an agent", sub: true },
  { id: "install", title: "Install a copy", sub: true },
  { id: "uninstall", title: "Stop using, or uninstall", sub: true },
  { id: "subscriptions", title: "Subscriptions and plans", sub: true },
  { id: "usage", title: "What you use and spend", sub: true },
  { id: "reviews", title: "Reviews", sub: true },
  { id: "earn", title: "Revenue and payouts" },
  { id: "revenue", title: "Revenue", sub: true },
  { id: "payouts", title: "Payouts", sub: true },
  { id: "cancel-payout", title: "Cancel a payout", sub: true },
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
          listing that sells use is used (<code>null</code> when the agent has no page). A listing read here also carries{" "}
          <code>plans</code>: the <a href="#plans">plans</a> it offers a buyer, each{" "}
          <code>&#123; id, name, priceCents, includedUses, extraUsePriceCents &#125;</code>, in the order they are shown,
          and empty when it offers none. In a search, the featured row and a publisher&apos;s profile each listing carries{" "}
          <code>plansFromCents</code> instead: the smallest price for 30 days among its plans, or <code>null</code>. Other
          public reads:
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
          or hold a subscription. Each also carries <code>paused</code>: <code>null</code> when the listing is not paused,
          and <code>&#123; since &#125;</code> while the model its agent runs on is not running; <code>since</code> is when
          that was first seen (an ISO date), or <code>null</code> when it has not been noted yet. See{" "}
          <Link href="/docs/guides/marketplace#model-stops">When the model stops</Link>. Each also carries{" "}
          <code>plans</code>, the plans it has on offer as <a href="#plans">the route below</a> answers them.
        </p>
      </Endpoint>

      <Endpoint id="plans" method="PUT" path="/api/marketplace/listings/{id}/plans" auth="API key, or session (owner or admin)" title="Set a listing's plans">
        <p>
          A listing that sells use per request can offer up to four plans: a price for 30 days, a number of uses
          included, and what happens when they run out. The body is the whole set, and it replaces what the listing
          has: a plan sent with its <code>id</code> is changed in place, a plan sent without one is new, and a plan
          that ends is named in <code>ended</code>.
        </p>
        <Fields
          fields={[
            { name: "plans", type: "array", required: true, description: "The plans the listing offers from now on, in the order buyers see them. At most 4. May be empty." },
            { name: "ended", type: "uuid[]", description: "The ids of the plans that end. Leave it out when none does. An id that is no longer on offer is no error." },
          ]}
        />
        <Fields
          title="A plan"
          fields={[
            { name: "id", type: "uuid", description: "Set to change a plan in place. Left out for a new plan." },
            { name: "kind", type: "string", required: true, description: <><code>paid</code>.</> },
            { name: "name", type: "string", required: true, description: "1 to 40 characters." },
            { name: "priceCents", type: "integer", required: true, description: "What 30 days cost: at least 100, and at least 1 cent for each included use, so $9.00 includes at most 900 uses." },
            { name: "includedUses", type: "integer", required: true, description: "1 to 100,000." },
            { name: "extraUsePriceCents", type: "integer | null", required: true, description: <>What each use past the included ones costs, at least 5. <code>null</code>: the plan stops until it renews. It must be sent, as a number or as <code>null</code>.</> },
          ]}
        />
        <CodeBlock
          language="bash"
          code={`curl -s -X PUT "$WHEELSAI_API_URL/api/marketplace/listings/$LISTING_ID/plans" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" -H "Content-Type: application/json" \\
  -d '{
    "plans": [
      { "kind": "paid", "name": "Starter", "priceCents": 900, "includedUses": 500, "extraUsePriceCents": 5 },
      { "kind": "paid", "name": "Team", "priceCents": 2900, "includedUses": 2000, "extraUsePriceCents": null }
    ],
    "ended": []
  }'`}
        />
        <p>
          Answers <code>&#123; plans &#125;</code>, the plans as they are now, each{" "}
          <code>&#123; id, kind, name, priceCents, includedUses, extraUsePriceCents, status, subscribers &#125;</code>;{" "}
          <code>subscribers</code> is how many subscriptions are on the plan. <code>GET /api/marketplace/my-listings</code>{" "}
          answers the same under each listing.
        </p>
        <ul>
          <li>
            Ending a plan is said, never implied. A plan on offer that is neither in <code>plans</code> nor in{" "}
            <code>ended</code> is one the request did not know of, so the whole save is refused with <code>409</code>{" "}
            <code>plans_changed</code> and nothing is written. Read the plans again and send them all.
          </li>
          <li>
            People already on a plan keep the terms they agreed to. Changing a plan changes it for new subscribers; the
            people on it renew at the price and with the uses they agreed to. Ending a plan takes it off offer: the
            people on it finish the 30 days they paid for and are not charged again.
          </li>
        </ul>
        <DocTable
          caption="Refusals of setting a listing's plans"
          columns={[
            { key: "status", label: "Status" },
            { key: "error", label: "error" },
            { key: "when", label: "When" },
          ]}
          rows={[
            { status: "400", error: <code>validation_failed</code>, when: <><code>message</code> is the first problem and <code>fields</code> has a sentence for each field, keyed as <code>plans[0].priceCents</code>: more than 4 plans, a name that is missing or too long, a price under $1.00, uses out of range or too many for the price, an extra price under $0.05, a plan that is in the list twice or in both lists, an <code>id</code> that is no longer on the listing, a <code>kind</code> other than <code>paid</code>.</> },
            { status: "403", error: "", when: "A member who is not an owner or admin." },
            { status: "404", error: <code>listing_not_found</code>, when: "No listing with that id in your organization." },
            { status: "409", error: <code>plans_not_available</code>, when: "The listing cannot have plans: it sells copies, it is not sold per use, or its agent runs on its own. The message says which." },
            { status: "409", error: <code>plans_changed</code>, when: "The plans were changed somewhere else since they were read, or another save got there first. Nothing was written." },
          ]}
        />
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
          The same route starts a plan, and moves you up to a bigger one.
        </p>
        <Fields
          fields={[
            { name: "expected", type: "object", description: <>To agree to the listing&apos;s price: the pricing you were shown, <code>pricingModel</code> and, as it applies, <code>pricePerRequestCents</code> or <code>monthlyPriceCents</code>. It is your consent: without it, and without <code>plan</code>, nothing is agreed to.</> },
            { name: "acceptNewPricing", type: "boolean", description: "Send true to continue on new terms after the creator changed the price." },
            { name: "plan", type: "object", description: <>To start a plan: the plan you were shown, whole, <code>&#123; id, priceCents, includedUses, extraUsePriceCents &#125;</code> (<code>extraUsePriceCents</code> is <code>null</code> when the plan stops). Its 30 days are charged from your credits now. Starting a plan agrees to no price per use.</> },
            { name: "switchNow", type: "true", description: <>With <code>plan</code>: move up to that bigger plan now. Its full price is charged, a fresh 30 days starts and the uses you had left are carried into them once.</> },
          ]}
        />
        <p>
          Answers <code>201</code> when this request started or accepted something, and <code>200</code> when you were already
          using the agent or the listing is free, with{" "}
          <code>&#123; access, acceptedPricing, subscription, agent: &#123; handle, name, agentKind &#125; &#125;</code>.{" "}
          <code>acceptedPricing</code> is <code>&#123; pricingModel, pricePerRequestCents, acceptedAt &#125;</code>, or{" "}
          <code>null</code> when no price was agreed. A plan start and a move always answer <code>201</code>; their{" "}
          <code>subscription</code> carries <code>plan</code>, the count as{" "}
          <Link href="/docs/api/agents#paid-plans">the paid-use reference</Link> describes it.
        </p>
        <ul>
          <li><code>400</code> <code>expected_terms_required</code>: send the price, or the plan, you were shown.</li>
          <li>
            With <code>plan</code>: <code>400</code> <code>invalid_plan_move</code>; <code>409</code>{" "}
            <code>pricing_changed</code> with <code>pricing</code> and the <code>plans</code> on offer now, when the plan
            is not what you were shown; <code>409</code> <code>already_on_plan</code>, <code>not_on_plan</code>,{" "}
            <code>same_plan</code> and <code>not_a_bigger_plan</code>. Nothing is charged on any of them; each is
            explained in <Link href="/docs/api/agents#paid-plans">the paid-use reference</Link>.
          </li>
          <li>
            <code>402</code> <code>insufficient_credits</code> with <code>requiredCents</code>: a monthly price, or a
            plan&apos;s 30 days, that your balance cannot cover. Nothing is written.
          </li>
          <li><code>404</code> <code>listing_not_found</code>.</li>
          <li><code>409</code> <code>sells_copies</code>: the listing sells copies; install it instead.</li>
          <li><code>409</code> <code>own_agent</code>: it is your organization&apos;s own agent.</li>
          <li><code>409</code> <code>not_offered</code>: the listing is not on sale.</li>
          <li>
            <code>409</code> <code>listing_paused</code>: the model the agent runs on is not running. Nothing was started
            and nothing was charged; try again later. This covers a first start, a new month and accepting a new price.
          </li>
          <li>
            <code>503</code> <code>service_unavailable</code>: whether the agent is paused could not be checked just now.
            Nothing was started and nothing was charged; try again later.
          </li>
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
        <p>Starting a plan:</p>
        <CodeBlock
          language="bash"
          code={`curl -s -X POST "$WHEELSAI_API_URL/api/marketplace/listings/$LISTING_ID/use" \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" -H "Content-Type: application/json" \\
  -d '{ "plan": { "id": "'"$PLAN_ID"'", "priceCents": 900, "includedUses": 500, "extraUsePriceCents": 5 } }'`}
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
          <code>pricing_changed</code> for either; <code>none</code> (not started), <code>plan_ended</code> (a plan that is
          over, with no price per use agreed to) and <code>not_offered</code> (the listing no longer sells use) for a use. A
          subscription&apos;s <code>endReason</code> is <code>pricing_changed</code>, <code>listing_archived</code>,{" "}
          <code>plan_ended</code> when its creator ended the plan, or <code>use_ended</code> when the listing stopped
          selling use: it then ends at the close of the 30 days already paid for.
        </p>
        <p>
          In <code>my-installs</code>, a use also carries what a buyer needs to see about plans: its{" "}
          <code>listing.plans</code> is the plans on offer, and its <code>subscription.plan</code> is the plan it is on
          while that gives uses (<code>null</code> otherwise). Beside <code>installs</code>, <code>canSpend</code> says
          whether this caller may start, move up or resume.
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

      <Endpoint id="subscriptions" method="GET" path="/api/marketplace/subscriptions" auth="API key or session" title="Subscriptions and plans">
        <p>
          Lists your organization&apos;s subscriptions, monthly ones and plans alike, with their status and current
          period. A plan&apos;s row carries <code>plan</code>, its count, while it gives uses.{" "}
          <code>POST /api/marketplace/subscriptions/&#123;listingId&#125;/cancel</code> stops renewal at the end of the paid
          period: access, and a plan&apos;s uses, stay until then and nothing more is charged. Any member can cancel.{" "}
          <code>.../resume</code> undoes that; it turns the charges back on, so it needs an owner or admin, or a key
          granted <code>marketplace:install</code> by name. Both answer <code>&#123; subscription &#125;</code>, and{" "}
          <code>404</code> when there is no subscription to change.
        </p>
        <p>
          Renewals are charged from credits once per 30-day period, at the price that was agreed, and a plan&apos;s count
          starts again with each one. An unpaid renewal is <code>past_due</code> and retried for 3 days before access is
          suspended. A subscription for use of an agent is not renewed while its listing is paused, and the month paid for
          is made longer by the time the listing was paused.
        </p>
      </Endpoint>

      <Endpoint id="usage" method="GET" path="/api/billing/marketplace-usage" auth="API key or session" title="What you use and spend">
        <p>
          One read for everything your organization pays to use: the one balance that pays for all of it, then a row
          for each listing you have started using. It is what the <strong>Usage</strong> page of the dashboard (
          <code>/dashboard/usage</code>) shows. It is a read, and does not count as an API call.
        </p>
        <CodeBlock
          language="json"
          code={`{
  "balanceCents": 495,
  "listings": [
    {
      "listingId": "5d2f9c1e-...",
      "title": "Support Bot",
      "slug": "support-bot",
      "handle": "support-bot",
      "access": "subscribed",
      "plan": {
        "id": "7c1e4b02-...",
        "name": "Starter",
        "includedUses": 500,
        "carriedUses": 0,
        "usedUses": 425,
        "remainingUses": 75,
        "extraUsePriceCents": 5,
        "resetsAt": "2026-11-12T09:30:00.000Z",
        "warning": 85
      },
      "periodEndsAt": "2026-11-12T09:30:00.000Z",
      "renewalPastDue": false,
      "extraThisPeriod": { "uses": 0, "cents": 0 },
      "perUseThisMonth": { "uses": 12, "cents": 60 }
    }
  ]
}`}
        />
        <ul>
          <li>
            <code>access</code> and <code>plan</code> are what{" "}
            <Link href="/docs/api/agents#paid-access">the access read</Link> answers for that agent.{" "}
            <code>plan</code> is <code>null</code> when you are on none.
          </li>
          <li>
            <code>periodEndsAt</code> is the end of the 30 days paid for, and the day a plan ends when it will not renew
            (its <code>plan</code> then has no <code>resetsAt</code>). <code>renewalPastDue</code> is <code>true</code>{" "}
            while a renewal that did not go through is being retried. Both are <code>null</code> and{" "}
            <code>false</code> with no plan.
          </li>
          <li>
            <code>extraThisPeriod</code> is the uses past the plan&apos;s count in its current 30 days and what they
            cost; <code>null</code> with no plan. <code>perUseThisMonth</code> is the uses paid per use in the current
            UTC month and what they cost. Both count only uses that were delivered and paid for: a charge that was
            given back is not in them.
          </li>
          <li>The newest 200 listings are answered.</li>
        </ul>
        <p>
          What each API key spent today is on the key: <code>GET /api/auth/keys</code> answers{" "}
          <code>spentTodayCents</code> for each key, for the current UTC day (<code>null</code> when it could not be
          read just now).
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
        <p>
          <code>payoutLimits</code> says what a payout request may ask for right now. Read the minimum and the limits
          from it instead of writing them into your own code. Every amount is in whole cents.
        </p>
        <Fields
          title="payoutLimits"
          fields={[
            { name: "minimumCents", type: "integer", description: "The smallest payout, for every method." },
            { name: "perPayoutCents", type: "integer", description: "The most one payout to a wallet may be. Credits have no such limit." },
            { name: "perDayCents", type: "integer", description: "The most you may request to a wallet in one UTC day." },
            { name: "usedTodayCents", type: "integer", description: <>What counts against <code>perDayCents</code> so far today: your wallet payouts requested today that are pending, processing or completed.</> },
            { name: "largestNowCents", type: "object", description: <><code>&#123; credits, wallet &#125;</code>: the largest amount a request can take right now as credits, and to a wallet. Either can be under <code>minimumCents</code>; then nothing can be requested that way yet.</> },
            { name: "methods", type: "string[]", description: <>The methods offered now, from <code>credits</code>, <code>crypto_usdc</code> and <code>crypto_sol</code>.</> },
          ]}
        />
      </Endpoint>

      <Endpoint id="payouts" method="POST" path="/api/marketplace/payouts" auth="Session only, owner or admin" title="Request a payout">
        <Fields
          fields={[
            { name: "payoutMethod", type: "enum", required: true, description: <><code>credits</code>, <code>crypto_usdc</code> or <code>crypto_sol</code>. The last two pay a Solana wallet.</> },
            { name: "payoutAddress", type: "string", description: "Required for a payout to a wallet: your Solana wallet address. Give the wallet address itself, not a token account." },
            { name: "amountCents", type: "integer", description: <>The amount to take out, in whole cents. Left out, the request takes the largest amount allowed right now for the method (<code>payoutLimits.largestNowCents</code>).</> },
          ]}
        />
        <p>
          Takes earnings out of your pending balance. The smallest payout is $5.00 for every method. As credits you can
          take any amount from the minimum up to your balance. A payout to a wallet also has a limit per payout and per
          UTC day; both are in <code>payoutLimits</code> on <code>GET /api/marketplace/revenue</code>. Only one payout
          can be open at a time. API keys are refused, so a leaked key cannot redirect earnings.
        </p>
        <p>
          Answers <code>201</code> with{" "}
          <code>&#123; payout, remainingCents, message &#125;</code>: the payout as the list below returns it, what
          stays in your earnings, and a sentence you can show as it comes, such as &quot;Payout of $41.20 requested. It
          is usually sent within a few minutes.&quot;
        </p>
        <CodeBlock
          language="bash"
          code={`curl -s -X POST "$WHEELSAI_API_URL/api/marketplace/payouts" \\
  -H "Authorization: Bearer $SESSION_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"payoutMethod":"crypto_usdc","payoutAddress":"'"$WALLET_ADDRESS"'","amountCents":4120}'`}
        />
        <p>
          A refused request reserves nothing and leaves your earnings unchanged. Each refusal is{" "}
          <code>&#123; error, message &#125;</code>, and <code>message</code> is a plain sentence to show as it comes.
          They are checked in this order:
        </p>
        <DocTable
          caption="Refusals of a payout request"
          columns={[
            { key: "status", label: "Status" },
            { key: "error", label: "error" },
            { key: "when", label: "When" },
          ]}
          rows={[
            { status: "503", error: <code>payouts_unavailable</code>, when: <>Payouts are not running. <code>GET /api/capabilities</code> says whether they are running now, in <code>payouts.available</code>.</> },
            { status: "400", error: <code>invalid_payload</code>, when: "The request could not be read. Check the method and the amount." },
            { status: "400", error: <code>payout_method_unavailable</code>, when: <>The method is not offered right now. <code>payoutLimits.methods</code> lists the ones that are.</> },
            { status: "409", error: <code>payout_in_progress</code>, when: "You already have an open payout. Wait for it to finish, or cancel it if it has not been sent." },
            { status: "400", error: <code>payout_below_minimum</code>, when: "The amount asked for, or your balance, is under the minimum." },
            { status: "400", error: <code>payout_above_balance</code>, when: "The amount asked for is more than your balance." },
            { status: "400", error: <code>payout_above_limit</code>, when: "A wallet method: the amount is more than one payout to a wallet may be. The rest stays in your earnings." },
            { status: "409", error: <code>payout_daily_limit</code>, when: "A wallet method: today's limit is reached. You can request more after midnight UTC, or take a payout as credits now." },
            { status: "400", error: <code>payout_address_required</code>, when: <>A wallet method with no <code>payoutAddress</code>.</> },
            { status: "400", error: <code>invalid_payout_address</code>, when: "The address is not a Solana wallet address, is a token account or a program, or belongs to WheelsAI. The message says which." },
            { status: "503", error: <code>payout_check_unavailable</code>, when: "The address could not be checked just now. Try again shortly." },
            { status: "409", error: <code>payout_reservation_conflict</code>, when: "Your balance changed while the request was being made. Nothing was written; request again." },
          ]}
        />
        <p>
          <code>GET /api/marketplace/payouts</code> (API key or session) lists your payouts, newest first. Each carries
          its <code>status</code> (<code>pending</code>, <code>processing</code>, <code>completed</code>,{" "}
          <code>failed</code> or <code>cancelled</code>) and three fields written for you:
        </p>
        <Fields
          title="On each payout"
          fields={[
            { name: "cancellable", type: "boolean", description: "True while the payout is requested and not yet being sent, so it can still be cancelled." },
            { name: "message", type: "string | null", description: "A plain sentence about where the payout stands, to show as it comes: a pending payout that is waiting to be sent says so, and a failed one says why. Null when there is nothing to say." },
            { name: "failureReason", type: "string | null", description: "Why a failed payout did not go through, as a plain sentence you can show as it comes. Null for a payout that did not fail. A failed payout's amount is already back in your earnings." },
          ]}
        />
      </Endpoint>

      <Endpoint id="cancel-payout" method="POST" path="/api/marketplace/payouts/{id}/cancel" auth="Session only, owner or admin" title="Cancel a payout">
        <p>
          Takes back a payout that is still <code>pending</code>: it becomes <code>cancelled</code> and its amount goes back
          to the earnings it was taken from, in one step. Answers <code>200</code> with <code>&#123; payout &#125;</code>. It
          works while payouts are not running too, so a request never leaves earnings reserved.
        </p>
        <ul>
          <li><code>404</code> <code>payout_not_found</code>: no payout of your organization has this id.</li>
          <li>
            <code>409</code> <code>payout_not_cancellable</code>: the payout is already being sent, or is finished. The{" "}
            <code>message</code> says which; show it as it comes.
          </li>
        </ul>
        <CodeBlock
          language="bash"
          code={`curl -s -X POST "$WHEELSAI_API_URL/api/marketplace/payouts/$PAYOUT_ID/cancel" \\
  -H "Authorization: Bearer $SESSION_TOKEN"`}
        />
      </Endpoint>
    </DocPage>
  );
}
