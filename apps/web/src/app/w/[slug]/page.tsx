import type { Metadata } from "next";
import { cache } from "react";

import { PublicWorkflowView } from "@/components/public-workflow/public-workflow-view";
import { API_BASE_URL, type PublicWorkflowRead } from "@/lib/api";
import { PAID_WORKFLOW_MESSAGES, isPublicWorkflowRead } from "@/lib/paid-use";

interface Params {
  slug: string;
}

/** Long enough for the API on a good day; a slow one hands the read to the browser. */
const SERVER_READ_TIMEOUT_MS = 5_000;

/**
 * The workflow on sale at this address, by its listing's slug, read on the
 * server so a shared link previews with its listing's title and the page
 * arrives drawn. No cookies go with it (this is a page for strangers) and
 * nothing is cached, a failure least of all: "not_found" is the API's own 404
 * (an unknown slug, a listing of an agent, or one not on sale for use), and
 * null is any other failure, which the browser then retries for itself.
 *
 * Wrapped in `cache` so the metadata and the page share one read a request.
 */
const readWorkflow = cache(async (slug: string): Promise<PublicWorkflowRead | "not_found" | null> => {
  try {
    const res = await fetch(`${API_BASE_URL}/api/w/${encodeURIComponent(slug)}`, {
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(SERVER_READ_TIMEOUT_MS),
    });
    if (res.status === 404) return "not_found";
    if (!res.ok) return null;
    const body: unknown = await res.json();
    // Anything that is not the page's own shape is treated as a failed read.
    return isPublicWorkflowRead(body) ? body : null;
  } catch {
    return null;
  }
});

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const read = await readWorkflow(slug);
  if (read === "not_found") return { title: PAID_WORKFLOW_MESSAGES.notFoundTitle, robots: { index: false } };
  if (read === null) return { title: "Workflow" };

  // The listing's title and one line: never the workflow's own name.
  const title = read.title.trim();
  const summary = read.description?.trim() || `${title} on WheelsAI.`;
  return {
    title,
    description: summary,
    openGraph: { type: "website", title, description: summary },
    twitter: { card: "summary", title, description: summary },
  };
}

export default async function PublicWorkflowPage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const initial = await readWorkflow(slug);
  // Keyed by the address: moving from one workflow's page to another starts the view afresh.
  return <PublicWorkflowView key={slug} slug={slug} initial={initial} />;
}
