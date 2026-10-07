"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Boxes, Database, GraduationCap, Plus, Rocket, Store } from "lucide-react";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Stat } from "@/components/ui/stat";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import {
  fineTunedModelsApi,
  trainingApi,
  formatDatasetRows,
  type Dataset,
  type FineTunedModel,
  type TrainingCapabilities,
  type TrainingJob,
} from "@/lib/api";
import { formatCents } from "@/lib/jobs";
import {
  formatBytes,
  formatRunTime,
  trainingCostView,
  trainingTotals,
} from "@/lib/training";

import { TrainingStatusBadge } from "./_components/status-badge";
import { TrainingBlockers } from "./_components/training-blockers";

/** How often the list is read again while a job is not over. */
const REFRESH_MS = 10_000;

interface PageData {
  capabilities: TrainingCapabilities;
  jobs: TrainingJob[];
  models: FineTunedModel[];
  datasets: Dataset[];
}

function RowsSkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-3" aria-busy="true">
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

export default function TrainingPage() {
  const [data, setData] = useState<PageData | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      const [capabilities, jobsRes, modelsRes, datasetsRes] = await Promise.all([
        trainingApi.getCapabilities(),
        trainingApi.listJobs(),
        fineTunedModelsApi.list(),
        trainingApi.listDatasets(),
      ]);
      setData({
        capabilities,
        jobs: jobsRes.jobs,
        models: modelsRes.fineTunedModels,
        datasets: datasetsRes.datasets,
      });
      setLoadError(null);
    } catch (error) {
      // A failed refresh keeps what is on the page; only a first load shows the error.
      setData((current) => {
        if (current === null) setLoadError(error);
        return current;
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hasActiveJob = data?.jobs.some(
    (job) => !["completed", "failed", "cancelled"].includes(job.status),
  );
  useEffect(() => {
    if (!hasActiveJob) return;
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [hasActiveJob, load]);

  function handleRetry() {
    setLoadError(null);
    void load();
  }

  const isLoading = data === null && loadError === null;
  const canStart = data?.capabilities.canStart ?? false;
  const totals = data ? trainingTotals(data.jobs) : null;

  return (
    <div className="flex flex-col">
      <Header title="Fine-tuning" description="Train LoRA and QLoRA adapters on your own data" />

      <div className="space-y-8 p-8">
        {loadError ? (
          <ErrorState
            title="Couldn't load fine-tuning"
            error={loadError}
            onRetry={handleRetry}
          />
        ) : (
          <>
            {data && <TrainingBlockers blockers={data.capabilities.blockers} />}

            {/* Totals: every figure is a sum over the jobs the API listed. */}
            <div className="grid gap-4 md:grid-cols-4">
              {[
                {
                  label: "Training jobs",
                  value: totals ? totals.total.toLocaleString() : null,
                  hint: totals ? `${totals.completed.toLocaleString()} completed` : null,
                },
                {
                  label: "Not finished",
                  value: totals ? totals.active.toLocaleString() : null,
                  hint: totals ? `${totals.running.toLocaleString()} running on a GPU` : null,
                },
                {
                  label: "Charged for training",
                  value: totals ? formatCents(totals.chargedCents) : null,
                  hint: totals ? `${formatRunTime(totals.billedSeconds)} of GPU time billed` : null,
                },
                {
                  label: "Held right now",
                  value: totals ? formatCents(totals.heldCents) : null,
                  hint: "Returned, less the charge, when each job ends",
                },
              ].map((tile) => (
                <Card key={tile.label}>
                  <CardContent className="py-4">
                    {tile.value === null ? (
                      <div className="space-y-2" aria-busy="true">
                        <Skeleton className="h-4 w-28" />
                        <Skeleton className="h-7 w-16" />
                      </div>
                    ) : (
                      <Stat label={tile.label} value={tile.value} hint={tile.hint} />
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>

            <div className="grid gap-8 lg:grid-cols-3">
              <div className="space-y-8 lg:col-span-2">
                {/* Training jobs */}
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between gap-4">
                    <div>
                      <CardTitle className="text-base">Training jobs</CardTitle>
                      <CardDescription>
                        Newest first. Cost is the charge once a job is settled, the cost so far while it
                        runs, and the amount held before that.
                      </CardDescription>
                    </div>
                    {canStart ? (
                      <Link href="/dashboard/training/new">
                        <Button size="sm">
                          <Plus className="mr-2 h-4 w-4" />
                          New training job
                        </Button>
                      </Link>
                    ) : (
                      <Button size="sm" disabled data-testid="new-training-job">
                        <Plus className="mr-2 h-4 w-4" />
                        New training job
                      </Button>
                    )}
                  </CardHeader>
                  <CardContent>
                    {isLoading || !data ? (
                      <RowsSkeleton label="Loading training jobs" />
                    ) : data.jobs.length === 0 ? (
                      <EmptyState
                        icon={GraduationCap}
                        title="No training jobs yet"
                        description={
                          canStart
                            ? "Start a fine-tuning run and it will appear here."
                            : "Training jobs you start will be listed here."
                        }
                        actionLabel={canStart ? "New training job" : undefined}
                        actionHref={canStart ? "/dashboard/training/new" : undefined}
                      />
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border text-left text-xs text-muted-foreground">
                              <th scope="col" className="pb-2 pr-4 font-medium">Job</th>
                              <th scope="col" className="pb-2 pr-4 font-medium">Status</th>
                              <th scope="col" className="pb-2 pr-4 font-medium">Dataset</th>
                              <th scope="col" className="pb-2 pr-4 font-medium">GPU tier</th>
                              <th scope="col" className="pb-2 text-right font-medium">Cost</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {data.jobs.map((job) => {
                              const cost = trainingCostView(job);
                              return (
                                <tr key={job.id} className="align-top">
                                  <td className="py-3 pr-4">
                                    <Link
                                      href={`/dashboard/training/${job.id}`}
                                      className="font-medium text-foreground underline-offset-4 hover:underline"
                                    >
                                      {job.name}
                                    </Link>
                                    <p className="mt-0.5 text-xs text-muted-foreground">
                                      {job.baseModelId} · {job.method.toUpperCase()}
                                    </p>
                                  </td>
                                  <td className="py-3 pr-4">
                                    <TrainingStatusBadge status={job.status} />
                                    {job.status === "running" && (
                                      <p className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">
                                        {Math.round(job.progress)}%
                                      </p>
                                    )}
                                    {job.failure && (
                                      <p className="mt-1 max-w-[16rem] text-xs text-muted-foreground">
                                        {job.failure.message}
                                      </p>
                                    )}
                                  </td>
                                  <td className="py-3 pr-4 text-muted-foreground">
                                    {job.datasetName ?? "Deleted dataset"}
                                  </td>
                                  <td className="py-3 pr-4 text-muted-foreground">{job.gpuTier}</td>
                                  <td className="py-3 text-right">
                                    <span className="font-mono tabular-nums text-foreground">{cost.text}</span>
                                    <p className="text-xs text-muted-foreground">{cost.label}</p>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Fine-tuned models */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Fine-tuned models</CardTitle>
                    <CardDescription>
                      The adapters your completed jobs produced. Deploy one to call it through the /v1 API.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {isLoading || !data ? (
                      <RowsSkeleton label="Loading fine-tuned models" />
                    ) : data.models.length === 0 ? (
                      <EmptyState
                        icon={Boxes}
                        title="No fine-tuned models yet"
                        description="A training job that completes adds its model here."
                      />
                    ) : (
                      <div className="space-y-3">
                        {data.models.map((model) => (
                          <div
                            key={model.id}
                            className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4"
                          >
                            <div className="min-w-0">
                              <Link
                                href={`/dashboard/training/models/${model.id}`}
                                className="font-medium text-foreground underline-offset-4 hover:underline"
                              >
                                {model.name}
                              </Link>
                              <p className="mt-0.5 text-sm text-muted-foreground">
                                {model.baseModelName} · {model.method.toUpperCase()} rank {model.loraR} ·{" "}
                                {formatBytes(model.adapterBytes)}
                              </p>
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                {model.activeDeployments === 0
                                  ? "Not deployed"
                                  : `${model.activeDeployments} active deployment${model.activeDeployments === 1 ? "" : "s"}`}
                              </p>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <Link href={`/dashboard/deployments/new?fineTunedModel=${model.id}`}>
                                <Button size="sm">
                                  <Rocket className="mr-2 h-4 w-4" />
                                  Deploy
                                </Button>
                              </Link>
                              {model.activeDeployments > 0 ? (
                                <Link href="/dashboard/marketplace/offerings/new">
                                  <Button size="sm" variant="outline">
                                    <Store className="mr-2 h-4 w-4" />
                                    List on marketplace
                                  </Button>
                                </Link>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled
                                  title="Deploy the model first: a listing sells a running deployment."
                                >
                                  <Store className="mr-2 h-4 w-4" />
                                  List on marketplace
                                </Button>
                              )}
                            </div>
                          </div>
                        ))}
                        <p className="text-xs text-muted-foreground">
                          A marketplace listing sells a running deployment, so List on marketplace opens
                          once a model is deployed.
                        </p>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* Datasets */}
              <div>
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between">
                    <div>
                      <CardTitle className="text-base">Datasets</CardTitle>
                      <CardDescription>Your training data</CardDescription>
                    </div>
                    <Link href="/dashboard/training/datasets">
                      <Button variant="outline" size="sm">
                        Manage
                      </Button>
                    </Link>
                  </CardHeader>
                  <CardContent>
                    {isLoading || !data ? (
                      <RowsSkeleton label="Loading datasets" />
                    ) : data.datasets.length === 0 ? (
                      <EmptyState
                        icon={Database}
                        title="No datasets yet"
                        description={
                          data.capabilities.storage.configured
                            ? "Upload a dataset to train on."
                            : "Datasets you upload will be listed here."
                        }
                        actionLabel={data.capabilities.storage.configured ? "Upload a dataset" : undefined}
                        actionHref={
                          data.capabilities.storage.configured ? "/dashboard/training/datasets" : undefined
                        }
                      />
                    ) : (
                      <div className="space-y-3">
                        {data.datasets.slice(0, 8).map((dataset) => (
                          <div
                            key={dataset.id}
                            className="flex items-center justify-between gap-3 rounded-lg border p-3"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">{dataset.name}</p>
                              <p className="text-xs text-muted-foreground">
                                {formatDatasetRows(dataset.rowCount)}
                              </p>
                            </div>
                            <Badge
                              variant={dataset.isValidated ? "success" : "secondary"}
                              className="shrink-0 whitespace-nowrap"
                            >
                              {dataset.isValidated ? "Valid" : "Not valid"}
                            </Badge>
                          </div>
                        ))}
                        {data.datasets.length > 8 && (
                          <p className="text-xs text-muted-foreground">
                            and {(data.datasets.length - 8).toLocaleString()} more on the Datasets page
                          </p>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
