"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  GraduationCap,
  Plus,
  Play,
  Square,
  CheckCircle,
  XCircle,
  Clock,
  Database,
  Cpu,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { trainingApi, type TrainingJob, type Dataset, getErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

const statusColors: Record<string, "success" | "warning" | "destructive" | "secondary"> = {
  running: "warning",
  completed: "success",
  failed: "destructive",
  pending: "secondary",
  queued: "secondary",
  cancelled: "secondary",
};

const statusIcons: Record<string, React.ElementType> = {
  running: Play,
  completed: CheckCircle,
  failed: XCircle,
  pending: Clock,
  queued: Clock,
  cancelled: Square,
};

const methodColors: Record<string, string> = {
  lora: "bg-blue-500/10 text-blue-500",
  qlora: "bg-purple-500/10 text-purple-500",
  full: "bg-orange-500/10 text-orange-500",
};

/** A stat card's number, or a skeleton of the same height while loading. */
function StatValue({ isLoading, children }: { isLoading: boolean; children: React.ReactNode }) {
  return isLoading ? (
    <Skeleton className="my-1 h-6 w-12" />
  ) : (
    <p className="text-2xl font-bold">{children}</p>
  );
}

export default function TrainingPage() {
  const [jobs, setJobs] = useState<TrainingJob[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      const [jobsRes, datasetsRes] = await Promise.all([
        trainingApi.listJobs(),
        trainingApi.listDatasets(),
      ]);
      setJobs(jobsRes.jobs);
      setDatasets(datasetsRes.datasets);
    } catch (error) {
      setLoadError(error);
      toast.error(getErrorMessage(error, "Failed to load training data"));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function handleRetry() {
    setLoadError(null);
    setIsLoading(true);
    void load();
  }

  const runningJobs = jobs.filter((j) => j.status === "running");
  const completedJobs = jobs.filter((j) => j.status === "completed");
  const totalGpuHours = jobs.reduce((sum, j) => {
    if (j.estimatedCostCents) {
      return sum + j.estimatedCostCents / 50; // Rough estimate: $0.50/hr
    }
    return sum;
  }, 0);

  if (loadError) {
    return (
      <div className="flex flex-col">
        <Header
          title="Training Studio"
          description="Fine-tune models with LoRA and QLoRA"
          action={{ label: "New Training", href: "/dashboard/training/new" }}
        />
        <div className="p-8">
          <ErrorState
            title="Couldn't load training jobs and datasets"
            error={loadError}
            onRetry={handleRetry}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <Header
        title="Training Studio"
        description="Fine-tune models with LoRA and QLoRA"
        action={{ label: "New Training", href: "/dashboard/training/new" }}
      />

      <div className="p-8">
        {/* Stats */}
        <div className="mb-8 grid gap-4 md:grid-cols-4">
          <Card>
            <CardContent className="py-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Training Jobs</p>
                  <StatValue isLoading={isLoading}>{jobs.length}</StatValue>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15">
                  <GraduationCap className="h-5 w-5 text-primary-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="py-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Running</p>
                  <StatValue isLoading={isLoading}>{runningJobs.length}</StatValue>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-yellow-500/10">
                  <Play className="h-5 w-5 text-yellow-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="py-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Datasets</p>
                  <StatValue isLoading={isLoading}>{datasets.length}</StatValue>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10">
                  <Database className="h-5 w-5 text-blue-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="py-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">GPU Hours</p>
                  <StatValue isLoading={isLoading}>{totalGpuHours.toFixed(1)}</StatValue>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10">
                  <Cpu className="h-5 w-5 text-green-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Main content grid */}
        <div className="grid gap-8 lg:grid-cols-3">
          {/* Training Jobs */}
          <div className="lg:col-span-2">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-base">Training Jobs</CardTitle>
                  <CardDescription>Recent fine-tuning runs</CardDescription>
                </div>
                <Link href="/dashboard/training/new">
                  <Button size="sm">
                    <Plus className="mr-2 h-4 w-4" />
                    New Job
                  </Button>
                </Link>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="space-y-4" aria-busy="true">
                    {[1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between rounded-lg border p-4"
                      >
                        <div className="flex items-center gap-4">
                          <Skeleton className="h-10 w-10 rounded-lg" />
                          <div className="space-y-2">
                            <Skeleton className="h-5 w-40" />
                            <Skeleton className="h-4 w-28" />
                          </div>
                        </div>
                        <Skeleton className="h-5 w-20 rounded-full" />
                      </div>
                    ))}
                    <span className="sr-only">Loading training jobs</span>
                  </div>
                ) : jobs.length === 0 ? (
                  <EmptyState
                    icon={GraduationCap}
                    title="No training jobs yet"
                    description="Start a fine-tuning run and it will appear here."
                    actionLabel="Start Training"
                    actionHref="/dashboard/training/new"
                  />
                ) : (
                  <div className="space-y-4">
                    {jobs.slice(0, 5).map((job) => {
                      const StatusIcon = statusIcons[job.status] || Clock;
                      return (
                        <Link key={job.id} href={`/dashboard/training/${job.id}`}>
                          <div className="flex items-center justify-between rounded-lg border p-4 transition-colors hover:bg-muted">
                            <div className="flex items-center gap-4">
                              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15">
                                <GraduationCap className="h-5 w-5 text-primary-600" />
                              </div>
                              <div>
                                <p className="font-medium">{job.name}</p>
                                <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                                  <span>{job.baseModelId}</span>
                                  <span className={cn("rounded px-1.5 py-0.5 text-xs font-medium", methodColors[job.method])}>
                                    {job.method.toUpperCase()}
                                  </span>
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-4">
                              {job.status === "running" && (
                                <div className="text-right">
                                  <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
                                    <div
                                      className="h-full bg-primary-500 transition-all"
                                      style={{ width: `${job.progress}%` }}
                                    />
                                  </div>
                                  <p className="mt-1 text-xs text-muted-foreground">{job.progress}%</p>
                                </div>
                              )}
                              <Badge variant={statusColors[job.status]}>
                                <StatusIcon className="mr-1 h-3 w-3" />
                                {job.status}
                              </Badge>
                            </div>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Datasets sidebar */}
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
                {isLoading ? (
                  <div className="space-y-3" aria-busy="true">
                    {[1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between rounded-lg border p-3"
                      >
                        <div className="space-y-2">
                          <Skeleton className="h-4 w-28" />
                          <Skeleton className="h-3 w-16" />
                        </div>
                        <Skeleton className="h-5 w-14 rounded-full" />
                      </div>
                    ))}
                    <span className="sr-only">Loading datasets</span>
                  </div>
                ) : datasets.length === 0 ? (
                  <EmptyState
                    icon={Database}
                    title="No datasets yet"
                    description="Upload your first dataset to start training."
                    actionLabel="Upload Dataset"
                    actionHref="/dashboard/training/datasets"
                  />
                ) : (
                  <div className="space-y-3">
                    {datasets.slice(0, 5).map((dataset) => (
                      <div
                        key={dataset.id}
                        className="flex items-center justify-between rounded-lg border p-3"
                      >
                        <div>
                          <p className="font-medium text-sm">{dataset.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {dataset.rowCount.toLocaleString()} rows
                          </p>
                        </div>
                        <Badge variant={dataset.isValidated ? "success" : "secondary"}>
                          {dataset.isValidated ? "Valid" : "Pending"}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Quick tips */}
            <Card className="mt-6">
              <CardHeader>
                <CardTitle className="text-base">Training Tips</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-muted-foreground">
                <div className="flex gap-2">
                  <TrendingUp className="h-4 w-4 shrink-0 text-primary-500" />
                  <p>QLoRA uses 4-bit quantization for 70B+ models on consumer GPUs</p>
                </div>
                <div className="flex gap-2">
                  <TrendingUp className="h-4 w-4 shrink-0 text-primary-500" />
                  <p>Start with 3 epochs and adjust based on loss curves</p>
                </div>
                <div className="flex gap-2">
                  <TrendingUp className="h-4 w-4 shrink-0 text-primary-500" />
                  <p>100+ examples recommended for meaningful fine-tuning</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
