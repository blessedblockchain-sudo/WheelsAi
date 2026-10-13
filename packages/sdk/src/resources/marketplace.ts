import { seg, type WheelsAIClient } from "../client.js";
import type { AgentKind } from "./agents.js";

export type ListingCategory =
  | "customer-support"
  | "coding"
  | "research"
  | "automation"
  | "creative"
  | "other";

export type PricingModel = "free" | "per_request" | "monthly" | "tokenized";

export type ListingStatus = "draft" | "published" | "archived" | (string & {});

/**
 * What a listing sells. `use`: buyers use the creator's own agent on its page or through the API and
 * never get a copy. `copies`: buyers install their own copy, including its instructions.
 */
export type ListingSells = "use" | "copies";

/** What one payment buys: a message, a run or a month. null for a free listing, a copy or a token listing. */
export type ListingUnit = "message" | "run" | "month";

/**
 * A plan a listing offers: one price for 30 days with a number of uses included, on top of the listing's
 * price per use. A listing that sells use per request can offer up to four. Every plan has a count.
 */
export interface PlanOffer {
  id: string;
  /** What its creator calls it. */
  name: string;
  /** What 30 days cost, in cents: charged from the buyer's credits at the start and at each renewal. */
  priceCents: number;
  /** The uses the 30 days include. */
  includedUses: number;
  /** What each use past the included ones costs, in cents. null: the plan stops until it renews. */
  extraUsePriceCents: number | null;
}

/**
 * The plan a buyer was shown, sent back whole to start it or to move up to it. It is their consent: if any
 * term differs from the plan as it is now, nothing is charged. `extraUsePriceCents` is always sent, null
 * when the plan stops. A `PlanOffer` can be passed as it came.
 */
export interface PlanTerms {
  id: string;
  priceCents: number;
  includedUses: number;
  extraUsePriceCents: number | null;
}

/** A plan as its creator sees it (`myListings`, `setPlans`). No buyer is named. */
export interface OwnerPlan extends PlanOffer {
  /** `paid`. */
  kind: string;
  status: string;
  /** How many subscriptions are on this plan. */
  subscribers: number;
}

/** One plan of the set `setPlans` sends. */
export interface PlanInput {
  /** Set to change a plan in place. Left out for a new plan. */
  id?: string;
  /** `paid`. */
  kind: "paid" | (string & {});
  /** 1 to 40 characters. */
  name: string;
  /** What 30 days cost, in cents: at least 100, and at least 1 cent for each included use. */
  priceCents: number;
  /** 1 to 100,000. */
  includedUses: number;
  /** What each use past the included ones costs, in cents, at least 5. null: the plan stops until it renews. */
  extraUsePriceCents: number | null;
}

/**
 * The plan a buyer is on, while it gives them uses: on the access answer (`use.access`), on a subscription
 * (`myInstalls`, `startPlan`, `movePlan`) and in `use.usage`. Uses and cents, and nothing of another buyer.
 */
export interface SubscriptionPlan {
  /** The plan the subscription was started on. */
  id: string | null;
  /** What its creator calls it now. */
  name: string;
  /** The uses of the 30 days, as agreed. */
  includedUses: number;
  /** Uses brought into these 30 days by a move to a bigger plan, on top of the included ones. 0 after a renewal. */
  carriedUses: number;
  usedUses: number;
  /** Included plus carried, less the ones used. Never below 0. */
  remainingUses: number;
  /** What each use past the count costs, as agreed. null: the plan stops until it renews. */
  extraUsePriceCents: number | null;
  /** When the count starts again (an ISO time). Left out when the plan will not renew. */
  resetsAt?: string;
  /** 85 when 85% of the uses are gone, 100 when all are. */
  warning: null | 85 | 100;
}

