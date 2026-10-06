"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle, LayoutGrid, Loader2, Plus, Save } from "lucide-react";
import { toast } from "sonner";

import {
  getApiErrorBody,
  getErrorMessage,
  orchestrationApi,
  type Orchestration,
  type OrchestrationDetail,
  type OrchestrationStep,
  type WorkflowExecutionMode,
  type WorkflowPlan,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { StepEditorPanel, type WorkflowResources } from "./step-editor-panel";
import { WorkflowCanvas, type CanvasEdge, type CanvasNode } from "./workflow-canvas";
import {
  autoLayout,
  definitionFromDraft,
  draftFromWorkflow,
  emptyDraft,
  EXECUTION_MODES,
  LIMITS,
  localIssues,
  newStep,
  nextPosition,
  planSignature,
  removeStep,
  renameStep,
  runOrder,
  wouldCycle,
  type DraftIssue,
  type StepDraft,
  type WorkflowDraft,
} from "./workflow-model";

type SavedWorkflow = Orchestration & { steps: OrchestrationStep[] };

/** What the server said about the current definition. */
type PlanState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ok"; plan: WorkflowPlan }
  | { status: "invalid"; issue: DraftIssue }
  // The check itself failed (network, 5xx). Saving still validates.
  | { status: "unchecked"; message: string };

const PLAN_DEBOUNCE_MS = 600;

function issueFromError(error: unknown, draft: WorkflowDraft): DraftIssue | null {
  const failure = getApiErrorBody(error);
  if (!failure || failure.status !== 400) return null;
  const { body } = failure;
  if (body.error === "invalid_workflow") {
    const stepName = typeof body.step === "string" ? body.step : undefined;
    return {
      message: typeof body.message === "string" ? body.message : "This workflow cannot run as defined",
      stepKey: stepName ? draft.steps.find((s) => s.name === stepName)?.key : undefined,
      field: typeof body.field === "string" ? body.field : undefined,
    };
  }
  if (body.error === "validation_failed") {
    const details = body.details as
      | { formErrors?: string[]; fieldErrors?: Record<string, string[]> }
      | undefined;
    const parts = [
      ...(details?.formErrors ?? []),
      ...Object.entries(details?.fieldErrors ?? {}).map(([field, messages]) => `${field}: ${messages.join(", ")}`),
    ];
    return { message: parts.join("; ") || "The workflow is not valid" };
  }
  return null;
}

/**
 * The workflow editor: a canvas of steps, a side panel for the selected
 * step (or the workflow's settings when none is selected), and a
 * validation bar that says, before saving, whether the server would
 * accept this definition and in what order it would run.
 */
export function WorkflowEditor({
  workflow,
  resources,
  onSaved,
  onDirtyChange,
  onReload,
}: {
  /** Null while creating a workflow. */
  workflow: OrchestrationDetail | null;
  resources: WorkflowResources;
  onSaved: (saved: SavedWorkflow) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Reloads the stored workflow, discarding the draft (after a stale save). */
  onReload?: () => void;
}) {
  const confirmAction = useConfirm();
  const [draft, setDraft] = useState<WorkflowDraft>(() =>
    workflow ? draftFromWorkflow(workflow) : emptyDraft()
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [planState, setPlanState] = useState<PlanState>({ status: "idle" });
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const [nameTaken, setNameTaken] = useState(false);

  const definition = useMemo(() => definitionFromDraft(draft), [draft]);
  const signature = useMemo(() => planSignature(definition), [definition]);
  // What "unsaved" compares: everything that is stored except where the
  // canvas happens to be scrolled, so panning alone is not a change.
  const full = useMemo(
    () => JSON.stringify({ ...definition, layout: { positions: definition.layout?.positions } }),
    [definition]
  );
  const [savedFull, setSavedFull] = useState(full);
  const dirty = full !== savedFull;

  const local = useMemo(() => localIssues(draft), [draft]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Closing the tab with unsaved work asks first. In-app navigation is
  // guarded by the page, which knows its own links.
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // Ask the server to plan the definition after each pause in editing.
  // Only the latest request may report: an older answer describes a
  // definition that is no longer on screen.
  const planRequest = useRef(0);
  const definitionRef = useRef(definition);
  definitionRef.current = definition;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const hasLocalIssues = local.length > 0;
  useEffect(() => {
    const request = ++planRequest.current;
    if (hasLocalIssues) {
      setPlanState({ status: "idle" });
      return;
    }
    setPlanState({ status: "checking" });
    const timer = setTimeout(async () => {
      try {
        const plan = await orchestrationApi.plan(definitionRef.current);
        if (planRequest.current === request) setPlanState({ status: "ok", plan });
      } catch (error) {
        if (planRequest.current !== request) return;
        const issue = issueFromError(error, draftRef.current);
        setPlanState(
          issue
            ? { status: "invalid", issue }
            : { status: "unchecked", message: getErrorMessage(error, "The server could not be reached") }
        );
      }
    }, PLAN_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [signature, hasLocalIssues]);

  const issues: DraftIssue[] = [
    ...local,
    ...(planState.status === "invalid" ? [planState.issue] : []),
  ];
  const invalidKeys = new Set(issues.map((i) => i.stepKey).filter((k): k is string => Boolean(k)));

  const selected = draft.steps.find((s) => s.key === selectedKey) ?? null;
  const selectedErrors: Record<string, string> = {};
  if (selected) {
    for (const issue of issues) {
      if (issue.stepKey === selected.key && issue.field && !(issue.field in selectedErrors)) {
        selectedErrors[issue.field] = issue.message;
      }
    }
  }

  const plan = planState.status === "ok" ? planState.plan : null;
  const modelStepsWarning = plan?.warnings.find((w) => w.startsWith("model steps cannot run"));
  const orderByName = new Map<string, number>(
    (plan ? plan.order : runOrder(draft.steps).map((s) => s.name)).map((name, index) => [name, index + 1])
  );

  const resourceName = (step: StepDraft): string => {
    if (step.stepType === "agent") return resources.agents.find((a) => a.id === step.agentId)?.name ?? "";
    if (step.stepType === "model") {
      return resources.deployments.find((d) => d.id === step.deploymentId)?.name ?? "";
    }
    return resources.knowledgeBases.find((k) => k.id === step.knowledgeBaseId)?.name ?? "";
  };

  const nodes: CanvasNode[] = draft.steps.map((step) => ({
    key: step.key,
    name: step.name,
    stepType: step.stepType,
    resource: resourceName(step),
    position: step.position,
    hasCondition: step.condition !== null,
    loop: step.loop?.kind ?? null,
    order: orderByName.get(step.name),
    invalid: invalidKeys.has(step.key),
  }));
  const edges: CanvasEdge[] = draft.steps.flatMap((step) =>
    step.dependsOn.map((from) => ({ from, to: step.key }))
  );

  function patchStep(key: string, patch: Partial<StepDraft>) {
    setDraft((d) => ({ ...d, steps: d.steps.map((s) => (s.key === key ? { ...s, ...patch } : s)) }));
  }

  function addStep() {
    if (draft.steps.length >= LIMITS.maxSteps) {
      toast.error(`A workflow has at most ${LIMITS.maxSteps} steps`);
      return;
    }
    const step = newStep(draft.steps, nextPosition(draft.steps));
    setDraft((d) => ({ ...d, steps: [...d.steps, step] }));
    setSelectedKey(step.key);
  }

  function connect(from: string, to: string) {
    const target = draft.steps.find((s) => s.key === to);
    if (!target || target.dependsOn.includes(from)) return;
    if (wouldCycle(draft.steps, from, to)) {
      const source = draft.steps.find((s) => s.key === from);
      toast.error(
        `${source?.name || "That step"} already waits for ${target.name || "this step"}; a workflow cannot loop back on itself. Use a step's Loop setting to repeat it.`
      );
      return;
    }
    patchStep(to, { dependsOn: [...target.dependsOn, from] });
  }

  function disconnect(from: string, to: string) {
    const target = draft.steps.find((s) => s.key === to);
    if (target) patchStep(to, { dependsOn: target.dependsOn.filter((k) => k !== from) });
  }

  async function deleteStep(step: StepDraft) {
    const confirmed = await confirmAction({
      title: `Delete step "${step.name || "unnamed"}"?`,
      description: "Steps that wait for it will no longer wait. Prompts that read its output will need changing.",
      confirmLabel: "Delete step",
      destructive: true,
    });
    if (!confirmed) return;
    setDraft((d) => removeStep(d, step.key));
    setSelectedKey(null);
  }

  function arrange() {
    const positions = autoLayout(draft.steps, draft.executionMode);
    setDraft((d) => ({
      ...d,
      steps: d.steps.map((s) => ({ ...s, position: positions.get(s.key) ?? s.position })),
      viewport: { x: 0, y: 0, zoom: 1 },
    }));
  }

  async function save() {
    if (local.length > 0) {
      const first = local[0]!;
      toast.error(first.message);
      if (first.stepKey) setSelectedKey(first.stepKey);
      else setSelectedKey(null);
      return;
    }
    setSaving(true);
    setNameTaken(false);
    try {
      const saved = workflow
        ? // The lock token is the version the page holds. The page updates
          // it after its own writes (enable, a save), so only a change
          // made elsewhere reads as stale.
          await orchestrationApi.replace(workflow.id, definition, workflow.updatedAt)
        : await orchestrationApi.create(definition);
      setSavedFull(full);
      setStale(false);
      toast.success(workflow ? "Workflow saved" : "Workflow created");
      onSaved(saved);
    } catch (error) {
      const failure = getApiErrorBody(error);
      const issue = issueFromError(error, draft);
      if (issue) {
        setPlanState({ status: "invalid", issue });
        if (issue.stepKey) setSelectedKey(issue.stepKey);
        toast.error(issue.message);
      } else if (failure?.body.error === "stale_definition") {
        setStale(true);
      } else if (failure?.body.error === "name_taken") {
        setNameTaken(true);
        setSelectedKey(null);
        toast.error("Another workflow already has this name");
      } else {
        toast.error(getErrorMessage(error, "Could not save the workflow"));
      }
    } finally {
      setSaving(false);
    }
  }

  const nameError = nameTaken
    ? "Another workflow already has this name"
    : local.find((i) => i.field === "name" && !i.stepKey)?.message;

  return (
    <div className="space-y-4">
      {/* Name, mode, save */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <label htmlFor="workflow-name" className="sr-only">
            Workflow name
          </label>
          <Input
            id="workflow-name"
            value={draft.name}
            onChange={(event) => {
              setNameTaken(false);
              setDraft((d) => ({ ...d, name: event.target.value }));
            }}
            placeholder="Workflow name"
            maxLength={80}
            aria-invalid={Boolean(nameError)}
            className="text-base font-medium"
          />
          {nameError && dirty && (
            <p role="alert" className="mt-1 text-xs text-danger">
              {nameError}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={addStep}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
            Add step
          </Button>
          <Button variant="outline" onClick={arrange} disabled={draft.steps.length === 0} title="Lay the steps out by run order">
            <LayoutGrid className="mr-1.5 h-4 w-4" aria-hidden="true" />
            Arrange
          </Button>
          <Button onClick={save} isLoading={saving} disabled={saving || (workflow !== null && !dirty)}>
            {!saving && <Save className="mr-1.5 h-4 w-4" aria-hidden="true" />}
            {workflow ? (dirty ? "Save changes" : "Saved") : "Create workflow"}
          </Button>
        </div>
      </div>

      {stale && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-sm text-foreground">
            This workflow was changed somewhere else after you opened it, so your changes were not saved. Reload to
            get the current version, then apply your changes again.
          </p>
          {onReload && (
            <Button variant="outline" size="sm" onClick={onReload}>
              Reload workflow
            </Button>
          )}
        </div>
      )}

      <ValidationBar issues={issues} planState={planState} mode={draft.executionMode} onPick={setSelectedKey} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <WorkflowCanvas
          className="h-[34rem]"
          nodes={nodes}
          edges={edges}
          selectedKey={selectedKey}
          viewport={draft.viewport}
          onViewportChange={(viewport) => setDraft((d) => ({ ...d, viewport }))}
          onSelect={setSelectedKey}
          onMove={(key, position) => patchStep(key, { position })}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        <div className="h-[34rem]">
          {selected ? (
            <StepEditorPanel
              key={selected.key}
              draft={draft}
              step={selected}
              resources={resources}
              fieldErrors={selectedErrors}
              modelStepsWarning={modelStepsWarning}
              onChange={(patch) => patchStep(selected.key, patch)}
              onRename={(name) => setDraft((d) => renameStep(d, selected.key, name))}
              onDelete={() => deleteStep(selected)}
              onClose={() => setSelectedKey(null)}
            />
          ) : (
            <WorkflowSettingsPanel draft={draft} issues={local} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Validation bar
// ---------------------------------------------------------------------------

function ValidationBar({
  issues,
  planState,
  mode,
  onPick,
}: {
  issues: DraftIssue[];
  planState: PlanState;
  mode: WorkflowExecutionMode;
  onPick: (key: string | null) => void;
}) {
  if (issues.length > 0) {
    return (
      <div role="status" className="rounded-lg border border-danger/40 bg-danger/5 px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AlertTriangle className="h-4 w-4 text-danger" aria-hidden="true" />
          {issues.length === 1 ? "1 thing to fix before this workflow can be saved" : `${issues.length} things to fix before this workflow can be saved`}
        </p>
        <ul className="mt-2 space-y-1">
          {issues.slice(0, 6).map((issue, index) => (
            <li key={index} className="text-sm text-foreground">
              {issue.stepKey ? (
                <button
                  type="button"
                  onClick={() => onPick(issue.stepKey!)}
                  className="rounded text-left underline decoration-dotted underline-offset-2 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {issue.message}
                </button>
              ) : (
                issue.message
              )}
            </li>
          ))}
          {issues.length > 6 && <li className="text-sm text-muted-foreground">and {issues.length - 6} more</li>}
        </ul>
      </div>
    );
  }

  if (planState.status === "checking" || planState.status === "idle") {
    return (
      <div role="status" className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Checking the workflow
      </div>
    );
  }

  if (planState.status === "unchecked") {
    return (
      <div role="status" className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
        The workflow could not be checked just now ({planState.message}). It is checked again when you save.
      </div>
    );
  }

  if (planState.status !== "ok") return null;
  const { plan } = planState;
  return (
    <div role="status" className="rounded-lg border border-border bg-card px-4 py-3">
      <p className="flex items-center gap-2 text-sm font-medium text-foreground">
        <CheckCircle className="h-4 w-4 text-success" aria-hidden="true" />
        Ready to run.
        <span className="font-normal text-muted-foreground">
          {mode === "parallel"
            ? `${plan.levels.length} stage${plan.levels.length === 1 ? "" : "s"}, up to ${plan.concurrency} steps at once`
            : `${plan.order.length} step${plan.order.length === 1 ? "" : "s"}, one at a time`}
        </span>
      </p>
      <ol className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {(mode === "parallel" ? plan.levels : plan.order.map((name) => [name])).map((names, index) => (
          <li key={index} className="flex items-center gap-2">
            {index > 0 && <span aria-hidden="true">→</span>}
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{names.join(" + ")}</span>
          </li>
        ))}
      </ol>
      {plan.warnings.length > 0 && (
        <ul className="mt-2 space-y-1">
          {plan.warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-2 text-sm text-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-yellow-600 dark:text-yellow-400" aria-hidden="true" />
              {warning}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workflow settings (shown when no step is selected)
// ---------------------------------------------------------------------------

function WorkflowSettingsPanel({
  draft,
  issues,
  onChange,
}: {
  draft: WorkflowDraft;
  issues: DraftIssue[];
  onChange: (patch: Partial<WorkflowDraft>) => void;
}) {
  const errorFor = (field: string) => issues.find((i) => !i.stepKey && i.field === field)?.message;
  const mode = EXECUTION_MODES.find((m) => m.value === draft.executionMode);

  return (
    <aside aria-label="Workflow settings" className="flex h-full flex-col rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">Workflow settings</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Select a step on the canvas to edit it.</p>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <div>
          <label htmlFor="workflow-description" className="mb-1 block text-xs font-medium text-foreground">
            Description
          </label>
          <Textarea
            id="workflow-description"
            value={draft.description}
            onChange={(event) => onChange({ description: event.target.value })}
            rows={2}
            maxLength={500}
          />
        </div>

        <div>
          <label htmlFor="workflow-mode" className="mb-1 block text-xs font-medium text-foreground">
            How steps run
          </label>
          <Select
            id="workflow-mode"
            value={draft.executionMode}
            onChange={(event) => onChange({ executionMode: event.target.value as WorkflowExecutionMode })}
          >
            {EXECUTION_MODES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-muted-foreground">{mode?.description}</p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="workflow-concurrency" className="mb-1 block text-xs font-medium text-foreground">
              Steps at once (1 to {LIMITS.maxConcurrency})
            </label>
            <Input
              id="workflow-concurrency"
              value={draft.maxConcurrency}
              onChange={(event) => onChange({ maxConcurrency: event.target.value })}
              inputMode="numeric"
              aria-invalid={Boolean(errorFor("maxConcurrency"))}
            />
          </div>
          <div>
            <label htmlFor="workflow-timeout" className="mb-1 block text-xs font-medium text-foreground">
              Run time limit (seconds)
            </label>
            <Input
              id="workflow-timeout"
              value={draft.timeoutSeconds}
              onChange={(event) => onChange({ timeoutSeconds: event.target.value })}
              inputMode="numeric"
              aria-invalid={Boolean(errorFor("timeout"))}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Steps at once applies to parallel workflows and to for-each loops. A run that passes its time limit is
          stopped and marked failed.
        </p>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="workflow-retries" className="mb-1 block text-xs font-medium text-foreground">
              Default retries
            </label>
            <Input
              id="workflow-retries"
              value={draft.retryMaxRetries}
              onChange={(event) => onChange({ retryMaxRetries: event.target.value })}
              inputMode="numeric"
              placeholder="0"
              aria-invalid={Boolean(errorFor("retryPolicy"))}
            />
          </div>
          <div>
            <label htmlFor="workflow-backoff" className="mb-1 block text-xs font-medium text-foreground">
              Wait between tries (ms)
            </label>
            <Input
              id="workflow-backoff"
              value={draft.retryBackoffMs}
              onChange={(event) => onChange({ retryBackoffMs: event.target.value })}
              inputMode="numeric"
              placeholder="0"
              aria-invalid={Boolean(errorFor("retryPolicy"))}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Used by steps that set no retries of their own. Every retry is another billed call.
        </p>

        <details>
          <summary className="cursor-pointer text-sm font-semibold text-foreground">Input and output schemas</summary>
          <div className="mt-3 space-y-3">
            <div>
              <label htmlFor="workflow-input-schema" className="mb-1 block text-xs font-medium text-foreground">
                Input schema (JSON Schema)
              </label>
              <Textarea
                id="workflow-input-schema"
                value={draft.inputSchema}
                onChange={(event) => onChange({ inputSchema: event.target.value })}
                rows={6}
                placeholder={'{\n  "type": "object",\n  "required": ["topic"],\n  "properties": { "topic": { "type": "string" } }\n}'}
                className="font-mono text-xs"
                aria-invalid={Boolean(errorFor("inputSchema"))}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                A run whose input does not match is refused before anything is called. Its properties appear as
                variables in step prompts.
              </p>
            </div>
            <div>
              <label htmlFor="workflow-output-schema" className="mb-1 block text-xs font-medium text-foreground">
                Output schema (JSON Schema)
              </label>
              <Textarea
                id="workflow-output-schema"
                value={draft.outputSchema}
                onChange={(event) => onChange({ outputSchema: event.target.value })}
                rows={6}
                className="font-mono text-xs"
                aria-invalid={Boolean(errorFor("outputSchema"))}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                A run whose final output does not match is marked failed. Supported keywords: type, enum, const,
                properties, required, additionalProperties, items, and the min/max length, items and number bounds.
              </p>
            </div>
          </div>
        </details>
      </div>
    </aside>
  );
}
