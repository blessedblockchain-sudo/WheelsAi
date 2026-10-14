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

/**
 * What a listing is for: an agent, or a workflow. A workflow's listing sells use only, per run, with
 * plans on top: no free trial, no copies, no token. Buyers run it at `/w/<slug>` (the listing's slug) and
 * as model `w/<slug>`; see `use.workflow`.
 */
export type ListingProductKind = "agent" | "workflow";

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
 *
 * A listing's free trial is started with its own terms: its id, a price of 0, its uses and no price for an
 * extra use. `trialTermsOf` builds them from a `TrialOffer`.
 */
export interface PlanTerms {
  id: string;
  priceCents: number;
  includedUses: number;
  extraUsePriceCents: number | null;
}

/**
 * The free trial a listing offers beside its plans: some uses for a number of days, at no price, started
 * once by a buyer's organization. It never renews and nothing is charged for it. A listing that sells use
 * per request can offer one. It is told by itself, never among `plans`: `freeTrial` on a listing read by
 * its slug, `trial` on the access answer (`use.access`).
 *
 * It is not "Try it", the free preview chat every published listing has for anyone.
 */
export interface TrialOffer {
  id: string;
  /** The uses the trial includes, 1 to 50. */
  includedUses: number;
  /** How many days it lasts from its start: 7. */
  days: number;
}

/**
 * The terms that start a listing's free trial, for `startPlan`: the trial's id and its uses as you were
 * shown them, a price of 0 and no price for an extra use.
 */
export function trialTermsOf(trial: TrialOffer): PlanTerms {
  return { id: trial.id, priceCents: 0, includedUses: trial.includedUses, extraUsePriceCents: null };
}

