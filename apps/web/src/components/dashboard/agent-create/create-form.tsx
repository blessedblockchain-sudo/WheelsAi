"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  MessageSquare,
  Plus,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";

import { FieldBuilder } from "@/components/dashboard/agent-create/field-builder";
import { DeliveryPicker } from "@/components/dashboard/delivery-picker";
import { Header } from "@/components/dashboard/header";
import { SchedulePicker, browserTimezone } from "@/components/dashboard/schedule-picker";
import { SkillStatusBadge, SkillUnavailableNote } from "@/components/dashboard/skill-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  chooseTemplateOver,
  createHold,
  draftToCreateInput,
  newDraft,
  placeServerProblems,
  releaseTemplate,
  validateDraft,
  withInstructions,
  withName,
  type AgentDraft,
  type TemplateForDraft,
} from "@/lib/agent-draft";
import {
  agentsApi,
  capabilitiesApi,
  getErrorMessage,
  getValidationError,
  knowledgeApi,
  skillsApi,
  templateApi,
  type AgentTemplate,
  type Capabilities,
  type KnowledgeBase,
  type Skill,
} from "@/lib/api";
import { defaultDrafts, serverFieldIssues } from "@/lib/field-builder";
import { cn } from "@/lib/utils";
import { AGENT_KIND_BADGES, type AgentKind } from "@wheelsai/shared/agent-kind";

/** A template as the API answers it: the listed fields plus what an agent made from it starts with. */
type Template = AgentTemplate & Pick<TemplateForDraft, "systemPrompt" | "tools" | "modelConfig">;

const KIND_CHOICES: Array<{ kind: AgentKind; title: string; sentence: string; icon: LucideIcon }> = [
  {
    kind: "conversation",
    title: "Talk to it",
    sentence: "People chat with it and it answers. Good for support, advice and questions.",
    icon: MessageSquare,
  },
  {
    kind: "task",
    title: "Give it a task",
    sentence: "People fill in a short form and get one result back. Good for writing, summaries and reviews.",
    icon: ClipboardList,
  },
  {
    kind: "scheduled",
    title: "It runs on its own",
    sentence: "It works on a schedule and sends you what it produced. Good for daily briefings, checks and reports.",
    icon: CalendarClock,
  },
];

const textLink =
  "rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const makeFieldId = (index: number) => `q${index}`;

type ServerProblems = ReturnType<typeof placeServerProblems>;
const NO_SERVER_PROBLEMS: ServerProblems = { byInput: {}, formFields: {}, advanced: [], other: [] };

export interface CreateFormProps {
  /** `?kind=`: the choice the screen opens on. */
  initialKind?: AgentKind | null;
  /** `?template=`: the template the screen starts from. */
  templateId?: string | null;
}

/**
 * Creating an agent on one screen: how people will use it, what it should
 * do, its name, and what its kind needs (a form, or a schedule and a place
 * for results). Templates fill the form; Advanced holds the model,
 * creativity, tools, knowledge and secrets. The draft and the request are
 * the pure functions of lib/agent-draft.
 */
