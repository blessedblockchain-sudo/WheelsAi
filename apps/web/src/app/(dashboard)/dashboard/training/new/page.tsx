"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Database, Lock } from "lucide-react";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import {
  billingApi,
  trainingApi,
  formatDatasetRows,
  getErrorMessage,
  type Dataset,
  type TrainableModel,
  type TrainingCapabilities,
  type TrainingEstimateResponse,
  type TrainingMethod,
} from "@/lib/api";
import { formatCents } from "@/lib/jobs";
import {
  HYPERPARAM_FIELDS,
  TRAINING_METHOD_LABELS,
  datasetTrainingBlocker,
  formatGpuRate,
  formatHourlyRate,
  formatParameters,
  formatRunTime,
  hyperparamFormDefaults,
  hyperparamFormErrors,
  hyperparamsToSend,
  insufficientCreditsSentence,
  methodBlocker,
  methodOf,
  runLimitError,
  runLimitMinuteBounds,
  tierChoices,
  trainingRefusal,
  type TrainingRefusalView,
} from "@/lib/training";
import { cn } from "@/lib/utils";

import { TrainingBlockers } from "../_components/training-blockers";

interface PageData {
  capabilities: TrainingCapabilities;
  models: TrainableModel[];
  datasets: Dataset[];
  /** null when the balance could not be read; the page then says so. */
  balanceCents: number | null;
}

type Step = "configure" | "review";

function FormSkeleton() {
  return (
    <div className="mx-auto max-w-3xl space-y-6" aria-busy="true">
      {[1, 2, 3].map((i) => (
        <Card key={i}>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-72 max-w-full" />
          </CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      ))}
      <span className="sr-only">Loading fine-tuning options</span>
    </div>
  );
}

export default function NewTrainingJobPage() {
  return (
    <div className="flex flex-col">
      <Header title="New training job" description="Fine-tune a base model on one of your datasets" />
      <div className="p-8">
        <Suspense fallback={<FormSkeleton />}>
          <NewTrainingJobForm />
        </Suspense>
      </div>
    </div>
  );
}

function choiceClass(selected: boolean, disabled: boolean) {
  return cn(
    "w-full rounded-lg border-2 p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    selected ? "border-primary bg-primary/10" : "border-border",
    disabled ? "cursor-not-allowed opacity-60" : !selected && "hover:border-muted-foreground/40",
  );
}

