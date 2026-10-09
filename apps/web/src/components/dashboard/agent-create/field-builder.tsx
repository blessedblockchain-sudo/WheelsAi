"use client";

import { useId, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";

import { SchemaForm } from "@/components/marketplace/schema-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  FORM_FULL_MESSAGE,
  addField,
  canAddField,
  checkFields,
  editField,
  moveField,
  previewKey,
  removeField,
  settleKeys,
  type FieldDraft,
  type FieldIssues,
} from "@/lib/field-builder";
import type { FormValues } from "@/lib/schema-form";
import { cn } from "@/lib/utils";
import {
  TASK_FIELD_TYPES,
  TASK_FIELD_TYPE_LABELS,
  taskInputSchema,
  type TaskFieldType,
} from "@wheelsai/shared/agent-kind";

export interface FieldBuilderProps {
  /** The questions, in order. Make the first list with `defaultDrafts` or `draftsFromFields` (lib/field-builder). */
  value: FieldDraft[];
  onChange: (fields: FieldDraft[]) => void;
  /** Problems the server found, per draft id (`serverFieldIssues`). Shown over the builder's own. */
  issues?: Record<string, FieldIssues>;
  /** A problem with the form as a whole, from the server. */
  formIssue?: string | null;
  /** Shows every problem at once, not only those of questions already worked on. */
  showAllProblems?: boolean;
  disabled?: boolean;
}

const iconButton =
  "inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

/**
 * "What do you need from people?": the questions of a task agent's form,
 * with a live preview of the form they make. Holds no questions of its own:
 * `value` in, `onChange` out. The moves are the pure functions of
 * lib/field-builder.
 */
