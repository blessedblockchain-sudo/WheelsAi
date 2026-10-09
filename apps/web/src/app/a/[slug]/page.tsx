import type { Metadata } from "next";
import { cache } from "react";

import { PublicAgentView } from "@/components/public-agent/public-agent-view";
import { API_BASE_URL, type PublicAgentDetail } from "@/lib/api";

interface Params {
  slug: string;
}

/** Long enough for the API on a good day; a slow one hands the read to the browser. */
const SERVER_READ_TIMEOUT_MS = 5_000;

/**
 * The agent at this address, read on the server so a shared link previews
 * with its name and the page arrives drawn. No cookies go with it (this is
 * a page for strangers) and nothing is cached, a failure least of all:
 * "not_found" is the API's own 404, and null is any other failure, which
 * the browser then retries for itself.
 *
 * Wrapped in `cache` so the metadata and the page share one read a request.
 */
const readAgent = cache(async (handle: string): Promise<PublicAgentDetail | "not_found" | null> => {
  try {
    const res = await fetch(`${API_BASE_URL}/api/a/${encodeURIComponent(handle)}`, {
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(SERVER_READ_TIMEOUT_MS),
    });
    if (res.status === 404) return "not_found";
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const detail = body as Partial<PublicAgentDetail> | null;
    // Anything that is not the page's own shape is treated as a failed read.
    if (!detail || typeof detail.agent?.name !== "string" || typeof detail.use?.state !== "string") return null;
    return detail as PublicAgentDetail;
  } catch {
    return null;
  }
});

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const detail = await readAgent(slug);
  if (detail === "not_found") return { title: "Agent not found", robots: { index: false } };
  if (detail === null) return { title: "Agent" };

  const { name, description } = detail.agent;
  const summary = description?.trim() || `${name} on WheelsAI.`;
  return {
    title: name,
    description: summary,
    openGraph: { type: "website", title: name, description: summary },
    twitter: { card: "summary", title: name, description: summary },
  };
}

export default async function PublicAgentPage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const initial = await readAgent(slug);
  // Keyed by the address: moving from one agent's page to another starts the view afresh.
  return <PublicAgentView key={slug} handle={slug} initial={initial} />;
}
