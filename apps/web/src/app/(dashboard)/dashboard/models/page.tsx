"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Search, Filter, Cpu, Zap, MessageSquare, Code, Brain, Bot } from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { modelsApi, type ModelListing, type GpuTier, getErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

const categoryIcons: Record<string, React.ReactNode> = {
  chat: <MessageSquare className="h-5 w-5" />,
  code: <Code className="h-5 w-5" />,
  reasoning: <Brain className="h-5 w-5" />,
  general: <Zap className="h-5 w-5" />,
};

/** Placeholder shaped like one model card in the catalog grid. */
function ModelCardSkeleton() {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-lg" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
          <Skeleton className="h-5 w-10 rounded-full" />
        </div>
        <div className="space-y-2 pt-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </CardHeader>
      <CardContent className="mt-auto">
        <div className="flex flex-wrap gap-1.5">
          <Skeleton className="h-5 w-14 rounded-full" />
          <Skeleton className="h-5 w-12 rounded-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <div className="mt-4 flex items-center justify-between border-t pt-4">
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-5 w-20" />
        </div>
        <Skeleton className="mt-4 h-10 w-full" />
      </CardContent>
    </Card>
  );
}

export default function ModelsPage() {
  const [models, setModels] = useState<ModelListing[]>([]);
  const [gpuTiers, setGpuTiers] = useState<GpuTier[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  async function loadModels() {
    setLoadError(null);
    setIsLoading(true);
    try {
      const { models, gpuTiers } = await modelsApi.list();
      setModels(models);
      setGpuTiers(gpuTiers);
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to load models"));
      setLoadError(error);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadModels();
  }, []);

  const categories = Array.from(new Set(models.flatMap((m) => m.tags ?? [])));

  const filteredModels = models.filter((model) => {
    const matchesSearch =
      model.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      model.description.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = !selectedCategory || (model.tags ?? []).includes(selectedCategory);
    return matchesSearch && matchesCategory;
  });

  function formatParams(params: number | undefined): string {
    // Hosted free models report no parameter count.
    if (typeof params !== "number") return "Hosted";
    if (params >= 1e9) return `${(params / 1e9).toFixed(0)}B`;
    if (params >= 1e6) return `${(params / 1e6).toFixed(0)}M`;
    return params.toString();
  }

  function getGpuPrice(tierId: string): number {
    const tier = gpuTiers.find((g) => g.id === tierId);
    return tier?.pricePerHour || 0;
  }

  return (
    <div className="flex flex-col">
      <Header
        title="Model catalog"
        description="Browse and deploy open-source AI models"
      />

      <div className="p-8">
        {/* Search and filters */}
        <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="relative w-full md:w-96">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <Input
              placeholder="Search models..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              variant={selectedCategory === null ? "default" : "outline"}
              size="sm"
              onClick={() => setSelectedCategory(null)}
            >
              All
            </Button>
            {["chat", "code", "reasoning"].map((category) => (
              <Button
                key={category}
                variant={selectedCategory === category ? "default" : "outline"}
                size="sm"
                onClick={() => setSelectedCategory(category)}
              >
                {categoryIcons[category]}
                <span className="ml-1.5 capitalize">{category}</span>
              </Button>
            ))}
          </div>
        </div>

        {/* Models grid */}
        {isLoading ? (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3" aria-busy="true">
            <span className="sr-only">Loading models</span>
            {Array.from({ length: 6 }).map((_, i) => (
              <ModelCardSkeleton key={i} />
            ))}
          </div>
        ) : loadError ? (
          <ErrorState
            title="Couldn't load models"
            error={loadError}
            onRetry={loadModels}
          />
        ) : models.length === 0 ? (
          <EmptyState
            icon={Cpu}
            title="No models available"
            description="There are no models in the catalog yet."
          />
        ) : filteredModels.length === 0 ? (
          <EmptyState
            icon={Search}
            title="No models found"
            description="Try adjusting your search query or filters to find what you are looking for."
            actionLabel="Clear filters"
            onAction={() => {
              setSearchQuery("");
              setSelectedCategory(null);
            }}
          />
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {filteredModels.map((model) => (
              <Card key={model.id} className="flex flex-col">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15">
                        {categoryIcons[model.tags?.[0] ?? ""] || <Cpu className="h-5 w-5 text-primary-600" />}
                      </div>
                      <div>
                        <CardTitle className="text-base">{model.displayName}</CardTitle>
                        <p className="text-xs text-muted-foreground">{model.provider}</p>
                      </div>
                    </div>
                    <Badge variant="secondary">{formatParams(model.parameters)}</Badge>
                  </div>
                  <CardDescription className="mt-3 line-clamp-2">
                    {model.description}
                  </CardDescription>
                </CardHeader>

                <CardContent className="mt-auto">
                  <div className="flex flex-wrap gap-1.5">
                    {(model.tags ?? []).slice(0, 4).map((tag) => (
                      <Badge key={tag} variant="outline" className="text-xs">
                        {tag}
                      </Badge>
                    ))}
                  </div>

                  {model.tier === "gpu" ? (
                    <>
                      <div className="mt-4 flex items-center justify-between border-t pt-4 text-sm">
                        <div className="text-muted-foreground">
                          <span className="font-medium text-foreground">{model.contextLength.toLocaleString()}</span> ctx
                        </div>
                        <div className="text-muted-foreground">
                          Min: <span className="font-medium text-foreground">{model.minGpuTier}</span>
                        </div>
                        <div className="text-muted-foreground">
                          From <span className="font-medium text-foreground">${getGpuPrice(model.minGpuTier).toFixed(2)}</span>/hr
                        </div>
                      </div>

                      <Link href={`/dashboard/deployments/new?model=${model.id}`} className="mt-4 block">
                        <Button className="w-full">
                          <Cpu className="mr-2 h-4 w-4" />
                          Deploy Model
                        </Button>
                      </Link>
                    </>
                  ) : (
                    <>
                      <div className="mt-4 flex items-center justify-between border-t pt-4 text-sm">
                        <div className="text-muted-foreground">
                          <span className="font-medium text-foreground">{model.contextLength.toLocaleString()}</span> ctx
                        </div>
                        <div className="text-muted-foreground">
                          <span className="font-medium text-foreground">Free</span>, no API key
                        </div>
                      </div>

                      <Link href="/dashboard/agents/new" className="mt-4 block">
                        <Button variant="outline" className="w-full">
                          <Bot className="mr-2 h-4 w-4" />
                          Use in an Agent
                        </Button>
                      </Link>
                    </>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* GPU Pricing info (same request as the models; hidden when it failed) */}
        {!loadError && (
          <Card className="mt-8">
            <CardHeader>
              <CardTitle className="text-base">GPU Pricing</CardTitle>
              <CardDescription>
                Pay only for the compute you use. All prices are per GPU-hour.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-5" aria-busy={isLoading}>
                {isLoading
                  ? [1, 2, 3, 4, 5].map((i) => (
                      <div
                        key={i}
                        className="flex flex-col items-center gap-2 rounded-lg border p-4"
                      >
                        <Skeleton className="h-5 w-20" />
                        <Skeleton className="h-8 w-16" />
                        <Skeleton className="h-3 w-10" />
                        <Skeleton className="mt-1 h-4 w-20" />
                      </div>
                    ))
                  : gpuTiers.map((tier) => (
                      <div
                        key={tier.id}
                        className="rounded-lg border p-4 text-center"
                      >
                        <p className="font-semibold">{tier.name}</p>
                        <p className="text-2xl font-bold text-primary-600">
                          ${tier.pricePerHour.toFixed(2)}
                        </p>
                        <p className="text-xs text-muted-foreground">/hour</p>
                        <p className="mt-2 text-sm text-muted-foreground">{tier.vram}GB VRAM</p>
                      </div>
                    ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
