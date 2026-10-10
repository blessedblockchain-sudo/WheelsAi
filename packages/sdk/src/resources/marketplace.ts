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

/** The agent a licence is for, as its buyer may know it. Never its instructions. */
export interface LicenceAgent {
  /** The name in `/a/<handle>`; null when the agent has no page. */
  handle: string | null;
  name: string;
  agentKind: AgentKind;
}

/**
 * Where a licence stands. A copy is `subscribed`, `listing_pricing`, `unlisted`, `subscription_lapsed`,
 * `pricing_changed` or `uninstalled`. Use of the creator's agent can also be `none` (not started) or
 * `not_offered` (the listing no longer sells it).
 */
export type InstallAccess =
  | "subscribed"
  | "listing_pricing"
  | "unlisted"
  | "subscription_lapsed"
  | "pricing_changed"
  | "uninstalled"
  | "none"
  | "not_offered";

/** A buyer's monthly subscription to a listing. */
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
  /** The monthly price the subscription was agreed at, which a renewal charges. */
  priceCents: number | null;
  /** Set when the publisher's side ended it. `use_ended`: the listing stopped selling use. */
  endReason: "pricing_changed" | "listing_archived" | "use_ended" | null;
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

/** The answer of `startUsing`. */
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

    /** The caller organization's listings in every status. */
    myListings: () =>
      client.get<{ listings: AgentListing[] }>("/api/marketplace/my-listings"),

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
     * cancel its renewal and start after that date; nothing is written or charged) and `pricing_changed`
     * (`pricing` in `error.data` is the listing as it is now; pass `acceptNewPricing: true` to continue on it).
     */
    startUsing: (listingId: string, options: { expected: ExpectedPricing; acceptNewPricing?: boolean }) =>
      client.post<StartedUsing>(`/api/marketplace/listings/${seg(listingId)}/use`, {
        expected: options.expected,
        ...(options.acceptNewPricing ? { acceptNewPricing: true } : {}),
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

    myInstalls: () =>
      client.get<{ installs: AgentInstall[] }>("/api/marketplace/my-installs"),

    // ---- reviews ----

    /** `POST /api/marketplace/listings/{id}/reviews`. `rating` is 1 to 5. The new row carries no `reviewerName`. */
    addReview: (listingId: string, review: { rating: number; title?: string; content?: string }) =>
      client.post<{ review: Omit<AgentReview, "reviewerName"> }>(`/api/marketplace/listings/${seg(listingId)}/reviews`, review),

    // ---- subscriptions and revenue ----

    subscriptions: () =>
      client.get<{ subscriptions: unknown[] }>("/api/marketplace/subscriptions"),

    cancelSubscription: (listingId: string) =>
      client.post<{ subscription: unknown }>(`/api/marketplace/subscriptions/${seg(listingId)}/cancel`),

    resumeSubscription: (listingId: string) =>
      client.post<{ subscription: unknown }>(`/api/marketplace/subscriptions/${seg(listingId)}/resume`),

    revenue: () =>
      client.get<Record<string, unknown>>("/api/marketplace/revenue"),

    payouts: () =>
      client.get<{ payouts: unknown[] }>("/api/marketplace/payouts"),
  };
}
