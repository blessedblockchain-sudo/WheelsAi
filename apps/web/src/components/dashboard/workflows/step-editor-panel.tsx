"use client";

import Link from "next/link";
import { Bot, BookOpen, Cpu, Trash2, X } from "lucide-react";

import type { Agent, Deployment, KnowledgeBase, WorkflowStepType } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ConditionBuilder } from "./condition-builder";
import { TemplateField, VariableChips } from "./template-field";
import {
  emptyCondition,
  LIMITS,
  variablesFor,
  wouldCycle,
  type StepDraft,
  type WorkflowDraft,
} from "./workflow-model";

export interface WorkflowResources {
  agents: Agent[];
  deployments: Deployment[];
  knowledgeBases: KnowledgeBase[];
}

const STEP_TYPES: Array<{
  value: WorkflowStepType;
  label: string;
  icon: React.ElementType;
  description: string;
}> = [
  { value: "agent", label: "Agent", icon: Bot, description: "Sends the prompt to one of your agents." },
  { value: "model", label: "Model", icon: Cpu, description: "Sends the prompt straight to one of your model deployments." },
  { value: "retrieval", label: "Retrieval", icon: BookOpen, description: "Searches a knowledge base and passes the passages on." },
];

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-xs text-danger">
      {message}
    </p>
  );
}

/**
 * The side panel for one step. Everything a step can be configured with
 * is here, so the canvas only has to show the shape of the workflow.
 */
