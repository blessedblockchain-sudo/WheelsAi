"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Search,
  Filter,
  Star,
  Users,
  Sparkles,
  Rocket,
  Loader2,
  ChevronRight,
  LayoutTemplate,
  ChevronDown,
  Bot,
  Code2,
  BookOpen,
  Cog,
  Palette,
  HelpCircle,
} from "lucide-react";
import { AgentKindBadge } from "@/components/dashboard/agent-kind-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { templateApi, type AgentTemplate, getErrorMessage, getValidationError } from "@/lib/api";
import { KIND_FILTERS, type KindFilter } from "@/lib/agent-list";
import { NEW_AGENT_BUTTON } from "@/lib/nav";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORIES = [
  { value: "", label: "All Categories" },
  { value: "customer-support", label: "Customer Support" },
  { value: "coding", label: "Coding" },
  { value: "research", label: "Research" },
  { value: "automation", label: "Automation" },
  { value: "creative", label: "Creative" },
  { value: "other", label: "Other" },
] as const;

const FRAMEWORKS = [
  { value: "", label: "All Frameworks" },
  { value: "mastra", label: "Mastra" },
  { value: "langchain", label: "LangChain" },
  { value: "autogen", label: "AutoGen" },
  { value: "custom", label: "Custom" },
  { value: "elizaos", label: "ElizaOS" },
] as const;

const KINDS = KIND_FILTERS.map((f) => ({
  value: f.value === "all" ? "" : f.value,
  label: f.value === "all" ? "All kinds" : f.label,
}));

const DIFFICULTIES = [
  { value: "", label: "All Levels" },
  { value: "beginner", label: "Beginner" },
  { value: "intermediate", label: "Intermediate" },
  { value: "advanced", label: "Advanced" },
] as const;

const CATEGORY_COLORS: Record<string, string> = {
  "customer-support": "bg-blue-500/20 text-blue-400 border-blue-500/30",
  coding: "bg-green-500/20 text-green-400 border-green-500/30",
  research: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  automation: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  creative: "bg-pink-500/20 text-pink-400 border-pink-500/30",
  other: "bg-gray-500/20 text-gray-400 border-gray-500/30",
};

const CATEGORY_ICONS: Record<string, React.ElementType> = {
  "customer-support": Users,
  coding: Code2,
  research: BookOpen,
  automation: Cog,
  creative: Palette,
  other: HelpCircle,
};

const FRAMEWORK_COLORS: Record<string, string> = {
  mastra: "bg-primary/10 text-primary border-primary/30",
  langchain: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30",
  autogen: "bg-sky-500/10 text-sky-400 border-sky-500/30",
  custom: "bg-gray-500/10 text-gray-400 border-gray-500/30",
  elizaos: "bg-indigo-500/10 text-indigo-400 border-indigo-500/30",
};

const DIFFICULTY_CONFIG: Record<string, { color: string; dot: string }> = {
  beginner: { color: "text-green-400", dot: "bg-green-400" },
  intermediate: { color: "text-yellow-400", dot: "bg-yellow-400" },
  advanced: { color: "text-red-400", dot: "bg-red-400" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function categoryLabel(cat: string): string {
  return cat
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DifficultyBadge({ difficulty }: { difficulty: string }) {
  const cfg = DIFFICULTY_CONFIG[difficulty] ?? DIFFICULTY_CONFIG.beginner ?? {
    color: "text-muted-foreground",
    dot: "bg-muted-foreground",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${cfg.color}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
      {difficulty.charAt(0).toUpperCase() + difficulty.slice(1)}
    </span>
  );
}

function CategoryBadge({ category }: { category: string }) {
  const cls = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.other;
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {categoryLabel(category)}
    </span>
  );
}

function FrameworkBadge({ framework }: { framework: string }) {
  const cls = FRAMEWORK_COLORS[framework] ?? FRAMEWORK_COLORS.custom;
  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {framework.charAt(0).toUpperCase() + framework.slice(1)}
    </span>
  );
}

function TemplateIcon({ template }: { template: AgentTemplate }) {
  const Icon = CATEGORY_ICONS[template.category] ?? Bot;
  if (template.iconUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- author-supplied URL on any host; next/image needs hosts allowlisted
      <img
        src={template.iconUrl}
        alt={template.title}
        className="h-10 w-10 rounded-lg object-cover"
      />
    );
  }
  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 border border-primary/20">
      <Icon className="h-5 w-5 text-primary" />
    </div>
  );
}

