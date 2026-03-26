import type { WheelsAIClient } from "../client.js";

export interface AgentListing {
  id: string;
  agentId: string;
  name: string;
  description: string;
  category: string;
  status: string;
  pricing: string;
  monthlyPrice: number;
  installCount: number;
  avgRating: number;
  publisherName: string;
  publisherVerified: boolean;
  tags: string[];
  createdAt: string;
}

export interface AgentReview {
  id: string;
  rating: number;
  title: string;
  body: string;
  userName: string;
  createdAt: string;
}

export function marketplaceResource(client: WheelsAIClient) {
  return {
    search: (params?: { query?: string; category?: string; sort?: string; limit?: number; offset?: number }) =>
      client.get<{ listings: AgentListing[]; total: number }>("/api/marketplace", params),

    get: (listingId: string) =>
      client.get<{ listing: AgentListing }>(`/api/marketplace/${listingId}`),

    install: (listingId: string) =>
      client.post<{ install: { id: string }; agent: { id: string } }>(`/api/marketplace/${listingId}/install`),

    reviews: (listingId: string) =>
      client.get<{ reviews: AgentReview[]; averageRating: number; totalReviews: number }>(`/api/marketplace/${listingId}/reviews`),

    addReview: (listingId: string, review: { rating: number; title: string; body: string }) =>
      client.post<{ review: AgentReview }>(`/api/marketplace/${listingId}/reviews`, review),
  };
}
