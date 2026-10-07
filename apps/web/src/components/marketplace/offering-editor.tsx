"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle, EyeOff, FlaskConical, Plus, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { SchemaForm } from "@/components/marketplace/schema-form";
import {
  agentsApi,
  apiErrorCode,
  deploymentsApi,
  getErrorMessage,
  offeringsApi,
  orchestrationApi,
  schemaIssuesOf,
  type OfferingProductKind,
  type OfferingTestRun,
  type PublisherOffering,
} from "@/lib/api";
import { OFFERING_STATUS, PRODUCT_KIND_LABEL, formatCents } from "@/lib/jobs";
import {
  CHECK_TYPES,
  STARTER_SCHEMA,
  buildOffering,
  checkIssues,
  draftFromOffering,
  emptyDraft,
  outboundToolsAllowed,
  serverIssueField,
  toCreateInput,
  type CheckType,
  type DraftField,
  type OfferingDraft,
  type SlaUnit,
} from "@/lib/offering-draft";
import { buildInput, initialValues, issuesByField, type FormValues } from "@/lib/schema-form";

interface ProductOption {
  id: string;
  name: string;
  /** Why it cannot be picked right now, shown beside it. */
  note?: string;
}

type Products = Record<OfferingProductKind, ProductOption[]>;

const KIND_HELP: Record<OfferingProductKind, string> = {
  agent: "An agent you built. An agent installed from the marketplace cannot be resold.",
  workflow: "An enabled workflow whose agents are all your own.",
  model: "One of your model deployments. It must be running when you publish and while jobs come in.",
};

function FieldError({ message }: { message?: string }) {
  return message ? (
    <p role="alert" className="mt-1 text-sm text-danger">
      {message}
    </p>
  ) : null;
}