export interface AgentListing {
  id: string;
  agentId: string;
  title: string;
  /** The URL segment: the listing lives at `<web>/marketplace/<slug>`. Derived from the title by the API. */
  slug: string;
  shortDescription: string;
  longDescription: string | null;
  category: ListingCategory;
  iconUrl: string | null;
  screenshots: string[];
  readme: string | null;
  pricingModel: PricingModel;
  pricePerRequestCents: number | null;
  monthlyPriceCents: number | null;
  /** What the listing sells. */
  sells: ListingSells;
  unit: ListingUnit | null;
  /** Whether the listing has a token. Present on a search, the featured row and a listing read by slug. */
  hasToken?: boolean;
  /** Your own listings only (create, update, `myListings`): the tools the agent may use for people who pay. */
  allowedTools?: string[];
  /** `myListings` only: how many people have a copy, use it, or are subscribed. */
  buyers?: { copies: number; using: number; subscribed: number };
  /**
   * The plans the listing offers, in the order buyers see them; empty when it offers none. Present on a
   * listing read by slug or id (`get`), on the listing of each of `myInstalls`, and on `myListings`, where
   * each plan also says its `status` and `subscribers` (`OwnedListing`).
   */
  plans?: PlanOffer[];
  /**
   * A search, the featured row and a publisher's profile: the smallest price for 30 days among the
   * listing's plans, in cents. null when it offers none.
   */
  plansFromCents?: number | null;
  /**
   * `myListings` only. Set while the listing is paused: it sells use, and the model its agent runs on (one
   * your organization runs itself) is not running, so nobody can start using it and nobody is charged.
   * `since` is when the pause was first seen (an ISO date), or null when it has only just begun. Null when
   * the listing is not paused.
   */
  paused?: { since: string | null } | null;
  publisherId: string;
  publisherName: string;
  status: ListingStatus;
  isFeatured: boolean;
  totalInstalls: number;
  activeInstalls: number;
  avgRating: number;
  reviewCount: number;
  totalRequests: number;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** `agentKind` says how people use the listed agent. */
  agent?: {
    id: string;
    framework: string;
    agentKind: AgentKind;
    tags: string[];
    slug?: string;
    isPublic?: boolean;
    /** The name in the agent's page address, `/a/<handle>`; null when it has no page. */
    handle?: string | null;
  };
}

/** One of your own listings, as `myListings` answers it: its plans carry their status and their subscribers. */
export interface OwnedListing extends AgentListing {
  plans?: OwnerPlan[];
}

/** The agent a licence is for, as its buyer may know it. Never its instructions. */
export interface LicenceAgent {
  /** The name in `/a/<handle>`; null when the agent has no page. */
  handle: string | null;
  name: string;
  agentKind: AgentKind;
}

/**
 * Where a licence stands. A copy is `subscribed`, `listing_pricing`, `unlisted`, `subscription_lapsed`,
 * `pricing_changed` or `uninstalled`. Use of the creator's agent can also be `none` (not started),
 * `plan_ended` (a plan that is over, with no price per use agreed to) or `not_offered` (the listing no
 * longer sells it).
 */
export type InstallAccess =
  | "subscribed"
  | "listing_pricing"
  | "unlisted"
  | "subscription_lapsed"
  | "pricing_changed"
  | "uninstalled"
  | "none"
  | "plan_ended"
  | "not_offered";

/** A buyer's subscription to a listing: a month, or a plan with a count of uses. */
export interface ListingSubscription {
  id: string;
  listingId: string;
  status: "active" | "past_due" | "cancelled" | "expired" | (string & {});
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  cancelledAt: string | null;
  hasAccess: boolean;
  graceEndsAt: string | null;
  /** The price for 30 days the subscription was agreed at, which a renewal charges. */
  priceCents: number | null;
  /**
   * Set when the publisher's side ended it. `use_ended`: the listing stopped selling use. `plan_ended`: its
   * creator ended the plan, and it finished with the 30 days paid for.
   */
  endReason: "pricing_changed" | "listing_archived" | "use_ended" | "plan_ended" | null;
  /** The plan it is on, while that gives uses. null for a month with no count, and for a plan that is over. */
  plan?: SubscriptionPlan | null;
}

