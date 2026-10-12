"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Copy, Rocket, Store, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { NosanaRecord } from "@/components/dashboard/nosana-record";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import {
  API_BASE_URL,
  deploymentsApi,
  fineTunedModelsApi,
  getApiErrorBody,
  getErrorMessage,
  trainingApi,
  type DeploymentDetail,
  type FineTunedModel,
} from "@/lib/api";
import { deploymentSnippets } from "@/lib/public-urls";
import {
  deployUnavailableMessage,
  fineTunedModelAgentHint,
  formatBytes,
  formatRunTime,
  metricNumber,
} from "@/lib/training";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-foreground">{children}</dd>
    </div>
  );
}

const DEPLOYMENT_BADGE: Record<string, "success" | "warning" | "destructive" | "secondary"> = {
  running: "success",
  degraded: "warning",
  provisioning: "warning",
  pending: "secondary",
  stopped: "secondary",
  failed: "destructive",
};

/** The figures of the run's metrics summary this page shows, each only when the run reported it. */
function metricRows(metrics: Record<string, unknown> | null): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const add = (label: string, value: number | null, format: (n: number) => string) => {
    if (value !== null) rows.push([label, format(value)]);
  };
  const nested = (key: string) => {
    const value = metrics?.[key];
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  };
  add("Final training loss", metricNumber(metrics, "finalTrainLoss"), (n) => n.toFixed(4));
  add("Final evaluation loss", metricNumber(metrics, "finalEvalLoss"), (n) => n.toFixed(4));
  add("Steps", metricNumber(metrics, "steps"), (n) => n.toLocaleString());
  add("Epochs", metricNumber(metrics, "epochs"), (n) => String(Math.round(n * 100) / 100));
  add("Tokens trained on", metricNumber(metrics, "trainTokens"), (n) => n.toLocaleString());
  add("Rows used", metricNumber(nested("rows"), "used"), (n) => n.toLocaleString());
  add("Rows cut to the sequence length", metricNumber(nested("rows"), "truncated"), (n) => n.toLocaleString());
  add("Rows skipped", metricNumber(nested("rows"), "skipped"), (n) => n.toLocaleString());
  add("Time training", metricNumber(nested("timings"), "train"), (n) => formatRunTime(n));
  add("Peak GPU memory", metricNumber(nested("gpu"), "peakVramGb"), (n) => `${n.toFixed(1)} GB`);
  return rows;
}

