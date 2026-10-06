import { seg, type WheelsAIClient } from "../client.js";

export type ListingCategory =
  | "customer-support"
  | "coding"
  | "research"
  | "automation"
  | "creative"
  | "other";

export type PricingModel = "free" | "per_request" | "monthly" | "tokenized";

export type ListingStatus = "draft" | "published" | "archived" | (string & {});

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
  agent?: { id: string; framework: string; tags: string[]; slug?: string; isPublic?: boolean };
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
     */
    install: (listingId: string, options: { acceptNewPricing?: boolean } = {}) =>
      client.post<{ message: string; install: unknown; clonedAgent: unknown; subscription: unknown }>(
        `/api/marketplace/listings/${seg(listingId)}/install`,
        options.acceptNewPricing ? { acceptNewPricing: true } : undefined,
      ),

    uninstall: (listingId: string) =>
      client.post<{ message: string }>(`/api/marketplace/listings/${seg(listingId)}/uninstall`),

    installStatus: (listingId: string) =>
      client.get<{ isInstalled: boolean; install: unknown | null }>(
        `/api/marketplace/listings/${seg(listingId)}/install-status`,
      ),

    myInstalls: () =>
      client.get<{ installs: unknown[] }>("/api/marketplace/my-installs"),

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