/** The publisher's test run of a saved offering: one real run, no job and no money. */
function TestRun({ offering, dirty }: { offering: PublisherOffering; dirty: boolean }) {
  const [values, setValues] = useState<FormValues>(() =>
    initialValues(offering.inputSchema, offering.sampleInputs[0]),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<OfferingTestRun | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // A saved change to the schema or the samples resets the form to match it.
  const schemaKey = JSON.stringify([offering.inputSchema, offering.sampleInputs[0] ?? null]);
  useEffect(() => {
    setValues(initialValues(offering.inputSchema, offering.sampleInputs[0]));
    setErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaKey]);

  async function run() {
    const built = buildInput(offering.inputSchema, values);
    setErrors(built.errors);
    if (Object.keys(built.errors).length > 0) return;
    setRunning(true);
    setResult(null);
    setFailure(null);
    try {
      setResult(await offeringsApi.testRun(offering.id, built.input));
    } catch (error) {
      const issues = schemaIssuesOf(error);
      if (issues.length > 0) setErrors(issuesByField(offering.inputSchema, issues));
      setFailure(getErrorMessage(error, "The test run failed"));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="h-4 w-4" aria-hidden />
          Test run
        </CardTitle>
        <CardDescription>
          Runs your {offering.productKind} once, exactly as a paid job would: same instructions, same checks. There is
          no job, no buyer and no money; the usage is your own.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {dirty && (
          <p className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-500">
            You have unsaved changes. A test run uses the offering as it was last saved.
          </p>
        )}
        <SchemaForm
          schema={offering.inputSchema}
          values={values}
          onChange={setValues}
          errors={errors}
          disabled={running}
          idPrefix="test-run"
        />
        <Button type="button" variant="outline" onClick={run} isLoading={running}>
          {running ? "Running…" : "Run it once"}
        </Button>

        {failure && (
          <p role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {failure}
          </p>
        )}

        {result && (
          <div className="space-y-3 rounded-md border p-4" aria-live="polite">
            <div className="flex items-center justify-between gap-3">
              <Badge variant={result.passed ? "success" : "destructive"}>
                {result.passed ? "Would be delivered" : "Would fail and refund"}
              </Badge>
              <span className="text-xs text-muted-foreground">{(result.durationMs / 1000).toFixed(1)} s</span>
            </div>
            <ul className="space-y-1.5 text-sm">
              {result.checkResults.map((check, index) => (
                <li key={index} className="flex gap-2">
                  {check.passed ? (
                    <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="Passed" />
                  ) : (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-label="Failed" />
                  )}
                  <span className="min-w-0">
                    <span className="text-foreground">{check.label}</span>
                    {check.details && <span className="block text-xs text-muted-foreground">{check.details}</span>}
                  </span>
                </li>
              ))}
            </ul>
            {result.output && (
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs text-foreground">
                {result.output.text}
              </pre>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Create or edit an offering. `offering` is null on the "new" page; once
 * saved, the page moves to the offering's own URL where it can be test-run
 * and published.
 */
export function OfferingEditor({
  offering,
  onSaved,
}: {
  offering: PublisherOffering | null;
  onSaved?: (offering: PublisherOffering) => void;
}) {
  const router = useRouter();
  const confirmAction = useConfirm();
  const [draft, setDraft] = useState<OfferingDraft>(() => (offering ? draftFromOffering(offering) : emptyDraft()));
  const [saved, setSaved] = useState<OfferingDraft>(draft);
  const [errors, setErrors] = useState<Partial<Record<DraftField, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [moving, setMoving] = useState(false);
  const [products, setProducts] = useState<Products | null>(null);
  const [productsError, setProductsError] = useState<unknown>(null);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved]);
  const archived = offering?.status === "archived";
  const outboundAllowed = outboundToolsAllowed(draft);
  const set = <K extends keyof OfferingDraft>(key: K, value: OfferingDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    if (offering) return; // The product of a saved offering cannot be changed.
    let cancelled = false;
    Promise.all([agentsApi.list(), orchestrationApi.list({ limit: 100 }), deploymentsApi.list()])
      .then(([agents, workflows, deployments]) => {
        if (cancelled) return;
        setProducts({
          agent: agents.agents.map((a) => ({ id: a.id, name: a.name })),
          workflow: workflows.orchestrations.map((w) => ({
            id: w.id,
            name: w.name,
            ...(w.isEnabled ? {} : { note: "disabled" }),
          })),
          model: deployments.deployments.map((d) => ({
            id: d.id,
            name: d.name,
            ...(d.status === "running" ? {} : { note: d.status }),
          })),
        });
      })
      .catch((error) => {
        if (!cancelled) setProductsError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [offering]);

  /** Puts a refusal where it belongs in the form. */
  function showRefusal(error: unknown) {
    const code = apiErrorCode(error);
    const message = getErrorMessage(error, "The offering could not be saved");
    const issues = schemaIssuesOf(error);
    if (code === "invalid_deliverable_check") {
      const rows = checkIssues(issues);
      setErrors(rows);
      setFormError(Object.keys(rows).length > 0 ? "A deliverable check was refused. See the check below." : message);
      return;
    }
    const field = serverIssueField(code);
    if (field) {
      const detail = issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join("; ");
      setErrors({ [field]: detail || message });
      setFormError(message);
      return;
    }
    setFormError(message);
  }

  async function save(): Promise<PublisherOffering | null> {
    const built = buildOffering(draft);
    const problems = { ...built.errors };
    if (!offering && !draft.productId) problems.productId = `Choose the ${draft.productKind} this offering runs on`;
    setErrors(problems);
    setFormError(null);
    if (Object.keys(problems).length > 0) {
      setFormError("Some fields need attention before this can be saved.");
      return null;
    }
    setSaving(true);
    try {
      const res = offering
        ? await offeringsApi.update(offering.id, built.content)
        : await offeringsApi.create(toCreateInput(draft, built.content));
      setSaved(draft);
      if (offering) {
        toast.success("Offering saved");
        onSaved?.(res.offering);
      } else {
        toast.success("Draft created. Test it, then publish it.");
        router.replace(`/dashboard/marketplace/offerings/${res.offering.id}`);
      }
      return res.offering;
    } catch (error) {
      showRefusal(error);
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function move(action: "activate" | "pause" | "archive") {
    if (!offering || moving) return;
    if (action === "activate" && dirty) {
      toast.error("Save your changes before publishing.");
      return;
    }
    if (action !== "pause") {
      const ok = await confirmAction(
        action === "activate"
          ? {
              title: `Publish "${offering.title}"?`,
              description: `Anyone on the marketplace can then hire it for ${formatCents(offering.priceCents)}. Each job runs your ${offering.productKind} in your organization; you are paid 90% when the buyer accepts the result, less any use of the platform's model keys.`,
              confirmLabel: "Publish",
            }
          : {
              title: `Archive "${offering.title}"?`,
              description:
                "It leaves the marketplace for good and can no longer be edited or republished. Jobs already hired still run and settle.",
              confirmLabel: "Archive",
              destructive: true,
            },
      );
      if (!ok) return;
    }
    setMoving(true);
    try {
      const res = await offeringsApi.setStatus(offering.id, action);
      toast.success(
        action === "activate" ? "Published. It can be hired now." : action === "pause" ? "Paused. No new hires." : "Archived.",
      );
      onSaved?.(res.offering);
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not change the offering's status"));
    } finally {
      setMoving(false);
    }
  }

  const options = products?.[draft.productKind] ?? [];

  return (
    <div className="space-y-6">
      {offering && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Badge variant={OFFERING_STATUS[offering.status].tone}>{OFFERING_STATUS[offering.status].label}</Badge>
            <span className="text-muted-foreground">
              {PRODUCT_KIND_LABEL[offering.productKind]}: {offering.product.name}
              {!offering.productAvailable && " (deleted)"}
            </span>
            {offering.status === "active" && (
              <Link
                href={`/marketplace/offerings/${offering.slug}`}
                className="font-medium text-primary underline underline-offset-2"
              >
                View public page
              </Link>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {(offering.status === "draft" || offering.status === "paused") && (
              <Button onClick={() => move("activate")} isLoading={moving} disabled={saving}>
                {offering.status === "paused" ? "Publish again" : "Publish"}
              </Button>
            )}
            {offering.status === "active" && (
              <Button variant="outline" onClick={() => move("pause")} isLoading={moving}>
                Pause
              </Button>
            )}
            {!archived && (
              <Button variant="ghost" onClick={() => move("archive")} disabled={moving}>
                Archive
              </Button>
            )}
          </div>
        </div>
      )}

      {archived && (
        <p className="rounded-md border bg-muted px-4 py-3 text-sm text-muted-foreground">
          This offering is archived. It is kept for its job history and can no longer be changed.
        </p>
      )}

      <fieldset disabled={archived || saving} className="space-y-6">
        {!offering && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">What runs the job</CardTitle>
              <CardDescription>
                The job runs your product in your organization. The buyer never gets a copy of it, your keys never
                leave, and the product cannot be changed after the offering is created.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div role="radiogroup" aria-label="Product type" className="grid gap-3 sm:grid-cols-3">
                {(["agent", "workflow", "model"] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    role="radio"
                    aria-checked={draft.productKind === kind}
                    onClick={() => setDraft((current) => ({ ...current, productKind: kind, productId: "" }))}
                    className={`rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      draft.productKind === kind ? "border-primary bg-primary/10" : "border-border hover:bg-muted"
                    }`}
                  >
                    <span className="block text-sm font-medium text-foreground">{PRODUCT_KIND_LABEL[kind]}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">{KIND_HELP[kind]}</span>
                  </button>
                ))}
              </div>
              <div>
                <Label htmlFor="offering-product">{PRODUCT_KIND_LABEL[draft.productKind]}</Label>
                {productsError !== null ? (
                  <p role="alert" className="mt-1 text-sm text-danger">
                    {getErrorMessage(productsError, "Your products could not be loaded")}
                  </p>
                ) : products === null ? (
                  <Skeleton className="mt-1 h-10 w-full" />
                ) : options.length === 0 ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    You have no {draft.productKind}s yet.{" "}
                    <Link
                      href={
                        draft.productKind === "agent"
                          ? "/dashboard/agents/new"
                          : draft.productKind === "workflow"
                            ? "/dashboard/orchestrations"
                            : "/dashboard/deployments"
                      }
                      className="font-medium text-primary underline underline-offset-2"
                    >
                      Create one first
                    </Link>
                    .
                  </p>
                ) : (
                  <Select
                    id="offering-product"
                    className="mt-1"
                    value={draft.productId}
                    onChange={(e) => set("productId", e.target.value)}
                  >
                    <option value="">Choose…</option>
                    {options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                        {option.note ? ` (${option.note})` : ""}
                      </option>
                    ))}
                  </Select>
                )}
                <FieldError message={errors.productId} />
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">What you are selling</CardTitle>
            <CardDescription>Buyers see this on the marketplace.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="offering-title">Title</Label>
              <Input
                id="offering-title"
                className="mt-1"
                value={draft.title}
                onChange={(e) => set("title", e.target.value)}
                maxLength={100}
                placeholder="e.g. One-paragraph market brief"
                error={errors.title}
              />
            </div>
            <div>
              <Label htmlFor="offering-description">Description</Label>
              <Textarea
                id="offering-description"
                className="mt-1"
                rows={4}
                value={draft.description}
                onChange={(e) => set("description", e.target.value)}
                maxLength={5000}
                placeholder="What the buyer sends, what they get back, and what it is good for."
                error={errors.description}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="offering-price">Price per job (USD)</Label>
                <Input
                  id="offering-price"
                  className="mt-1"
                  inputMode="decimal"
                  value={draft.price}
                  onChange={(e) => set("price", e.target.value)}
                  error={errors.price}
                  aria-describedby="offering-price-hint"
                />
                <p id="offering-price-hint" className="mt-1 text-xs text-muted-foreground">
                  $0.50 to $1,000. You keep 90%.
                </p>
              </div>
              <div>
                <Label htmlFor="offering-sla">Delivered within</Label>
                <div className="mt-1 flex gap-2">
                  <Input
                    id="offering-sla"
                    inputMode="decimal"
                    value={draft.slaAmount}
                    onChange={(e) => set("slaAmount", e.target.value)}
                    aria-describedby="offering-sla-hint"
                    aria-invalid={errors.slaAmount ? true : undefined}
                  />
                  <Select
                    aria-label="Delivery time unit"
                    value={draft.slaUnit}
                    onChange={(e) => set("slaUnit", e.target.value as SlaUnit)}
                  >
                    <option value="minutes">minutes</option>
                    <option value="hours">hours</option>
                    <option value="days">days</option>
                  </Select>
                </div>
                <FieldError message={errors.slaAmount} />
                <p id="offering-sla-hint" className="mt-1 text-xs text-muted-foreground">
                  5 minutes to 7 days. A job not delivered in time expires and the buyer is refunded.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">What the buyer sends</CardTitle>
            <CardDescription>
              A JSON Schema for the job&apos;s input. The hire form is drawn from it and every hire is validated
              against it. Leave it empty to accept any JSON object.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="flex items-center justify-between">
                <Label htmlFor="offering-schema">Input schema</Label>
                <Button type="button" variant="ghost" size="sm" onClick={() => set("inputSchema", STARTER_SCHEMA)}>
                  Use the starter schema
                </Button>
              </div>
              <Textarea
                id="offering-schema"
                className="mt-1 font-mono text-xs"
                rows={10}
                spellCheck={false}
                value={draft.inputSchema}
                onChange={(e) => set("inputSchema", e.target.value)}
                error={errors.inputSchema}
              />
            </div>
            <div>
              <Label htmlFor="offering-samples">Sample inputs (optional)</Label>
              <Textarea
                id="offering-samples"
                className="mt-1 font-mono text-xs"
                rows={4}
                spellCheck={false}
                value={draft.sampleInputs}
                onChange={(e) => set("sampleInputs", e.target.value)}
                placeholder={'[{ "topic": "GPU rental prices this quarter" }]'}
                error={errors.sampleInputs}
                aria-describedby="offering-samples-hint"
              />
              <p id="offering-samples-hint" className="mt-1 text-xs text-muted-foreground">
                Up to 5, as a JSON array. Buyers can start from one with a click; each must match the schema.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <EyeOff className="h-4 w-4" aria-hidden />
              Private instructions
            </CardTitle>
            <CardDescription>
              Never shown to buyers. Sent to your {draft.productKind} with every job, ahead of the buyer&apos;s input.
              A deliverable that repeats them is not delivered.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Label htmlFor="offering-instructions" className="sr-only">
              Private instructions
            </Label>
            <Textarea
              id="offering-instructions"
              rows={6}
              value={draft.instructions}
              onChange={(e) => set("instructions", e.target.value)}
              maxLength={20000}
              placeholder="How the task should be done: structure, tone, what to leave out."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Checks before delivery</CardTitle>
            <CardDescription>
              Every deliverable must pass all of these before the buyer sees it. One that fails is produced again, up
              to the number of attempts below; if it still fails, the job fails and the buyer is refunded. Buyers can
              read these checks on your offering&apos;s page.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {draft.checks.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No checks yet. Without any, whatever your {draft.productKind} produces is delivered.
              </p>
            )}
            {draft.checks.map((check, index) => {
              const meta = CHECK_TYPES.find((option) => option.type === check.type)!;
              const update = (patch: Partial<typeof check>) =>
                set(
                  "checks",
                  draft.checks.map((row, i) => (i === index ? { ...row, ...patch } : row)),
                );
              return (
                <div key={index} className="space-y-2 rounded-md border p-3">
                  <div className="flex items-center gap-2">
                    <Select
                      aria-label={`Check ${index + 1} type`}
                      value={check.type}
                      onChange={(e) => update({ type: e.target.value as CheckType })}
                    >
                      {CHECK_TYPES.map((option) => (
                        <option key={option.type} value={option.type}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove check ${index + 1}`}
                      onClick={() =>
                        set(
                          "checks",
                          draft.checks.filter((_, i) => i !== index),
                        )
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  {check.type === "json_schema" ? (
                    <Textarea
                      aria-label={`Check ${index + 1} schema`}
                      className="font-mono text-xs"
                      rows={5}
                      spellCheck={false}
                      value={check.value}
                      onChange={(e) => update({ value: e.target.value })}
                      placeholder={meta.placeholder}
                    />
                  ) : (
                    <Input
                      aria-label={`Check ${index + 1} value`}
                      value={check.value}
                      onChange={(e) => update({ value: e.target.value })}
                      placeholder={meta.placeholder}
                    />
                  )}
                  <Input
                    aria-label={`Check ${index + 1} label`}
                    value={check.label}
                    onChange={(e) => update({ label: e.target.value })}
                    placeholder="Label shown to buyers (optional)"
                    maxLength={120}
                  />
                  <FieldError message={errors[`checks.${index}`]} />
                </div>
              );
            })}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={draft.checks.length >= 10}
              onClick={() => set("checks", [...draft.checks, { type: "contains", value: "", label: "" }])}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add a check
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">How it runs</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="offering-format">The buyer receives</Label>
              <Select
                id="offering-format"
                className="mt-1"
                value={draft.outputFormat}
                onChange={(e) => set("outputFormat", e.target.value as OfferingDraft["outputFormat"])}
              >
                <option value="text">Text</option>
                <option value="json">Structured JSON</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="offering-attempts">Attempts when a check fails</Label>
              <Input
                id="offering-attempts"
                className="mt-1"
                inputMode="numeric"
                value={draft.maxAttempts}
                onChange={(e) => set("maxAttempts", e.target.value)}
                error={errors.maxAttempts}
              />
            </div>
            <div>
              <Label htmlFor="offering-concurrency">Jobs open at once</Label>
              <Input
                id="offering-concurrency"
                className="mt-1"
                inputMode="numeric"
                value={draft.maxConcurrentJobs}
                onChange={(e) => set("maxConcurrentJobs", e.target.value)}
                error={errors.maxConcurrentJobs}
                aria-describedby="offering-concurrency-hint"
              />
              <p id="offering-concurrency-hint" className="mt-1 text-xs text-muted-foreground">
                1 to 50. A hire past this is refused and not charged.
              </p>
            </div>
            {draft.productKind === "agent" && (
              <div>
                <Label htmlFor="offering-tools">Tools the agent may use (optional)</Label>
                <Input
                  id="offering-tools"
                  className="mt-1"
                  value={draft.allowedTools}
                  onChange={(e) => set("allowedTools", e.target.value)}
                  placeholder="web_search, calculator"
                  aria-describedby="offering-tools-hint"
                />
                <p id="offering-tools-hint" className="mt-1 text-xs text-muted-foreground">
                  Comma-separated. Empty means the agent&apos;s own tools, except <code>http_request</code>: a tool that
                  can call any address only runs in a paid job when you name it here. Tools that move money or change
                  your data are always off during a paid job.
                </p>
                {outboundAllowed.length > 0 && (
                  <p
                    role="note"
                    className="mt-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-foreground"
                  >
                    <strong>{outboundAllowed.join(", ")} is allowed in paid jobs.</strong> A buyer writes the job&apos;s
                    input and can ask the agent to send your private instructions, or anything else it can read, to a
                    server of theirs. The checks on the result do not see requests the agent makes along the way. Allow
                    it only if the task needs it and the instructions hold nothing you would not show a buyer.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </fieldset>

      {formError && (
        <p role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {formError}
        </p>
      )}

      {!archived && (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void save()} isLoading={saving} disabled={offering !== null && !dirty}>
            {offering ? "Save changes" : "Create draft"}
          </Button>
          <Link
            href="/dashboard/marketplace/offerings"
            className="text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            {offering ? "Back to offerings" : "Cancel"}
          </Link>
          {offering && dirty && <span className="text-sm text-muted-foreground">Unsaved changes</span>}
        </div>
      )}

      {offering && !archived && <TestRun offering={offering} dirty={dirty} />}
    </div>
  );
}
