"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, KeyRound, Plus, Save, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { taskFieldsOf, type AgentKind } from "@wheelsai/shared/agent-kind";

import { FieldBuilder } from "@/components/dashboard/agent-create/field-builder";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ModelSelector } from "@/components/dashboard/model-selector";
import {
  agentsApi,
  getErrorMessage,
  getValidationError,
  knowledgeApi,
  type HostedModelChoice,
  type KnowledgeBase,
  type UpdateAgentInput,
} from "@/lib/api";
import { DRAFT_MESSAGES } from "@/lib/agent-draft";
import { KIND_CHOICES, kindOf } from "@/lib/agent-list";
import { KIND_CHANGE_MESSAGES, deleteWarning, kindChangeConfirm } from "@/lib/agent-page";
import {
  checkFields,
  draftsFromFields,
  serverFieldIssues,
  settleKeys,
  toFieldInputs,
  type FieldDraft,
  type FieldIssues,
} from "@/lib/field-builder";
import { hostedModelLine } from "@/lib/model-choice";
import { cn } from "@/lib/utils";
import type { AgentTabProps } from "./types";

/** The API returns secret names only (values are write-only). */
function secretKeys(env: unknown): string[] {
  if (env && typeof env === "object" && Array.isArray((env as { keys?: unknown }).keys)) {
    return (env as { keys: string[] }).keys;
  }
  return [];
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

type FormProblems = Partial<
  Record<"name" | "description" | "systemPrompt" | "temperature" | "maxTokens" | "tags" | "knowledgeBaseId" | "env", string>
>;

/** Where a server sentence about a setting goes: the input it is about, when this tab shows it. */
const SERVER_PATHS: Record<string, keyof FormProblems> = {
  name: "name",
  description: "description",
  systemPrompt: "systemPrompt",
  "modelConfig.temperature": "temperature",
  "modelConfig.maxTokens": "maxTokens",
  tags: "tags",
  knowledgeBaseId: "knowledgeBaseId",
  env: "env",
};

const ADVANCED_PROBLEMS: Array<keyof FormProblems> = ["temperature", "maxTokens", "tags", "env"];

/** Whether what is in a form differs from what it started from. */
function formEdited(current: unknown, started: unknown): boolean {
  return JSON.stringify(current) !== JSON.stringify(started);
}

export function SettingsTab({ agent, agentId, loadAgent }: AgentTabProps) {
  const router = useRouter();
  const kind = kindOf(agent.agentKind);

  const initial = useMemo(
    () => ({
      name: agent.name,
      description: agent.description ?? "",
      systemPrompt: agent.systemPrompt ?? "",
      model: agent.modelConfig?.externalModel ?? agent.modelConfig?.modelId ?? "",
      temperature: String(agent.modelConfig?.temperature ?? 0.7),
      maxTokens: String(agent.modelConfig?.maxTokens ?? 4096),
      tags: (agent.tags ?? []).join(", "),
      isPublic: agent.isPublic,
      knowledgeBaseId: (agent as { knowledgeBaseId?: string | null }).knowledgeBaseId ?? "",
    }),
    [agent]
  );
  const [form, setForm] = useState(initial);
  const [problems, setProblems] = useState<FormProblems>({});
  const [saving, setSaving] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);

  // The questions of a task agent's form.
  const initialQuestions = useMemo(
    () => draftsFromFields(taskFieldsOf(agent.kindConfig), (index) => `saved-${index}`),
    [agent.kindConfig]
  );
  const [questions, setQuestions] = useState<FieldDraft[]>(initialQuestions);
  const [questionIssues, setQuestionIssues] = useState<Record<string, FieldIssues>>({});
  const [questionFormIssue, setQuestionFormIssue] = useState<string | null>(null);
  const [showAllQuestionProblems, setShowAllQuestionProblems] = useState(false);

  // Secrets: existing names from the API, plus pending sets and deletes.
  const existingKeys = secretKeys(agent.env);
  const [secretSets, setSecretSets] = useState<Array<{ key: string; value: string }>>([]);
  const [secretDeletes, setSecretDeletes] = useState<string[]>([]);

  // What a delete takes with it: the agent's own schedule and its other scheduled tasks.
  const [scheduleInfo, setScheduleInfo] = useState<{ hasSchedule: boolean; otherTasks: number } | null>(null);
  const [pendingKind, setPendingKind] = useState<AgentKind | null>(null);

  // The agent was read again (a save here, the page's Refresh, a change on
  // another tab). What is being typed is kept: the form follows the agent
  // only while it has no unsaved edit, or right after its own save.
  const shown = useRef({ initial, initialQuestions });
  const typed = useRef({ form, questions });
  useEffect(() => {
    typed.current = { form, questions };
  });
  const followAgent = useRef(false);
  useEffect(() => {
    const before = shown.current;
    shown.current = { initial, initialQuestions };
    const follow = followAgent.current;
    followAgent.current = false;
    if (follow || !formEdited(typed.current.form, before.initial)) setForm(initial);
    if (follow || !formEdited(toFieldInputs(typed.current.questions), toFieldInputs(before.initialQuestions))) {
      setQuestions(initialQuestions);
      setQuestionIssues({});
      setQuestionFormIssue(null);
      setShowAllQuestionProblems(false);
    }
  }, [initial, initialQuestions]);
  useEffect(() => {
    knowledgeApi
      .list({ limit: 100 })
      .then((res) => setKnowledgeBases(res.knowledgeBases))
      .catch(() => setKnowledgeBases([]));
  }, []);
  useEffect(() => {
    let current = true;
    agentsApi
      .getSchedule(agentId)
      .then((answer) => {
        if (current) setScheduleInfo({ hasSchedule: Boolean(answer.schedule), otherTasks: answer.otherTasks });
      })
      .catch(() => {
        if (current) setScheduleInfo(null);
      });
    return () => {
      current = false;
    };
    // The kind is here so the note is read again after a change that turned the schedule off.
  }, [agentId, agent.agentKind]);

  const update = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const questionsChanged =
    kind === "task" && JSON.stringify(toFieldInputs(questions)) !== JSON.stringify(toFieldInputs(initialQuestions));
  const dirty =
    JSON.stringify(form) !== JSON.stringify(initial) ||
    secretSets.length > 0 ||
    secretDeletes.length > 0 ||
    questionsChanged;

  const showAdvanced = advancedOpen || ADVANCED_PROBLEMS.some((field) => problems[field]);

  // The models this organization runs on Nosana, as the picker read them: null until it has, or when the server does not say.
  const [hostedModels, setHostedModels] = useState<HostedModelChoice[] | null>(null);
  const modelLine = hostedModelLine(form.model, hostedModels);

  function discard() {
    setForm(initial);
    setProblems({});
    setSecretSets([]);
    setSecretDeletes([]);
    setQuestions(initialQuestions);
    setQuestionIssues({});
    setQuestionFormIssue(null);
    setShowAllQuestionProblems(false);
  }

  async function handleSave() {
    const temperature = Number(form.temperature);
    const maxTokens = Number(form.maxTokens);
    const found: FormProblems = {};
    if (form.name.trim().length < 3) found.name = DRAFT_MESSAGES.name;
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      found.temperature = "Enter a number from 0 to 2.";
    }
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 32768) {
      found.maxTokens = "Enter a whole number from 1 to 32,768.";
    }
    const badKey = secretSets.find((s) => !ENV_KEY.test(s.key) || !s.value);
    if (badKey) {
      found.env = badKey.value
        ? `"${badKey.key}" is not a valid variable name.`
        : `Enter a value for ${badKey.key || "the new variable"}.`;
    }

    let fields: ReturnType<typeof toFieldInputs> | null = null;
    if (questionsChanged) {
      const settled = settleKeys(questions);
      if (!checkFields(settled).ok) {
        setShowAllQuestionProblems(true);
        setProblems(found);
        return;
      }
      fields = toFieldInputs(settled);
    }
    setProblems(found);
    if (Object.keys(found).length > 0) return;

    const env: Record<string, string | null> = {};
    for (const key of secretDeletes) env[key] = null;
    for (const { key, value } of secretSets) env[key] = value;

    // Send only what changed, so an untouched prompt is not re-versioned.
    const changes: Record<string, unknown> = {};
    if (form.name !== initial.name) changes.name = form.name.trim();
    if (form.description !== initial.description) changes.description = form.description;
    if (form.systemPrompt !== initial.systemPrompt) changes.systemPrompt = form.systemPrompt;
    if (form.model !== initial.model || form.temperature !== initial.temperature || form.maxTokens !== initial.maxTokens) {
      changes.modelConfig = { ...agent.modelConfig, externalModel: form.model || undefined, temperature, maxTokens };
    }
    if (form.tags !== initial.tags) {
      changes.tags = form.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }
    if (form.isPublic !== initial.isPublic) changes.isPublic = form.isPublic;
    if (form.knowledgeBaseId !== initial.knowledgeBaseId) changes.knowledgeBaseId = form.knowledgeBaseId || null;
    if (Object.keys(env).length > 0) changes.env = env;
    // A key that is sent replaces that key only: the other kinds' settings are kept.
    if (fields) changes.kindConfig = { task: { fields } };

    setSaving(true);
    setQuestionIssues({});
    setQuestionFormIssue(null);
    try {
      await agentsApi.update(agentId, changes as UpdateAgentInput);
      followAgent.current = true;
      setSecretSets([]);
      setSecretDeletes([]);
      setShowAllQuestionProblems(false);
      toast.success("Settings saved");
      await loadAgent();
    } catch (error) {
      const validation = getValidationError(error);
      if (!validation) {
        toast.error(getErrorMessage(error, "Failed to save settings"));
        return;
      }
      const placed: FormProblems = {};
      let unplaced = false;
      for (const [path, sentence] of Object.entries(validation.fields)) {
        const field = SERVER_PATHS[path];
        if (field) placed[field] ??= sentence;
        else if (!path.startsWith("kindConfig")) unplaced = true;
      }
      const fromServer = serverFieldIssues(questions, validation.fields);
      setProblems(placed);
      setQuestionIssues(fromServer.issues);
      setQuestionFormIssue(fromServer.formIssue);
      const anyPlaced =
        Object.keys(placed).length > 0 || Object.keys(fromServer.issues).length > 0 || fromServer.formIssue !== null;
      if (unplaced || !anyPlaced) toast.error(validation.message);
    } finally {
      setSaving(false);
    }
  }

  async function changeKind(next: AgentKind) {
    const answer = await agentsApi.update(agentId, { agentKind: next });
    const title = KIND_CHOICES.find((choice) => choice.kind === next)?.title ?? next;
    toast.success(`This agent is now used as "${title}"`);
    if (answer.schedulePaused) toast.info(KIND_CHANGE_MESSAGES.schedulePaused);
    setPendingKind(null);
    await loadAgent();
  }

  async function handleDelete() {
    await agentsApi.delete(agentId);
    toast.success("Agent deleted");
    router.push("/dashboard/agents");
  }

  const confirmKind = pendingKind ? kindChangeConfirm(kind, pendingKind) : null;

  return (
    <div className="min-w-0 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">How people use it</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-3" role="radiogroup" aria-label="How people use it">
            {KIND_CHOICES.map((choice) => {
              const selected = choice.kind === kind;
              return (
                <button
                  key={choice.kind}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => {
                    if (!selected) setPendingKind(choice.kind);
                  }}
                  className={cn(
                    "rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected ? "border-primary bg-primary/10" : "hover:bg-muted"
                  )}
                >
                  <p className="text-sm font-medium text-foreground">{choice.title}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{choice.description}</p>
                </button>
              );
            })}
          </div>
          {confirmKind && pendingKind && (
            <ConfirmDialog
              open
              onOpenChange={(open) => {
                if (!open) setPendingKind(null);
              }}
              title={confirmKind.title}
              description={confirmKind.description}
              confirmLabel={confirmKind.confirmLabel}
              onConfirm={() => changeKind(pendingKind)}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">About this agent</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="agent-name">Name</Label>
            <Input
              id="agent-name"
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              maxLength={100}
              error={problems.name}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="agent-description">Description</Label>
            <Input
              id="agent-description"
              value={form.description}
              onChange={(e) => update("description", e.target.value)}
              maxLength={500}
              error={problems.description}
              aria-describedby="agent-description-hint"
            />
            <p id="agent-description-hint" className="text-xs text-muted-foreground">
              One line that tells people what this agent does. It shows on its public page.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="agent-prompt">Instructions</Label>
            <Textarea
              id="agent-prompt"
              value={form.systemPrompt}
              onChange={(e) => update("systemPrompt", e.target.value)}
              maxLength={10000}
              rows={8}
              error={problems.systemPrompt}
              aria-describedby="agent-prompt-hint"
            />
            <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span id="agent-prompt-hint">What the agent should do and how it should answer. People who use it never see this.</span>
              <span className="tabular-nums">{form.systemPrompt.length.toLocaleString()} / 10,000</span>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="agent-kb">Knowledge</Label>
            <Select
              id="agent-kb"
              value={form.knowledgeBaseId}
              onChange={(e) => update("knowledgeBaseId", e.target.value)}
              error={problems.knowledgeBaseId}
              aria-describedby="agent-kb-hint"
            >
              <option value="">None</option>
              {knowledgeBases.map((kb) => (
                <option key={kb.id} value={kb.id}>
                  {kb.name}
                </option>
              ))}
            </Select>
            <p id="agent-kb-hint" className="text-xs text-muted-foreground">
              Documents the agent reads from when it answers.
            </p>
          </div>
        </CardContent>
      </Card>

      {kind === "task" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What do you need from people?</CardTitle>
            <CardDescription>The questions of the form people fill in before a run.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldBuilder
              value={questions}
              onChange={setQuestions}
              issues={questionIssues}
              formIssue={questionFormIssue}
              showAllProblems={showAllQuestionProblems}
              disabled={saving}
            />
          </CardContent>
        </Card>
      )}

      <div>
        <button
          type="button"
          onClick={() => setAdvancedOpen((open) => !open)}
          aria-expanded={showAdvanced}
          aria-controls="agent-settings-advanced"
          className="flex items-center gap-1 rounded text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {showAdvanced ? (
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          )}
          Advanced
          <span className="font-normal">(model, creativity, tags, secrets)</span>
        </button>

        {showAdvanced && (
          <div id="agent-settings-advanced" className="mt-4 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Model</CardTitle>
                <CardDescription>Which model answers, and how it answers.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="agent-model">Model</Label>
                  <ModelSelector
                    id="agent-model"
                    agentId={agentId}
                    value={form.model}
                    onChange={(v) => update("model", v)}
                    defaultLabel="WheelsAI's default model"
                    onModels={(models) => setHostedModels(models.hostedModels ?? null)}
                  />
                  {modelLine && (
                    <p className="text-xs text-muted-foreground">
                      {modelLine.text}
                      {modelLine.kind !== "hosted" && (
                        <>
                          {" "}
                          <Link
                            href={modelLine.href}
                            className="rounded text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {modelLine.linkLabel}
                          </Link>
                        </>
                      )}
                    </p>
                  )}
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="agent-temperature">Temperature</Label>
                    <Input
                      id="agent-temperature"
                      type="number"
                      min={0}
                      max={2}
                      step={0.1}
                      value={form.temperature}
                      onChange={(e) => update("temperature", e.target.value)}
                      error={problems.temperature}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="agent-max-tokens">Max tokens</Label>
                    <Input
                      id="agent-max-tokens"
                      type="number"
                      min={1}
                      max={32768}
                      step={1}
                      value={form.maxTokens}
                      onChange={(e) => update("maxTokens", e.target.value)}
                      error={problems.maxTokens}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Tags and public page</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="agent-tags">Tags</Label>
                  <Input
                    id="agent-tags"
                    value={form.tags}
                    onChange={(e) => update("tags", e.target.value)}
                    placeholder="research, support"
                    error={problems.tags}
                  />
                </div>
                <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                  <div className="min-w-0">
                    <p id="agent-public-label" className="text-sm font-medium">
                      Public agent page
                    </p>
                    <p className="break-words text-xs text-muted-foreground">
                      {agent.publicHandle
                        ? `Shows the agent's public page and on-chain track record at /a/${agent.publicHandle}.`
                        : "Shows the agent's public page and on-chain track record. Its address is on the Share tab."}
                    </p>
                  </div>
                  <Switch
                    checked={form.isPublic}
                    onCheckedChange={(v) => update("isPublic", v)}
                    aria-labelledby="agent-public-label"
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <KeyRound className="h-4 w-4" aria-hidden="true" />
                  Environment variables
                </CardTitle>
                <CardDescription>
                  Encrypted at rest and never shown again after saving. Marketplace buyers never receive them.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {existingKeys.length === 0 && secretSets.length === 0 && (
                  <p className="text-sm text-muted-foreground">No variables set.</p>
                )}
                {existingKeys.map((key) => {
                  const deleting = secretDeletes.includes(key);
                  return (
                    <div key={key} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
                      <span
                        className={cn(
                          "min-w-0 break-all font-mono text-sm",
                          deleting && "text-muted-foreground line-through"
                        )}
                      >
                        {key}
                      </span>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-xs text-muted-foreground">{deleting ? "will be removed" : "set"}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setSecretDeletes((d) => (deleting ? d.filter((k) => k !== key) : [...d, key]))
                          }
                        >
                          {deleting ? "Keep" : "Remove"}
                        </Button>
                      </div>
                    </div>
                  );
                })}
                {secretSets.map((row, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                    <Input
                      placeholder="NAME"
                      value={row.key}
                      onChange={(e) =>
                        setSecretSets((s) => s.map((r, j) => (j === i ? { ...r, key: e.target.value.trim() } : r)))
                      }
                      className="font-mono"
                      aria-label="Variable name"
                    />
                    <Input
                      type="password"
                      placeholder={existingKeys.includes(row.key) ? "New value (replaces the current one)" : "Value"}
                      value={row.value}
                      onChange={(e) => setSecretSets((s) => s.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                      aria-label="Variable value"
                      autoComplete="off"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setSecretSets((s) => s.filter((_, j) => j !== i))}
                      aria-label="Discard this variable"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                {problems.env && (
                  <p role="alert" className="text-sm text-danger">
                    {problems.env}
                  </p>
                )}
                <Button variant="outline" size="sm" onClick={() => setSecretSets((s) => [...s, { key: "", value: "" }])}>
                  <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                  Add or replace a variable
                </Button>
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" disabled={!dirty || saving} onClick={discard}>
          Discard changes
        </Button>
        <Button onClick={handleSave} disabled={!dirty} isLoading={saving}>
          <Save className="mr-2 h-4 w-4" aria-hidden="true" />
          Save settings
        </Button>
      </div>

      <Card className="border-danger/30">
        <CardHeader>
          <CardTitle className="text-base text-danger">Danger Zone</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium">Delete Agent</p>
              <p className="text-sm text-muted-foreground">Permanently delete this agent and all its deployments</p>
            </div>
            <ConfirmDialog
              title="Delete this agent?"
              description={deleteWarning(scheduleInfo)}
              confirmLabel="Delete agent"
              destructive
              onConfirm={handleDelete}
            >
              <Button variant="destructive">
                <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                Delete Agent
              </Button>
            </ConfirmDialog>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
