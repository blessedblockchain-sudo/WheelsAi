"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Cpu, Check, Zap, Server, Box, ChevronRight, ChevronDown } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  API_BASE_URL,
  modelsApi,
  deploymentsApi,
  fineTunedModelsApi,
  type FineTunedModel,
  type Model,
  type GpuTier,
  getApiErrorBody,
  getErrorMessage,
} from "@/lib/api";
import { COMPUTE_PAUSED_MESSAGE, isComputePaused } from "@/lib/deployments";
import { deploymentEndpointPattern } from "@/lib/public-urls";
import { cn } from "@/lib/utils";

type Step = "model" | "config" | "review";
type Engine = "vllm" | "ollama";
type SimplifiedTier = "basic" | "standard" | "premium" | "enterprise";

// Prices intentionally NOT hand-typed here: each tier's price is looked
// up from the fetched gpuTiers, which the API derives from the same
// market table billing meters against. Three surfaces used to disagree
// ($0.35 vs $0.25 vs a $0.54 metered rate for the same GPU).
interface SimplifiedTierOption {
  id: SimplifiedTier;
  label: string;
  recommended?: boolean;
  /** Substring matched against GpuTier.id returned from the API. */
  gpuIdFragment: string;
}

const SIMPLIFIED_TIERS: SimplifiedTierOption[] = [
  { id: "basic",      label: "Basic",      gpuIdFragment: "3060" },
  { id: "standard",   label: "Standard",   gpuIdFragment: "4070", recommended: true },
  { id: "premium",    label: "Premium",    gpuIdFragment: "4090" },
  { id: "enterprise", label: "Enterprise", gpuIdFragment: "a100" },
];

interface EngineOption {
  id: Engine;
  name: string;
  description: string;
  icon: typeof Server;
  features: string[];
}

const ENGINE_OPTIONS: EngineOption[] = [
  {
    id: "vllm",
    name: "vLLM",
    description: "High-throughput serving with PagedAttention",
    icon: Server,
    features: [
      "Maximum throughput",
      "Continuous batching",
      "Best for production",
    ],
  },
  {
    id: "ollama",
    name: "Ollama",
    description: "Simple deployment with OpenAI-compatible API",
    icon: Box,
    features: [
      "Easy setup",
      "Lower resource usage",
      "Great for development",
    ],
  },
];

/** Placeholder shaped like one model card in the "Select Model" grid. */
function ModelCardSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-5 w-10 rounded-full" />
        </div>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-5 w-14 rounded-full" />
          <Skeleton className="h-5 w-12 rounded-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <div className="mt-3 flex items-center justify-between">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-5 w-24" />
        </div>
      </CardContent>
    </Card>
  );
}

export default function NewDeploymentPage() {
  // useSearchParams (the ?fineTunedModel= link from a model's page) needs a boundary.
  return (
    <Suspense fallback={null}>
      <NewDeploymentContent />
    </Suspense>
  );
}

