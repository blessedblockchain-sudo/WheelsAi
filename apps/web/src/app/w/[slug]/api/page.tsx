import type { Metadata } from "next";
import { cache } from "react";

import { ApiPageView } from "@/components/api-page/api-page-view";
import { API_BASE_URL, type WorkflowApiPage } from "@/lib/api";
import { WORKFLOW_API_PAGE_WORDS, apiPageSummary, apiPageTitle, isWorkflowApiPage } from "@/lib/api-page";

interface Params {
  slug: string;
}

/** Long enough for the API on a good day; a slow one hands the read to the browser. */
const SERVER_READ_TIMEOUT_MS = 5_000;

/**
 * The API page of the workflow on sale at this address, by its listing's
 * slug, read on the server so a shared link previews with the listing's title
 * and the page arrives drawn. No cookies go with it (this is a page for
 * strangers) and nothing is cached here, a failure least of all: "not_found"
 * is the API's own 404 (an unknown slug, a listing of an agent, or one not on
 * sale for use), and null is any other failure, which the browser then
 * retries for itself.
 *
 * Wrapped in `cache` so the metadata and the page share one read a request.
 */
const readApiPage = cache(async (slug: string): Promise<WorkflowApiPage | "not_found" | null> => {
  try {
    const res = await fetch(`${API_BASE_URL}/api/w/${encodeURIComponent(slug)}/api`, {
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(SERVER_READ_TIMEOUT_MS),
    });
    if (res.status === 404) return "not_found";
    if (!res.ok) return null;
    const body: unknown = await res.json();
    // Anything that is not the page's own shape is treated as a failed read.
    return isWorkflowApiPage(body) ? body : null;
  } catch {
    return null;
  }
});

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const page = await readApiPage(slug);
  if (page === "not_found") return { title: WORKFLOW_API_PAGE_WORDS.notFoundTitle, robots: { index: false } };
  if (page === null) return { title: "Workflow API" };

  // The listing's title: never the workflow's own name.
  const title = apiPageTitle(page.name);
  const summary = apiPageSummary(page.name);
  return {
    title,
    description: summary,
    openGraph: { type: "website", title, description: summary },
    twitter: { card: "summary", title, description: summary },
  };
}

export default async function WorkflowApiPageRoute({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const initial = await readApiPage(slug);
  // Keyed by the address: moving from one workflow's API page to another starts the view afresh.
  return <ApiPageView key={slug} handle={slug} initial={initial} reader="workflow" />;
}
