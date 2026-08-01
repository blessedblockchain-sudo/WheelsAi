"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Search, Filter, Cpu, Zap, MessageSquare, Code, Brain } from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonCard } from "@/components/ui/skeleton";
import { modelsApi, type Model, type GpuTier } from "@/lib/api";
import { cn } from "@/lib/utils";

const categoryIcons: Record<string, React.ReactNode> = {
  chat: <MessageSquare className="h-5 w-5" />,
  code: <Code className="h-5 w-5" />,
  reasoning: <Brain className="h-5 w-5" />,
  general: <Zap className="h-5 w-5" />,
};

export default function ModelsPage() {
  const [models, setModels] = useState<Model[]>([]);
  const [gpuTiers, setGpuTiers] = useState<GpuTier[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  useEffect(() => {
    async function loadModels() {
      try {
        const { models, gpuTiers } = await modelsApi.list();
        setModels(models);
        setGpuTiers(gpuTiers);
      } catch (error) {
        toast.error("Failed to load models");
      } finally {
        setIsLoading(false);
      }
    }
    loadModels();
  }, []);

  const categories = Array.from(new Set(models.flatMap((m) => m.tags)));

  const filteredModels = models.filter((model) => {
    const matchesSearch =
      model.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      model.description.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = !selectedCategory || model.tags.includes(selectedCategory);
    return matchesSearch && matchesCategory;
  });

  function formatParams(params: number): string {
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
        title="Model Catalog"
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
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : models.length === 0 ? (
          <EmptyState
            icon={Cpu}
            title="No models available"
            description="There are no models in the catalog yet. Check back soon as new models are added regularly."
          />
        ) : filteredModels.length === 0 ? (
          <EmptyState
            icon={Search}
            title="No models found"
            description="Try adjusting your search query or filters to find what you are looking for."
          />
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {filteredModels.map((model) => (
              <Card key={model.id} className="flex flex-col">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-100">
                        {categoryIcons[model.tags[0] ?? ""] || <Cpu className="h-5 w-5 text-primary-600" />}
                      </div>
                      <div>
                        <CardTitle className="text-base">{model.displayName}</CardTitle>
                        <p className="text-xs text-gray-500">{model.provider}</p>
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
                    {model.tags.slice(0, 4).map((tag) => (
                      <Badge key={tag} variant="outline" className="text-xs">
                        {tag}
                      </Badge>
                    ))}
                  </div>

                  <div className="mt-4 flex items-center justify-between border-t pt-4 text-sm">
                    <div className="text-gray-500">
                      <span className="font-medium text-gray-900">{model.contextLength.toLocaleString()}</span> ctx
                    </div>
                    <div className="text-gray-500">
                      Min: <span className="font-medium text-gray-900">{model.minGpuTier}</span>
                    </div>
                    <div className="text-gray-500">
                      From <span className="font-medium text-gray-900">${getGpuPrice(model.minGpuTier).toFixed(2)}</span>/hr
                    </div>
                  </div>

                  <Link href={`/dashboard/deployments/new?model=${model.id}`} className="mt-4 block">
                    <Button className="w-full">
                      <Cpu className="mr-2 h-4 w-4" />
                      Deploy Model
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* GPU Pricing info */}
        <Card className="mt-8">
          <CardHeader>
            <CardTitle className="text-base">GPU Pricing</CardTitle>
            <CardDescription>
              Pay only for the compute you use. All prices are per GPU-hour.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-5">
              {gpuTiers.map((tier) => (
                <div
                  key={tier.id}
                  className="rounded-lg border p-4 text-center"
                >
                  <p className="font-semibold">{tier.name}</p>
                  <p className="text-2xl font-bold text-primary-600">
                    ${tier.pricePerHour.toFixed(2)}
                  </p>
                  <p className="text-xs text-gray-500">/hour</p>
                  <p className="mt-2 text-sm text-gray-600">{tier.vram}GB VRAM</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
