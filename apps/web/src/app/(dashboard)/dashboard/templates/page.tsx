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
  X,
  Loader2,
  LayoutTemplate,
  ChevronDown,
  Bot,
  Code2,
  BookOpen,
  Cog,
  Palette,
  HelpCircle,
} from "lucide-react";
import { templateApi, type AgentTemplate } from "@/lib/api";
import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";

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
  mastra: "bg-matrix-green/10 text-matrix-green border-matrix-green/30",
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

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
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
      <img
        src={template.iconUrl}
        alt={template.title}
        className="h-10 w-10 rounded-lg object-cover"
      />
    );
  }
  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-matrix-green/10 border border-matrix-green/20">
      <Icon className="h-5 w-5 text-matrix-green" />
    </div>
  );
}

function SelectDropdown({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none rounded-lg border border-matrix-border bg-matrix-surface px-3 py-2 pr-8 text-sm text-gray-200 outline-none transition-colors focus:border-matrix-green/50 focus:ring-1 focus:ring-matrix-green/30"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
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
      className={`group relative flex flex-col rounded-xl border border-matrix-border bg-matrix-surface p-5 transition-all duration-300 hover:border-matrix-green/30 hover:shadow-[0_0_30px_rgba(0,255,0,0.08)] ${
        featured ? "md:col-span-2 md:flex-row md:gap-6" : ""
      }`}
    >
      {template.isFeatured && (
        <div className="absolute -top-px right-4 rounded-b-md bg-matrix-green px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-black">
          Featured
        </div>
      )}

      <div className={`flex items-start gap-4 ${featured ? "md:flex-shrink-0" : ""}`}>
        <TemplateIcon template={template} />
        {!featured && (
          <div className="flex-1 min-w-0">
            <h3 className="truncate font-semibold text-gray-100 group-hover:text-matrix-green transition-colors">
              {template.title}
            </h3>
            <p className="mt-0.5 text-xs text-gray-500">by {template.authorName}</p>
          </div>
        )}
      </div>

      {featured && (
        <div className="mt-3 flex-1 md:mt-0">
          <h3 className="font-semibold text-lg text-gray-100 group-hover:text-matrix-green transition-colors">
            {template.title}
          </h3>
          <p className="mt-0.5 text-xs text-gray-500">by {template.authorName}</p>
        </div>
      )}

      <p className={`mt-3 text-sm leading-relaxed text-gray-400 ${featured ? "" : "line-clamp-2"}`}>
        {template.description}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <CategoryBadge category={template.category} />
        <FrameworkBadge framework={template.framework} />
        <DifficultyBadge difficulty={template.difficulty} />
      </div>

      <div className="mt-auto flex items-center justify-between pt-4">
        <div className="flex items-center gap-3 text-xs text-gray-500">
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
          className="rounded-lg border border-matrix-green/40 bg-matrix-green/10 px-3.5 py-1.5 text-xs font-semibold text-matrix-green transition-all hover:bg-matrix-green hover:text-black hover:shadow-[0_0_16px_rgba(0,255,0,0.35)]"
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
  const [agentSlug, setAgentSlug] = useState(slugify(template.title));
  const [description, setDescription] = useState(template.description);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setAgentSlug(slugify(name));
  }, [name]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !agentSlug.trim()) return;

    setSubmitting(true);
    setError("");

    try {
      const created = await templateApi.use(template.id, {
        name: name.trim(),
        slug: agentSlug.trim(),
        description: description.trim() || undefined,
      });
      // Land the user on their new agent instead of silently closing the
      // modal over the gallery (INT-B2).
      router.push(`/dashboard/agents/${created.id}`);
    } catch (err: any) {
      setError(err.message || "Failed to create agent from template");
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      <div className="relative z-10 w-full max-w-lg rounded-xl border border-matrix-border bg-matrix-dark p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-100">Create Agent from Template</h2>
            <p className="mt-1 text-sm text-gray-500">
              Using <span className="text-matrix-green">{template.title}</span>
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-gray-500 transition-colors hover:bg-matrix-surface hover:text-gray-300"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">
              Agent Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-matrix-border bg-matrix-surface px-3 py-2 text-sm text-gray-200 outline-none transition-colors placeholder:text-gray-600 focus:border-matrix-green/50 focus:ring-1 focus:ring-matrix-green/30"
              placeholder="My Agent"
              required
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">
              Slug <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={agentSlug}
              onChange={(e) => setAgentSlug(e.target.value)}
              className="w-full rounded-lg border border-matrix-border bg-matrix-surface px-3 py-2 text-sm font-mono text-gray-200 outline-none transition-colors placeholder:text-gray-600 focus:border-matrix-green/50 focus:ring-1 focus:ring-matrix-green/30"
              placeholder="my-agent"
              required
            />
            <p className="mt-1 text-xs text-gray-600">URL-safe identifier for your agent</p>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full resize-none rounded-lg border border-matrix-border bg-matrix-surface px-3 py-2 text-sm text-gray-200 outline-none transition-colors placeholder:text-gray-600 focus:border-matrix-green/50 focus:ring-1 focus:ring-matrix-green/30"
              placeholder="Describe what your agent does..."
            />
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm font-medium text-gray-400 transition-colors hover:bg-matrix-surface hover:text-gray-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim() || !agentSlug.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-matrix-green px-4 py-2 text-sm font-semibold text-black transition-all hover:shadow-[0_0_20px_rgba(0,255,0,0.4)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Create Agent
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [framework, setFramework] = useState("");
  const [difficulty, setDifficulty] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState<AgentTemplate | null>(null);

  useEffect(() => {
    loadTemplates();
  }, [category, framework, difficulty]);

  async function loadTemplates() {
    try {
      setLoading(true);
      const res = await templateApi.list({
        category: category || undefined,
        framework: framework || undefined,
        difficulty: difficulty || undefined,
        search: search || undefined,
        limit: 50,
      });
      setTemplates(res.templates);
    } catch (err) {
      console.error("Failed to load templates:", err);
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
    <div className="min-h-screen bg-matrix-dark">
      {/* Header */}
      <div className="border-b border-matrix-border bg-matrix-surface/50 px-6 py-8 md:px-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-matrix-green/10 border border-matrix-green/20">
            <LayoutTemplate className="h-5 w-5 text-matrix-green" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-100">Agent Templates</h1>
            <p className="mt-0.5 text-sm text-gray-500">
              Get started quickly with pre-built agent templates
            </p>
          </div>
        </div>
      </div>

      <div className="px-6 py-6 md:px-8">
        {/* Filter Bar */}
        <form
          onSubmit={handleSearchSubmit}
          className="flex flex-wrap items-center gap-3 rounded-xl border border-matrix-border bg-matrix-surface/60 p-3"
        >
          <div className="relative flex-1 min-w-[200px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search templates..."
              className="w-full rounded-lg border border-matrix-border bg-matrix-dark py-2 pl-9 pr-3 text-sm text-gray-200 outline-none transition-colors placeholder:text-gray-600 focus:border-matrix-green/50 focus:ring-1 focus:ring-matrix-green/30"
            />
          </div>

          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-gray-500" />
          </div>

          <SelectDropdown value={category} onChange={setCategory} options={CATEGORIES} />
          <SelectDropdown value={framework} onChange={setFramework} options={FRAMEWORKS} />
          <SelectDropdown value={difficulty} onChange={setDifficulty} options={DIFFICULTIES} />

          <button
            type="submit"
            className="rounded-lg bg-matrix-green/10 border border-matrix-green/30 px-4 py-2 text-sm font-medium text-matrix-green transition-colors hover:bg-matrix-green/20"
          >
            Search
          </button>
        </form>

        {/* Loading State */}
        {loading && (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="rounded-xl border border-matrix-border bg-matrix-surface p-5 space-y-4"
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
                  <Skeleton className="h-6 w-18" />
                </div>
                <div className="flex items-center justify-between pt-2">
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-8 w-24" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Empty State */}
        {!loading && templates.length === 0 && (
          <div className="mt-16 flex flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-matrix-surface border border-matrix-border">
              <LayoutTemplate className="h-8 w-8 text-gray-600" />
            </div>
            <h3 className="text-lg font-semibold text-gray-300">No templates found</h3>
            <p className="max-w-sm text-sm text-gray-500">
              Try adjusting your search or filters to find what you are looking for.
            </p>
          </div>
        )}

        {!loading && templates.length > 0 && (
          <>
            {/* Featured Templates */}
            {featured.length > 0 && (
              <section className="mt-8">
                <div className="mb-4 flex items-center gap-2">
                  <Sparkles className="h-5 w-5 text-matrix-green" />
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

            {/* All Templates */}
            <section className="mt-8">
              {featured.length > 0 && (
                <div className="mb-4 flex items-center gap-2">
                  <LayoutTemplate className="h-5 w-5 text-gray-500" />
                  <h2 className="text-lg font-semibold text-gray-200">All Templates</h2>
                  <span className="ml-1 rounded-full bg-matrix-surface px-2 py-0.5 text-xs text-gray-500">
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
