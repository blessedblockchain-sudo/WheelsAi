"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { LayoutTemplate, Search } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { templateApi, type AgentTemplate } from "@/lib/api";

const FRAMEWORK_LABELS: Record<string, string> = {
  mastra: "Mastra",
  elizaos: "ElizaOS",
  langchain: "LangChain",
  autogen: "AutoGen",
  crewai: "CrewAI",
  custom: "Custom",
};

function label(value: string): string {
  return FRAMEWORK_LABELS[value] ?? value.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const USE_HREF = `/register?next=${encodeURIComponent("/dashboard/templates")}`;
const SIGN_IN_HREF = `/login?next=${encodeURIComponent("/dashboard/templates")}`;

/**
 * Public, read-only view of the published template catalog
 * (GET /api/templates needs no session). Using a template needs an account,
 * so the call to action goes through sign-up to the dashboard gallery.
 */
export function TemplateGallery() {
  const [templates, setTemplates] = useState<AgentTemplate[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const [framework, setFramework] = useState("");

  const load = useCallback(async () => {
    setError(null);
    setTemplates(null);
    try {
      const res = await templateApi.list({ limit: 100 });
      setTemplates(res.templates ?? []);
      setTotal(res.total ?? 0);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const frameworks = useMemo(
    () => Array.from(new Set((templates ?? []).map((t) => t.framework))).sort(),
    [templates],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (templates ?? []).filter(
      (t) =>
        (!framework || t.framework === framework) &&
        (!q ||
          t.title.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.tags.some((tag) => tag.toLowerCase().includes(q))),
    );
  }, [templates, query, framework]);

  if (error) {
    return <ErrorState title="Could not load templates" error={error} onRetry={() => void load()} />;
  }

  if (!templates) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
        <span className="sr-only">Loading templates</span>
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-48 w-full" />
        ))}
      </div>
    );
  }

  if (templates.length === 0) {
    return (
      <EmptyState
        icon={LayoutTemplate}
        title="No templates published yet"
        description="When the WheelsAI team publishes starter agents, they will appear here. You can still create an agent from scratch or import one from GitHub."
        actionLabel="Create an account"
        actionHref="/register"
      />
    );
  }

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="template-search" className="text-sm font-medium text-foreground">
            Search templates
          </label>
          <div className="relative mt-1.5">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              id="template-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name, description or tag"
              className="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </div>
        <div className="sm:w-56">
          <label htmlFor="template-framework" className="text-sm font-medium text-foreground">
            Framework
          </label>
          <select
            id="template-framework"
            value={framework}
            onChange={(e) => setFramework(e.target.value)}
            className="mt-1.5 h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">All frameworks</option>
            {frameworks.map((f) => (
              <option key={f} value={f}>
                {label(f)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="mt-4 text-sm text-muted-foreground" aria-live="polite">
        Showing {visible.length} of {total} published {total === 1 ? "template" : "templates"}.
      </p>

      {visible.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          No templates match your search.
        </p>
      ) : (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((t) => (
            <li key={t.id} className="flex flex-col rounded-lg border border-border bg-card p-5">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full bg-primary/15 px-2 py-0.5 font-semibold text-primary">{label(t.framework)}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">{label(t.category)}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">{label(t.difficulty)}</span>
                {t.isFeatured && (
                  <span className="rounded-full bg-yellow-500/10 px-2 py-0.5 font-semibold text-yellow-700 dark:text-yellow-400">Featured</span>
                )}
              </div>
              <h3 className="mt-3 font-semibold text-foreground">{t.title}</h3>
              <p className="mt-1.5 line-clamp-4 flex-1 text-sm leading-6 text-foreground/80">{t.description}</p>
              {t.tags.length > 0 && (
                <p className="mt-3 truncate text-xs text-muted-foreground">
                  <span className="sr-only">Tags: </span>
                  {t.tags.map((tag) => `#${tag}`).join("  ")}
                </p>
              )}
              <Link
                href={USE_HREF}
                className="mt-4 inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Use the ${t.title} template`}
              >
                Use this template
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-8 text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href={SIGN_IN_HREF} className="font-medium text-primary underline-offset-4 hover:underline">
          Sign in to open the gallery in your dashboard
        </Link>
        .
      </p>
    </div>
  );
}
