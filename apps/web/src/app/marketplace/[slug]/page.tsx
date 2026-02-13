"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  Star,
  Download,
  Cpu,
  ArrowLeft,
  ExternalLink,
  Shield,
  Clock,
  Users,
  CheckCircle,
  ChevronRight,
  MessageSquare,
  Play,
} from "lucide-react";
import {
  marketplaceApi,
  type MarketplaceListing,
  type MarketplaceReview,
} from "@/lib/api";

function formatPrice(listing: MarketplaceListing): string {
  if (listing.pricingModel === "free") return "Free";
  if (listing.pricingModel === "tokenized") return "Token Gated";
  if (listing.pricingModel === "per_request" && listing.pricePerRequestCents) {
    const price = listing.pricePerRequestCents / 100;
    return `$${price.toFixed(4)} per request`;
  }
  if (listing.pricingModel === "monthly" && listing.monthlyPriceCents) {
    const price = listing.monthlyPriceCents / 100;
    return `$${price.toFixed(2)}/month`;
  }
  return "Free";
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          className={`h-4 w-4 ${
            star <= rating
              ? "fill-yellow-400 text-yellow-400"
              : "fill-gray-200 text-gray-200"
          }`}
        />
      ))}
    </div>
  );
}

function ReviewCard({ review }: { review: MarketplaceReview }) {
  return (
    <div className="border-b py-4 last:border-0">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-900">
              {review.reviewerName}
            </span>
            {review.isVerified && (
              <span className="flex items-center gap-1 text-xs text-green-600">
                <CheckCircle className="h-3 w-3" />
                Verified
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <StarRating rating={review.rating} />
            <span className="text-sm text-gray-500">
              {formatDate(review.createdAt)}
            </span>
          </div>
        </div>
      </div>
      {review.title && (
        <h4 className="mt-2 font-medium text-gray-900">{review.title}</h4>
      )}
      {review.content && (
        <p className="mt-1 text-sm text-gray-600">{review.content}</p>
      )}
    </div>
  );
}

export default function ListingDetailPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;

  const [listing, setListing] = useState<MarketplaceListing | null>(null);
  const [reviews, setReviews] = useState<MarketplaceReview[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"overview" | "reviews">("overview");

  useEffect(() => {
    async function loadData() {
      setIsLoading(true);
      try {
        const [listingRes, reviewsRes] = await Promise.all([
          marketplaceApi.getListing(slug),
          marketplaceApi.getListingReviews(slug, 1, 10).catch(() => ({
            reviews: [],
            pagination: { page: 1, limit: 10, total: 0, totalPages: 0 },
          })),
        ]);

        setListing(listingRes.listing);
        setReviews(reviewsRes.reviews);
      } catch (error) {
        console.error("Failed to load listing:", error);
      } finally {
        setIsLoading(false);
      }
    }

    if (slug) {
      loadData();
    }
  }, [slug]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <header className="border-b bg-white">
          <div className="mx-auto flex h-16 max-w-7xl items-center px-4 sm:px-6 lg:px-8">
            <div className="h-8 w-32 animate-pulse rounded bg-gray-200" />
          </div>
        </header>
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <div className="h-64 animate-pulse rounded-lg bg-gray-200" />
        </div>
      </div>
    );
  }

  if (!listing) {
    return (
      <div className="min-h-screen bg-gray-50">
        <header className="border-b bg-white">
          <div className="mx-auto flex h-16 max-w-7xl items-center px-4 sm:px-6 lg:px-8">
            <Link href="/" className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-600">
                <Cpu className="h-5 w-5 text-white" />
              </div>
              <span className="text-xl font-bold">WheelsAI</span>
            </Link>
          </div>
        </header>
        <div className="mx-auto max-w-7xl px-4 py-16 text-center sm:px-6 lg:px-8">
          <h1 className="text-2xl font-bold text-gray-900">Agent Not Found</h1>
          <p className="mt-2 text-gray-600">
            The agent you're looking for doesn't exist or has been removed.
          </p>
          <Link
            href="/marketplace"
            className="mt-6 inline-flex items-center gap-2 text-primary-600 hover:text-primary-700"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Marketplace
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="border-b bg-white">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link href="/" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-600">
              <Cpu className="h-5 w-5 text-white" />
            </div>
            <span className="text-xl font-bold">WheelsAI</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link
              href="/login"
              className="text-sm font-medium text-gray-600 hover:text-gray-900"
            >
              Sign in
            </Link>
            <Link href="/register" className="btn-primary">
              Get Started
            </Link>
          </div>
        </div>
      </header>

      {/* Breadcrumb */}
      <div className="border-b bg-white">
        <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 lg:px-8">
          <nav className="flex items-center gap-2 text-sm">
            <Link
              href="/marketplace"
              className="text-gray-500 hover:text-gray-700"
            >
              Marketplace
            </Link>
            <ChevronRight className="h-4 w-4 text-gray-400" />
            <span className="text-gray-900">{listing.title}</span>
          </nav>
        </div>
      </div>

      {/* Main Content */}
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="grid gap-8 lg:grid-cols-3">
          {/* Left Column - Details */}
          <div className="lg:col-span-2">
            {/* Header */}
            <div className="rounded-lg border bg-white p-6">
              <div className="flex items-start gap-4">
                <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary-100 to-primary-200">
                  {listing.iconUrl ? (
                    <img
                      src={listing.iconUrl}
                      alt={listing.title}
                      className="h-10 w-10 rounded-lg"
                    />
                  ) : (
                    <Cpu className="h-8 w-8 text-primary-600" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h1 className="text-2xl font-bold text-gray-900">
                      {listing.title}
                    </h1>
                    {listing.isFeatured && (
                      <span className="rounded bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800">
                        Featured
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-gray-600">
                    by{" "}
                    <Link
                      href={`/marketplace/publisher/${listing.publisherId}`}
                      className="text-primary-600 hover:text-primary-700"
                    >
                      {listing.publisherName}
                    </Link>
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
                    <div className="flex items-center gap-1 text-yellow-600">
                      <Star className="h-4 w-4 fill-current" />
                      <span className="font-medium">
                        {listing.avgRating.toFixed(1)}
                      </span>
                      <span className="text-gray-400">
                        ({listing.reviewCount} reviews)
                      </span>
                    </div>
                    <div className="flex items-center gap-1 text-gray-500">
                      <Download className="h-4 w-4" />
                      <span>
                        {listing.totalInstalls.toLocaleString()} installs
                      </span>
                    </div>
                    <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600">
                      {listing.agent?.framework || "custom"}
                    </span>
                  </div>
                </div>
              </div>

              <p className="mt-4 text-gray-700">{listing.shortDescription}</p>
            </div>

            {/* Tabs */}
            <div className="mt-6">
              <div className="border-b">
                <nav className="-mb-px flex gap-6">
                  <button
                    onClick={() => setActiveTab("overview")}
                    className={`border-b-2 pb-3 text-sm font-medium ${
                      activeTab === "overview"
                        ? "border-primary-600 text-primary-600"
                        : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                    }`}
                  >
                    Overview
                  </button>
                  <button
                    onClick={() => setActiveTab("reviews")}
                    className={`flex items-center gap-2 border-b-2 pb-3 text-sm font-medium ${
                      activeTab === "reviews"
                        ? "border-primary-600 text-primary-600"
                        : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                    }`}
                  >
                    Reviews
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs">
                      {listing.reviewCount}
                    </span>
                  </button>
                </nav>
              </div>

              {/* Tab Content */}
              <div className="mt-6">
                {activeTab === "overview" && (
                  <div className="space-y-6">
                    {/* Description */}
                    {listing.longDescription && (
                      <div className="rounded-lg border bg-white p-6">
                        <h2 className="font-semibold text-gray-900">
                          Description
                        </h2>
                        <div className="prose prose-sm mt-4 max-w-none text-gray-600">
                          {listing.longDescription}
                        </div>
                      </div>
                    )}

                    {/* Screenshots */}
                    {listing.screenshots && listing.screenshots.length > 0 && (
                      <div className="rounded-lg border bg-white p-6">
                        <h2 className="font-semibold text-gray-900">
                          Screenshots
                        </h2>
                        <div className="mt-4 grid gap-4 sm:grid-cols-2">
                          {listing.screenshots.map((url, i) => (
                            <img
                              key={i}
                              src={url}
                              alt={`Screenshot ${i + 1}`}
                              className="rounded-lg border"
                            />
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Tags */}
                    {listing.agent?.tags && listing.agent.tags.length > 0 && (
                      <div className="rounded-lg border bg-white p-6">
                        <h2 className="font-semibold text-gray-900">Tags</h2>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {listing.agent.tags.map((tag) => (
                            <span
                              key={tag}
                              className="rounded-full bg-gray-100 px-3 py-1 text-sm text-gray-600"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "reviews" && (
                  <div className="rounded-lg border bg-white p-6">
                    <div className="flex items-center justify-between">
                      <h2 className="font-semibold text-gray-900">
                        User Reviews
                      </h2>
                      <Link
                        href="/login"
                        className="text-sm text-primary-600 hover:text-primary-700"
                      >
                        Write a Review
                      </Link>
                    </div>

                    {/* Rating Summary */}
                    <div className="mt-4 flex items-center gap-4 rounded-lg bg-gray-50 p-4">
                      <div className="text-center">
                        <div className="text-4xl font-bold text-gray-900">
                          {listing.avgRating.toFixed(1)}
                        </div>
                        <StarRating rating={Math.round(listing.avgRating)} />
                        <div className="mt-1 text-sm text-gray-500">
                          {listing.reviewCount} reviews
                        </div>
                      </div>
                    </div>

                    {/* Review List */}
                    <div className="mt-6">
                      {reviews.length === 0 ? (
                        <div className="py-8 text-center text-gray-500">
                          <MessageSquare className="mx-auto h-8 w-8 text-gray-300" />
                          <p className="mt-2">No reviews yet</p>
                          <p className="text-sm">
                            Be the first to review this agent
                          </p>
                        </div>
                      ) : (
                        <div className="divide-y">
                          {reviews.map((review) => (
                            <ReviewCard key={review.id} review={review} />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right Column - Sidebar */}
          <div className="space-y-6">
            {/* Pricing Card */}
            <div className="rounded-lg border bg-white p-6">
              <div className="text-center">
                <div
                  className={`text-3xl font-bold ${listing.pricingModel === "free" ? "text-green-600" : "text-gray-900"}`}
                >
                  {formatPrice(listing)}
                </div>
                {listing.pricingModel !== "free" && (
                  <p className="mt-1 text-sm text-gray-500">
                    {listing.pricingModel === "per_request"
                      ? "Pay only for what you use"
                      : listing.pricingModel === "tokenized"
                      ? "Hold tokens to access this agent"
                      : "Billed monthly"}
                  </p>
                )}
              </div>

              <Link
                href="/login"
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 py-3 font-medium text-white hover:bg-primary-700"
              >
                <Play className="h-4 w-4" />
                Deploy Agent
              </Link>

              <p className="mt-3 text-center text-xs text-gray-500">
                Sign in to deploy this agent to your account
              </p>
            </div>

            {/* Stats Card */}
            <div className="rounded-lg border bg-white p-6">
              <h3 className="font-semibold text-gray-900">Statistics</h3>
              <dl className="mt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <dt className="flex items-center gap-2 text-sm text-gray-500">
                    <Download className="h-4 w-4" />
                    Total Installs
                  </dt>
                  <dd className="font-medium text-gray-900">
                    {listing.totalInstalls.toLocaleString()}
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="flex items-center gap-2 text-sm text-gray-500">
                    <Users className="h-4 w-4" />
                    Active Users
                  </dt>
                  <dd className="font-medium text-gray-900">
                    {listing.activeInstalls.toLocaleString()}
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="flex items-center gap-2 text-sm text-gray-500">
                    <Star className="h-4 w-4" />
                    Rating
                  </dt>
                  <dd className="font-medium text-gray-900">
                    {listing.avgRating.toFixed(1)} / 5
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="flex items-center gap-2 text-sm text-gray-500">
                    <Clock className="h-4 w-4" />
                    Published
                  </dt>
                  <dd className="font-medium text-gray-900">
                    {listing.publishedAt
                      ? formatDate(listing.publishedAt)
                      : "Draft"}
                  </dd>
                </div>
              </dl>
            </div>

            {/* Info Card */}
            <div className="rounded-lg border bg-white p-6">
              <h3 className="font-semibold text-gray-900">Information</h3>
              <dl className="mt-4 space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <dt className="text-gray-500">Category</dt>
                  <dd className="font-medium capitalize text-gray-900">
                    {listing.category.replace("-", " ")}
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-gray-500">Framework</dt>
                  <dd className="font-medium capitalize text-gray-900">
                    {listing.agent?.framework || "Custom"}
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-gray-500">Last Updated</dt>
                  <dd className="font-medium text-gray-900">
                    {formatDate(listing.updatedAt)}
                  </dd>
                </div>
              </dl>
            </div>

            {/* Publisher Card */}
            <div className="rounded-lg border bg-white p-6">
              <h3 className="font-semibold text-gray-900">Publisher</h3>
              <div className="mt-4 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-100">
                  <span className="text-sm font-semibold text-primary-600">
                    {listing.publisherName.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div>
                  <div className="font-medium text-gray-900">
                    {listing.publisherName}
                  </div>
                  <Link
                    href={`/marketplace/publisher/${listing.publisherId}`}
                    className="text-sm text-primary-600 hover:text-primary-700"
                  >
                    View Profile
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="mt-12 border-t bg-white py-8">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded bg-primary-600">
                <Cpu className="h-4 w-4 text-white" />
              </div>
              <span className="font-semibold">WheelsAI</span>
            </div>
            <p className="text-sm text-gray-500">
              Built on Nosana. Powered by decentralized compute.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