function SelectDropdown({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  /** The select's accessible name. */
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <div className="relative">
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none rounded-lg border border-border bg-card px-3 py-2 pr-8 text-sm text-gray-200 outline-none transition-colors focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Template Card
// ---------------------------------------------------------------------------

function TemplateCard({
  template,
  featured = false,
  onUse,
}: {
  template: AgentTemplate;
  featured?: boolean;
  onUse: (t: AgentTemplate) => void;
}) {
  return (
    <div
      className={`group relative flex flex-col rounded-xl border border-border bg-card p-5 transition-all duration-300 hover:border-primary/30 hover:shadow-[0_0_30px_rgba(0,255,0,0.08)] ${
        featured ? "md:col-span-2 md:flex-row md:gap-6" : ""
      }`}
    >
      {template.isFeatured && (
        <div className="absolute -top-px right-4 rounded-b-md bg-primary px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary-foreground">
          Featured
        </div>
      )}

      <div className={`flex items-start gap-4 ${featured ? "md:flex-shrink-0" : ""}`}>
        <TemplateIcon template={template} />
        {!featured && (
          <div className="flex-1 min-w-0">
            <h3 className="truncate font-semibold text-gray-100 group-hover:text-primary transition-colors">
              {template.title}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">by {template.authorName}</p>
          </div>
        )}
      </div>

      {featured && (
        <div className="mt-3 flex-1 md:mt-0">
          <h3 className="font-semibold text-lg text-gray-100 group-hover:text-primary transition-colors">
            {template.title}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">by {template.authorName}</p>
        </div>
      )}

      <p className={`mt-3 text-sm leading-relaxed text-gray-400 ${featured ? "" : "line-clamp-2"}`}>
        {template.description}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <AgentKindBadge kind={template.agentKind} />
        <CategoryBadge category={template.category} />
        <FrameworkBadge framework={template.framework} />
        <DifficultyBadge difficulty={template.difficulty} />
      </div>

      <div className="mt-auto flex items-center justify-between pt-4">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Rocket className="h-3.5 w-3.5" />
            {template.usageCount.toLocaleString()}
          </span>
          {template.avgRating > 0 && (
            <span className="flex items-center gap-1">
              <Star className="h-3.5 w-3.5 text-yellow-500" />
              {template.avgRating.toFixed(1)}
            </span>
          )}
        </div>

        <button
          onClick={() => onUse(template)}
          className="rounded-lg border border-primary/40 bg-primary/10 px-3.5 py-1.5 text-xs font-semibold text-primary transition-all hover:bg-primary hover:text-black hover:shadow-[0_0_16px_rgba(0,255,0,0.35)]"
        >
          Use Template
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Use-Template Modal
// ---------------------------------------------------------------------------

function UseTemplateModal({
  template,
  onClose,
}: {
  template: AgentTemplate;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(template.title);
  const [agentSlug, setAgentSlug] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (name.trim().length < 3) {
      setFieldErrors({ name: "Give your agent a name of at least 3 characters." });
      return;
    }

    setSubmitting(true);
    setError("");
    setFieldErrors({});

    try {
      // Only a name is needed. The address is optional: left out, it is made
      // from the name and made unique, so one template can be used twice.
      const created = await templateApi.use(template.id, {
        name: name.trim(),
        ...(agentSlug.trim() ? { slug: agentSlug.trim() } : {}),
      });
      // Land the user on their new agent instead of silently closing the
      // modal over the gallery (INT-B2).
      router.push(`/dashboard/agents/${created.agent.id}`);
    } catch (err) {
      const invalid = getValidationError(err);
      if (invalid && Object.keys(invalid.fields).length > 0) {
        setFieldErrors(invalid.fields);
        if (invalid.fields.slug) setAdvancedOpen(true);
      } else {
        setError(invalid?.message ?? getErrorMessage(err, "Failed to create agent from template"));
      }
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && onClose()}>
      <DialogContent
        className="mx-4 max-w-lg"
        aria-labelledby="use-template-title"
        aria-describedby="use-template-description"
        hideClose={submitting}
      >
        <DialogHeader>
          <DialogTitle id="use-template-title">Create agent from template</DialogTitle>
          <DialogDescription id="use-template-description">
            Using <span className="font-medium text-primary">{template.title}</span>
          </DialogDescription>
          <div className="pt-1">
            <AgentKindBadge kind={template.agentKind} />
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="use-template-name">Name</Label>
            <Input
              id="use-template-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My agent"
              maxLength={100}
              error={fieldErrors.name}
            />
          </div>

          <div>
            <button
              type="button"
              onClick={() => setAdvancedOpen((open) => !open)}
              aria-expanded={advancedOpen}
              aria-controls="use-template-advanced"
              className="inline-flex items-center gap-1 rounded-sm text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronRight
                className={`h-4 w-4 transition-transform ${advancedOpen ? "rotate-90" : ""}`}
                aria-hidden="true"
              />
              Advanced
            </button>
            {advancedOpen && (
              <div id="use-template-advanced" className="mt-3 space-y-1.5">
                <Label htmlFor="use-template-slug">Address (optional)</Label>
                <Input
                  id="use-template-slug"
                  type="text"
                  value={agentSlug}
                  onChange={(e) => setAgentSlug(e.target.value)}
                  className="font-mono"
                  placeholder="my-agent"
                  error={fieldErrors.slug}
                />
                <p className="text-xs text-muted-foreground">
                  The short name in your agent&apos;s web address. Left empty, it is made from the name.
                </p>
              </div>
            )}
          </div>

          {error && (
            <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          <DialogFooter className="gap-2 pt-2 sm:space-x-0">
            <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !name.trim()}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              Create agent
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [framework, setFramework] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [difficulty, setDifficulty] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState<AgentTemplate | null>(null);

  useEffect(() => {
    loadTemplates();
    // The search text is applied on submit, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, framework, kind, difficulty]);

  async function loadTemplates() {
    try {
      setLoading(true);
      setLoadError(null);
      const res = await templateApi.list({
        category: category || undefined,
        framework: framework || undefined,
        agentKind: kind === "all" ? undefined : kind,
        difficulty: difficulty || undefined,
        search: search || undefined,
        limit: 50,
      });
      setTemplates(res.templates);
    } catch (err) {
      console.error("Failed to load templates:", err);
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  }

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    loadTemplates();
  }

  const featured = templates.filter((t) => t.isFeatured);
  const regular = templates.filter((t) => !t.isFeatured);

  return (
    <div className="min-h-full bg-background">
      {/* Header */}
      <div className="border-b border-border bg-card/50 px-6 py-8 md:px-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 border border-primary/20">
            <LayoutTemplate className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-100">Templates</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Get started quickly with pre-built agent templates
            </p>
          </div>
        </div>
      </div>

      <div className="px-6 py-6 md:px-8">
        {/* Filter Bar */}
        <form
          onSubmit={handleSearchSubmit}
          className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card/60 p-3"
        >
          <div className="relative flex-1 min-w-[200px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              aria-label="Search templates"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search templates..."
              className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm text-gray-200 outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
            />
          </div>

          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
          </div>

          <SelectDropdown label="Filter by kind" value={kind === "all" ? "" : kind} onChange={(v) => setKind((v || "all") as KindFilter)} options={KINDS} />
          <SelectDropdown label="Filter by category" value={category} onChange={setCategory} options={CATEGORIES} />
          <SelectDropdown label="Filter by framework" value={framework} onChange={setFramework} options={FRAMEWORKS} />
          <SelectDropdown label="Filter by level" value={difficulty} onChange={setDifficulty} options={DIFFICULTIES} />

          <button
            type="submit"
            className="rounded-lg bg-primary/10 border border-primary/30 px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/20"
          >
            Search
          </button>
        </form>

        {/* Loading State */}
        {loading && (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
            <span className="sr-only">Loading templates</span>
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="rounded-xl border border-border bg-card p-5 space-y-4"
              >
                <div className="flex items-start gap-4">
                  <Skeleton className="h-10 w-10 rounded-lg" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
                <div className="flex gap-2">
                  <Skeleton className="h-6 w-20" />
                  <Skeleton className="h-6 w-16" />
                  <Skeleton className="h-6 w-20" />
                </div>
                <div className="flex items-center justify-between pt-2">
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-8 w-24" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Error State */}
        {!loading && loadError !== null && (
          <div className="mt-8">
            <ErrorState
              title="Couldn't load templates"
              error={loadError}
              onRetry={loadTemplates}
            />
          </div>
        )}

        {/* Empty State */}
        {!loading && loadError === null && templates.length === 0 && (
          <div className="mt-8">
            <EmptyState
              icon={LayoutTemplate}
              title="No templates found"
              description="Try adjusting your search or filters to find what you are looking for."
              actionLabel={NEW_AGENT_BUTTON.label}
              actionHref={NEW_AGENT_BUTTON.href}
            />
          </div>
        )}

        {!loading && loadError === null && templates.length > 0 && (
          <>
            {/* Featured Templates */}
            {featured.length > 0 && (
              <section className="mt-8">
                <div className="mb-4 flex items-center gap-2">
                  <Sparkles className="h-5 w-5 text-primary" />
                  <h2 className="text-lg font-semibold text-gray-200">Featured Templates</h2>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  {featured.map((t) => (
                    <TemplateCard
                      key={t.id}
                      template={t}
                      featured
                      onUse={setSelectedTemplate}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* All Templates: left out when every template shown is a featured one. */}
            {(featured.length === 0 || regular.length > 0) && (
            <section className="mt-8">
              {featured.length > 0 && (
                <div className="mb-4 flex items-center gap-2">
                  <LayoutTemplate className="h-5 w-5 text-muted-foreground" />
                  <h2 className="text-lg font-semibold text-gray-200">All Templates</h2>
                  <span className="ml-1 rounded-full bg-card px-2 py-0.5 text-xs text-muted-foreground">
                    {regular.length}
                  </span>
                </div>
              )}
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {(featured.length > 0 ? regular : templates).map((t) => (
                  <TemplateCard
                    key={t.id}
                    template={t}
                    onUse={setSelectedTemplate}
                  />
                ))}
              </div>
            </section>
            )}
          </>
        )}
      </div>

      {/* Use Template Modal */}
      {selectedTemplate && (
        <UseTemplateModal
          template={selectedTemplate}
          onClose={() => setSelectedTemplate(null)}
        />
      )}
    </div>
  );
}