/** One licence in `myInstalls`: a copy the buyer owns, or the right to use the creator's agent. */
export interface AgentInstall {
  id: string;
  listingId: string;
  /** `use`: the buyer uses the creator's agent and has no copy. `copy`: their own copy. */
  kind: "copy" | "use";
  /** null when `kind` is `use`. */
  clonedAgentId: string | null;
  agent: LicenceAgent;
  status: string;
  totalRequests: number;
  totalSpentCents: number;
  installedAt: string;
  access: InstallAccess;
  acceptedPricing: { pricingModel: PricingModel | null; pricePerRequestCents: number | null; acceptedAt: string | null };
  listing: AgentListing;
  subscription: ListingSubscription | null;
}

/** The pricing a buyer was shown; sent back to start using, so nothing is agreed to that they did not see. */
export interface ExpectedPricing {
  pricingModel: PricingModel;
  pricePerRequestCents?: number | null;
  monthlyPriceCents?: number | null;
}

/** The answer of `startUsing`, `startPlan` and `movePlan`. */
export interface StartedUsing {
  access: InstallAccess;
  /** What the buyer agreed to; null for a free listing. */
  acceptedPricing: { pricingModel: PricingModel | null; pricePerRequestCents: number | null; acceptedAt: string | null } | null;
  subscription: ListingSubscription | null;
  agent: LicenceAgent;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface AgentReview {
  id: string;
  rating: number;
  title: string | null;
  content: string | null;
  isVerified: boolean;
  helpfulCount: number;
  reviewerName: string | null;
  createdAt: string;
}

export interface SearchListingsParams {
  query?: string;
  category?: string;
  pricingModel?: string;
  minRating?: number;
  sortBy?: "popular" | "rating" | "newest" | "price_low" | "price_high";
  page?: number;
  limit?: number;
}

export interface CreateListingInput {
  /** The agent to list. Must belong to the caller's organization and have no listing yet. */
  agentId: string;
  /** 3 to 100 characters. */
  title: string;
  /** 10 to 280 characters. */
  shortDescription: string;
  longDescription?: string;
  category: ListingCategory;
  iconUrl?: string;
  screenshots?: string[];
  readme?: string;
  pricingModel: PricingModel;
  /** Required for `per_request`: 1 to 100000. */
  pricePerRequestCents?: number;
  /** Required for `monthly`: 100 to 10000000. */
  monthlyPriceCents?: number;
  /**
   * What the listing sells. Left out, a new listing sells use of the agent and an update keeps what it sells.
   * `copies` lets buyers install their own copy, including its instructions; you cannot take a copy back.
   * Selling use needs `pricePerRequestCents` of at least 5, or `monthlyPriceCents` of at least 100, and does
   * not accept `tokenized`. A graph agent cannot be sold for use, and an agent installed from the marketplace
   * cannot be listed.
   */
  sells?: ListingSells;
  /** Skill keys (such as `http_request`) the agent may use for people who pay; at most 50. */
  allowedTools?: string[];
  /** Publish in the same request. */
  publish?: boolean;
}

export type UpdateListingInput = Partial<Omit<CreateListingInput, "agentId">>;

export type PayoutStatus = "pending" | "processing" | "completed" | "failed" | "cancelled";

/**
 * How a payout is taken: as `credits` on the platform, or sent to a Solana wallet in USDC
 * (`crypto_usdc`) or SOL (`crypto_sol`). The last two are the wallet methods.
 */
export type PayoutMethod = "credits" | "crypto_usdc" | "crypto_sol";

/** What a payout request may ask for right now. Every amount is in whole cents. */
export interface PayoutLimits {
  /** The smallest payout, for every method. */
  minimumCents: number;
  /** The most one payout to a wallet may be. Credits have no such limit. */
  perPayoutCents: number;
  /** The most that may be requested to a wallet in one UTC day. */
  perDayCents: number;
  /** What today's wallet payouts already count for against `perDayCents`. */
  usedTodayCents: number;
  /**
   * The largest amount a request can take right now: as credits, and to a wallet. Either can be
   * under `minimumCents`; then nothing can be requested that way yet.
   */
  largestNowCents: { credits: number; wallet: number };
  /** The methods offered now. `crypto_sol` is left out while SOL payouts are not available. */
  methods: PayoutMethod[];
}

/**
 * The answer of `revenue`: your earnings across listings and jobs, and what a payout may ask for.
 * Fields not named here are read as `unknown`.
 */
export interface PublisherRevenue {
  totalRevenueCents: number;
  /** Earnings you can take out now. */
  pendingPayoutCents: number;
  totalListings: number;
  totalInstalls: number;
  payoutLimits: PayoutLimits;
  [field: string]: unknown;
}

export interface RequestPayoutInput {
  payoutMethod: PayoutMethod;
  /** The Solana wallet to pay. Needed for `crypto_usdc` and `crypto_sol`; left out for credits. */
  payoutAddress?: string;
  /**
   * The amount to take out, in whole cents. Left out, the request takes the largest amount
   * allowed right now for the method (`payoutLimits.largestNowCents`).
   */
  amountCents?: number;
}

/** The answer of `requestPayout`. */
export interface RequestedPayout {
  payout: CreatorPayout;
  /** What stays in your earnings after this request. */
  remainingCents: number;
  /** A plain sentence about the request, written for the creator. */
  message: string;
}

/** One payout request of a creator's earnings. */
export interface CreatorPayout {
  id: string;
  amountCents: number;
  payoutMethod: PayoutMethod;
  payoutAddress: string | null;
  status: PayoutStatus;
  txSignature: string | null;
  grossRevenueCents: number;
  platformFeeCents: number;
  periodStart: string;
  periodEnd: string;
  requestedAt: string;
  processedAt: string | null;
  /**
   * Why a failed payout did not go through, as a plain sentence written for the creator; null
   * when it did not fail. A failed payout's amount is already back in the earnings.
   */
  failureReason: string | null;
  /**
   * A plain sentence about where the payout stands, written for the creator: that a pending
   * payout is waiting to be sent, or why a failed one did not go through. Null when there is
   * nothing to say.
   */
  message: string | null;
  /** True while `cancelPayout` can still take it back: requested and not yet being sent. */
  cancellable: boolean;
}

/** The four terms of a plan and nothing else, so that what is sent is what was shown. */
function planTermsOf(plan: PlanTerms): PlanTerms {
  return {
    id: plan.id,
    priceCents: plan.priceCents,
    includedUses: plan.includedUses,
    extraUsePriceCents: plan.extraUsePriceCents,
  };
}

export function marketplaceResource(client: WheelsAIClient) {
  return {
    // ---- public ----

    /** `GET /api/marketplace/listings`: published listings only. */
    search: (params?: SearchListingsParams) =>
      client.get<{ listings: AgentListing[]; pagination: Pagination }>("/api/marketplace/listings", { ...params }),

    /** One listing by slug (or id). Published listings only. */
    get: (slugOrId: string) =>
      client.get<{ listing: AgentListing }>(`/api/marketplace/listings/${seg(slugOrId)}`),

    featured: (limit?: number) =>
      client.get<{ listings: AgentListing[] }>("/api/marketplace/featured", { limit }),

    categories: () =>
      client.get<{ categories: Array<{ id: string; label: string; icon: string; count: number }> }>(
        "/api/marketplace/categories",
      ),

    pricingModels: () =>
      client.get<{ pricingModels: Array<{ id: PricingModel; label: string }> }>("/api/marketplace/pricing-models"),

    publisher: (slug: string) =>
      client.get<{ publisher: unknown }>(`/api/marketplace/publishers/${seg(slug)}`),

    reviews: (listingId: string, params?: { page?: number; limit?: number }) =>
      client.get<{ reviews: AgentReview[]; pagination: Pagination }>(
        `/api/marketplace/listings/${seg(listingId)}/reviews`,
        params,
      ),

    // ---- publishing ----

    /** The caller organization's listings in every status, each with the plans it has on offer. */
    myListings: () =>
      client.get<{ listings: OwnedListing[] }>("/api/marketplace/my-listings"),

    /** Creates a draft. Follow with `publishListing`. */
    createListing: (input: CreateListingInput) =>
      client.post<{ listing: AgentListing }>("/api/marketplace/listings", input),

    updateListing: (listingId: string, updates: UpdateListingInput) =>
      client.patch<{ listing: AgentListing }>(`/api/marketplace/listings/${seg(listingId)}`, updates),

    /** Makes a draft or archived listing public. The response carries the `slug`. */
    publishListing: (listingId: string) =>
      client.post<{ listing: AgentListing; message: string }>(
        `/api/marketplace/listings/${seg(listingId)}/publish`,
      ),

    archiveListing: (listingId: string) =>
      client.post<{ listing: AgentListing; message: string }>(
        `/api/marketplace/listings/${seg(listingId)}/archive`,
      ),

    /**
     * `PUT /api/marketplace/listings/{id}/plans`: set the plans of a listing that sells use per request.
     * `plans` is the whole set and replaces what the listing has: a plan sent with its `id` is changed in
     * place, one sent without is new. A plan that ends is named in `ended`; ending is said, never implied,
     * so a plan on offer that is in neither list refuses the whole save. At most four plans. People already
     * on a plan keep the terms they agreed to. Needs an owner or admin, or an API key.
     *
     * Answers the plans as they are now. Refusals: 400 `validation_failed` (`message` is the first problem,
     * `fields` in `error.data` has a sentence for each, keyed as `plans[0].priceCents`); 404
     * `listing_not_found`; 409 `plans_not_available` (the listing sells copies, is not sold per use, or its
     * agent runs on its own); 409 `plans_changed` (the plans were changed somewhere else; read them again).
     */
    setPlans: (listingId: string, input: { plans: PlanInput[]; ended?: string[] }) =>
      client.put<{ plans: OwnerPlan[] }>(`/api/marketplace/listings/${seg(listingId)}/plans`, {
        plans: input.plans,
        ...(input.ended !== undefined ? { ended: input.ended } : {}),
      }),

    // ---- installing ----

    /**
     * Install a listing into the caller's organization. Besides the usual errors:
     * a monthly listing charges its first period and answers 402 `insufficient_credits`
     * (with `requiredCents` in `error.data`); a token-gated listing answers 403
     * `token_required` (with `tokenSymbol`, `mintAddress` and `requiredBalance` in `error.data`).
     * When the publisher changed the listing's pricing after your subscription was agreed,
     * the install pauses at the end of the paid period and this call answers 409
     * `pricing_changed`; pass `acceptNewPricing: true` to continue on the new terms.
     * 409 `subscription_claim_lost` means another request for the same install won; retry.
     * A listing that sells use is not installed: it answers 409 `sells_use` (with `handle`), and
     * `startUsing` is the call. 409 `already_using` (with `handle`) means you already use that agent.
     */
    install: (listingId: string, options: { acceptNewPricing?: boolean } = {}) =>
      client.post<{ message: string; install: unknown; clonedAgent: unknown; subscription: unknown }>(
        `/api/marketplace/listings/${seg(listingId)}/install`,
        options.acceptNewPricing ? { acceptNewPricing: true } : undefined,
      ),

    /**
     * Start using the creator's agent (a listing that sells `use`), or accept its new pricing. No copy is made:
     * you use the agent with `use.chat` and `use.run`, or on its page.
     *
     * `expected` is the pricing you were shown, and it is required: it is your consent. A per-use price charges
     * nothing now (each use is charged when it is sent); a monthly price charges the first 30 days from your
     * credits. 201 when this call started or accepted something, 200 when you were already using it.
     * Needs an owner or admin, or a key granted `marketplace:install` by name.
     *
     * Refusals: 400 `expected_terms_required`; 402 `insufficient_credits` (`requiredCents` in `error.data`);
     * 404 `listing_not_found`; 409 `sells_copies` (install it instead), `own_agent`, `not_offered`,
     * `subscription_claim_lost` (another request won; retry), `copy_subscription_active` (you hold a copy of
     * the agent with a month paid for; `until` in `error.data` is the date it ends, so remove the copy or
     * cancel its renewal and start after that date; nothing is written or charged), `listing_paused` (the
     * model the agent runs on is not running; nothing was started or charged, try again later) and
     * `pricing_changed` (`pricing` in `error.data` is the listing as it is now; pass `acceptNewPricing: true`
     * to continue on it); 503 `service_unavailable` (the start could not be checked; nothing was charged).
     */
    startUsing: (listingId: string, options: { expected: ExpectedPricing; acceptNewPricing?: boolean }) =>
      client.post<StartedUsing>(`/api/marketplace/listings/${seg(listingId)}/use`, {
        expected: options.expected,
        ...(options.acceptNewPricing ? { acceptNewPricing: true } : {}),
      }),

    /**
     * Start a plan on a listing: `POST /api/marketplace/listings/{id}/use` with the plan you were shown, whole
     * (a `PlanOffer` from `get`, `use.access` or `myInstalls` can be passed as it came). Its 30 days are charged
     * from your credits now, and the same price every 30 days after that. Starting a plan agrees to no price
     * per use. Always 201. Needs an owner or admin, or a key granted `marketplace:install` by name.
     *
     * Refusals, with nothing charged: 400 `expected_terms_required`; 402 `insufficient_credits`
     * (`requiredCents` in `error.data`); 409 `pricing_changed` (the plan is not what you were shown;
     * `pricing` and the `plans` on offer now are in `error.data`), `already_on_plan` (a plan or a month for
     * this agent still runs), `subscription_claim_lost` (another request won; retry); and the refusals of
     * `startUsing` about the listing (`listing_not_found`, `own_agent`, `sells_copies`, `not_offered`,
     * `copy_subscription_active`, `listing_paused`, 503 `service_unavailable`).
     */
    startPlan: (listingId: string, plan: PlanTerms) =>
      client.post<StartedUsing>(`/api/marketplace/listings/${seg(listingId)}/use`, { plan: planTermsOf(plan) }),

    /**
     * Move up to a bigger plan of the same listing now: the same route with `switchNow: true`. The bigger
     * plan's full price is charged, a fresh 30 days starts, and the uses you had left are carried into them
     * once (`carriedUses`). The 30 days that were running are not refunded, so only a plan that costs more
     * is a move; to move to a smaller one, cancel the renewal and start it when your plan ends. Always 201.
     *
     * Refusals, with nothing charged or changed: 400 `invalid_plan_move`; 402 `insufficient_credits`; 409
     * `not_on_plan`, `same_plan`, `not_a_bigger_plan`, `pricing_changed` (as at a start) and
     * `subscription_claim_lost` (a renewal, a use or another move changed your subscription first).
     */
    movePlan: (listingId: string, plan: PlanTerms) =>
      client.post<StartedUsing>(`/api/marketplace/listings/${seg(listingId)}/use`, {
        plan: planTermsOf(plan),
        switchNow: true,
      }),

    /**
     * Stop using an agent. This is the uninstall route: a subscription ends now, and the month you paid for
     * is not refunded (cancel the subscription instead to keep access until it ends).
     */
    stopUsing: (listingId: string) =>
      client.post<{ message: string }>(`/api/marketplace/listings/${seg(listingId)}/uninstall`),

    /** Remove a copy, or stop using an agent (`stopUsing` is the same call). */
    uninstall: (listingId: string) =>
      client.post<{ message: string }>(`/api/marketplace/listings/${seg(listingId)}/uninstall`),

    installStatus: (listingId: string) =>
      client.get<{
        isInstalled: boolean;
        install: {
          id: string;
          status: string;
          kind: "copy" | "use";
          clonedAgentId: string | null;
          agent: LicenceAgent;
          access: InstallAccess;
          installedAt: string;
        } | null;
      }>(`/api/marketplace/listings/${seg(listingId)}/install-status`),

    /**
     * Your installs, lapsed ones included. A use carries the plans its listing offers (`listing.plans`) and
     * the plan it is on (`subscription.plan`). `canSpend` says whether this caller may start, move up or
     * resume: an owner or admin, or a key granted `marketplace:install` by name.
     */
    myInstalls: () =>
      client.get<{ installs: AgentInstall[]; canSpend: boolean }>("/api/marketplace/my-installs"),

    // ---- reviews ----

    /** `POST /api/marketplace/listings/{id}/reviews`. `rating` is 1 to 5. The new row carries no `reviewerName`. */
    addReview: (listingId: string, review: { rating: number; title?: string; content?: string }) =>
      client.post<{ review: Omit<AgentReview, "reviewerName"> }>(`/api/marketplace/listings/${seg(listingId)}/reviews`, review),

    // ---- subscriptions and revenue ----

    /** Your subscriptions: months and plans alike. */
    subscriptions: () =>
      client.get<{ subscriptions: unknown[] }>("/api/marketplace/subscriptions"),

    /**
     * Stop the renewal of a month or a plan. Access, and a plan's uses, stay until the 30 days paid for end,
     * and nothing more is charged. Any member can cancel. 404 `subscription_not_found`.
     */
    cancelSubscription: (listingId: string) =>
      client.post<{ subscription: unknown }>(`/api/marketplace/subscriptions/${seg(listingId)}/cancel`),

    /**
     * Keep renewing after all. It turns the charges back on, so it needs an owner or admin, or a key granted
     * `marketplace:install` by name. 404 `subscription_not_found`.
     */
    resumeSubscription: (listingId: string) =>
      client.post<{ subscription: unknown }>(`/api/marketplace/subscriptions/${seg(listingId)}/resume`),

    /**
     * Your earnings, and in `payoutLimits` what a payout may ask for right now: the minimum, the
     * limits for a wallet, what was used today, the largest amount and the methods offered.
     */
    revenue: () =>
      client.get<PublisherRevenue>("/api/marketplace/revenue"),

    /**
     * Requests a payout of your earnings as credits, or to a Solana wallet in USDC or SOL. Leave
     * `amountCents` out to take the largest amount allowed right now. Needs a session token of an
     * owner or admin (an API key is refused). One payout can be open at a time.
     *
     * A refusal is a `WheelsAIError` whose `message` is a plain sentence to show as it comes, and
     * whose `code` is one of: `payouts_unavailable` (503), `invalid_payload`,
     * `payout_method_unavailable`, `payout_below_minimum`, `payout_above_balance`,
     * `payout_above_limit`, `payout_address_required`, `invalid_payout_address` (400),
     * `payout_in_progress`, `payout_daily_limit`, `payout_reservation_conflict` (409) or
     * `payout_check_unavailable` (503). Nothing is reserved by a refused request.
     */
    requestPayout: (input: RequestPayoutInput) =>
      client.post<RequestedPayout>("/api/marketplace/payouts", input),

    /** Your payout requests, newest first. */
    payouts: () =>
      client.get<{ payouts: CreatorPayout[] }>("/api/marketplace/payouts"),

    /**
     * Cancels a payout that has not started to be sent: it becomes `cancelled` and its amount goes
     * back to the earnings it was taken from. Needs a session token of an owner or admin (an API
     * key is refused). 404 `payout_not_found`; 409 `payout_not_cancellable` once the payout is
     * being sent or is finished (`error.message` says which).
     */
    cancelPayout: (payoutId: string) =>
      client.post<{ payout: CreatorPayout }>(`/api/marketplace/payouts/${seg(payoutId)}/cancel`),
  };
}
