"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  GraduationCap,
  Database,
  Cpu,
  Settings,
  Check,
  ArrowLeft,
  ArrowRight,
  AlertTriangle,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  trainingApi,
  type Dataset,
  type TrainableModel,
  type CreateTrainingJobInput,
  getErrorMessage,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type Step = "model" | "dataset" | "config" | "review";

const steps: { id: Step; label: string; icon: React.ElementType }[] = [
  { id: "model", label: "Base Model", icon: Cpu },
  { id: "dataset", label: "Dataset", icon: Database },
  { id: "config", label: "Configuration", icon: Settings },
  { id: "review", label: "Review", icon: Check },
];

const methodDescriptions: Record<string, string> = {
  lora: "Low-Rank Adaptation - efficient fine-tuning with minimal memory overhead",
  qlora: "Quantized LoRA - 4-bit quantization for training 70B+ models on consumer GPUs",
  full: "Full fine-tuning - updates all model weights (only for smaller models)",
};

export default function NewTrainingPage() {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState<Step>("model");
  const [isCreating, setIsCreating] = useState(false);

  const [models, setModels] = useState<TrainableModel[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [formData, setFormData] = useState<CreateTrainingJobInput>({
    name: "",
    baseModelId: "",
    datasetId: "",
    method: "lora",
    gpuTier: "rtx-4070",
    gpuCount: 1,
    config: {
      epochs: 3,
      batchSize: 4,
      learningRate: 0.0002,
      warmupSteps: 100,
      gradientAccumulationSteps: 4,
      loraR: 16,
      loraAlpha: 32,
      loraDropout: 0.05,
    },
  });

  const [showAdvancedGpu, setShowAdvancedGpu] = useState(false);

  const [estimate, setEstimate] = useState<{
    gpuHours: number;
    totalCostUsd: string;
    recommendedGpuTier: string;
  } | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [modelsRes, datasetsRes] = await Promise.all([
          trainingApi.listTrainableModels(),
          trainingApi.listDatasets(),
        ]);
        setModels(modelsRes.models);
        setDatasets(datasetsRes.datasets.filter((d) => d.isValidated));
      } catch (error) {
        toast.error(getErrorMessage(error, "Failed to load data"));
      } finally {
        setIsLoading(false);
      }
    }
    load();
  }, []);

  // Update estimate when config changes
  useEffect(() => {
    if (formData.baseModelId && formData.datasetId) {
      trainingApi
        .estimate({
          baseModelId: formData.baseModelId,
          datasetId: formData.datasetId,
          method: formData.method,
          epochs: formData.config?.epochs,
          gpuTier: formData.gpuTier,
        })
        .then((res) => {
          setEstimate({
            gpuHours: res.estimate.gpuHours,
            totalCostUsd: res.estimate.totalCostUsd,
            recommendedGpuTier: res.estimate.recommendedGpuTier,
          });
        })
        .catch(() => {
          // Ignore estimation errors
        });
    }
  }, [formData.baseModelId, formData.datasetId, formData.method, formData.config?.epochs, formData.gpuTier]);

  const currentStepIndex = steps.findIndex((s) => s.id === currentStep);
  const selectedModel = models.find((m) => m.id === formData.baseModelId);
  const selectedDataset = datasets.find((d) => d.id === formData.datasetId);

  function nextStep() {
    const nextIndex = currentStepIndex + 1;
    const nextStepConfig = steps[nextIndex];
    if (nextStepConfig) {
      setCurrentStep(nextStepConfig.id);
    }
  }

  function prevStep() {
    const prevIndex = currentStepIndex - 1;
    const prevStepConfig = steps[prevIndex];
    if (prevStepConfig) {
      setCurrentStep(prevStepConfig.id);
    }
  }

  async function handleCreate() {
    if (!formData.name) {
      toast.error("Please enter a job name");
      return;
    }

    setIsCreating(true);
    try {
      const { job } = await trainingApi.createJob(formData);
      toast.success("Training job created");
      router.push(`/dashboard/training/${job.id}`);
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to create training job"));
    } finally {
      setIsCreating(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex flex-col">
        <Header title="New Training Job" />
        <div className="p-8">
          <div className="h-96 animate-pulse rounded-lg bg-muted" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <Header
        title="New Training Job"
        description="Fine-tune a model with your data"
      />

      <div className="p-8">
        {/* Progress steps */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            {steps.map((step, index) => (
              <div key={step.id} className="flex items-center">
                <button
                  onClick={() => setCurrentStep(step.id)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
                    currentStep === step.id
                      ? "bg-primary/15 text-primary-700"
                      : index < currentStepIndex
                      ? "text-primary-600"
                      : "text-gray-400"
                  )}
                >
                  <step.icon className="h-4 w-4" />
                  <span className="hidden md:inline">{step.label}</span>
                </button>
                {index < steps.length - 1 && (
                  <div
                    className={cn(
                      "mx-2 h-0.5 w-8 md:w-16",
                      index < currentStepIndex ? "bg-primary-500" : "bg-muted"
                    )}
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="grid gap-8 lg:grid-cols-3">
          {/* Main content */}
          <div className="lg:col-span-2">
            <Card>
              <CardContent className="py-6">
                {/* Model selection */}
                {currentStep === "model" && (
                  <div>
                    <h3 className="text-lg font-medium">Select Base Model</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Choose the model you want to fine-tune
                    </p>

                    <div className="mt-6 space-y-4">
                      {models.map((model) => (
                        <button
                          key={model.id}
                          onClick={() => {
                            setFormData({
                              ...formData,
                              baseModelId: model.id,
                              gpuTier: model.recommendedGpuTier,
                              method: model.supportedMethods[0] as any,
                            });
                          }}
                          className={cn(
                            "w-full rounded-lg border-2 p-4 text-left transition-all",
                            formData.baseModelId === model.id
                              ? "border-primary-500 bg-primary/10"
                              : "border-border hover:border-muted-foreground/40"
                          )}
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="font-medium">{model.displayName}</p>
                              <p className="text-sm text-muted-foreground">{model.hfId}</p>
                            </div>
                            <div className="text-right">
                              <p className="text-sm font-medium">
                                {model.parameters ? `${(model.parameters / 1e9).toFixed(0)}B params` : ""}
                              </p>
                              <div className="mt-1 flex gap-1">
                                {model.supportedMethods.map((method) => (
                                  <Badge key={method} variant="secondary" className="text-xs">
                                    {method}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Dataset selection */}
                {currentStep === "dataset" && (
                  <div>
                    <h3 className="text-lg font-medium">Select Dataset</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Choose a validated dataset for training
                    </p>

                    {datasets.length === 0 ? (
                      <div className="mt-8 flex flex-col items-center justify-center py-12">
                        <Database className="h-12 w-12 text-gray-300" />
                        <p className="mt-4 text-muted-foreground">No validated datasets available</p>
                        <Link href="/dashboard/training/datasets" className="mt-4">
                          <Button>Upload Dataset</Button>
                        </Link>
                      </div>
                    ) : (
                      <div className="mt-6 space-y-4">
                        {datasets.map((dataset) => (
                          <button
                            key={dataset.id}
                            onClick={() => setFormData({ ...formData, datasetId: dataset.id })}
                            className={cn(
                              "w-full rounded-lg border-2 p-4 text-left transition-all",
                              formData.datasetId === dataset.id
                                ? "border-primary-500 bg-primary/10"
                                : "border-border hover:border-muted-foreground/40"
                            )}
                          >
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="font-medium">{dataset.name}</p>
                                <p className="text-sm text-muted-foreground">
                                  {dataset.description || `${dataset.format} format`}
                                </p>
                              </div>
                              <div className="text-right">
                                <p className="font-medium">{dataset.rowCount.toLocaleString()} rows</p>
                                <p className="text-sm text-muted-foreground">
                                  {(dataset.sizeBytes / 1024 / 1024).toFixed(2)} MB
                                </p>
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Configuration */}
                {currentStep === "config" && (
                  <div className="space-y-6">
                    <div>
                      <h3 className="text-lg font-medium">Training Configuration</h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Configure hyperparameters and compute resources
                      </p>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-foreground">
                        Job Name *
                      </label>
                      <Input
                        value={formData.name}
                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                        placeholder="my-finetuned-model"
                        className="mt-1"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-foreground">
                        Training Method
                      </label>
                      <div className="mt-2 grid gap-3 md:grid-cols-3">
                        {(selectedModel?.supportedMethods || ["lora", "qlora"]).map((method) => (
                          <button
                            key={method}
                            onClick={() => setFormData({ ...formData, method: method as any })}
                            className={cn(
                              "rounded-lg border-2 p-3 text-left transition-all",
                              formData.method === method
                                ? "border-primary-500 bg-primary/10"
                                : "border-border hover:border-muted-foreground/40"
                            )}
                          >
                            <p className="font-medium uppercase">{method}</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {methodDescriptions[method]}
                            </p>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <div>
                        <label className="block text-sm font-medium text-foreground">GPU Tier</label>
                        <Select
                          value={formData.gpuTier}
                          onChange={(e) => setFormData({ ...formData, gpuTier: e.target.value })}
                          className="mt-1"
                        >
                          <option value="rtx-3060">Basic (~$0.15/hr)</option>
                          <option value="rtx-4070">Standard (~$0.35/hr) ★ Recommended</option>
                          <option value="rtx-4090">Premium (~$0.50/hr)</option>
                          <option value="a100">Enterprise (~$1.50/hr)</option>
                        </Select>
                        {estimate?.recommendedGpuTier && estimate.recommendedGpuTier !== formData.gpuTier && (
                          <p className="mt-1 text-xs text-yellow-600">
                            Recommended: {estimate.recommendedGpuTier}
                          </p>
                        )}

                        {/* Advanced GPU toggle */}
                        <button
                          type="button"
                          onClick={() => setShowAdvancedGpu((v) => !v)}
                          className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                          {showAdvancedGpu ? (
                            <ChevronDown className="h-3 w-3" />
                          ) : (
                            <ChevronRight className="h-3 w-3" />
                          )}
                          Advanced GPU Options
                        </button>

                        {showAdvancedGpu && (
                          <div className="mt-2">
                            <label className="block text-xs text-muted-foreground mb-1">
                              Specific GPU Model
                            </label>
                            <Select
                              value={formData.gpuTier}
                              onChange={(e) => setFormData({ ...formData, gpuTier: e.target.value })}
                            >
                              <option value="rtx-3060">RTX 3060 (12GB) - $0.15/hr</option>
                              <option value="rtx-4070">RTX 4070 (12GB) - $0.35/hr</option>
                              <option value="rtx-4090">RTX 4090 (24GB) - $0.50/hr</option>
                              <option value="a100">A100 40GB - $1.50/hr</option>
                              <option value="a100-80gb">A100 80GB - $2.50/hr</option>
                            </Select>
                          </div>
                        )}
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-foreground">Epochs</label>
                        <Input
                          type="number"
                          min={1}
                          max={100}
                          value={formData.config?.epochs}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              config: { ...formData.config!, epochs: parseInt(e.target.value) },
                            })
                          }
                          className="mt-1"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-foreground">Batch Size</label>
                        <Select
                          value={formData.config?.batchSize?.toString()}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              config: { ...formData.config!, batchSize: parseInt(e.target.value) },
                            })
                          }
                          className="mt-1"
                        >
                          {[1, 2, 4, 8, 16, 32].map((n) => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                        </Select>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-foreground">
                          Learning Rate
                        </label>
                        <Select
                          value={formData.config?.learningRate?.toString()}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              config: { ...formData.config!, learningRate: parseFloat(e.target.value) },
                            })
                          }
                          className="mt-1"
                        >
                          <option value="0.0001">1e-4 (Conservative)</option>
                          <option value="0.0002">2e-4 (Recommended)</option>
                          <option value="0.0003">3e-4 (Aggressive)</option>
                        </Select>
                      </div>
                    </div>

                    {(formData.method === "lora" || formData.method === "qlora") && (
                      <div>
                        <h4 className="font-medium">LoRA Parameters</h4>
                        <div className="mt-3 grid gap-4 md:grid-cols-3">
                          <div>
                            <label className="block text-sm text-muted-foreground">Rank (r)</label>
                            <Select
                              value={formData.config?.loraR?.toString()}
                              onChange={(e) =>
                                setFormData({
                                  ...formData,
                                  config: { ...formData.config!, loraR: parseInt(e.target.value) },
                                })
                              }
                              className="mt-1"
                            >
                              {[8, 16, 32, 64, 128].map((n) => (
                                <option key={n} value={n}>{n}</option>
                              ))}
                            </Select>
                          </div>

                          <div>
                            <label className="block text-sm text-muted-foreground">Alpha</label>
                            <Select
                              value={formData.config?.loraAlpha?.toString()}
                              onChange={(e) =>
                                setFormData({
                                  ...formData,
                                  config: { ...formData.config!, loraAlpha: parseInt(e.target.value) },
                                })
                              }
                              className="mt-1"
                            >
                              {[16, 32, 64, 128, 256].map((n) => (
                                <option key={n} value={n}>{n}</option>
                              ))}
                            </Select>
                          </div>

                          <div>
                            <label className="block text-sm text-muted-foreground">Dropout</label>
                            <Select
                              value={formData.config?.loraDropout?.toString()}
                              onChange={(e) =>
                                setFormData({
                                  ...formData,
                                  config: { ...formData.config!, loraDropout: parseFloat(e.target.value) },
                                })
                              }
                              className="mt-1"
                            >
                              <option value="0">0 (None)</option>
                              <option value="0.05">0.05</option>
                              <option value="0.1">0.1</option>
                            </Select>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Review */}
                {currentStep === "review" && (
                  <div>
                    <h3 className="text-lg font-medium">Review Training Job</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Review your configuration before starting
                    </p>

                    <div className="mt-6 space-y-4">
                      <div className="rounded-lg border p-4">
                        <h4 className="font-medium">Job Details</h4>
                        <dl className="mt-2 grid gap-2 text-sm">
                          <div className="flex justify-between">
                            <dt className="text-muted-foreground">Name</dt>
                            <dd className="font-medium">{formData.name || "—"}</dd>
                          </div>
                          <div className="flex justify-between">
                            <dt className="text-muted-foreground">Method</dt>
                            <dd className="font-medium uppercase">{formData.method}</dd>
                          </div>
                        </dl>
                      </div>

                      <div className="rounded-lg border p-4">
                        <h4 className="font-medium">Base Model</h4>
                        <p className="mt-1 text-sm">
                          {selectedModel?.displayName || formData.baseModelId}
                        </p>
                        <p className="text-xs text-muted-foreground">{selectedModel?.hfId}</p>
                      </div>

                      <div className="rounded-lg border p-4">
                        <h4 className="font-medium">Dataset</h4>
                        <p className="mt-1 text-sm">{selectedDataset?.name || "—"}</p>
                        <p className="text-xs text-muted-foreground">
                          {selectedDataset?.rowCount.toLocaleString()} rows
                        </p>
                      </div>

                      <div className="rounded-lg border p-4">
                        <h4 className="font-medium">Hyperparameters</h4>
                        <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
                          <div className="flex justify-between">
                            <dt className="text-muted-foreground">Epochs</dt>
                            <dd>{formData.config?.epochs}</dd>
                          </div>
                          <div className="flex justify-between">
                            <dt className="text-muted-foreground">Batch Size</dt>
                            <dd>{formData.config?.batchSize}</dd>
                          </div>
                          <div className="flex justify-between">
                            <dt className="text-muted-foreground">Learning Rate</dt>
                            <dd>{formData.config?.learningRate}</dd>
                          </div>
                          <div className="flex justify-between">
                            <dt className="text-muted-foreground">LoRA Rank</dt>
                            <dd>{formData.config?.loraR}</dd>
                          </div>
                        </dl>
                      </div>

                      <div className="rounded-lg border p-4">
                        <h4 className="font-medium">Compute</h4>
                        <dl className="mt-2 grid gap-2 text-sm">
                          <div className="flex justify-between">
                            <dt className="text-muted-foreground">GPU Tier</dt>
                            <dd className="font-medium">{formData.gpuTier}</dd>
                          </div>
                          {estimate && (
                            <>
                              <div className="flex justify-between">
                                <dt className="text-muted-foreground">Estimated GPU Hours</dt>
                                <dd>{estimate.gpuHours}</dd>
                              </div>
                              <div className="flex justify-between">
                                <dt className="text-muted-foreground">Estimated Cost</dt>
                                <dd className="font-medium text-primary-600">
                                  ${estimate.totalCostUsd}
                                </dd>
                              </div>
                            </>
                          )}
                        </dl>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Navigation */}
            <div className="mt-6 flex justify-between">
              <Button
                variant="outline"
                onClick={prevStep}
                disabled={currentStepIndex === 0}
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Button>

              {currentStep === "review" ? (
                <Button onClick={handleCreate} isLoading={isCreating}>
                  <GraduationCap className="mr-2 h-4 w-4" />
                  Start Training
                </Button>
              ) : (
                <Button
                  onClick={nextStep}
                  disabled={
                    (currentStep === "model" && !formData.baseModelId) ||
                    (currentStep === "dataset" && !formData.datasetId)
                  }
                >
                  Next
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              )}
            </div>
          </div>

          {/* Sidebar */}
          <div>
            {estimate && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Cost Estimate</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">GPU Hours</span>
                      <span className="font-medium">{estimate.gpuHours}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">GPU Tier</span>
                      <span className="font-medium">{formData.gpuTier}</span>
                    </div>
                    <div className="border-t pt-3">
                      <div className="flex justify-between">
                        <span className="font-medium">Total Cost</span>
                        <span className="text-xl font-bold text-primary-600">
                          ${estimate.totalCostUsd}
                        </span>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            <Card className="mt-6">
              <CardHeader>
                <CardTitle className="text-base">Training Tips</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-muted-foreground">
                <p>
                  <strong>LoRA vs QLoRA:</strong> QLoRA uses 4-bit quantization, requiring less VRAM but slightly slower training.
                </p>
                <p>
                  <strong>Epochs:</strong> Start with 3 epochs and monitor loss curves. Increase if underfitting.
                </p>
                <p>
                  <strong>Batch Size:</strong> Larger batches train faster but require more VRAM. Use gradient accumulation for effective larger batches.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
