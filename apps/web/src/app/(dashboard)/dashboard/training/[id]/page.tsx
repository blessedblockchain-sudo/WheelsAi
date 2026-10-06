"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  GraduationCap,
  Play,
  Square,
  CheckCircle,
  XCircle,
  Clock,
  RefreshCw,
  Terminal,
  TrendingDown,
  Cpu,
  Database,
  Download,
  Copy,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { trainingApi, type TrainingJobDetail, getErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ui/confirm-dialog";

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

type Tab = "overview" | "logs" | "metrics";

/**
 * The API answers 404 when no job with this ID exists in the caller's org,
 * and 400 when the ID is not a UUID (e.g. a truncated or hand-edited link).
 * The job ID is the endpoint's only input, so a 400 can only mean a bad ID:
 * both cases mean there is no such job, and retrying can never succeed.
 */
function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const status = (error as { status?: unknown }).status;
  return status === 404 || status === 400;
}

export default function TrainingJobDetailPage() {
  const confirmAction = useConfirm();
  const params = useParams();
  const router = useRouter();
  const jobId = params.id as string;

  const [job, setJob] = useState<TrainingJobDetail | null>(null);
  const [logs, setLogs] = useState<string>("");
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [isCancelling, setIsCancelling] = useState(false);

  const logsRef = useRef<HTMLPreElement>(null);
  const pollInterval = useRef<NodeJS.Timeout | null>(null);

  const loadJob = useCallback(async () => {
    try {
      const { job } = await trainingApi.getJob(jobId);
      setJob(job);
      setLoadError(null);
      return job;
    } catch (error) {
      setLoadError(error);
      toast.error(getErrorMessage(error, "Failed to load training job"));
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [jobId]);

  const loadLogs = useCallback(async () => {
    try {
      const { logs } = await trainingApi.getJobLogs(jobId, 500);
      setLogs(logs);
    } catch (error) {
      // Ignore log loading errors
    }
  }, [jobId]);

  function handleRetry() {
    setLoadError(null);
    setIsLoading(true);
    void loadJob();
    void loadLogs();
  }

  useEffect(() => {
    loadJob();
    loadLogs();

    // Poll for updates while running
    pollInterval.current = setInterval(async () => {
      const updatedJob = await loadJob();
      if (updatedJob?.status === "running") {
        await loadLogs();
      } else if (["completed", "failed", "cancelled"].includes(updatedJob?.status || "")) {
        // Stop polling when done
        if (pollInterval.current) {
          clearInterval(pollInterval.current);
        }
      }
    }, 5000);

    return () => {
      if (pollInterval.current) {
        clearInterval(pollInterval.current);
      }
    };
  }, [loadJob, loadLogs]);

  // Auto-scroll logs
  useEffect(() => {
    if (logsRef.current && activeTab === "logs") {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logs, activeTab]);

  async function handleCancel() {
    if (!(await confirmAction({ title: "Cancel this training job?", destructive: true }))) {
      return;
    }

    setIsCancelling(true);
    try {
      await trainingApi.cancelJob(jobId);
      toast.success("Training job cancelled");
      loadJob();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to cancel training job"));
    } finally {
      setIsCancelling(false);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  }

  if (isLoading) {
    return (
      <div className="flex flex-col">
        <Header title="Loading..." />
        <div className="p-8" aria-busy="true">
          <span className="sr-only">Loading training job</span>

          {/* Status bar */}
          <Card className="mb-6">
            <CardContent className="py-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <Skeleton className="h-12 w-12 rounded-lg" />
                  <div className="space-y-2">
                    <Skeleton className="h-5 w-24 rounded-full" />
                    <Skeleton className="h-4 w-40" />
                  </div>
                </div>
                <Skeleton className="h-10 w-12" />
              </div>
            </CardContent>
          </Card>

          {/* Tabs */}
          <div className="mb-6 flex gap-2 border-b">
            {[1, 2, 3].map((i) => (
              <div key={i} className="px-4 py-2.5">
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </div>

          {/* Overview cards */}
          <div className="grid gap-6 md:grid-cols-2">
            {[1, 2, 3, 4].map((i) => (
              <SkeletonCard key={i} />
            ))}
            <div className="md:col-span-2">
              <SkeletonCard />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!job) {
    // A 404 (unknown job) or 400 (malformed job ID) means the job does not
    // exist; any other failure is a load error the user can retry.
    const notFound = !loadError || isNotFoundError(loadError);
    return (
      <div className="flex flex-col">
        <Header title={notFound ? "Job Not Found" : "Training Job"} />
        <div className="p-8">
          {notFound ? (
            <EmptyState
              icon={GraduationCap}
              title="Training job not found"
              description="Check the link, or go back to your training jobs."
              actionLabel="Back to Training"
              actionHref="/dashboard/training"
            />
          ) : (
            <ErrorState
              title="Couldn't load training job"
              error={loadError}
              onRetry={handleRetry}
              actionLabel="Back to Training"
              actionHref="/dashboard/training"
            />
          )}
        </div>
      </div>
    );
  }

  const StatusIcon = statusIcons[job.status] || Clock;
  const isRunning = job.status === "running";
  const isComplete = job.status === "completed";
  const isFailed = job.status === "failed";

  return (
    <div className="flex flex-col">
      <Header
        title={job.name}
        description={`${job.method.toUpperCase()} fine-tuning of ${job.baseModelId}`}
      />

      <div className="p-8">
        {/* Status bar */}
        <Card className="mb-6">
          <CardContent className="py-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/15">
                  <GraduationCap className="h-6 w-6 text-primary-600" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <Badge variant={statusColors[job.status]}>
                      <StatusIcon className="mr-1 h-3 w-3" />
                      {job.status}
                    </Badge>
                    <span className="text-sm text-muted-foreground">
                      {job.method.toUpperCase()} on {job.gpuTier}
                    </span>
                  </div>
                  {isRunning && (
                    <div className="mt-2 flex items-center gap-3">
                      <div className="h-2 w-48 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full bg-primary-500 transition-all duration-500"
                          style={{ width: `${job.progress}%` }}
                        />
                      </div>
                      <span className="text-sm font-medium">{job.progress}%</span>
                      {job.currentEpoch && job.totalEpochs && (
                        <span className="text-sm text-muted-foreground">
                          Epoch {job.currentEpoch}/{job.totalEpochs}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex gap-2">
                {isRunning && (
                  <Button
                    variant="destructive"
                    onClick={handleCancel}
                    isLoading={isCancelling}
                  >
                    <Square className="mr-2 h-4 w-4" />
                    Cancel
                  </Button>
                )}
                <Button variant="outline" onClick={loadJob}>
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Error banner */}
        {isFailed && job.lastError && (
          <Card className="mb-6 border-red-500/30 bg-red-500/10">
            <CardContent className="py-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-red-500" />
                <div>
                  <p className="font-medium text-red-500">Training Failed</p>
                  <p className="mt-1 text-sm text-red-500">{job.lastError}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Success banner */}
        {isComplete && job.outputPath && (
          <Card className="mb-6 border-green-500/30 bg-green-500/10">
            <CardContent className="py-4">
              <div className="flex items-center justify-between">
                <div className="flex items-start gap-3">
                  <CheckCircle className="h-5 w-5 text-green-500" />
                  <div>
                    <p className="font-medium text-green-500">Training Complete</p>
                    <p className="mt-1 text-sm text-green-500">
                      Adapter weights saved to: {job.outputPath}
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  onClick={() => copyToClipboard(job.outputPath!)}
                >
                  <Copy className="mr-2 h-4 w-4" />
                  Copy Path
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Tabs */}
        <div className="mb-6 flex gap-2 border-b">
          {(["overview", "logs", "metrics"] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "border-b-2 px-4 py-2 text-sm font-medium transition-colors",
                activeTab === tab
                  ? "border-primary-500 text-primary-600"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {activeTab === "overview" && (
          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Base Model</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10">
                    <Cpu className="h-5 w-5 text-blue-600" />
                  </div>
                  <div>
                    <p className="font-medium">{job.baseModelId}</p>
                    <p className="text-sm text-muted-foreground">{job.baseModelHfId}</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Dataset</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10">
                    <Database className="h-5 w-5 text-green-600" />
                  </div>
                  <div>
                    <p className="font-medium">{job.dataset.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {job.dataset.rowCount.toLocaleString()} rows
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Hyperparameters</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Method</dt>
                    <dd className="font-medium uppercase">{job.method}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Epochs</dt>
                    <dd className="font-medium">{job.config.epochs}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Batch Size</dt>
                    <dd className="font-medium">{job.config.batchSize}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Learning Rate</dt>
                    <dd className="font-medium">{job.config.learningRate}</dd>
                  </div>
                  {job.config.loraR && (
                    <>
                      <div>
                        <dt className="text-muted-foreground">LoRA Rank</dt>
                        <dd className="font-medium">{job.config.loraR}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">LoRA Alpha</dt>
                        <dd className="font-medium">{job.config.loraAlpha}</dd>
                      </div>
                    </>
                  )}
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Compute & Cost</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-muted-foreground">GPU Tier</dt>
                    <dd className="font-medium">{job.gpuTier}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">GPU Count</dt>
                    <dd className="font-medium">{job.gpuCount}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Estimated Cost</dt>
                    <dd className="font-medium">
                      {job.estimatedCostCents
                        ? `$${(job.estimatedCostCents / 100).toFixed(2)}`
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Actual Cost</dt>
                    <dd className="font-medium">
                      {job.actualCostCents
                        ? `$${(job.actualCostCents / 100).toFixed(2)}`
                        : "—"}
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>

            {(job.trainingLoss || job.evalLoss) && (
              <Card className="md:col-span-2">
                <CardHeader>
                  <CardTitle className="text-base">Training Progress</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex gap-8">
                    {job.trainingLoss && (
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-500/10">
                          <TrendingDown className="h-5 w-5 text-orange-600" />
                        </div>
                        <div>
                          <p className="text-sm text-muted-foreground">Training Loss</p>
                          <p className="text-xl font-bold">{job.trainingLoss.toFixed(4)}</p>
                        </div>
                      </div>
                    )}
                    {job.evalLoss && (
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-500/10">
                          <TrendingDown className="h-5 w-5 text-purple-600" />
                        </div>
                        <div>
                          <p className="text-sm text-muted-foreground">Eval Loss</p>
                          <p className="text-xl font-bold">{job.evalLoss.toFixed(4)}</p>
                        </div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            <Card className="md:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">Timeline</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Created</dt>
                    <dd className="font-medium">
                      {new Date(job.createdAt).toLocaleString()}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Started</dt>
                    <dd className="font-medium">
                      {job.startedAt
                        ? new Date(job.startedAt).toLocaleString()
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Completed</dt>
                    <dd className="font-medium">
                      {job.completedAt
                        ? new Date(job.completedAt).toLocaleString()
                        : "—"}
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          </div>
        )}

        {activeTab === "logs" && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">Training Logs</CardTitle>
              <Button variant="outline" size="sm" onClick={loadLogs}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Refresh
              </Button>
            </CardHeader>
            <CardContent>
              <pre
                ref={logsRef}
                className="h-[500px] overflow-auto rounded-lg bg-gray-900 p-4 text-sm text-gray-100"
              >
                {logs || "No logs available yet..."}
              </pre>
            </CardContent>
          </Card>
        )}

        {activeTab === "metrics" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Training Metrics</CardTitle>
              <CardDescription>Loss curves and performance metrics</CardDescription>
            </CardHeader>
            <CardContent>
              {job.metrics ? (
                <div className="space-y-4">
                  <pre className="overflow-auto rounded-lg bg-muted p-4 text-sm">
                    {JSON.stringify(job.metrics, null, 2)}
                  </pre>
                </div>
              ) : (
                <EmptyState
                  icon={TrendingDown}
                  title="No metrics yet"
                  description="Metrics will appear here once training starts."
                />
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