function NewDeploymentContent() {
  const router = useRouter();
  const requestedFineTunedId = useSearchParams().get("fineTunedModel");
  const [step, setStep] = useState<Step>("model");
  const [models, setModels] = useState<Model[]>([]);
  const [gpuTiers, setGpuTiers] = useState<GpuTier[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [isDeploying, setIsDeploying] = useState(false);
  // The API refused the deploy because new GPU capacity is paused. Deploy
  // stays disabled until the user asks to try again.
  const [computePaused, setComputePaused] = useState(false);

  // Form state
  const [selectedModel, setSelectedModel] = useState<Model | null>(null);
  // The organization's fine-tuned models, and the one being deployed (if any).
  // Its base model is `selectedModel`; an adapter is served by vLLM only.
  const [fineTunedModels, setFineTunedModels] = useState<FineTunedModel[]>([]);
  const [selectedFineTuned, setSelectedFineTuned] = useState<FineTunedModel | null>(null);
  // The ?fineTunedModel= link named a model that is not in the list.
  const [fineTunedNotFound, setFineTunedNotFound] = useState(false);
  // Why the API refused to deploy the fine-tuned model, in its own sentence.
  const [deployRefusal, setDeployRefusal] = useState<string | null>(null);
  // GPU memory the API said serving this fine-tuned model needs (from a
  // tier_too_small_for_serving refusal). Smaller tiers are then not offered.
  const [servingVramGb, setServingVramGb] = useState<number | null>(null);
  const [selectedGpu, setSelectedGpu] = useState<GpuTier | null>(null);
  const [selectedEngine, setSelectedEngine] = useState<Engine>("vllm");
  const [name, setName] = useState("");
  const [replicas, setReplicas] = useState(1);
  const [maxTokens, setMaxTokens] = useState(4096);

  // Simplified tier state
  const [selectedSimplifiedTier, setSelectedSimplifiedTier] = useState<SimplifiedTier>("standard");
  const [showAdvancedGpu, setShowAdvancedGpu] = useState(false);

  async function loadData() {
    setLoadError(null);
    setIsLoading(true);
    try {
      const [{ models, gpuTiers }, fineTuned] = await Promise.all([
        modelsApi.listDeployable(),
        // The catalog can be deployed without this list; a failed read shows none.
        fineTunedModelsApi.list().then(
          (res) => res.fineTunedModels,
          () => [] as FineTunedModel[],
        ),
      ]);
      setModels(models);
      setGpuTiers(gpuTiers);
      setFineTunedModels(fineTuned);
      if (requestedFineTunedId) {
        // Preselected from the link on the model's page.
        const requested = fineTuned.find((m) => m.id === requestedFineTunedId);
        const base = requested ? models.find((m) => m.id === requested.baseModelId) : undefined;
        if (requested && base) {
          selectFineTuned(requested, base, gpuTiers);
        } else if (!requested) {
          setFineTunedNotFound(true);
        }
      }
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to load models"));
      setLoadError(error);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  /** Deploy a fine-tuned model: its base model on vLLM, with the adapter loaded. */
  function selectFineTuned(fineTuned: FineTunedModel, base: Model, tiers: GpuTier[] = gpuTiers) {
    setSelectedFineTuned(fineTuned);
    setSelectedModel(base);
    setName(fineTuned.slug.slice(0, 50));
    setSelectedEngine("vllm");
    setDeployRefusal(null);
    setServingVramGb(null);
    const compatible = tiers.find((g) => g.id === base.minGpuTier);
    if (compatible) {
      setSelectedGpu(compatible);
      const matchedTier = SIMPLIFIED_TIERS.find((t) => compatible.id.includes(t.gpuIdFragment));
      setSelectedSimplifiedTier(matchedTier?.id ?? "standard");
    }
    setStep("config");
  }

  function selectModel(model: Model) {
    setSelectedFineTuned(null);
    setDeployRefusal(null);
    setServingVramGb(null);
    setSelectedModel(model);
    setName(model.displayName.toLowerCase().replace(/\s+/g, "-"));

    // Set default engine from model
    setSelectedEngine(model.defaultEngine as Engine);

    // Auto-select compatible GPU and sync simplified tier
    const compatible = gpuTiers.find((g) => g.id === model.minGpuTier);
    if (compatible) {
      setSelectedGpu(compatible);
      // Derive the closest simplified tier for the auto-selected GPU
      const matchedTier = SIMPLIFIED_TIERS.find((t) =>
        compatible.id.includes(t.gpuIdFragment)
      );
      setSelectedSimplifiedTier(matchedTier?.id ?? "standard");
    }

    setStep("config");
  }

  function getCompatibleGpus(model: Model): GpuTier[] {
    const tierOrder = ["3060", "4070", "4090", "a100", "h100"];
    const minIndex = tierOrder.indexOf(model.minGpuTier);
    return gpuTiers.filter(
      (g) => tierOrder.indexOf(g.id) >= minIndex && (servingVramGb === null || g.vram >= servingVramGb)
    );
  }

  function getAvailableEngines(model: Model): EngineOption[] {
    // An adapter is loaded by vLLM; the API refuses any other engine for one.
    if (selectedFineTuned) return ENGINE_OPTIONS.filter((e) => e.id === "vllm");
    return ENGINE_OPTIONS.filter((e) => model.supportedEngines.includes(e.id));
  }

  /**
   * Given a simplified tier, find the best matching GpuTier from those
   * compatible with the currently selected model. Falls back to the first
   * compatible GPU if no exact fragment match is found.
   */
  function resolveGpuForTier(tier: SimplifiedTier, model: Model): GpuTier | null {
    const compatible = getCompatibleGpus(model);
    const option = SIMPLIFIED_TIERS.find((t) => t.id === tier);
    if (!option) return compatible[0] ?? null;
    return (
      compatible.find((g) => g.id.includes(option.gpuIdFragment)) ??
      compatible[0] ??
      null
    );
  }

  function handleSimplifiedTierChange(tier: SimplifiedTier) {
    setSelectedSimplifiedTier(tier);
    if (selectedModel) {
      const gpu = resolveGpuForTier(tier, selectedModel);
      setSelectedGpu(gpu);
    }
  }

  async function handleDeploy() {
    if (!selectedModel || !selectedGpu) return;

    setIsDeploying(true);
    setDeployRefusal(null);
    try {
      const { deployment } = await deploymentsApi.create({
        name,
        // The base model comes from the fine-tuned model on the server.
        ...(selectedFineTuned
          ? { fineTunedModelId: selectedFineTuned.id }
          : { modelId: selectedModel.id }),
        gpuTier: selectedGpu.id,
        engine: selectedEngine,
        replicas,
        config: { maxTokens },
      });

      toast.success("Deployment created! Provisioning GPU...");
      router.push(`/dashboard/deployments/${deployment.id}`);
    } catch (error) {
      if (isComputePaused(error)) {
        // Nothing was created or reserved. The API's reason is not shown.
        setComputePaused(true);
      } else if (selectedFineTuned && getApiErrorBody(error)) {
        // A refusal of the adapter (tier too small, model deleted, engine):
        // it stays on the page with what to change. Nothing was reserved.
        setDeployRefusal(getErrorMessage(error, "This fine-tuned model could not be deployed."));
        const failure = getApiErrorBody(error);
        const required = failure?.body.requiredVramGb;
        if (failure?.body.error === "tier_too_small_for_serving" && typeof required === "number") {
          // Back to the tier choice, with the tiers the API will accept.
          setServingVramGb(required);
          setSelectedGpu(null);
          setShowAdvancedGpu(true);
          setStep("config");
        }
      } else {
        toast.error(getErrorMessage(error, "Failed to create deployment"));
      }
    } finally {
      setIsDeploying(false);
    }
  }

  function formatPrice(pricePerHour: number): string {
    return `$${pricePerHour.toFixed(2)}/hr`;
  }

  function formatParams(params: number): string {
    if (params >= 1e9) return `${(params / 1e9).toFixed(0)}B`;
    if (params >= 1e6) return `${(params / 1e6).toFixed(0)}M`;
    return params.toString();
  }

  // Ollama has slightly lower overhead
  const engineMultiplier = selectedEngine === "ollama" ? 0.95 : 1.0;
  const estimatedCost = selectedGpu
    ? selectedGpu.pricePerHour * replicas * 24 * 30 * engineMultiplier
    : 0;

  return (
    <div className="flex flex-col">
      <Header title="Deploy Model" description="Launch a new inference endpoint" />

      <div className="p-8">
        {/* Progress steps */}
        <div className="mb-8 flex items-center justify-center">
          <div className="flex items-center gap-4">
            {[
              { id: "model", label: "Select Model" },
              { id: "config", label: "Configure" },
              { id: "review", label: "Review & Deploy" },
            ].map((s, i) => (
              <div key={s.id} className="flex items-center gap-4">
                <div
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium",
                    step === s.id
                      ? "bg-primary-600 text-white"
                      : ["model"].indexOf(step) < ["model", "config", "review"].indexOf(s.id)
                      ? "bg-muted text-muted-foreground"
                      : "bg-green-500/10 text-green-600"
                  )}
                >
                  {["model"].indexOf(step) > ["model", "config", "review"].indexOf(s.id) ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    i + 1
                  )}
                </div>
                <span
                  className={cn(
                    "text-sm font-medium",
                    step === s.id ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  {s.label}
                </span>
                {i < 2 && <div className="h-px w-12 bg-gray-300" />}
              </div>
            ))}
          </div>
        </div>

        {/* Step 1: Select Model */}
        {step === "model" && (
          <div>
            {fineTunedNotFound && (
              <p role="alert" className="mb-4 rounded-lg border border-border bg-muted p-4 text-sm text-foreground">
                The fine-tuned model in this link was not found. It may have been deleted. Choose a
                model below.
              </p>
            )}
            {!isLoading && !loadError && fineTunedModels.length > 0 && (
              <div className="mb-8" data-testid="fine-tuned-choices">
                <h2 className="mb-1 text-lg font-semibold">Your fine-tuned models</h2>
                <p className="mb-4 text-sm text-muted-foreground">
                  Served by vLLM as the base model with your adapter loaded.
                </p>
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {fineTunedModels.map((fineTuned) => {
                    const base = models.find((m) => m.id === fineTuned.baseModelId);
                    return (
                      <button
                        key={fineTuned.id}
                        type="button"
                        disabled={!base}
                        data-fine-tuned={fineTuned.id}
                        onClick={() => base && selectFineTuned(fineTuned, base)}
                        className={cn(
                          "rounded-lg border bg-card p-4 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          base ? "hover:border-primary/40 hover:shadow-md" : "cursor-not-allowed opacity-60",
                          selectedFineTuned?.id === fineTuned.id && "border-primary ring-2 ring-primary/30"
                        )}
                      >
                        <span className="flex items-start justify-between gap-2">
                          <span className="font-semibold text-foreground">{fineTuned.name}</span>
                          <Badge variant="default">Fine-tuned</Badge>
                        </span>
                        <span className="mt-1 block text-sm text-muted-foreground">
                          {fineTuned.baseModelName} · {fineTuned.method.toUpperCase()} rank {fineTuned.loraR}
                        </span>
                        {!base && (
                          <span className="mt-2 block text-xs text-muted-foreground">
                            Cannot be deployed here: its base model is not in this server&apos;s
                            deployable catalog.
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <h2 className="mb-4 text-lg font-semibold">Choose a model to deploy</h2>
            {isLoading ? (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3" aria-busy="true">
                <span className="sr-only">Loading models</span>
                {[1, 2, 3, 4, 5, 6].map((i) => (
                  <ModelCardSkeleton key={i} />
                ))}
              </div>
            ) : loadError ? (
              <ErrorState
                title="Couldn't load models"
                error={loadError}
                onRetry={loadData}
              />
            ) : models.length === 0 ? (
              <EmptyState
                icon={Cpu}
                title="No models available"
                description="There are no models in the catalog to deploy yet."
                actionLabel="Back to Deployments"
                actionHref="/dashboard/deployments"
              />
            ) : (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {models.map((model) => (
                  <Card
                    key={model.id}
                    className={cn(
                      "cursor-pointer transition-all hover:border-primary/40 hover:shadow-md",
                      selectedModel?.id === model.id && "border-primary-500 ring-2 ring-primary/30"
                    )}
                    onClick={() => selectModel(model)}
                  >
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between">
                        <CardTitle className="text-base">{model.displayName}</CardTitle>
                        <Badge variant="secondary">{formatParams(model.parameters)}</Badge>
                      </div>
                      <CardDescription className="line-clamp-2">
                        {model.description}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="flex flex-wrap gap-2">
                        {model.tags.slice(0, 3).map((tag) => (
                          <Badge key={tag} variant="outline" className="text-xs">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                      <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
                        <span>Min: {model.minGpuTier}</span>
                        <div className="flex items-center gap-2">
                          {model.supportedEngines.includes("ollama") && (
                            <Badge variant="secondary" className="text-xs">
                              Ollama
                            </Badge>
                          )}
                          <span>{model.contextLength.toLocaleString()} ctx</span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Step 2: Configure */}
        {step === "config" && selectedModel && (
          <div className="mx-auto max-w-2xl">
            <Button variant="ghost" className="mb-4" onClick={() => setStep("model")}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to models
            </Button>

            <Card>
              <CardHeader>
                <CardTitle>Configure Deployment</CardTitle>
                <CardDescription>
                  Deploying{" "}
                  {selectedFineTuned
                    ? `${selectedFineTuned.name} (fine-tuned from ${selectedModel.displayName})`
                    : selectedModel.displayName}{" "}
                  on Nosana&apos;s
                  decentralized GPU network — billed per second of real
                  compute, not per month.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {deployRefusal && (
                  <div
                    role="alert"
                    data-testid="deploy-refusal"
                    className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm"
                  >
                    <p className="font-medium text-foreground">{deployRefusal}</p>
                    <p className="mt-1 text-muted-foreground">
                      Nothing was created and nothing was reserved.
                      {servingVramGb !== null &&
                        ` Choose a GPU with at least ${servingVramGb} GB under Advanced GPU Options.`}
                    </p>
                  </div>
                )}
                <div>
                  <label className="block text-sm font-medium text-foreground">
                    Deployment Name
                  </label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="my-llama-deployment"
                    className="mt-1"
                  />
                  <p className="mt-1 text-sm text-muted-foreground">
                    This will be used in your endpoint URL
                  </p>
                </div>

                {/* Engine Selection */}
                <div>
                  <label className="block text-sm font-medium text-foreground mb-2">
                    Inference Engine
                  </label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {getAvailableEngines(selectedModel).map((engine) => {
                      const Icon = engine.icon;
                      const isDefault = selectedModel.defaultEngine === engine.id;
                      return (
                        <div
                          key={engine.id}
                          className={cn(
                            "cursor-pointer rounded-lg border-2 p-4 transition-all",
                            selectedEngine === engine.id
                              ? "border-primary-500 bg-primary/10"
                              : "border-border hover:border-muted-foreground/40"
                          )}
                          onClick={() => setSelectedEngine(engine.id)}
                        >
                          <div className="flex items-center gap-3">
                            <div className={cn(
                              "flex h-10 w-10 items-center justify-center rounded-lg",
                              selectedEngine === engine.id
                                ? "bg-primary/15 text-primary-600"
                                : "bg-muted text-muted-foreground"
                            )}>
                              <Icon className="h-5 w-5" />
                            </div>
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                <span className="font-medium">{engine.name}</span>
                                {isDefault && (
                                  <Badge variant="secondary" className="text-xs">
                                    Recommended
                                  </Badge>
                                )}
                              </div>
                              <p className="text-sm text-muted-foreground">{engine.description}</p>
                            </div>
                          </div>
                          <ul className="mt-3 space-y-1">
                            {engine.features.map((feature) => (
                              <li key={feature} className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Check className="h-3 w-3 text-green-500" />
                                {feature}
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })}
                  </div>
                  {selectedFineTuned ? (
                    <p className="mt-2 text-sm text-muted-foreground">
                      A fine-tuned model is served by vLLM, which loads the adapter on top of the
                      base model.
                    </p>
                  ) : (
                    getAvailableEngines(selectedModel).length === 1 && (
                      <p className="mt-2 text-sm text-muted-foreground">
                        This model only supports {selectedModel.defaultEngine} engine.
                      </p>
                    )
                  )}
                </div>

                {/* Simplified GPU tier selector */}
                <div>
                  <label className="block text-sm font-medium text-foreground">
                    Performance Tier
                  </label>
                  <div className="mt-2 grid gap-3 sm:grid-cols-2">
                    {SIMPLIFIED_TIERS.map((tier) => (
                      <div
                        key={tier.id}
                        className={cn(
                          "cursor-pointer rounded-lg border-2 p-4 transition-all",
                          selectedSimplifiedTier === tier.id
                            ? "border-primary-500 bg-primary/10"
                            : "border-border hover:border-muted-foreground/40"
                        )}
                        onClick={() => handleSimplifiedTierChange(tier.id)}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{tier.label}</span>
                            {tier.recommended && (
                              <Badge variant="secondary" className="text-xs">
                                Recommended
                              </Badge>
                            )}
                          </div>
                          <span className="text-sm text-muted-foreground">
                            {(() => {
                              const gpu = gpuTiers.find((g) =>
                                g.id.includes(tier.gpuIdFragment)
                              );
                              return gpu ? `$${gpu.pricePerHour.toFixed(2)}/hr` : "—";
                            })()}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Advanced GPU options toggle */}
                <div>
                  <button
                    type="button"
                    onClick={() => setShowAdvancedGpu(!showAdvancedGpu)}
                    className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showAdvancedGpu ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                    Advanced GPU Options
                  </button>

                  {showAdvancedGpu && (
                    <div className="mt-3 rounded-lg border border-border p-4">
                      <p className="mb-3 text-xs text-muted-foreground">
                        Selecting a specific GPU overrides the simplified tier above.
                      </p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {getCompatibleGpus(selectedModel).map((gpu) => (
                          <div
                            key={gpu.id}
                            className={cn(
                              "cursor-pointer rounded-lg border-2 p-4 transition-all",
                              selectedGpu?.id === gpu.id
                                ? "border-primary-500 bg-primary/10"
                                : "border-border hover:border-muted-foreground/40"
                            )}
                            onClick={() => {
                              setSelectedGpu(gpu);
                              // Sync simplified tier if there's a match
                              const matched = SIMPLIFIED_TIERS.find((t) =>
                                gpu.id.includes(t.gpuIdFragment)
                              );
                              if (matched) setSelectedSimplifiedTier(matched.id);
                            }}
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-medium">{gpu.name}</span>
                              <span className="text-sm text-muted-foreground">
                                {formatPrice(gpu.pricePerHour)}
                              </span>
                            </div>
                            <div className="mt-1 text-sm text-muted-foreground">
                              {gpu.vram}GB VRAM
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="block text-sm font-medium text-foreground">
                      Replicas
                    </label>
                    <Select
                      value={replicas.toString()}
                      onChange={(e) => setReplicas(parseInt(e.target.value))}
                      className="mt-1"
                    >
                      {[1, 2, 3, 4, 5].map((n) => (
                        <option key={n} value={n}>
                          {n} replica{n > 1 ? "s" : ""}
                        </option>
                      ))}
                    </Select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-foreground">
                      Max Tokens
                    </label>
                    <Select
                      value={maxTokens.toString()}
                      onChange={(e) => setMaxTokens(parseInt(e.target.value))}
                      className="mt-1"
                    >
                      {[2048, 4096, 8192, 16384, 32768].map((n) => (
                        <option key={n} value={n}>
                          {n.toLocaleString()}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>

                <div className="rounded-lg bg-muted p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-foreground">
                      Estimated Monthly Cost
                    </span>
                    <span className="text-lg font-bold text-foreground">
                      ${estimatedCost.toFixed(2)}/mo
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Based on 24/7 usage.
                    {selectedEngine === "ollama" && " Ollama offers ~5% lower overhead."}
                  </p>
                </div>

                <div className="flex justify-end gap-3">
                  <Button variant="outline" onClick={() => setStep("model")}>
                    Back
                  </Button>
                  <Button onClick={() => setStep("review")} disabled={!selectedGpu}>
                    Continue
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Step 3: Review & Deploy */}
        {step === "review" && selectedModel && selectedGpu && (
          <div className="mx-auto max-w-2xl">
            <Button variant="ghost" className="mb-4" onClick={() => setStep("config")}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to configuration
            </Button>

            <Card>
              <CardHeader>
                <CardTitle>Review & Deploy</CardTitle>
                <CardDescription>
                  Confirm your deployment settings
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="rounded-lg border border-border divide-y">
                  <div className="flex items-center justify-between p-4">
                    <span className="text-muted-foreground">{selectedFineTuned ? "Base model" : "Model"}</span>
                    <span className="font-medium">{selectedModel.displayName}</span>
                  </div>
                  {selectedFineTuned && (
                    <div className="flex items-center justify-between p-4" data-testid="review-fine-tuned">
                      <span className="text-muted-foreground">Fine-tuned model</span>
                      <span className="font-medium">{selectedFineTuned.name}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between p-4">
                    <span className="text-muted-foreground">Deployment Name</span>
                    <span className="font-medium">{name}</span>
                  </div>
                  <div className="flex items-center justify-between p-4">
                    <span className="text-muted-foreground">Inference Engine</span>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">
                        {selectedEngine === "vllm" ? "vLLM" : "Ollama"}
                      </span>
                      {selectedEngine === selectedModel.defaultEngine && (
                        <Badge variant="secondary" className="text-xs">Default</Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-between p-4">
                    <span className="text-muted-foreground">GPU</span>
                    <span className="font-medium">
                      {selectedGpu.name}
                      <span className="ml-2 text-sm font-normal text-muted-foreground">
                        via Nosana
                      </span>
                    </span>
                  </div>
                  <div className="flex items-center justify-between p-4">
                    <span className="text-muted-foreground">Replicas</span>
                    <span className="font-medium">{replicas}</span>
                  </div>
                  <div className="flex items-center justify-between p-4">
                    <span className="text-muted-foreground">Max Tokens</span>
                    <span className="font-medium">{maxTokens.toLocaleString()}</span>
                  </div>
                  <div className="flex items-center justify-between p-4">
                    <span className="text-muted-foreground">Estimated Cost</span>
                    <span className="font-medium">${estimatedCost.toFixed(2)}/mo</span>
                  </div>
                </div>

                <div className="rounded-lg bg-primary/10 p-4">
                  <div className="flex items-start gap-3">
                    <Zap className="h-5 w-5 text-primary-600" />
                    <div>
                      <p className="font-medium text-primary-900">Ready to deploy</p>
                      <p className="mt-1 text-sm text-primary-700">
                        Runs as a Nosana GPU job. Once a host passes its
                        health check, your OpenAI-compatible endpoint goes
                        live at:{" "}
                        <code className="rounded bg-primary/15 px-1">
                          {deploymentEndpointPattern(API_BASE_URL)}
                        </code>
                        . The slug is assigned from the name when the
                        deployment is created and shown on its page.
                      </p>
                      {selectedEngine === "ollama" && (
                        <p className="mt-2 text-sm text-primary-700">
                          Using Ollama engine with OpenAI-compatible API at port 11434.
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {deployRefusal && (
                  <div
                    role="alert"
                    data-testid="deploy-refusal"
                    className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm"
                  >
                    <p className="font-medium text-foreground">{deployRefusal}</p>
                    <p className="mt-1 text-muted-foreground">Nothing was created and nothing was reserved.</p>
                  </div>
                )}

                {computePaused && (
                  <div
                    role="status"
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted p-4"
                  >
                    <p className="text-sm font-medium text-foreground">{COMPUTE_PAUSED_MESSAGE}</p>
                    <Button variant="ghost" size="sm" onClick={() => setComputePaused(false)}>
                      Try again
                    </Button>
                  </div>
                )}

                <div className="flex justify-end gap-3">
                  <Button variant="outline" onClick={() => setStep("config")}>
                    Back
                  </Button>
                  <Button onClick={handleDeploy} isLoading={isDeploying} disabled={computePaused}>
                    <Cpu className="mr-2 h-4 w-4" />
                    Deploy with {selectedEngine === "vllm" ? "vLLM" : "Ollama"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