export function StepEditorPanel({
  draft,
  step,
  resources,
  fieldErrors,
  modelStepsWarning,
  onChange,
  onRename,
  onDelete,
  onClose,
}: {
  draft: WorkflowDraft;
  step: StepDraft;
  resources: WorkflowResources;
  /** Problems with this step, by field name. */
  fieldErrors: Record<string, string>;
  /** Set when model steps cannot run right now; the reason, shown as is. */
  modelStepsWarning?: string;
  onChange: (patch: Partial<StepDraft>) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const id = (suffix: string) => `step-${step.key}-${suffix}`;
  const variables = variablesFor(draft, step.key);
  const others = draft.steps.filter((s) => s.key !== step.key);
  const isRetrieval = step.stepType === "retrieval";

  function setType(stepType: WorkflowStepType) {
    onChange({
      stepType,
      // A retrieval step returns passages; text/json and an agent fallback do not apply.
      ...(stepType === "retrieval"
        ? { outputFormat: "text", onError: step.onError === "fallback" ? "fail" : step.onError }
        : {}),
    });
  }

  function toggleDependency(key: string) {
    onChange({
      dependsOn: step.dependsOn.includes(key)
        ? step.dependsOn.filter((k) => k !== key)
        : [...step.dependsOn, key],
    });
  }

  return (
    <aside
      aria-label={`Step ${step.name || "unnamed"}`}
      className="flex h-full flex-col rounded-lg border border-border bg-card"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">Step</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close step panel"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <Section title="Name" hint="Other steps refer to this step by its name.">
          <label htmlFor={id("name")} className="sr-only">
            Step name
          </label>
          <Input
            id={id("name")}
            value={step.name}
            onChange={(event) => onRename(event.target.value)}
            maxLength={64}
            aria-invalid={Boolean(fieldErrors.name)}
          />
          <FieldError message={fieldErrors.name} />
        </Section>

        <Section title="What it runs">
          <div role="radiogroup" aria-label="Step type" className="grid grid-cols-3 gap-2">
            {STEP_TYPES.map((type) => {
              const Icon = type.icon;
              const active = step.stepType === type.value;
              return (
                <button
                  key={type.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setType(type.value)}
                  title={type.description}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-md border px-2 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {type.label}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            {STEP_TYPES.find((t) => t.value === step.stepType)?.description}
          </p>

          {step.stepType === "agent" && (
            <div>
              <label htmlFor={id("agent")} className="mb-1 block text-xs font-medium text-foreground">
                Agent
              </label>
              <Select
                id={id("agent")}
                value={step.agentId}
                onChange={(event) => onChange({ agentId: event.target.value })}
                aria-invalid={Boolean(fieldErrors.agentId)}
              >
                <option value="">Choose an agent</option>
                {step.agentId && !resources.agents.some((a) => a.id === step.agentId) && (
                  <option value={step.agentId}>Deleted agent ({step.agentId.slice(0, 8)})</option>
                )}
                {resources.agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </Select>
              <FieldError message={fieldErrors.agentId} />
              {resources.agents.length === 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  You have no agents yet.{" "}
                  <Link href="/dashboard/agents/new" className="text-primary hover:underline">
                    Create one
                  </Link>
                  .
                </p>
              )}
            </div>
          )}

          {step.stepType === "model" && (
            <div className="space-y-2">
              {modelStepsWarning && (
                <p role="status" className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-foreground">
                  {modelStepsWarning} You can save a model step, but a run that reaches it fails with this reason.
                </p>
              )}
              <div>
                <label htmlFor={id("deployment")} className="mb-1 block text-xs font-medium text-foreground">
                  Model deployment
                </label>
                <Select
                  id={id("deployment")}
                  value={step.deploymentId}
                  onChange={(event) => onChange({ deploymentId: event.target.value })}
                  aria-invalid={Boolean(fieldErrors.deploymentId)}
                >
                  <option value="">Choose a deployment</option>
                  {step.deploymentId && !resources.deployments.some((d) => d.id === step.deploymentId) && (
                    <option value={step.deploymentId}>Deleted deployment ({step.deploymentId.slice(0, 8)})</option>
                  )}
                  {resources.deployments.map((deployment) => (
                    <option key={deployment.id} value={deployment.id}>
                      {deployment.name} ({deployment.model}, {deployment.status})
                    </option>
                  ))}
                </Select>
                <FieldError message={fieldErrors.deploymentId} />
                {resources.deployments.length === 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    You have no model deployments.{" "}
                    <Link href="/dashboard/deployments/new" className="text-primary hover:underline">
                      Deploy a model
                    </Link>
                    .
                  </p>
                )}
              </div>
              <div>
                <label htmlFor={id("model")} className="mb-1 block text-xs font-medium text-foreground">
                  Model id (optional)
                </label>
                <Input
                  id={id("model")}
                  value={step.modelId}
                  onChange={(event) => onChange({ modelId: event.target.value })}
                  placeholder="Defaults to the deployment's model"
                />
              </div>
            </div>
          )}

          {isRetrieval && (
            <div>
              <label htmlFor={id("kb")} className="mb-1 block text-xs font-medium text-foreground">
                Knowledge base
              </label>
              <Select
                id={id("kb")}
                value={step.knowledgeBaseId}
                onChange={(event) => onChange({ knowledgeBaseId: event.target.value })}
                aria-invalid={Boolean(fieldErrors.knowledgeBaseId)}
              >
                <option value="">Choose a knowledge base</option>
                {step.knowledgeBaseId &&
                  !resources.knowledgeBases.some((k) => k.id === step.knowledgeBaseId) && (
                    <option value={step.knowledgeBaseId}>
                      Deleted knowledge base ({step.knowledgeBaseId.slice(0, 8)})
                    </option>
                  )}
                {resources.knowledgeBases.map((kb) => (
                  <option key={kb.id} value={kb.id}>
                    {kb.name} ({kb.totalDocuments} documents)
                  </option>
                ))}
              </Select>
              <FieldError message={fieldErrors.knowledgeBaseId} />
              {resources.knowledgeBases.length === 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  You have no knowledge bases.{" "}
                  <Link href="/dashboard/knowledge" className="text-primary hover:underline">
                    Create one
                  </Link>
                  .
                </p>
              )}
            </div>
          )}
        </Section>

        <Section
          title={isRetrieval ? "Search query" : "Prompt"}
          hint={
            isRetrieval
              ? "What to search the knowledge base for. Variables are replaced before the search."
              : "What this step is asked. Variables are replaced with the run input or earlier steps' outputs."
          }
        >
          <label htmlFor={id("prompt")} className="sr-only">
            {isRetrieval ? "Search query" : "Prompt"}
          </label>
          <TemplateField
            id={id("prompt")}
            value={step.promptTemplate}
            onChange={(promptTemplate) => onChange({ promptTemplate })}
            variables={variables}
            invalid={Boolean(fieldErrors.promptTemplate || fieldErrors.references)}
            placeholder={
              isRetrieval
                ? "{{input.prompt}}"
                : "Summarize this for a customer:\n\n{{steps.research.output}}"
            }
          />
          <FieldError message={fieldErrors.promptTemplate ?? fieldErrors.references} />
          {step.promptTemplate.trim() === "" && (
            <p className="text-xs text-muted-foreground">
              {draft.executionMode === "pipeline"
                ? "Left empty, this step receives the previous step's output (the first step receives the run prompt)."
                : "Left empty, this step receives the run's own prompt."}
            </p>
          )}
        </Section>

        <Section
          title="Waits for"
          hint="This step starts after the ticked steps. It runs if at least one of them succeeded."
        >
          {others.length === 0 ? (
            <p className="text-xs text-muted-foreground">There are no other steps yet.</p>
          ) : (
            <ul className="space-y-1">
              {others.map((other) => {
                const checked = step.dependsOn.includes(other.key);
                const blocked = !checked && wouldCycle(draft.steps, other.key, step.key);
                return (
                  <li key={other.key}>
                    <label
                      className={cn(
                        "flex items-center gap-2 text-sm",
                        blocked ? "text-muted-foreground" : "text-foreground"
                      )}
                      title={blocked ? `${other.name} already waits for this step` : undefined}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={blocked}
                        onChange={() => toggleDependency(other.key)}
                        className="h-4 w-4 rounded border-border text-primary focus:ring-ring"
                      />
                      <span className="truncate">{other.name || "Unnamed step"}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          <FieldError message={fieldErrors.dependsOn} />
        </Section>

        <Section
          title="Run only if"
          hint="A branch: when the rule does not hold the step is skipped, and so are steps that wait only for it."
        >
          <div className="flex items-center gap-2">
            <Switch
              checked={step.condition !== null}
              onCheckedChange={(on) => onChange({ condition: on ? emptyCondition() : null })}
              aria-label="Run this step only if a condition holds"
            />
            <span className="text-sm text-foreground">
              {step.condition ? "Only when the rule below holds" : "Always runs"}
            </span>
          </div>
          {step.condition && (
            <ConditionBuilder
              idPrefix={id("condition")}
              value={step.condition}
              onChange={(condition) => onChange({ condition })}
              variables={variables}
            />
          )}
          <FieldError message={fieldErrors.condition} />
        </Section>

        <Section title="Loop" hint="Run this step more than once.">
          <label htmlFor={id("loop")} className="sr-only">
            Loop kind
          </label>
          <Select
            id={id("loop")}
            value={step.loop?.kind ?? "none"}
            onChange={(event) => {
              const kind = event.target.value;
              onChange({
                loop:
                  kind === "forEach"
                    ? { kind: "forEach", source: "", maxItems: "" }
                    : kind === "until"
                      ? { kind: "until", condition: emptyCondition(), maxIterations: "3", onExhausted: "fail" }
                      : null,
              });
            }}
          >
            <option value="none">Run once</option>
            <option value="forEach">Once for each item of a list</option>
            <option value="until">Repeat until a condition holds</option>
          </Select>

          {step.loop?.kind === "forEach" && (
            <div className="space-y-2">
              <div>
                <label htmlFor={id("loop-source")} className="mb-1 block text-xs font-medium text-foreground">
                  List to loop over
                </label>
                <Input
                  id={id("loop-source")}
                  value={step.loop.source}
                  onChange={(event) =>
                    onChange({ loop: { ...step.loop!, source: event.target.value } as StepDraft["loop"] })
                  }
                  placeholder="$.steps.plan.output.items"
                  className="font-mono text-xs"
                />
              </div>
              <VariableChips
                variables={variables.filter((v) => v.reference !== "$.item" && v.reference !== "$.index")}
                label="Use"
                onPick={(chip) =>
                  onChange({ loop: { ...step.loop!, source: chip.reference } as StepDraft["loop"] })
                }
              />
              <div>
                <label htmlFor={id("loop-max")} className="mb-1 block text-xs font-medium text-foreground">
                  Most items allowed (1 to {LIMITS.maxForEachItems})
                </label>
                <Input
                  id={id("loop-max")}
                  value={step.loop.maxItems}
                  onChange={(event) =>
                    onChange({ loop: { ...step.loop!, maxItems: event.target.value } as StepDraft["loop"] })
                  }
                  inputMode="numeric"
                  placeholder={String(LIMITS.maxForEachItems)}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                The list can be a JSON array or one item per line. A longer list fails the step before anything is
                called. Use the loop item and loop index variables in the prompt. Each item is one billed call.
              </p>
            </div>
          )}

          {step.loop?.kind === "until" && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-foreground">Stop when</p>
              <ConditionBuilder
                idPrefix={id("until")}
                value={step.loop.condition}
                onChange={(condition) =>
                  onChange({ loop: { ...step.loop!, condition } as StepDraft["loop"] })
                }
                variables={[
                  ...(step.name
                    ? [
                        {
                          template: `{{steps.${step.name}.output}}`,
                          reference: `$.steps.${step.name}.output`,
                          label: "this step's output",
                        },
                      ]
                    : []),
                  ...variables,
                ]}
              />
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor={id("until-max")} className="mb-1 block text-xs font-medium text-foreground">
                    Most passes (1 to {LIMITS.maxUntilIterations})
                  </label>
                  <Input
                    id={id("until-max")}
                    value={step.loop.maxIterations}
                    onChange={(event) =>
                      onChange({
                        loop: { ...step.loop!, maxIterations: event.target.value } as StepDraft["loop"],
                      })
                    }
                    inputMode="numeric"
                  />
                </div>
                <div>
                  <label htmlFor={id("until-exhausted")} className="mb-1 block text-xs font-medium text-foreground">
                    If it never holds
                  </label>
                  <Select
                    id={id("until-exhausted")}
                    value={step.loop.onExhausted}
                    onChange={(event) =>
                      onChange({
                        loop: { ...step.loop!, onExhausted: event.target.value } as StepDraft["loop"],
                      })
                    }
                  >
                    <option value="fail">Fail the step</option>
                    <option value="continue">Keep the last output</option>
                  </Select>
                </div>
              </div>
            </div>
          )}
          <FieldError message={fieldErrors.loop} />
        </Section>

        <Section title="When it fails">
          <label htmlFor={id("on-error")} className="sr-only">
            On error
          </label>
          <Select
            id={id("on-error")}
            value={step.onError}
            onChange={(event) => onChange({ onError: event.target.value as StepDraft["onError"] })}
          >
            <option value="fail">Fail the whole run</option>
            <option value="continue">Continue; steps that wait only for it are skipped</option>
            {!isRetrieval && <option value="fallback">Try a fallback agent</option>}
          </Select>
          {step.onError === "fallback" && (
            <div>
              <label htmlFor={id("fallback")} className="mb-1 block text-xs font-medium text-foreground">
                Fallback agent
              </label>
              <Select
                id={id("fallback")}
                value={step.fallbackAgentId}
                onChange={(event) => onChange({ fallbackAgentId: event.target.value })}
                aria-invalid={Boolean(fieldErrors.fallbackAgentId)}
              >
                <option value="">Choose an agent</option>
                {resources.agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </Select>
              <FieldError message={fieldErrors.fallbackAgentId} />
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor={id("retries")} className="mb-1 block text-xs font-medium text-foreground">
                Retries (0 to {LIMITS.maxRetries})
              </label>
              <Input
                id={id("retries")}
                value={step.maxRetries}
                onChange={(event) => onChange({ maxRetries: event.target.value })}
                inputMode="numeric"
                aria-invalid={Boolean(fieldErrors.maxRetries)}
              />
            </div>
            <div>
              <label htmlFor={id("timeout")} className="mb-1 block text-xs font-medium text-foreground">
                Time limit (seconds)
              </label>
              <Input
                id={id("timeout")}
                value={step.timeoutSeconds}
                onChange={(event) => onChange({ timeoutSeconds: event.target.value })}
                inputMode="numeric"
                placeholder="No step limit"
                aria-invalid={Boolean(fieldErrors.timeoutMs)}
              />
            </div>
          </div>
          <FieldError message={fieldErrors.maxRetries ?? fieldErrors.timeoutMs ?? fieldErrors.onError} />
          <p className="text-xs text-muted-foreground">
            Each retry is another billed call. A step that hits its time limit is stopped, not retried.
          </p>
        </Section>

        {!isRetrieval && (
          <Section
            title="Output"
            hint="JSON lets later steps read fields such as $.steps.name.output.category. The step fails if the reply is not valid JSON."
          >
            <label htmlFor={id("format")} className="sr-only">
              Output format
            </label>
            <Select
              id={id("format")}
              value={step.outputFormat}
              onChange={(event) => onChange({ outputFormat: event.target.value as "text" | "json" })}
            >
              <option value="text">Text</option>
              <option value="json">JSON</option>
            </Select>
            <FieldError message={fieldErrors.outputFormat} />
          </Section>
        )}

        <details className="border-t border-border pt-4">
          <summary className="cursor-pointer text-sm font-semibold text-foreground">Advanced mappings</summary>
          <div className="mt-3 space-y-3">
            <div>
              <label htmlFor={id("input-mapping")} className="mb-1 block text-xs font-medium text-foreground">
                Input mapping (JSON)
              </label>
              <Textarea
                id={id("input-mapping")}
                value={step.inputMapping}
                onChange={(event) => onChange({ inputMapping: event.target.value })}
                rows={4}
                placeholder={'{ "prompt": "$.steps.research.output" }'}
                className="font-mono text-xs"
                aria-invalid={Boolean(fieldErrors.inputMapping)}
              />
              <FieldError message={fieldErrors.inputMapping} />
              <p className="mt-1 text-xs text-muted-foreground">
                The older way to wire a step. A prompt above takes precedence over a mapped prompt.
              </p>
            </div>
            <div>
              <label htmlFor={id("output-mapping")} className="mb-1 block text-xs font-medium text-foreground">
                Output mapping (JSON)
              </label>
              <Textarea
                id={id("output-mapping")}
                value={step.outputMapping}
                onChange={(event) => onChange({ outputMapping: event.target.value })}
                rows={4}
                placeholder={'{ "answer": "$.steps.reply.output" }'}
                className="font-mono text-xs"
                aria-invalid={Boolean(fieldErrors.outputMapping)}
              />
              <FieldError message={fieldErrors.outputMapping} />
              <p className="mt-1 text-xs text-muted-foreground">
                Publishes values into the run&apos;s final output once this step has finished. Without any output
                mapping a run&apos;s output is empty and each step&apos;s output is read from its own result.
              </p>
            </div>
          </div>
        </details>
      </div>

      <div className="border-t border-border p-4">
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-danger transition-colors hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          Delete step
        </button>
      </div>
    </aside>
  );
}