export function CreateForm({ initialKind, templateId }: CreateFormProps) {
  const router = useRouter();
  const uid = useId();

  const [draft, setDraft] = useState<AgentDraft>(() =>
    newDraft({ kind: initialKind ?? undefined, timezone: browserTimezone(), fields: defaultDrafts(makeFieldId) }),
  );
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [server, setServer] = useState<ServerProblems>(NO_SERVER_PROBLEMS);
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Slack or Discord is chosen and its link is not saved yet.
  const [linkPending, setLinkPending] = useState(false);
  // The draft on screen, for a template chosen outside a render; and the
  // draft as it was before any template chip, which un-pressing brings back.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  });
  const beforeTemplate = useRef<AgentDraft | null>(null);

  // What the server offers. Each loads on its own, so one failing leaves the rest usable.
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [capabilitiesError, setCapabilitiesError] = useState<unknown>(null);
  const [capabilitiesSettled, setCapabilitiesSettled] = useState(false);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [skillsError, setSkillsError] = useState<unknown>(null);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[] | null>(null);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [templatesError, setTemplatesError] = useState<unknown>(null);
  const [templateNote, setTemplateNote] = useState<string | null>(null);

  const models = useMemo(() => capabilities?.chat.models ?? [], [capabilities]);
  const modelIds = useMemo(() => models.map((model) => model.id), [models]);
  const defaultModel = capabilities?.chat.defaultModel ?? "";

  const loadCapabilities = useCallback(() => {
    setCapabilitiesError(null);
    capabilitiesApi
      .get()
      .then((answer) => {
        setCapabilities(answer);
        // The platform's default model is where a plain draft starts.
        const model = answer.chat.defaultModel ?? "";
        setDraft((current) =>
          current.template || current.baseline.model !== "" || current.advanced.model !== ""
            ? current
            : {
                ...current,
                advanced: { ...current.advanced, model },
                baseline: { ...current.baseline, model },
              },
        );
      })
      .catch((err) => setCapabilitiesError(err))
      .finally(() => setCapabilitiesSettled(true));
  }, []);

  const loadSkills = useCallback(() => {
    setSkillsError(null);
    skillsApi
      .list()
      .then((answer) => setSkills(answer.skills))
      .catch((err) => setSkillsError(err));
  }, []);

  const loadTemplates = useCallback(() => {
    setTemplatesError(null);
    templateApi
      .list({ limit: 50 })
      .then((answer) => setTemplates(answer.templates as Template[]))
      .catch((err) => setTemplatesError(err));
  }, []);

  useEffect(() => {
    loadCapabilities();
    loadSkills();
    loadTemplates();
    knowledgeApi
      .list({ limit: 100 })
      .then((answer) => setKnowledgeBases(answer.knowledgeBases))
      .catch(() => setKnowledgeBases([]));
  }, [loadCapabilities, loadSkills, loadTemplates]);

  const chooseTemplate = useCallback(
    (template: Template) => {
      setTemplateNote(null);
      setServer(NO_SERVER_PROBLEMS);
      const next = chooseTemplateOver(draftRef.current, beforeTemplate.current, template, {
        makeFieldId,
        availableModels: modelIds,
      });
      beforeTemplate.current = next.kept;
      draftRef.current = next.draft;
      setDraft(next.draft);
    },
    [modelIds],
  );

  const letTemplateGo = useCallback(() => {
    const next = releaseTemplate(draftRef.current, beforeTemplate.current, defaultModel);
    beforeTemplate.current = null;
    draftRef.current = next;
    setDraft(next);
  }, [defaultModel]);

  // `?template=`: once, after the models are known, so the template's model can be matched.
  const startedFromParam = useRef(false);
  useEffect(() => {
    if (!templateId || !capabilitiesSettled || startedFromParam.current) return;
    startedFromParam.current = true;
    templateApi
      .get(templateId)
      .then((template) => chooseTemplate(template as Template))
      .catch(() => setTemplateNote("That template could not be found. Choose another one below."));
  }, [templateId, capabilitiesSettled, chooseTemplate]);

  // ----- edits -----

  const clearServer = (...inputs: Array<keyof ServerProblems["byInput"]>) =>
    setServer((current) => {
      if (inputs.every((input) => current.byInput[input] === undefined) && current.other.length === 0) return current;
      const byInput = { ...current.byInput };
      for (const input of inputs) delete byInput[input];
      return { ...current, byInput, other: [] };
    });
  const touch = (input: string) => setTouched((seen) => (seen.has(input) ? seen : new Set(seen).add(input)));
  const setAdvanced = (changes: Partial<AgentDraft["advanced"]>) => {
    setServer((current) => (current.advanced.length === 0 ? current : { ...current, advanced: [] }));
    setDraft((current) => ({ ...current, advanced: { ...current.advanced, ...changes } }));
  };

  const problems = useMemo(() => validateDraft(draft), [draft]);
  const reason = createHold(draft, problems, linkPending);
  const shown = (input: "instructions" | "name") =>
    server.byInput[input] ?? (touched.has(input) ? problems[input] : undefined);
  const fromServer = useMemo(() => serverFieldIssues(draft.fields, server.formFields), [draft.fields, server.formFields]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (reason || creating) return;
    setCreating(true);
    setFormError(null);
    setServer(NO_SERVER_PROBLEMS);
    try {
      const descriptions = Object.fromEntries((skills ?? []).map((skill) => [skill.key, skill.description]));
      const { agent } = await agentsApi.create(draftToCreateInput(draft, descriptions));
      toast.success("Agent created");
      router.push(`/dashboard/agents/${agent.id}`);
    } catch (err) {
      const invalid = getValidationError(err);
      if (invalid) {
        const placed = placeServerProblems(invalid.fields);
        setServer(placed);
        if (placed.advanced.length > 0) setAdvancedOpen(true);
        const nothingPlaced =
          Object.keys(placed.byInput).length === 0 &&
          Object.keys(placed.formFields).length === 0 &&
          placed.advanced.length === 0 &&
          placed.other.length === 0;
        if (nothingPlaced) setFormError(invalid.message);
      } else {
        setFormError(getErrorMessage(err, "Your agent could not be created. Try again."));
      }
      setCreating(false);
    }
  }

  const sectionTitle = "text-base font-semibold text-foreground";

  return (
    <div className="flex flex-col">
      <Header title="New agent" />

      <form
        onSubmit={create}
        noValidate
        className="mx-auto w-full max-w-4xl p-4 sm:p-8"
        // Enter in a one-line input moves nothing and creates nothing: only the button creates.
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault();
        }}
      >
        <div className="mb-4 flex justify-end">
          <Link href="/dashboard/agents/new?mode=code" className={cn(textLink, "inline-flex items-center gap-1 text-sm")}>
            Import your code
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>

        <Card>
          <CardContent className="space-y-8 p-4 sm:p-6">
            {/* How will people use it? */}
            <fieldset>
              <legend className={sectionTitle}>How will people use it?</legend>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {KIND_CHOICES.map((choice) => {
                  const checked = draft.kind === choice.kind;
                  return (
                    <label key={choice.kind} className="relative block cursor-pointer">
                      <input
                        type="radio"
                        name={`${uid}-kind`}
                        value={choice.kind}
                        checked={checked}
                        onChange={() => setDraft((current) => ({ ...current, kind: choice.kind }))}
                        className="peer sr-only"
                      />
                      <span
                        className={cn(
                          "flex h-full flex-col gap-2 rounded-lg border-2 p-4 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
                          checked ? "border-primary bg-primary/10" : "border-border hover:border-muted-foreground/40",
                        )}
                      >
                        <span className="flex items-center gap-2">
                          <choice.icon
                            className={cn("h-5 w-5", checked ? "text-primary" : "text-muted-foreground")}
                            aria-hidden
                          />
                          <span className="font-medium text-foreground">{choice.title}</span>
                        </span>
                        <span className="text-sm text-muted-foreground">{choice.sentence}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            {/* What should it do? */}
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-instructions`} className={sectionTitle}>
                What should it do?
              </Label>
              <Textarea
                id={`${uid}-instructions`}
                value={draft.instructions}
                rows={3}
                placeholder="One or two sentences"
                error={shown("instructions")}
                aria-describedby={`${uid}-instructions-hint`}
                onChange={(e) => {
                  clearServer("instructions", "name");
                  setDraft((current) => withInstructions(current, e.target.value));
                }}
                onBlur={() => touch("instructions")}
              />
              <p id={`${uid}-instructions-hint`} className="text-sm text-muted-foreground">
                This becomes your agent&apos;s instructions. You can change it later.
              </p>
            </div>

            {/* Name */}
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-name`} className={sectionTitle}>
                Name
              </Label>
              <Input
                id={`${uid}-name`}
                value={draft.name}
                maxLength={100}
                autoComplete="off"
                error={shown("name")}
                onChange={(e) => {
                  clearServer("name");
                  setDraft((current) => withName(current, e.target.value));
                }}
                onBlur={() => touch("name")}
              />
            </div>

            {/* Task: the form */}
            {draft.kind === "task" && (
              <div className="space-y-3">
                <h2 className={sectionTitle}>What do you need from people?</h2>
                <FieldBuilder
                  value={draft.fields}
                  onChange={(fields) => {
                    setServer((current) =>
                      Object.keys(current.formFields).length === 0 ? current : { ...current, formFields: {} },
                    );
                    setDraft((current) => ({ ...current, fields }));
                  }}
                  issues={fromServer.issues}
                  formIssue={fromServer.formIssue}
                  disabled={creating}
                />
              </div>
            )}

            {/* Runs on its own: when, and where results go */}
            {draft.kind === "scheduled" && (
              <div className="space-y-6">
                <SchedulePicker
                  value={draft.schedule}
                  onChange={(schedule) => {
                    clearServer("schedule.cronExpression", "schedule.timezone");
                    setDraft((current) => ({ ...current, schedule }));
                  }}
                  error={{
                    cronExpression: server.byInput["schedule.cronExpression"] ?? problems["schedule.cronExpression"],
                    timezone: server.byInput["schedule.timezone"] ?? problems["schedule.timezone"],
                  }}
                  disabled={creating}
                />
                <DeliveryPicker
                  value={draft.deliverChannelId}
                  onChange={(deliverChannelId) => {
                    clearServer("schedule.deliver.channelId");
                    setDraft((current) => ({ ...current, deliverChannelId }));
                  }}
                  error={server.byInput["schedule.deliver.channelId"]}
                  disabled={creating}
                  onPendingChange={setLinkPending}
                />
              </div>
            )}

            {/* Start from a template */}
            <div className="space-y-3">
              <h2 className={sectionTitle}>Start from a template</h2>
              {templateNote && (
                <p role="alert" className="text-sm text-danger">
                  {templateNote}
                </p>
              )}
              {server.byInput.templateId && (
                <p role="alert" className="text-sm text-danger">
                  {server.byInput.templateId}
                </p>
              )}
              {templatesError ? (
                <p className="text-sm text-muted-foreground">
                  {getErrorMessage(templatesError, "Templates could not be loaded.")}{" "}
                  <button type="button" onClick={loadTemplates} className={textLink}>
                    Try again
                  </button>
                </p>
              ) : templates === null ? (
                <div className="flex flex-wrap gap-2" aria-hidden>
                  {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-9 w-40 rounded-full" />
                  ))}
                </div>
              ) : templates.length === 0 ? (
                <p className="text-sm text-muted-foreground">There are no templates yet.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {templates.map((template) => {
                    const chosen = draft.template?.id === template.id;
                    return (
                      <button
                        key={template.id}
                        type="button"
                        aria-pressed={chosen}
                        disabled={creating}
                        onClick={() => {
                          if (chosen) {
                            clearServer("templateId");
                            letTemplateGo();
                          } else chooseTemplate(template);
                        }}
                        className={cn(
                          "inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50",
                          chosen
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border text-foreground hover:bg-muted",
                        )}
                      >
                        <span className="min-w-0 truncate">{template.title}</span>
                        <Badge variant="secondary" className="shrink-0">
                          {AGENT_KIND_BADGES[template.agentKind] ?? AGENT_KIND_BADGES.conversation}
                        </Badge>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Advanced */}
            <div>
              <button
                type="button"
                aria-expanded={advancedOpen}
                aria-controls={`${uid}-advanced`}
                onClick={() => setAdvancedOpen((open) => !open)}
                className="inline-flex items-center gap-1 rounded-sm text-left text-sm font-medium text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {advancedOpen ? (
                  <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
                )}
                <span>
                  Advanced <span className="font-normal text-muted-foreground">(model, creativity, tools, knowledge, secrets)</span>
                </span>
              </button>

              {advancedOpen && (
                <div id={`${uid}-advanced`} className="mt-4 space-y-6">
                  {server.advanced.map((sentence) => (
                    <p key={sentence} role="alert" className="text-sm text-danger">
                      {sentence}
                    </p>
                  ))}

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor={`${uid}-model`}>Model</Label>
                      {capabilitiesError ? (
                        <p className="text-sm text-muted-foreground">
                          {getErrorMessage(capabilitiesError, "The models could not be loaded.")}{" "}
                          <button type="button" onClick={loadCapabilities} className={textLink}>
                            Try again
                          </button>
                        </p>
                      ) : capabilities === null ? (
                        <Skeleton className="h-10 w-full" />
                      ) : models.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No model is available right now.</p>
                      ) : (
                        <Select
                          id={`${uid}-model`}
                          value={draft.advanced.model}
                          disabled={creating}
                          onChange={(e) => setAdvanced({ model: e.target.value })}
                        >
                          {/* A template's own model, when it is not one of the models listed here. */}
                          {(draft.baseline.model === "" || draft.advanced.model === "") && (
                            <option value="">{draft.template ? "The template's model" : "No preference"}</option>
                          )}
                          {models.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.label}
                              {model.id === defaultModel ? " (default)" : ""}
                            </option>
                          ))}
                        </Select>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor={`${uid}-creativity`}>Creativity: {draft.advanced.temperature.toFixed(1)}</Label>
                      <input
                        id={`${uid}-creativity`}
                        type="range"
                        min="0"
                        max="2"
                        step="0.1"
                        value={draft.advanced.temperature}
                        disabled={creating}
                        aria-describedby={`${uid}-creativity-hint`}
                        onChange={(e) => setAdvanced({ temperature: Number.parseFloat(e.target.value) })}
                        className="mt-2 w-full accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                      <p id={`${uid}-creativity-hint`} className="text-xs text-muted-foreground">
                        Lower gives steadier answers. Higher gives more varied ones.
                      </p>
                    </div>
                  </div>

                  <fieldset>
                    <legend className="text-sm font-medium text-foreground">Tools</legend>
                    <p className="mt-1 text-sm text-muted-foreground">Choose what your agent can use.</p>
                    {skillsError ? (
                      <p className="mt-3 text-sm text-muted-foreground">
                        {getErrorMessage(skillsError, "The tools could not be loaded.")}{" "}
                        <button type="button" onClick={loadSkills} className={textLink}>
                          Try again
                        </button>
                      </p>
                    ) : skills === null ? (
                      <div className="mt-3 grid gap-3 sm:grid-cols-2" aria-hidden>
                        {[0, 1, 2, 3].map((i) => (
                          <Skeleton key={i} className="h-20" />
                        ))}
                      </div>
                    ) : (
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        {skills.map((tool) => {
                          const on = draft.advanced.tools.includes(tool.key);
                          return (
                            <label
                              key={tool.key}
                              className={cn(
                                "flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors focus-within:ring-2 focus-within:ring-ring",
                                on ? "border-primary bg-primary/10" : "border-border hover:border-muted-foreground/40",
                              )}
                            >
                              <input
                                type="checkbox"
                                checked={on}
                                disabled={creating}
                                onChange={(e) =>
                                  setAdvanced({
                                    tools: e.target.checked
                                      ? [...draft.advanced.tools, tool.key]
                                      : draft.advanced.tools.filter((key) => key !== tool.key),
                                  })
                                }
                                className="mt-1 accent-primary"
                              />
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="font-medium text-foreground">{tool.name}</p>
                                  <SkillStatusBadge skill={tool} />
                                </div>
                                <p className="text-sm text-muted-foreground">{tool.description}</p>
                                <SkillUnavailableNote skill={tool} />
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </fieldset>

                  <div className="max-w-sm space-y-1.5">
                    <Label htmlFor={`${uid}-knowledge`}>Knowledge</Label>
                    {knowledgeBases === null ? (
                      <Skeleton className="h-10 w-full" />
                    ) : (
                      <Select
                        id={`${uid}-knowledge`}
                        value={draft.advanced.knowledgeBaseId}
                        disabled={creating}
                        aria-describedby={`${uid}-knowledge-hint`}
                        onChange={(e) => setAdvanced({ knowledgeBaseId: e.target.value })}
                      >
                        <option value="">None</option>
                        {knowledgeBases.map((base) => (
                          <option key={base.id} value={base.id}>
                            {base.name}
                          </option>
                        ))}
                      </Select>
                    )}
                    <p id={`${uid}-knowledge-hint`} className="text-xs text-muted-foreground">
                      Your agent answers from the documents in it. Add documents in{" "}
                      <Link href="/dashboard/knowledge" className={textLink}>
                        Knowledge
                      </Link>
                      .
                    </p>
                  </div>

                  <fieldset>
                    <legend className="text-sm font-medium text-foreground">Secrets</legend>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Keys and passwords your tools need. A value is not shown again after it is saved.
                    </p>
                    <div className="mt-3 space-y-3">
                      {draft.advanced.secrets.map((secret, index) => (
                        <div key={index} className="flex flex-col gap-2 sm:flex-row">
                          <div className="sm:w-1/3">
                            <Input
                              aria-label={`Secret ${index + 1} name`}
                              value={secret.key}
                              placeholder="NAME"
                              autoComplete="off"
                              spellCheck={false}
                              disabled={creating}
                              className="font-mono"
                              onChange={(e) =>
                                setAdvanced({
                                  secrets: draft.advanced.secrets.map((row, i) =>
                                    i === index ? { ...row, key: e.target.value } : row,
                                  ),
                                })
                              }
                            />
                          </div>
                          <div className="flex min-w-0 flex-1 gap-2">
                            <Input
                              aria-label={`Secret ${index + 1} value`}
                              value={secret.value}
                              placeholder="Value"
                              type="password"
                              autoComplete="new-password"
                              disabled={creating}
                              onChange={(e) =>
                                setAdvanced({
                                  secrets: draft.advanced.secrets.map((row, i) =>
                                    i === index ? { ...row, value: e.target.value } : row,
                                  ),
                                })
                              }
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`Remove secret ${index + 1}`}
                              disabled={creating}
                              onClick={() =>
                                setAdvanced({ secrets: draft.advanced.secrets.filter((_, i) => i !== index) })
                              }
                            >
                              <Trash2 className="h-4 w-4 text-danger" aria-hidden />
                            </Button>
                          </div>
                        </div>
                      ))}
                      {problems.secrets && (
                        <p role="alert" className="text-sm text-danger">
                          {problems.secrets}
                        </p>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={creating}
                        onClick={() => setAdvanced({ secrets: [...draft.advanced.secrets, { key: "", value: "" }] })}
                      >
                        <Plus className="mr-2 h-4 w-4" aria-hidden />
                        Add a secret
                      </Button>
                    </div>
                  </fieldset>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {(formError || server.other.length > 0) && (
          <div role="alert" className="mt-4 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {formError && <p>{formError}</p>}
            {server.other.map((sentence) => (
              <p key={sentence}>{sentence}</p>
            ))}
          </div>
        )}

        <div className="mt-6 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-end">
          {reason && (
            <p id={`${uid}-reason`} className="text-sm text-muted-foreground sm:text-right">
              {reason}
            </p>
          )}
          <Button
            type="submit"
            isLoading={creating}
            disabled={Boolean(reason)}
            aria-describedby={reason ? `${uid}-reason` : undefined}
          >
            Create agent
          </Button>
        </div>
      </form>
    </div>
  );
}