export default function FineTunedModelPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const modelId = params.id;

  const [model, setModel] = useState<FineTunedModel | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  // The running deployment the snippet is written for, read for its endpoint.
  const [served, setServed] = useState<DeploymentDetail | null>(null);
  // Why a delete was refused (409 model_in_use).
  const [deleteRefusal, setDeleteRefusal] = useState<string | null>(null);
  // Why no fine-tuned model can be deployed right now; null while it can, and
  // while that is not known (not read yet, or the read failed): the API decides then.
  const [deployUnavailable, setDeployUnavailable] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const { fineTunedModel } = await fineTunedModelsApi.get(modelId);
      setModel(fineTunedModel);
      const running = fineTunedModel.deployments.find((d) => d.status === "running");
      if (running) {
        // The snippet needs the endpoint the API serves; without it none is shown.
        deploymentsApi.get(running.id).then(
          ({ deployment }) => setServed(deployment),
          () => setServed(null),
        );
      } else {
        setServed(null);
      }
    } catch (error) {
      setLoadError(error);
    }
  }, [modelId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    trainingApi.getCapabilities().then(
      (capabilities) => setDeployUnavailable(deployUnavailableMessage(capabilities)),
      () => setDeployUnavailable(null),
    );
  }, []);

  async function handleDelete() {
    setDeleteRefusal(null);
    try {
      await fineTunedModelsApi.delete(modelId);
    } catch (error) {
      if (getApiErrorBody(error)?.status === 409) {
        // Stays on the page: the reason names what to stop first.
        setDeleteRefusal(getErrorMessage(error, "This model is in use and cannot be deleted yet."));
        void load();
        return;
      }
      throw error;
    }
    toast.success("Fine-tuned model deleted");
    router.push("/dashboard/training");
  }

  if (loadError) {
    return (
      <div className="flex flex-col">
        <Header title="Fine-tuned model" />
        <div className="p-8">
          <ErrorState
            title="Couldn't load this fine-tuned model"
            error={loadError}
            onRetry={load}
            actionLabel="Back to fine-tuning"
            actionHref="/dashboard/training"
          />
        </div>
      </div>
    );
  }

  if (!model) {
    return (
      <div className="flex flex-col">
        <Header title="Fine-tuned model" />
        <div className="grid gap-6 p-8 lg:grid-cols-3" aria-busy="true">
          <Card className="lg:col-span-2">
            <CardHeader>
              <Skeleton className="h-5 w-40" />
            </CardHeader>
            <CardContent className="space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-3 py-6">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </CardContent>
          </Card>
          <span className="sr-only">Loading fine-tuned model</span>
        </div>
      </div>
    );
  }

  const metrics = metricRows(model.metrics);
  const partial = model.metrics?.stopReason === "max_runtime";
  const snippets = served
    ? deploymentSnippets({
        endpoint: served.endpoint,
        slug: served.slug,
        apiBase: API_BASE_URL,
        temperature: 0.7,
        maxTokens: 256,
      })
    : null;
  const deployHref = `/dashboard/deployments/new?fineTunedModel=${model.id}`;

  return (
    <div className="flex flex-col">
      <Header title={model.name} description={`Fine-tuned from ${model.baseModelName}`} />

      <div className="space-y-6 p-8">
        <Link
          href="/dashboard/training"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to fine-tuning
        </Link>

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Adapter</CardTitle>
                <CardDescription>
                  A LoRA adapter stored for your organization. It is loaded on top of the base model
                  when you deploy it.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="divide-y divide-border text-sm" data-testid="model-facts">
                  <Row label="Base model">
                    {model.baseModelName}
                    <span className="block break-all font-mono text-xs font-normal text-muted-foreground">
                      {model.baseModelHfId}
                    </span>
                  </Row>
                  <Row label="Method">
                    {model.method.toUpperCase()}, rank {model.loraR}
                  </Row>
                  <Row label="Adapter size">{formatBytes(model.adapterBytes)}</Row>
                  <Row label="Adapter sha256">
                    <span className="break-all font-mono text-xs">{model.adapterSha256}</span>
                  </Row>
                  <Row label="Created">{new Date(model.createdAt).toLocaleString()}</Row>
                  <Row label="Training job">
                    {model.trainingJob ? (
                      <Link
                        href={`/dashboard/training/${model.trainingJob.id}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {model.trainingJob.name}
                      </Link>
                    ) : (
                      "No longer available"
                    )}
                  </Row>
                </dl>
                <NosanaRecord nosana={model.trainingJob?.nosana} className="mt-4" />
                {partial && (
                  <p className="mt-3 rounded-md border border-border bg-muted p-3 text-sm text-foreground">
                    The run stopped at its run limit, so this adapter is from a partial run.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Training metrics</CardTitle>
                <CardDescription>As recorded by the run that produced this adapter.</CardDescription>
              </CardHeader>
              <CardContent>
                {metrics.length === 0 ? (
                  <p className="text-sm text-muted-foreground">The run recorded no metrics.</p>
                ) : (
                  <dl className="grid gap-x-8 text-sm sm:grid-cols-2" data-testid="model-metrics">
                    {metrics.map(([label, value]) => (
                      <Row key={label} label={label}>
                        <span className="font-mono tabular-nums">{value}</span>
                      </Row>
                    ))}
                  </dl>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Deployments using this model</CardTitle>
                <CardDescription>
                  Each deployment is its own GPU endpoint, billed per second while it runs.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {model.deployments.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="model-no-deployments">
                    Not deployed yet. Deploy it to call it through the /v1 API.
                  </p>
                ) : (
                  <ul className="space-y-2" data-testid="model-deployments">
                    {model.deployments.map((deployment) => (
                      <li
                        key={deployment.id}
                        className="flex items-center justify-between gap-4 rounded-lg border p-3 text-sm"
                      >
                        <div className="min-w-0">
                          <Link
                            href={`/dashboard/deployments/${deployment.id}`}
                            className="font-medium text-foreground underline-offset-4 hover:underline"
                          >
                            {deployment.name}
                          </Link>
                          <p className="font-mono text-xs text-muted-foreground">{deployment.slug}</p>
                        </div>
                        <Badge variant={DEPLOYMENT_BADGE[deployment.status] ?? "secondary"}>
                          {deployment.status}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            {snippets && served && (
              <Card data-testid="model-snippet">
                <CardHeader>
                  <CardTitle className="text-base">Call it</CardTitle>
                  <CardDescription>
                    Served by the running deployment <span className="font-medium">{served.name}</span>.
                    The model name on the /v1 API is the deployment&apos;s slug,{" "}
                    <code className="rounded bg-muted px-1 font-mono text-xs">{snippets.model}</code>.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {(
                    [
                      ["curl", snippets.curl],
                      ["Python (OpenAI client)", snippets.python],
                    ] as const
                  ).map(([label, code]) => (
                    <div key={label}>
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium text-foreground">{label}</p>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            void navigator.clipboard.writeText(code).then(
                              () => toast.success("Copied"),
                              () => toast.error("Could not copy"),
                            );
                          }}
                        >
                          <Copy className="mr-2 h-4 w-4" />
                          Copy
                        </Button>
                      </div>
                      <pre className="mt-1 overflow-x-auto rounded-lg bg-muted p-4 font-mono text-xs text-foreground">
                        {code}
                      </pre>
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">
                    Create an API key under{" "}
                    <Link href="/dashboard/keys" className="text-primary underline-offset-4 hover:underline">
                      API Keys
                    </Link>
                    .
                  </p>
                </CardContent>
              </Card>
            )}
          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Use this model</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {deployUnavailable ? (
                  <>
                    <Button
                      className="w-full"
                      disabled
                      aria-describedby="model-deploy-unavailable"
                      data-testid="model-deploy"
                    >
                      <Rocket className="mr-2 h-4 w-4" />
                      Deploy
                    </Button>
                    <p
                      id="model-deploy-unavailable"
                      className="text-xs text-muted-foreground"
                      data-testid="model-deploy-unavailable"
                    >
                      {deployUnavailable}
                    </p>
                  </>
                ) : (
                  <Link href={deployHref} className="block">
                    <Button className="w-full" data-testid="model-deploy">
                      <Rocket className="mr-2 h-4 w-4" />
                      Deploy
                    </Button>
                  </Link>
                )}
                {model.activeDeployments > 0 ? (
                  <Link href="/dashboard/marketplace/offerings/new" className="block">
                    <Button variant="outline" className="w-full">
                      <Store className="mr-2 h-4 w-4" />
                      List on marketplace
                    </Button>
                  </Link>
                ) : (
                  <>
                    <Button variant="outline" className="w-full" disabled>
                      <Store className="mr-2 h-4 w-4" />
                      List on marketplace
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      A marketplace listing sells a running deployment. Deploy the model first.
                    </p>
                  </>
                )}
                <p className="text-xs text-muted-foreground" data-testid="model-agent-hint">
                  {fineTunedModelAgentHint(model)}
                </p>
                {!snippets && (
                  <p className="text-xs text-muted-foreground">
                    The /v1 example for this model appears here once a deployment of it is running.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Delete</CardTitle>
                <CardDescription>
                  Removes the adapter from storage. The training job and its charges stay in your
                  history.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {model.activeDeployments > 0 && (
                  <p className="text-sm text-muted-foreground">
                    {model.activeDeployments} active deployment{model.activeDeployments === 1 ? "" : "s"}{" "}
                    {model.activeDeployments === 1 ? "serves" : "serve"} this model. Stop{" "}
                    {model.activeDeployments === 1 ? "it" : "them"} before deleting.
                  </p>
                )}
                {deleteRefusal && (
                  <p role="alert" className="text-sm text-danger" data-testid="model-delete-refusal">
                    Not deleted. {deleteRefusal}
                  </p>
                )}
                <ConfirmDialog
                  title={`Delete "${model.name}"?`}
                  description="The adapter is removed from storage and cannot be recovered. To get it back you would train again."
                  confirmLabel="Delete model"
                  destructive
                  onConfirm={handleDelete}
                >
                  <Button
                    variant="destructive"
                    className="w-full"
                    disabled={model.activeDeployments > 0}
                    data-testid="model-delete"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete model
                  </Button>
                </ConfirmDialog>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