/** A plan as its creator sees it (`myListings`, `setPlans`). No buyer is named. */
export interface OwnerPlan extends PlanOffer {
  /** `paid`, or `trial` for the listing's free trial, which comes first. Its `name` is `Free trial`, its `priceCents` 0 and its `extraUsePriceCents` null. */
  kind: string;
  status: string;
  /** How many subscriptions are on this plan. For the free trial: the trials that are running now. */
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
 * The listing's one free trial, as an entry of the set `setPlans` sends beside the paid plans. It is not
 * one of the four. It has no name of its own: buyers see it as "Free trial". Sent with its `id` it is
 * changed in place; named in `ended` it stops being offered, and the people on it keep it until its days
 * end. Nothing is charged for its uses and its creator is not paid for them.
 */
export interface TrialPlanInput {
  /** Set to change the trial in place. Left out to start offering one. */
  id?: string;
  kind: "trial";
  /** A free trial has no price. */
  priceCents: 0;
  /** 1 to 50. */
  includedUses: number;
  /** A free trial has no price for an extra use. It is always sent, as null. */
  extraUsePriceCents: null;
}

/**
 * The plan a buyer is on, while it gives them uses: on the access answer (`use.access`), on a subscription
 * (`myInstalls`, `startPlan`, `movePlan`) and in `use.usage`. Uses and cents, and nothing of another buyer.
 */
export interface SubscriptionPlan {
  /** The plan the subscription was started on. */
  id: string | null;
  /** What its creator calls it now. `Free trial` for a free trial. */
  name: string;
  /**
   * True on the listing's free trial, which costs nothing and never renews. When its uses are gone it
   * stops, unless you agreed to the listing's price per use yourself. False on a paid plan.
   */
  trial: boolean;
  /** The uses of the 30 days, as agreed. On a free trial: the uses of its days. */
  includedUses: number;
  /** Uses brought into these 30 days by a move to a bigger plan, on top of the included ones. 0 after a renewal. */
  carriedUses: number;
  usedUses: number;
  /** Included plus carried, less the ones used. Never below 0. */
  remainingUses: number;
  /** What each use past the count costs, as agreed. null: the plan stops until it renews. Always null on a free trial. */
  extraUsePriceCents: number | null;
  /** When the count starts again (an ISO time). Left out when the plan will not renew, and always on a free trial. */
  resetsAt?: string;
  /** 85 when 85% of the uses are gone, 100 when all are. */
  warning: null | 85 | 100;
}

export interface AgentListing {
  id: string;
  /** An agent, or a workflow. */
  productKind: ListingProductKind;
  /** The listed agent. null on a workflow's listing. */
  agentId: string | null;
  /**
   * Your own listings only (create, update, `myListings`): the listed workflow, and null on an agent's
   * listing. A read anyone can make does not carry it.
   */
  orchestrationId?: string | null;
  title: string;
  /**
   * The URL segment: the listing lives at `<web>/marketplace/<slug>`. Derived from the title by the API. A
   * workflow's listing is also used by it: its page is `/w/<slug>` and its model `w/<slug>`.
   */
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
  /** What the listing sells. A workflow's listing sells `use`. */
  sells: ListingSells;
  /** `run` on a workflow's listing. */
  unit: ListingUnit | null;
  /** Whether the listing has a token. Present on a search, the featured row and a listing read by slug. */
  hasToken?: boolean;
  /** Your own listings only (create, update, `myListings`): the tools the agent may use for people who pay. */
  allowedTools?: string[];
  /** `myListings` only: how many people have a copy, use it, or are subscribed. */
  buyers?: { copies: number; using: number; subscribed: number };
  /**
   * The plans the listing offers, in the order buyers see them; empty when it offers none. Present on a
   * listing read by its slug (`get`), on the listing of each of `myInstalls`, and on `myListings`, where
   * each plan also says its `status` and `subscribers` (`OwnedListing`). Left out on a read by id.
   */
  plans?: PlanOffer[];
  /**
   * A listing read by its slug (`get`) only: the free trial it offers beside its plans, or null when it
   * offers none. Left out on a read by id: read the listing by its slug, or ask `use.access(handle)`.
   */
  freeTrial?: TrialOffer | null;
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
  /** `agentKind` says how people use the listed agent. Left out on a workflow's listing. */
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

/**
 * A listing as `publishListing` and `archiveListing` answer it: the row as it is stored, which carries no
 * `productKind` and no `unit`. Read them with `myListings`, or keep the ones of the listing you had.
 */
export type StoredListing = Omit<AgentListing, "productKind" | "unit"> &
  Partial<Pick<AgentListing, "productKind" | "unit">>;

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
 * `plan_ended` (a plan or a free trial that is over, with no price per use agreed to) or `not_offered`
 * (the listing no longer sells it).
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
  /** The price for 30 days the subscription was agreed at, which a renewal charges. 0 on a free trial, which is never renewed. */
  priceCents: number | null;
  /**
   * Set when it ended for a reason other than your own cancelling. `use_ended`: the listing stopped selling
   * use. `plan_ended`: its creator ended the plan and it finished with the 30 days paid for, or it was a
   * free trial whose 7 days are over (`trialEnded` on the install tells the two apart).
   */
  endReason: "pricing_changed" | "listing_archived" | "use_ended" | "plan_ended" | null;
  /** The plan it is on, while that gives uses. null for a month with no count, and for a plan that is over. */
  plan?: SubscriptionPlan | null;
}

/** One licence in `myInstalls`: a copy the buyer owns, or the right to use the creator's agent or workflow. */
export interface AgentInstall {
  id: string;
  listingId: string;
  /** `use`: the buyer uses the creator's agent or workflow and has no copy. `copy`: their own copy. */
  kind: "copy" | "use";
  /** null when `kind` is `use`. */
  clonedAgentId: string | null;
  /** What the listing is for. */
  productKind: ListingProductKind;
  /** The listing's slug: a workflow is used at `/w/<slug>`. */
  slug: string;
  /** The agent, as its buyer may know it. null for a workflow, which has no agent. */
  agent: LicenceAgent | null;
  status: string;
  totalRequests: number;
  totalSpentCents: number;
  installedAt: string;
  access: InstallAccess;
  /**
   * True only when `access` is `plan_ended` and what ended was your organization's own free trial, not a
   * paid plan. Always false for a copy.
   */
  trialEnded: boolean;
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
  /** What the listing is for. */
  productKind: ListingProductKind;
  /** The listing's slug: a workflow is used at `/w/<slug>`. */
  slug: string;
  /** null for a workflow, which has no agent. */
  agent: LicenceAgent | null;
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

/** The fields of a listing that do not say what it sells. */
interface ListingFields {
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

/** A listing of an agent. */
export interface CreateAgentListingInput extends ListingFields {
  /** The agent to list. Must belong to the caller's organization and have no listing yet. */
  agentId: string;
  orchestrationId?: never;
}

/**
 * A listing of a workflow, sold per run: `pricingModel` is `per_request` and `pricePerRequestCents` at least
 * 5. Plans are set afterwards with `setPlans`; a workflow has no free trial. The workflow must be enabled,
 * have a step, use only agents its organization built, and have a time limit of 10 minutes or less (the
 * capabilities' `paidUse.paidWorkflowMaxRunMs`), or the create answers 409 `workflow_not_sellable` with the
 * reason. Refused on their field (400 `validation_failed`): `sells: "copies"`, any other pricing model, a
 * price under 5, any `allowedTools`, and a title with no letter or digit. 409 `listing_exists` when the
 * workflow already has a listing; 404 `workflow_not_found` when it is not one of the caller's.
 */
export interface CreateWorkflowListingInput extends Omit<ListingFields, "pricingModel" | "pricePerRequestCents" | "monthlyPriceCents" | "sells" | "allowedTools"> {
  /** The workflow to list. Must belong to the caller's organization and have no listing yet. */
  orchestrationId: string;
  agentId?: never;
  pricingModel: "per_request";
  /** The price of one run, in cents: 5 to 100000. */
  pricePerRequestCents: number;
  /** A workflow is sold by use only. */
  sells?: "use";
}

/** What `createListing` sends: an agent or a workflow, exactly one of the two. */
export type CreateListingInput = CreateAgentListingInput | CreateWorkflowListingInput;

/**
 * A change never names what a listing sells. On a workflow's listing the price per run, the words and the
 * category change; the same refusals as at a create apply.
 */
export type UpdateListingInput = Partial<ListingFields>;

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