export function FieldBuilder({ value, onChange, issues = {}, formIssue, showAllProblems, disabled }: FieldBuilderProps) {
  const uid = useId();
  const counter = useRef(0);
  /** Questions whose label has been worked on: their problems are shown. */
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [advancedOpen, setAdvancedOpen] = useState<Set<string>>(new Set());
  const [previewValues, setPreviewValues] = useState<FormValues>({});

  const check = useMemo(() => checkFields(value), [value]);
  const schema = useMemo(() => taskInputSchema(check.fields), [check.fields]);
  const full = !canAddField(value);

  const touch = (id: string) => setTouched((seen) => (seen.has(id) ? seen : new Set(seen).add(id)));
  const toggleAdvanced = (id: string) =>
    setAdvancedOpen((open) => {
      const next = new Set(open);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  function problemsOf(draft: FieldDraft): FieldIssues {
    const own = check.issues[draft.id] ?? {};
    const shown: FieldIssues = showAllProblems || touched.has(draft.id) ? { ...own } : {};
    // Two questions with one name in code is said at once: either could be the one meant.
    if (own.key && !shown.key) shown.key = own.key;
    return { ...shown, ...(issues[draft.id] ?? {}) };
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="min-w-0 space-y-4">
        <ol className="space-y-4">
          {value.map((draft, index) => {
            const base = `${uid}-${draft.id}`;
            const problems = problemsOf(draft);
            const showKey = advancedOpen.has(draft.id) || Boolean(problems.key);
            const keyHint = previewKey(value, draft.id);
            return (
              <li key={draft.id} className="rounded-lg border border-border bg-background p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-foreground">Question {index + 1}</p>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className={iconButton}
                      aria-label={`Move up question ${index + 1}`}
                      title="Move up"
                      disabled={disabled || index === 0}
                      onClick={() => onChange(moveField(value, draft.id, -1))}
                    >
                      <ArrowUp className="h-4 w-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      className={iconButton}
                      aria-label={`Move down question ${index + 1}`}
                      title="Move down"
                      disabled={disabled || index === value.length - 1}
                      onClick={() => onChange(moveField(value, draft.id, 1))}
                    >
                      <ArrowDown className="h-4 w-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      className={cn(iconButton, "hover:text-danger")}
                      aria-label={`Remove question ${index + 1}`}
                      title="Remove"
                      // A form needs at least one question.
                      disabled={disabled || value.length === 1}
                      onClick={() => onChange(removeField(value, draft.id))}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  </div>
                </div>

                <div className="mt-3 grid gap-4 sm:grid-cols-[minmax(0,1fr)_11rem]">
                  <div className="space-y-1.5">
                    <Label htmlFor={`${base}-label`}>Label</Label>
                    <Input
                      id={`${base}-label`}
                      value={draft.label}
                      disabled={disabled}
                      error={problems.label}
                      onChange={(e) => onChange(editField(value, draft.id, { label: e.target.value }))}
                      onBlur={() => {
                        touch(draft.id);
                        // The name in code is made from the first label, then kept.
                        if (!draft.key.trim() && draft.label.trim()) onChange(settleKeys(value, draft.id));
                      }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`${base}-type`}>Type</Label>
                    <Select
                      id={`${base}-type`}
                      value={draft.type}
                      disabled={disabled}
                      error={problems.type}
                      onChange={(e) => onChange(editField(value, draft.id, { type: e.target.value as TaskFieldType }))}
                    >
                      {TASK_FIELD_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {TASK_FIELD_TYPE_LABELS[type]}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>

                {draft.type === "choice" && (
                  <div className="mt-4 space-y-1.5">
                    <Label htmlFor={`${base}-options`}>Options, one per line</Label>
                    <Textarea
                      id={`${base}-options`}
                      value={draft.options}
                      rows={3}
                      disabled={disabled}
                      error={problems.options}
                      onChange={(e) => onChange(editField(value, draft.id, { options: e.target.value }))}
                      onBlur={() => touch(draft.id)}
                    />
                  </div>
                )}

                <div className="mt-4 space-y-1.5">
                  <Label htmlFor={`${base}-help`}>Help text (optional)</Label>
                  <Input
                    id={`${base}-help`}
                    value={draft.help}
                    disabled={disabled}
                    error={problems.help}
                    onChange={(e) => onChange(editField(value, draft.id, { help: e.target.value }))}
                  />
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Switch
                      id={`${base}-required`}
                      checked={draft.required}
                      disabled={disabled}
                      onCheckedChange={(required) => onChange(editField(value, draft.id, { required }))}
                    />
                    <Label htmlFor={`${base}-required`}>Required</Label>
                  </div>
                  <button
                    type="button"
                    aria-expanded={showKey}
                    aria-controls={`${base}-advanced`}
                    onClick={() => toggleAdvanced(draft.id)}
                    className="inline-flex items-center gap-1 rounded-sm text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {showKey ? (
                      <ChevronDown className="h-4 w-4" aria-hidden />
                    ) : (
                      <ChevronRight className="h-4 w-4" aria-hidden />
                    )}
                    Advanced
                  </button>
                </div>

                {showKey && (
                  <div id={`${base}-advanced`} className="mt-3 space-y-1.5">
                    <Label htmlFor={`${base}-key`}>Name in code</Label>
                    <Input
                      id={`${base}-key`}
                      value={draft.key}
                      disabled={disabled}
                      placeholder={keyHint}
                      spellCheck={false}
                      autoComplete="off"
                      className="font-mono"
                      error={problems.key}
                      onChange={(e) => onChange(editField(value, draft.id, { key: e.target.value }))}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ol>

        <div className="space-y-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || full}
            aria-describedby={full ? `${uid}-full` : undefined}
            onClick={() => {
              counter.current += 1;
              onChange(addField(value, `${uid}n${counter.current}`));
            }}
          >
            <Plus className="mr-2 h-4 w-4" aria-hidden />
            Add a question
          </Button>
          {full && (
            <p id={`${uid}-full`} className="text-sm text-muted-foreground">
              {FORM_FULL_MESSAGE}
            </p>
          )}
          {(formIssue || check.formIssue) && (
            <p role="alert" className="text-sm text-danger">
              {formIssue || check.formIssue}
            </p>
          )}
        </div>
      </div>

      <div className="min-w-0">
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm font-medium text-foreground">Preview</p>
          <p className="mt-1 text-sm text-muted-foreground">This is the form people fill in.</p>
          <div className="mt-4">
            {check.fields.length > 0 ? (
              <SchemaForm
                schema={schema}
                values={previewValues}
                onChange={setPreviewValues}
                idPrefix={`${uid}-preview`}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Give a question a label to see it here.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