function NewTrainingJobForm() {
  const router = useRouter();
  const requestedDatasetId = useSearchParams().get("dataset");

  const [data, setData] = useState<PageData | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  const [step, setStep] = useState<Step>("configure");
  const [name, setName] = useState("");
  const [datasetId, setDatasetId] = useState("");
  const [modelId, setModelId] = useState("");
  const [method, setMethod] = useState<TrainingMethod | "">("");
  const [gpuTier, setGpuTier] = useState("");
  const [hyperForm, setHyperForm] = useState<Record<string, string>>({});
  const [runLimitMinutes, setRunLimitMinutes] = useState("");

  const [estimate, setEstimate] = useState<TrainingEstimateResponse | null>(null);
  const [isEstimating, setIsEstimating] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  // The API's refusal of the estimate or of the create, shown where it happened.
  const [refusal, setRefusal] = useState<TrainingRefusalView | null>(null);
  const [otherError, setOtherError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [capabilities, modelsRes, datasetsRes, balance] = await Promise.all([
        trainingApi.getCapabilities(),
        trainingApi.listTrainableModels(),
        trainingApi.listDatasets(),
        // The balance is shown in the review; the job can be planned without it.
        billingApi.getBalance().then(
          (res) => Math.round(res.balance.available * 100),
          () => null,
        ),
      ]);
      setData({ capabilities, models: modelsRes.models, datasets: datasetsRes.datasets, balanceCents: balance });
      setHyperForm(hyperparamFormDefaults(capabilities.hyperparameters));
      // ?dataset= preselects a dataset of this organization; one that cannot
      // be trained on stays selected so its reason is shown.
      if (requestedDatasetId && datasetsRes.datasets.some((d) => d.id === requestedDatasetId)) {
        setDatasetId(requestedDatasetId);
      }
    } catch (error) {
      setLoadError(error);
    }
  }, [requestedDatasetId]);

  useEffect(() => {
    void load();
  }, [load]);

  const model = data?.models.find((m) => m.id === modelId) ?? null;
  const methodEntry = model && method ? methodOf(model, method) : undefined;
  const tiers = useMemo(
    () => (data ? tierChoices(data.capabilities, methodEntry) : []),
    [data, methodEntry],
  );
  const dataset = data?.datasets.find((d) => d.id === datasetId) ?? null;
  const datasetBlocker = dataset ? datasetTrainingBlocker(dataset) : null;
  // No tokens per row were measured (a Parquet file): no time can be
  // estimated or limit suggested, so the run limit is the user's to choose.
  const needsRunLimit = dataset !== null && dataset.avgTokensPerRow === null;

  function chooseModel(next: TrainableModel) {
    if (!next.available) return;
    setModelId(next.id);
    // The first method of this model that fits a tier here, and its cheapest tier.
    const usable = next.methods.find((entry) => entry.tiers.length > 0);
    setMethod(usable?.method ?? "");
    setGpuTier(usable?.recommendedTier ?? usable?.tiers[0]?.tier ?? "");
    if (!name) setName(`${next.id}-finetune`);
  }

  function chooseMethod(next: TrainingMethod) {
    if (!model) return;
    const entry = methodOf(model, next);
    if (!entry || entry.tiers.length === 0) return;
    setMethod(next);
    // Keep the tier when the new method still fits on it.
    if (!entry.tiers.some((tier) => tier.tier === gpuTier)) {
      setGpuTier(entry.recommendedTier ?? entry.tiers[0]!.tier);
    }
  }

  if (loadError) {
    return <ErrorState title="Couldn't load fine-tuning options" error={loadError} onRetry={load} />;
  }
  if (!data) return <FormSkeleton />;

  const { capabilities } = data;
  const hyperErrors = hyperparamFormErrors(hyperForm, capabilities.hyperparameters);
  const runLimitProblem =
    runLimitMinutes.trim() === "" ? null : runLimitError(runLimitMinutes, capabilities.runLimit);
  const minuteBounds = runLimitMinuteBounds(capabilities.runLimit);
  const nameProblem = name.trim().length === 0 || name.trim().length > 100;

  // What is still missing before the review, in words, so a disabled button is never a riddle.
  const missing: string[] = [];
  if (nameProblem) missing.push("a name of 1 to 100 characters");
  if (!dataset) missing.push("a dataset");
  else if (datasetBlocker) missing.push("a dataset that can be trained on");
  if (!model) missing.push("a base model");
  if (model && !method) missing.push("a method");
  if (model && method && !gpuTier) missing.push("a GPU tier");
  if (Object.keys(hyperErrors).length > 0) missing.push("hyperparameters inside their bounds");
  if (runLimitProblem) missing.push("a run limit inside its bounds");
  else if (needsRunLimit && runLimitMinutes.trim() === "") {
    missing.push("a run limit (this dataset's training time cannot be estimated)");
  }
  const canReview = missing.length === 0;

  function jobChoice() {
    return {
      baseModelId: modelId,
      datasetId,
      method: method as TrainingMethod,
      gpuTier,
      hyperparams: hyperparamsToSend(hyperForm, capabilities.hyperparameters),
      ...(runLimitMinutes.trim() !== "" ? { maxRuntimeSeconds: Number(runLimitMinutes) * 60 } : {}),
    };
  }

  function showFailure(error: unknown, fallback: string) {
    const view = trainingRefusal(error);
    if (view && view.message) {
      setRefusal(view);
      setOtherError(null);
    } else {
      setRefusal(null);
      setOtherError(getErrorMessage(error, fallback));
    }
  }

  async function handleReview() {
    if (!canReview) return;
    setIsEstimating(true);
    setRefusal(null);
    setOtherError(null);
    try {
      const result = await trainingApi.estimate(jobChoice());
      setEstimate(result);
      setStep("review");
    } catch (error) {
      setEstimate(null);
      showFailure(error, "The estimate could not be worked out.");
    } finally {
      setIsEstimating(false);
    }
  }

  async function handleStart() {
    if (!estimate || !capabilities.canStart) return;
    const held = estimate.hold;
    setIsStarting(true);
    setRefusal(null);
    setOtherError(null);
    try {
      const { job } = await trainingApi.createJob({
        name: name.trim(),
        ...jobChoice(),
        // The limit that was reviewed is the limit that is held for.
        maxRuntimeSeconds: held.maxRuntimeSeconds,
      });
      router.push(`/dashboard/training/${job.id}`);
    } catch (error) {
      showFailure(error, "The training job could not be created.");
      setIsStarting(false);
    }
  }

  const refusalPanel = (refusal || otherError) && (
    <div
      role="alert"
      data-testid="training-refusal"
      data-code={refusal?.code}
      className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm"
    >
      {refusal?.code === "insufficient_credits" ? (
        <>
          <p className="font-medium text-foreground">Not enough credits to hold for this run</p>
          <p className="mt-1 text-muted-foreground">{insufficientCreditsSentence(refusal)}</p>
          <p className="mt-1 text-muted-foreground">Nothing was created and nothing was held.</p>
          <Link
            href="/dashboard/billing"
            className="mt-3 inline-flex text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            Add credits
          </Link>
        </>
      ) : (
        <>
          <p className="font-medium text-foreground">{refusal?.message ?? otherError}</p>
          <p className="mt-1 text-muted-foreground">Nothing was created and nothing was held.</p>
        </>
      )}
    </div>
  );

  // ============================================
  // Review
  // ============================================

  if (step === "review" && estimate && model && dataset) {
    // e is null for a dataset whose training time cannot be estimated; the
    // hold is always known.
    const e = estimate.estimate;
    const hold = estimate.hold;
    const tier = tiers.find((t) => t.tier === hold.gpuTier);
    const sent = hyperparamsToSend(hyperForm, capabilities.hyperparameters);
    const short =
      data.balanceCents !== null && data.balanceCents < hold.cents ? hold.cents - data.balanceCents : null;
    const rows: Array<[string, React.ReactNode]> = [
      ["Name", name.trim()],
      ["Base model", `${model.displayName} (${model.hfId})`],
      ["Method", TRAINING_METHOD_LABELS[method as TrainingMethod]?.name ?? method],
      ["Dataset", `${dataset.name}, ${formatDatasetRows(estimate.dataset.rowCount)}`],
      ["GPU tier", tier ? `${tier.name}, ${tier.vramGb} GB` : hold.gpuTier],
      [
        "Hyperparameters",
        Object.keys(sent).length === 0
          ? "The trainer's defaults"
          : Object.entries(sent)
              .map(([key, value]) => `${key} ${String(value)}`)
              .join(", "),
      ],
    ];
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <Button variant="ghost" onClick={() => setStep("configure")}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to configuration
        </Button>

        <TrainingBlockers blockers={capabilities.blockers} />

        <Card>
          <CardHeader>
            <CardTitle>Review</CardTitle>
            <CardDescription>What will run, what it is expected to cost, and what is held.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <dl className="divide-y divide-border rounded-lg border border-border text-sm">
              {rows.map(([label, value]) => (
                <div key={label} className="flex items-start justify-between gap-6 p-3">
                  <dt className="shrink-0 text-muted-foreground">{label}</dt>
                  <dd className="text-right font-medium text-foreground">{value}</dd>
                </div>
              ))}
            </dl>

            <div data-testid="training-estimate">
              <h3 className="text-sm font-semibold text-foreground">{e ? "Estimate" : "Cost"}</h3>
              {e ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  A planning figure worked out from the dataset&apos;s size and the model, not a
                  measurement of this run. The charge is for the seconds the run actually takes.
                </p>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground" data-testid="training-no-estimate">
                  This dataset&apos;s training time cannot be estimated: no tokens per row were measured
                  when it was validated (as for a Parquet file). The run is held for the run limit you
                  chose and charged for the seconds it actually takes.
                </p>
              )}
              <dl className="mt-3 divide-y divide-border rounded-lg border border-border text-sm">
                {e && (
                  <div className="flex items-start justify-between gap-6 p-3">
                    <dt className="text-muted-foreground">Expected cost</dt>
                    <dd className="text-right">
                      <span className="font-mono font-semibold tabular-nums text-foreground">
                        {formatCents(e.estimate.cents)}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        range {formatCents(e.low.cents)} to {formatCents(e.high.cents)}
                      </span>
                    </dd>
                  </div>
                )}
                {e && (
                  <div className="flex items-start justify-between gap-6 p-3">
                    <dt className="text-muted-foreground">Expected time on the GPU</dt>
                    <dd className="text-right">
                      <span className="font-medium text-foreground">{formatRunTime(e.estimate.seconds)}</span>
                      <span className="block text-xs text-muted-foreground">
                        range {formatRunTime(e.low.seconds)} to {formatRunTime(e.high.seconds)}
                      </span>
                    </dd>
                  </div>
                )}
                <div className="flex items-start justify-between gap-6 p-3">
                  <dt className="text-muted-foreground">Price</dt>
                  <dd className="text-right font-medium text-foreground">{formatGpuRate(hold.pricePerSecondUsd)}</dd>
                </div>
                <div className="flex items-start justify-between gap-6 p-3">
                  <dt className="text-muted-foreground">Run limit</dt>
                  <dd className="text-right">
                    <span className="font-medium text-foreground">{formatRunTime(hold.maxRuntimeSeconds)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {!e
                        ? "the limit you chose"
                        : runLimitMinutes.trim() === ""
                          ? "the suggested limit for this estimate"
                          : `suggested: ${formatRunTime(e.runLimit.suggestedSeconds)}`}
                    </span>
                  </dd>
                </div>
                <div className="flex items-start justify-between gap-6 p-3">
                  <dt className="text-muted-foreground">
                    Held when the job is created
                    <span className="block text-xs">the most this job can cost</span>
                  </dt>
                  <dd
                    className="text-right font-mono font-semibold tabular-nums text-foreground"
                    data-testid="training-maximum"
                  >
                    {formatCents(hold.cents)}
                  </dd>
                </div>
                <div className="flex items-start justify-between gap-6 p-3">
                  <dt className="text-muted-foreground">Your balance</dt>
                  <dd className="text-right font-mono tabular-nums text-foreground" data-testid="training-balance">
                    {data.balanceCents === null ? "Could not be read" : formatCents(data.balanceCents)}
                  </dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">
                The hold is the price per second times the run limit. When the job ends the whole hold
                is returned and the seconds it ran are charged, never more than the hold. Time waiting
                for a GPU node is free, and a job that fails for a reason that is not your data is not
                charged.
              </p>
              {e && !e.fitsRunLimit && (
                <p className="mt-3 rounded-md border border-border bg-muted p-3 text-sm text-foreground">
                  The expected time is longer than this run limit. The trainer stops at the limit and
                  keeps a partial adapter, which is charged for the time it ran. Raise the run limit, or
                  lower the epochs, to finish the run.
                </p>
              )}
              {e?.suggestionCapped && (
                <p className="mt-3 rounded-md border border-border bg-muted p-3 text-sm text-foreground">
                  The suggested run limit was cut to the longest this server allows (
                  {formatRunTime(e.runLimit.maxSeconds)}).
                </p>
              )}
            </div>

            {short !== null && !refusal && (
              <div className="rounded-lg border border-border bg-muted p-4 text-sm" data-testid="training-short">
                <p className="font-medium text-foreground">
                  Your balance is {formatCents(short)} short of the amount this run holds.
                </p>
                <Link
                  href="/dashboard/billing"
                  className="mt-2 inline-flex font-medium text-primary underline-offset-4 hover:underline"
                >
                  Add credits
                </Link>
              </div>
            )}

            {refusalPanel}

            <div className="flex justify-end gap-3">
              <Button variant="outline" onClick={() => setStep("configure")} disabled={isStarting}>
                Back
              </Button>
              <Button
                onClick={handleStart}
                isLoading={isStarting}
                disabled={!capabilities.canStart}
                data-testid="start-training"
              >
                Hold {formatCents(hold.cents)} and start
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ============================================
  // Configure
  // ============================================

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link
        href="/dashboard/training"
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to fine-tuning
      </Link>

      <TrainingBlockers blockers={capabilities.blockers} />

      {/* Name and dataset */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Job and dataset</CardTitle>
          <CardDescription>The job is pinned to the dataset as it was validated.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label htmlFor="job-name" className="block text-sm font-medium text-foreground">
              Name
            </label>
            <Input
              id="job-name"
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              placeholder="support-assistant-v1"
              className="mt-1"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Also names the fine-tuned model the job produces.
            </p>
          </div>

          <div>
            <label htmlFor="job-dataset" className="block text-sm font-medium text-foreground">
              Dataset
            </label>
            {data.datasets.length === 0 ? (
              <div className="mt-2">
                <EmptyState
                  icon={Database}
                  title="No datasets yet"
                  description="Upload and validate a dataset before starting a training job."
                  actionLabel="Go to datasets"
                  actionHref="/dashboard/training/datasets"
                />
              </div>
            ) : (
              <>
                <Select
                  id="job-dataset"
                  value={datasetId}
                  onChange={(event) => setDatasetId(event.target.value)}
                  className="mt-1"
                >
                  <option value="">Choose a dataset</option>
                  {data.datasets.map((d) => {
                    const blocker = datasetTrainingBlocker(d);
                    return (
                      <option key={d.id} value={d.id}>
                        {d.name} ({formatDatasetRows(d.rowCount)}){blocker ? " - cannot be used yet" : ""}
                      </option>
                    );
                  })}
                </Select>
                {dataset && datasetBlocker && (
                  <p role="alert" className="mt-2 text-sm text-danger" data-testid="dataset-blocker">
                    This dataset cannot be trained on yet. {datasetBlocker}{" "}
                    <Link href="/dashboard/training/datasets" className="underline underline-offset-4">
                      Open datasets
                    </Link>
                  </p>
                )}
                {dataset && !datasetBlocker && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {dataset.fileType}
                    {dataset.schemaFormat ? `, ${dataset.schemaFormat} rows` : ""}
                    {dataset.avgTokensPerRow !== null
                      ? `, about ${Math.round(dataset.avgTokensPerRow).toLocaleString()} tokens per row`
                      : ""}
                  </p>
                )}
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Base model */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Base model</CardTitle>
          <CardDescription>
            The models this server can fine-tune. Memory figures are planning figures.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.models.length === 0 ? (
            <p className="text-sm text-muted-foreground">This server offers no base model to fine-tune.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Base model">
              {data.models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={modelId === m.id}
                  aria-disabled={!m.available}
                  disabled={!m.available}
                  data-model={m.id}
                  onClick={() => chooseModel(m)}
                  className={choiceClass(modelId === m.id, !m.available)}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{m.displayName}</span>
                    {formatParameters(m.parameters) && (
                      <Badge variant="secondary">{formatParameters(m.parameters)}</Badge>
                    )}
                    {m.gated && (
                      <Badge variant="outline">
                        <Lock className="mr-1 h-3 w-3" aria-hidden="true" />
                        Gated
                      </Badge>
                    )}
                  </span>
                  <span className="mt-1 block font-mono text-xs text-muted-foreground">{m.hfId}</span>
                  <span className="mt-2 block text-xs text-muted-foreground">
                    {m.available
                      ? m.methods
                          .map((entry) => `${TRAINING_METHOD_LABELS[entry.method]?.name ?? entry.method} from ${entry.requiredVramGb} GB`)
                          .join(" · ")
                      : `Not available: ${m.unavailableMessage ?? "it cannot be fine-tuned on this server."}`}
                  </span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Method and tier */}
      {model && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Method and GPU</CardTitle>
            <CardDescription>One GPU per job. Billed per second while the run is on the GPU.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Method">
              {model.methods.map((entry) => {
                const blocker = methodBlocker(entry);
                const label = TRAINING_METHOD_LABELS[entry.method];
                return (
                  <button
                    key={entry.method}
                    type="button"
                    role="radio"
                    aria-checked={method === entry.method}
                    disabled={blocker !== null}
                    data-method={entry.method}
                    onClick={() => chooseMethod(entry.method)}
                    className={choiceClass(method === entry.method, blocker !== null)}
                  >
                    <span className="font-medium text-foreground">{label?.name ?? entry.method}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">{label?.description}</span>
                    <span className="mt-2 block text-xs text-muted-foreground">
                      {blocker ?? `Needs ${entry.requiredVramGb} GB of GPU memory.`}
                    </span>
                  </button>
                );
              })}
            </div>

            <div>
              <p className="text-sm font-medium text-foreground">GPU tier</p>
              {tiers.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">This server lists no GPU tier.</p>
              ) : (
                <div className="mt-2 grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="GPU tier">
                  {tiers.map((tier) => (
                    <button
                      key={tier.tier}
                      type="button"
                      role="radio"
                      aria-checked={gpuTier === tier.tier}
                      disabled={!tier.selectable}
                      data-tier={tier.tier}
                      onClick={() => setGpuTier(tier.tier)}
                      className={choiceClass(gpuTier === tier.tier, !tier.selectable)}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-medium text-foreground">{tier.name}</span>
                        <span className="font-mono text-sm tabular-nums text-muted-foreground">
                          {formatHourlyRate(tier.pricePerSecondUsd)}
                        </span>
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {tier.vramGb} GB{tier.reason ? `. ${tier.reason}` : ""}
                        {methodEntry?.recommendedTier === tier.tier ? ". Cheapest that fits." : ""}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Hyperparameters and run limit */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Hyperparameters and run limit</CardTitle>
          <CardDescription>
            Filled with the trainer&apos;s defaults. Only the values you change are sent.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            {HYPERPARAM_FIELDS.map((field) => {
              const bound = capabilities.hyperparameters.bounds[field.key];
              const error = hyperErrors[field.key];
              return (
                <div key={field.key}>
                  <label htmlFor={`hp-${field.key}`} className="block text-sm font-medium text-foreground">
                    {field.label}
                  </label>
                  <Input
                    id={`hp-${field.key}`}
                    inputMode="decimal"
                    value={hyperForm[field.key] ?? ""}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={`hp-${field.key}-help`}
                    onChange={(event) => setHyperForm((form) => ({ ...form, [field.key]: event.target.value }))}
                    className="mt-1"
                  />
                  <p
                    id={`hp-${field.key}-help`}
                    className={cn("mt-1 text-xs", error ? "text-danger" : "text-muted-foreground")}
                  >
                    {error ??
                      [field.hint, bound ? `${bound.min} to ${bound.max}${bound.integer ? ", whole number" : ""}` : ""]
                        .filter(Boolean)
                        .join(" ")}
                  </p>
                </div>
              );
            })}
            <div>
              <label htmlFor="hp-loraR" className="block text-sm font-medium text-foreground">
                LoRA rank
              </label>
              <Select
                id="hp-loraR"
                value={hyperForm.loraR ?? ""}
                onChange={(event) => setHyperForm((form) => ({ ...form, loraR: event.target.value }))}
                className="mt-1"
              >
                {capabilities.hyperparameters.loraRanks.map((rank) => (
                  <option key={rank} value={rank}>
                    {rank}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">Size of the adapter.</p>
            </div>
          </div>

          <div>
            <label htmlFor="run-limit" className="block text-sm font-medium text-foreground">
              Run limit, in minutes
            </label>
            <Input
              id="run-limit"
              inputMode="numeric"
              value={runLimitMinutes}
              aria-invalid={runLimitProblem ? true : undefined}
              aria-describedby="run-limit-help"
              onChange={(event) => setRunLimitMinutes(event.target.value)}
              placeholder={needsRunLimit ? "Required for this dataset" : "Leave empty to use the suggested limit"}
              className="mt-1 sm:max-w-xs"
            />
            <p
              id="run-limit-help"
              className={cn("mt-1 text-xs", runLimitProblem ? "text-danger" : "text-muted-foreground")}
            >
              {runLimitProblem ??
                (minuteBounds.maxMinutes < minuteBounds.minMinutes
                  ? "This server's job time limit leaves no room for a training run."
                  : needsRunLimit
                    ? `From ${minuteBounds.minMinutes.toLocaleString()} to ${minuteBounds.maxMinutes.toLocaleString()} minutes. Required for this dataset: no tokens per row were measured when it was validated, so its training time cannot be estimated and no limit can be suggested. The run stops at the limit, and the limit sets the amount held.`
                    : `From ${minuteBounds.minMinutes.toLocaleString()} to ${minuteBounds.maxMinutes.toLocaleString()} minutes. The run stops at the limit, and the limit sets the amount held. The review shows a suggested limit for your dataset.`)}
            </p>
          </div>
        </CardContent>
      </Card>

      {refusalPanel}

      <div className="flex flex-wrap items-center justify-end gap-3">
        {!canReview && (
          <p className="text-sm text-muted-foreground" data-testid="review-missing">
            Still needed: {missing.join(", ")}.
          </p>
        )}
        <Link href="/dashboard/training">
          <Button variant="outline">Cancel</Button>
        </Link>
        <Button onClick={handleReview} disabled={!canReview} isLoading={isEstimating} data-testid="review-training">
          Review and estimate
        </Button>
      </div>
    </div>
  );
}