    /**
     * One listing by slug (or id). Published listings only. Only a read by slug carries `plans` and `freeTrial`.
     * `productKind` says whether it is an agent's or a workflow's.
     */
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

    /**
     * The caller organization's listings in every status, each with the plans it has on offer, what it is for
     * (`productKind`) and, for a workflow's listing, the workflow (`orchestrationId`).
     */
    myListings: () =>
      client.get<{ listings: OwnedListing[] }>("/api/marketplace/my-listings"),

    /**
     * Creates a draft of an agent's listing (`agentId`) or a workflow's (`orchestrationId`), exactly one of
     * the two: both or neither answers 400 `validation_failed`. Follow with `publishListing`, or send
     * `publish: true`.
     */
    createListing: (input: CreateListingInput) =>
      client.post<{ listing: AgentListing }>("/api/marketplace/listings", input),

    updateListing: (listingId: string, updates: UpdateListingInput) =>
      client.patch<{ listing: AgentListing }>(`/api/marketplace/listings/${seg(listingId)}`, updates),

    /**
     * Makes a draft or archived listing public. The response carries the `slug`. Its listing is the stored
     * row (`StoredListing`): it has no `productKind` and no `unit`; read them with `myListings`.
     */
    publishListing: (listingId: string) =>
      client.post<{ listing: StoredListing; message: string }>(
        `/api/marketplace/listings/${seg(listingId)}/publish`,
      ),

    /** Stops selling a listing. Its listing is the stored row, as `publishListing` answers it. */
    archiveListing: (listingId: string) =>
      client.post<{ listing: StoredListing; message: string }>(
        `/api/marketplace/listings/${seg(listingId)}/archive`,
      ),

