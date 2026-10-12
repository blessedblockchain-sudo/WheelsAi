"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, RefreshCw, Rocket, RotateCw, Square } from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { NosanaRecord } from "@/components/dashboard/nosana-record";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import {
  trainingApi,
  formatDatasetRows,
  getErrorMessage,
  type TrainingBlocker,
  type TrainingJobDetail,
  type TrainingJobLogs,
} from "@/lib/api";
import { formatCents } from "@/lib/jobs";
import {
  canCancelTraining,
  canRetryTraining,
  deployUnavailableMessage,
  formatGpuRate,
  formatRunTime,
  insufficientCreditsSentence,
  isLegacyTrainingJob,
  isTerminalTrainingStatus,
  lossPolyline,
  trainingLedgerLabel,
  trainingRefusal,
  trainingSettlement,
  trainingStatusView,
  trainingTimeline,
  type TrainingRefusalView,
} from "@/lib/training";

import { TrainingStatusBadge } from "../_components/status-badge";
import { TrainingBlockers } from "../_components/training-blockers";

/** How often the job is read again while it is not over. */
const REFRESH_MS = 5_000;
const LOG_TAIL = 500;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium text-foreground">{children}</dd>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="grid gap-8 lg:grid-cols-3" aria-busy="true">
      <div className="space-y-6 lg:col-span-2">
        {[1, 2].map((i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-40" />
            </CardHeader>
            <CardContent className="space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </CardContent>
      </Card>
      <span className="sr-only">Loading training job</span>
    </div>
  );
}

/** The loss the trainer reported, joined into a line. Shown only when there are points to join. */
function LossChart({ series, label }: { series: Array<[number, number]> | undefined; label: string }) {
  const points = lossPolyline(series, 300, 80);
  if (!points || !series) return null;
  const first = series[0]!;
  const last = series[series.length - 1]!;
  return (
    <figure className="mt-4">
      <figcaption className="text-xs text-muted-foreground">
        {label}: {first[1].toFixed(4)} at step {first[0].toLocaleString()}, {last[1].toFixed(4)} at step{" "}
        {last[0].toLocaleString()}
      </figcaption>
      <svg
        viewBox="-2 -2 304 84"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label} by training step`}
        className="mt-2 h-24 w-full rounded-md bg-muted text-primary"
      >
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
    </figure>
  );
}

export default function TrainingJobPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const jobId = params.id;

  const [job, setJob] = useState<TrainingJobDetail | null>(null);
  const [blockers, setBlockers] = useState<TrainingBlocker[] | null>(null);
  // Why no fine-tuned model can be deployed right now; null while it can, and
  // while that is not known: the API decides then.
  const [deployUnavailable, setDeployUnavailable] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [logs, setLogs] = useState<TrainingJobLogs | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  // Why a cancel or a retry was refused, shown under the actions.
  const [actionRefusal, setActionRefusal] = useState<TrainingRefusalView | null>(null);

  const load = useCallback(async () => {
    try {
      const { job } = await trainingApi.getJob(jobId);
      setJob(job);
      setLoadError(null);
    } catch (error) {
      setJob((current) => {
        if (current === null) setLoadError(error);
        return current;
      });
    }
  }, [jobId]);

  const loadLogs = useCallback(async () => {
    setIsLoadingLogs(true);
    try {
      setLogs(await trainingApi.getJobLogs(jobId, LOG_TAIL));
      setLogsError(null);
    } catch (error) {
      setLogsError(getErrorMessage(error, "The logs could not be read."));
    } finally {
      setIsLoadingLogs(false);
    }
  }, [jobId]);

  useEffect(() => {
    void load();
    void loadLogs();
    // Retry is offered only where a new job can start; a failed read leaves it enabled
    // and the API decides.
    trainingApi.getCapabilities().then(
      (capabilities) => {
        setBlockers(capabilities.blockers);
        setDeployUnavailable(deployUnavailableMessage(capabilities));
      },
      () => {
        setBlockers([]);
        setDeployUnavailable(null);
      },
    );
  }, [load, loadLogs]);

  const isOver = job ? isTerminalTrainingStatus(job.status) : false;
  const shouldPoll = job !== null && !isOver;
  useEffect(() => {
    if (!shouldPoll) return;
    const id = setInterval(() => {
      void load();
      void loadLogs();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [shouldPoll, load, loadLogs]);

  async function handleCancel() {
    setActionRefusal(null);
    try {
      const result = await trainingApi.cancelJob(jobId);
      toast.success(result.message);
    } catch (error) {
      const view = trainingRefusal(error);
      if (!view || !view.message) throw error;
      // 409 training_job_not_cancellable: the job moved on while the dialog was open.
      setActionRefusal(view);
    }
    await load();
  }

  async function handleRetry() {
    setActionRefusal(null);
    try {
      const { job: created } = await trainingApi.retryJob(jobId);
      toast.success("A new job was created with the same configuration.");
      router.push(`/dashboard/training/${created.id}`);
    } catch (error) {
      const view = trainingRefusal(error);
      if (!view || !view.message) throw error;
      setActionRefusal(view);
    }
  }

  if (loadError) {
    return (
      <div className="flex flex-col">
        <Header title="Training job" />
        <div className="p-8">
          <ErrorState
            title="Couldn't load this training job"
            error={loadError}
            onRetry={() => {
              setLoadError(null);
              void load();
            }}
            actionLabel="Back to fine-tuning"
            actionHref="/dashboard/training"
          />
        </div>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="flex flex-col">
        <Header title="Training job" />
        <div className="p-8">
          <PageSkeleton />
        </div>
      </div>
    );
  }

  const status = trainingStatusView(job.status);
  const settlement = trainingSettlement(job);
  const timeline = trainingTimeline(job);
  const retryBlocked = blockers !== null && blockers.length > 0;
  const hyperparams = Object.entries(job.hyperparams ?? {});

  return (
    <div className="flex flex-col">
      <Header title={job.name} description={`${job.baseModelId} · ${job.method.toUpperCase()} · ${job.gpuTier}`} />

      <div className="space-y-6 p-8">
        <Link
          href="/dashboard/training"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to fine-tuning
        </Link>

        {/* State and actions */}
        <Card>
          <CardContent className="flex flex-wrap items-start justify-between gap-4 py-5">
            <div className="min-w-0">
              <div className="flex items-center gap-3" data-testid="training-status" data-status={job.status}>
                <TrainingStatusBadge status={job.status} />
                {job.partial && <span className="text-sm text-muted-foreground">Stopped at the run limit; the adapter is partial.</span>}
              </div>
              {isLegacyTrainingJob(job) ? (
                <p className="mt-2 max-w-2xl text-sm text-muted-foreground" data-testid="training-legacy">
                  This job was recorded before training jobs held credits and stored their adapter. It has
                  no hold, charge or fine-tuned model on record.
                </p>
              ) : (
                status.description &&
                job.status !== "failed" && (
                  <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{status.description}</p>
                )
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {canCancelTraining(job.status) && (
                <ConfirmDialog
                  title="Cancel this training job?"
                  description={
                    job.status === "running"
                      ? "The run is stopped and no adapter is kept. You are charged for the time it ran up to now, and the rest of the hold is returned."
                      : "Nothing has run on a GPU yet, so nothing is charged and the whole hold is returned."
                  }
                  confirmLabel="Cancel job"
                  cancelLabel="Keep running"
                  destructive
                  onConfirm={handleCancel}
                >
                  <Button variant="outline">
                    <Square className="mr-2 h-4 w-4" />
                    Cancel job
                  </Button>
                </ConfirmDialog>
              )}
              {canRetryTraining(job.status) &&
                (retryBlocked ? (
                  <Button variant="outline" disabled data-testid="retry-training">
                    <RotateCw className="mr-2 h-4 w-4" />
                    Retry
                  </Button>
                ) : (
                  <ConfirmDialog
                    title="Retry with the same configuration?"
                    description={
                      job.reservationCents !== null
                        ? `This creates a new job and holds credits for it again (this one held ${formatCents(job.reservationCents)}). This job stays as it is.`
                        : "This creates a new job and holds credits for it. This job stays as it is."
                    }
                    confirmLabel="Create new job"
                    onConfirm={handleRetry}
                  >
                    <Button variant="outline" data-testid="retry-training">
                      <RotateCw className="mr-2 h-4 w-4" />
                      Retry
                    </Button>
                  </ConfirmDialog>
                ))}
            </div>
          </CardContent>
        </Card>

        {canRetryTraining(job.status) && retryBlocked && blockers && (
          <TrainingBlockers blockers={blockers} title="Retry is not available right now" />
        )}

        {actionRefusal && (
          <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm">
            <p className="font-medium text-foreground">
              {actionRefusal.code === "insufficient_credits"
                ? insufficientCreditsSentence(actionRefusal)
                : actionRefusal.message}
            </p>
            {actionRefusal.code === "insufficient_credits" && (
              <Link
                href="/dashboard/billing"
                className="mt-2 inline-flex font-medium text-primary underline-offset-4 hover:underline"
              >
                Add credits
              </Link>
            )}
          </div>
        )}

        {/* Failure, in plain words, with whether it was charged */}
        {job.failure && (
          <div
            role="status"
            data-testid="training-failure"
            className="rounded-lg border border-danger/30 bg-danger/10 p-4"
          >
            <p className="text-sm font-medium text-foreground">{job.failure.message}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {job.failure.charged
                ? `You were charged ${formatCents(job.actualCostCents ?? 0)} for the time the run was on the GPU. The rest of the hold was returned.`
                : job.settledAt
                  ? "You were not charged. The whole hold was returned."
                  : "The job is being settled."}
            </p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">{job.failure.code}</p>
          </div>
        )}

        {/* The model, once there is one */}
        {job.fineTunedModel && (
          <Card data-testid="training-model">
            <CardContent className="flex flex-wrap items-center justify-between gap-4 py-5">
              <div>
                <p className="text-sm text-muted-foreground">Fine-tuned model</p>
                <Link
                  href={`/dashboard/training/models/${job.fineTunedModel.id}`}
                  className="text-lg font-semibold text-foreground underline-offset-4 hover:underline"
                >
                  {job.fineTunedModel.name}
                </Link>
                <p className="font-mono text-xs text-muted-foreground">{job.fineTunedModel.slug}</p>
              </div>
              {deployUnavailable ? (
                <div className="max-w-xs text-right">
                  <Button disabled aria-describedby="training-deploy-unavailable" data-testid="training-deploy">
                    <Rocket className="mr-2 h-4 w-4" />
                    Deploy
                  </Button>
                  <p
                    id="training-deploy-unavailable"
                    className="mt-2 text-xs text-muted-foreground"
                    data-testid="training-deploy-unavailable"
                  >
                    {deployUnavailable}
                  </p>
                </div>
              ) : (
                <Link href={`/dashboard/deployments/new?fineTunedModel=${job.fineTunedModel.id}`}>
                  <Button data-testid="training-deploy">
                    <Rocket className="mr-2 h-4 w-4" />
                    Deploy
                  </Button>
                </Link>
              )}
            </CardContent>
          </Card>
        )}

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            {/* Progress */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Progress</CardTitle>
                <CardDescription>As reported by the training run.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {job.currentStep !== null && job.totalSteps !== null
                      ? `Step ${job.currentStep.toLocaleString()} of ${job.totalSteps.toLocaleString()}`
                      : isOver
                        ? "No step was recorded"
                        : job.startedAt
                          ? "No step reported yet"
                          : "Not started"}
                    {job.currentEpoch !== null && job.totalEpochs !== null
                      ? `, epoch ${job.currentEpoch} of ${job.totalEpochs}`
                      : ""}
                  </span>
                  <span className="font-mono font-medium tabular-nums">{Math.round(job.progress)}%</span>
                </div>
                <div
                  className="mt-2 h-2 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(job.progress)}
                  aria-label="Training progress"
                >
                  <div className="h-full bg-primary transition-all" style={{ width: `${Math.min(100, Math.max(0, job.progress))}%` }} />
                </div>

                <dl className="mt-4 grid gap-x-8 text-sm sm:grid-cols-2">
                  <Row label="Training loss">
                    {job.trainingLoss !== null ? job.trainingLoss.toFixed(4) : "Not reported"}
                  </Row>
                  <Row label="Evaluation loss">
                    {job.evalLoss !== null ? job.evalLoss.toFixed(4) : "Not reported"}
                  </Row>
                  {job.metrics.phase && <Row label="Phase">{job.metrics.phase}</Row>}
                  {job.metrics.started?.gpu && (
                    <Row label="GPU">
                      {job.metrics.started.gpu}
                      {job.metrics.started.vramGb !== null ? `, ${job.metrics.started.vramGb} GB` : ""}
                    </Row>
                  )}
                  {!isOver && job.metrics.step?.tokensPerSecond != null && (
                    <Row label="Tokens per second">
                      {Math.round(job.metrics.step.tokensPerSecond).toLocaleString()}
                    </Row>
                  )}
                  {!isOver && job.metrics.step && job.metrics.step.etaSeconds > 0 && (
                    <Row label="Time left (trainer's estimate)">{formatRunTime(job.metrics.step.etaSeconds)}</Row>
                  )}
                </dl>

                <LossChart series={job.metrics.trainLoss} label="Training loss" />
                <LossChart series={job.metrics.evalLoss} label="Evaluation loss" />
              </CardContent>
            </Card>

            {/* Logs */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-4">
                <div>
                  <CardTitle className="text-base">Logs</CardTitle>
                  <CardDescription>
                    {logs === null
                      ? "The run's own output."
                      : logs.source === "none"
                        ? "No log line has been received."
                        : `${logs.source === "callbacks" ? "Sent by the run as it went" : "Read back from the GPU network after the run"}. Showing the last ${Math.min(logs.totalLines, LOG_TAIL).toLocaleString()} of ${logs.totalLines.toLocaleString()} lines.`}
                  </CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={() => void loadLogs()} isLoading={isLoadingLogs}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Refresh
                </Button>
              </CardHeader>
              <CardContent>
                {logsError ? (
                  <p role="alert" className="text-sm text-danger">
                    {logsError}
                  </p>
                ) : logs === null ? (
                  <Skeleton className="h-32 w-full" />
                ) : logs.logs ? (
                  <pre
                    data-testid="training-logs"
                    className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 font-mono text-xs text-foreground"
                  >
                    {logs.logs}
                  </pre>
                ) : (
                  <p className="text-sm text-muted-foreground" data-testid="training-logs-empty">
                    {isOver
                      ? "This job ended without any log line reaching the platform."
                      : "Log lines appear here once the run starts on a GPU."}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            {/* Money */}
            <Card data-testid="training-money">
              <CardHeader>
                <CardTitle className="text-base">Cost</CardTitle>
                <CardDescription>
                  {settlement
                    ? settlement.chargeCents > 0
                      ? "Settled. The hold was returned and the time on the GPU charged."
                      : "Settled. The whole hold was returned and nothing was charged."
                    : job.reservationCents !== null
                      ? "Credits are held until the job ends."
                      : "This job held no credits."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="divide-y divide-border text-sm">
                  {job.reservationCents !== null && (
                    <Row label={settlement ? "Held" : "Held now"}>
                      <span className="font-mono tabular-nums">{formatCents(job.reservationCents)}</span>
                    </Row>
                  )}
                  {job.costSoFarCents !== null && !settlement && (
                    <Row label="Cost so far">
                      <span className="font-mono tabular-nums">{formatCents(job.costSoFarCents)}</span>
                    </Row>
                  )}
                  {settlement && (
                    <>
                      <Row label="Charged">
                        <span className="font-mono tabular-nums" data-testid="training-charge">
                          {formatCents(settlement.chargeCents)}
                        </span>
                      </Row>
                      <Row label="Returned">
                        <span className="font-mono tabular-nums" data-testid="training-returned">
                          {formatCents(settlement.returnedCents)}
                        </span>
                      </Row>
                    </>
                  )}
                  {job.billedSeconds !== null && (
                    <Row label="Time billed">{formatRunTime(job.billedSeconds)}</Row>
                  )}
                  {job.pricePerSecondUsd !== null && (
                    <Row label="Price">{formatGpuRate(job.pricePerSecondUsd)}</Row>
                  )}
                  {job.maxRuntimeSeconds !== null && (
                    <Row label="Run limit">{formatRunTime(job.maxRuntimeSeconds)}</Row>
                  )}
                </dl>

                <NosanaRecord nosana={job.nosana} className="mt-4" />

                {job.ledger.length > 0 && (
                  <div className="mt-4" data-testid="training-ledger">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Ledger entries
                    </p>
                    <ul className="mt-2 space-y-2 text-sm">
                      {job.ledger.map((entry) => (
                        <li key={entry.id} className="rounded-md border border-border p-2">
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-foreground">{trainingLedgerLabel(entry.type)}</span>
                            <span className="font-mono tabular-nums text-foreground">
                              {entry.amountCents > 0 ? "+" : entry.amountCents < 0 ? "-" : ""}
                              {formatCents(Math.abs(entry.amountCents))}
                            </span>
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {formatTime(entry.createdAt)} · balance after {formatCents(entry.balanceAfterCents)}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Times */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Timeline</CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="space-y-3 text-sm" data-testid="training-timeline">
                  {timeline.map((entry) => (
                    <li key={entry.key} className="flex items-start justify-between gap-4">
                      <span className="text-foreground">{entry.label}</span>
                      <time dateTime={entry.at} className="shrink-0 text-right text-xs text-muted-foreground">
                        {formatTime(entry.at)}
                      </time>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>

            {/* Configuration */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Configuration</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="divide-y divide-border text-sm">
                  <Row label="Base model">
                    <span className="break-all">{job.baseModelHfId}</span>
                  </Row>
                  <Row label="Method">{job.method.toUpperCase()}</Row>
                  <Row label="GPU tier">{job.gpuTier}</Row>
                  <Row label="Dataset">
                    {job.dataset
                      ? `${job.dataset.name}${job.dataset.deleted ? " (deleted)" : ""}, ${formatDatasetRows(job.dataset.rowCount)}`
                      : "No longer available"}
                  </Row>
                  {job.datasetSha256 && (
                    <Row label="Dataset fingerprint">
                      <span className="font-mono text-xs" title={job.datasetSha256}>
                        {job.datasetSha256.slice(0, 12)}
                      </span>
                    </Row>
                  )}
                  <Row label="Hyperparameters">
                    {hyperparams.length === 0
                      ? job.hyperparams === null
                        ? "Not recorded"
                        : "The trainer's defaults"
                      : hyperparams.map(([key, value]) => (
                          <span key={key} className="block font-mono text-xs">
                            {key} {Array.isArray(value) ? value.join(",") : String(value)}
                          </span>
                        ))}
                  </Row>
                </dl>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