    /**
     * `PUT /api/marketplace/listings/{id}/plans`: set the plans of a listing that sells use per request.
     * `plans` is the whole set and replaces what the listing has: a plan sent with its `id` is changed in
     * place, one sent without is new. A plan that ends is named in `ended`; ending is said, never implied,
     * so a plan on offer that is in neither list refuses the whole save. At most four plans. People already
     * on a plan keep the terms they agreed to. Needs an owner or admin, or an API key.
     *
     * The listing's one free trial is one more entry of `plans` (`TrialPlanInput`), beside the four: changed
     * in place by its `id`, and named in `ended` to stop offering it. A free trial with a price, with a price
     * for an extra use, with more than 50 uses, or a second one in the set, is refused with 400
     * `validation_failed`. A workflow's listing takes plans, where one run is one use, and no free trial: an
     * entry of kind `trial` is refused on its `kind`.
     *
     * Answers the plans as they are now. Refusals: 400 `validation_failed` (`message` is the first problem,
     * `fields` in `error.data` has a sentence for each, keyed as `plans[0].priceCents`); 404
     * `listing_not_found`; 409 `plans_not_available` (the listing sells copies, is not sold per use, or its
     * agent runs on its own); 409 `plans_changed` (the plans were changed somewhere else; read them again).
     */
    setPlans: (listingId: string, input: { plans: Array<PlanInput | TrialPlanInput>; ended?: string[] }) =>
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
     * A listing that sells use is not installed: it answers 409 `sells_use` (with `handle`, null for a
     * workflow), and `startUsing` is the call. 409 `already_using` (with `handle`) means you already use that
     * agent.
     */
    install: (listingId: string, options: { acceptNewPricing?: boolean } = {}) =>
      client.post<{ message: string; install: unknown; clonedAgent: unknown; subscription: unknown }>(
        `/api/marketplace/listings/${seg(listingId)}/install`,
        options.acceptNewPricing ? { acceptNewPricing: true } : undefined,
      ),

    /**
     * Start using the creator's agent (a listing that sells `use`), or accept its new pricing. No copy is made:
     * you use the agent with `use.chat` and `use.run`, or on its page. A workflow's listing is started the same
     * way and run with `use.workflow.run`; one that cannot run right now is refused with 409 `not_offered` and
     * nothing is charged, and the answer's `agent` is null.
     *
     * `expected` is the pricing you were shown, and it is required: it is your consent. A per-use price charges
     * nothing now (each use is charged when it is sent); a monthly price charges the first 30 days from your
     * credits. 201 when this call started or accepted something, 200 when you were already using it.
     * Needs an owner or admin, or a key granted `marketplace:install` by name.
     *
     * While a plan or a free trial runs, sending the listing's price per use here is your agreement to it:
     * it takes effect at once and answers 201, nothing is charged, and nothing of the plan or the trial
     * changes. It is what you pay per use when the plan or the trial is over, and for each use past the uses
     * of a free trial. A price that went up after you agreed is accepted only with `acceptNewPricing: true`.
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
     *
     * A listing's free trial is started here too, with the trial's own terms: `startPlan(listingId,
     * trialTermsOf(trial))`, where `trial` is the `TrialOffer` you were shown (`freeTrial` of `get` by slug, `trial`
     * of `use.access`). Nothing is charged, and your organization starts it once for a listing. Its own
     * refusals, with nothing written: 409 `trial_already_used` (your organization started this listing's
     * trial before), `trial_needs_credits` (your organization has never added credits: add credits once; the
     * trial itself costs nothing), `already_on_plan`, and `pricing_changed` with `trial` in `error.data`, the
     * trial on offer now or null. A paid plan can be started over a trial that is running: it is charged as
     * any start and nothing of the trial is carried into it.
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
     * `not_on_plan`, `same_plan`, `not_a_bigger_plan`, `pricing_changed` (as at a start),
     * `trial_cannot_move` (you are on a free trial: start the plan you want with `startPlan`) and
     * `subscription_claim_lost` (a renewal, a use or another move changed your subscription first).
     */
    movePlan: (listingId: string, plan: PlanTerms) =>
      client.post<StartedUsing>(`/api/marketplace/listings/${seg(listingId)}/use`, {
        plan: planTermsOf(plan),
        switchNow: true,
      }),

    /**
     * Stop using an agent or a workflow. This is the uninstall route: a subscription ends now, and the month
     * you paid for is not refunded (cancel the subscription instead to keep access until it ends).
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
          productKind: ListingProductKind;
          slug: string;
          /** null for a workflow. */
          agent: LicenceAgent | null;
          access: InstallAccess;
          installedAt: string;
        } | null;
      }>(`/api/marketplace/listings/${seg(listingId)}/install-status`),

    /**
     * Your installs, lapsed ones included. A use carries the plans its listing offers (`listing.plans`) and
     * the plan it is on (`subscription.plan`, a free trial that is running among them), and `trialEnded`
     * says when what ended was a free trial. `canSpend` says whether this caller may start, move up or
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
     * `marketplace:install` by name. 404 `subscription_not_found`, also for a free trial, which is never
     * renewed.
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
