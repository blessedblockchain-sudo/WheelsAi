"use client";

import { Plus, X } from "lucide-react";

import type { AlertChannel, Deployment, KnowledgeBase, TaskTypeField, UptimeMonitor } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  isFieldVisible,
  type FieldValue,
  type FormErrors,
  type HeaderRow,
  type SourceRow,
} from "./task-form-model";

/** What the resource pickers choose from. `null` means the list could not be loaded. */
export interface TaskFieldOptions {
  knowledgeBases: KnowledgeBase[] | null;
  deployments: Deployment[] | null;
  monitors: UptimeMonitor[] | null;
  alertChannels: AlertChannel[] | null;
}

const rowButton =
  "rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const addButton =
  "inline-flex items-center gap-1 rounded text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function ResourceSelect({
  id,
  value,
  onChange,
  required,
  items,
  noun,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  required: boolean;
  items: Array<{ id: string; label: string }> | null;
  noun: string;
  invalid: boolean;
}) {
  if (items === null) {
    return (
      <p className="text-xs text-danger">
        Your {noun}s could not be loaded. Close this form and try again.
      </p>
    );
  }
  return (
    <>
      <Select id={id} value={value} onChange={(event) => onChange(event.target.value)} aria-invalid={invalid}>
        <option value="">{required ? `Choose a ${noun}` : `No ${noun}`}</option>
        {value !== "" && !items.some((item) => item.id === value) && (
          <option value={value}>Deleted {noun} ({value.slice(0, 8)})</option>
        )}
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label}
          </option>
        ))}
      </Select>
      {items.length === 0 && <p className="mt-1 text-xs text-muted-foreground">You have no {noun}s yet.</p>}
    </>
  );
}

/**
 * The payload inputs of one task type, rendered from the field list the
 * API publishes. A new task type, field or option appears here without a
 * change to this file; an option the server cannot honour is shown,
 * disabled, with the server's reason.
 */
export function TaskTypeFields({
  fields,
  values,
  errors,
  options,
  onChange,
}: {
  fields: TaskTypeField[];
  values: Record<string, FieldValue>;
  errors: FormErrors;
  options: TaskFieldOptions;
  onChange: (key: string, value: FieldValue) => void;
}) {
  return (
    <>
      {fields
        .filter((field) => isFieldVisible(field, values))
        .map((field) => {
          const id = `task-field-${field.key}`;
          const error = errors[`payload.${field.key}`];
          const value = values[field.key];
          const text = typeof value === "string" ? value : "";
          const label = (
            <label htmlFor={id} className="mb-1 block text-sm font-medium text-foreground">
              {field.label}
              {!field.required && field.kind !== "boolean" && (
                <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
              )}
            </label>
          );

          let control: React.ReactNode;
          switch (field.kind) {
            case "boolean":
              control = (
                <div className="flex items-center gap-2">
                  <Switch
                    id={id}
                    checked={value === true}
                    onCheckedChange={(checked) => onChange(field.key, checked)}
                    aria-label={field.label}
                  />
                  <span className="text-sm text-foreground">{field.label}</span>
                </div>
              );
              break;
            case "textarea":
              control = (
                <Textarea
                  id={id}
                  value={text}
                  onChange={(event) => onChange(field.key, event.target.value)}
                  rows={4}
                  maxLength={field.max}
                  aria-invalid={Boolean(error)}
                />
              );
              break;
            case "json":
              control = (
                <Textarea
                  id={id}
                  value={text}
                  onChange={(event) => onChange(field.key, event.target.value)}
                  rows={4}
                  placeholder='{ "key": "value" }'
                  className="font-mono text-xs"
                  aria-invalid={Boolean(error)}
                />
              );
              break;
            case "number":
              control = (
                <Input
                  id={id}
                  value={text}
                  onChange={(event) => onChange(field.key, event.target.value)}
                  inputMode="decimal"
                  placeholder={
                    field.min !== undefined && field.max !== undefined ? `${field.min} to ${field.max}` : undefined
                  }
                  aria-invalid={Boolean(error)}
                />
              );
              break;
            case "select": {
              const chosen = field.options?.find((o) => o.value === text);
              control = (
                <>
                  <Select
                    id={id}
                    value={text}
                    onChange={(event) => onChange(field.key, event.target.value)}
                    aria-invalid={Boolean(error)}
                  >
                    {!field.required && <option value="">Default</option>}
                    {field.options?.map((option) => (
                      <option key={option.value} value={option.value} disabled={!option.available}>
                        {option.label}
                        {option.available ? "" : " (not available)"}
                      </option>
                    ))}
                  </Select>
                  {/* Say why an option is greyed out; nothing is hidden. */}
                  {field.options
                    ?.filter((o) => !o.available && o.reason && o !== chosen)
                    .map((o) => (
                      <p key={o.value} className="mt-1 text-xs text-muted-foreground">
                        {o.label}: {o.reason}
                      </p>
                    ))}
                </>
              );
              break;
            }
            case "headers": {
              const rows = Array.isArray(value) ? (value as HeaderRow[]) : [];
              const set = (next: HeaderRow[]) => onChange(field.key, next);
              control = (
                <div className="space-y-2">
                  {rows.map((row, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <Input
                        aria-label={`Header ${index + 1} name`}
                        value={row.name}
                        onChange={(event) => set(rows.map((r, i) => (i === index ? { ...r, name: event.target.value } : r)))}
                        placeholder="X-Source"
                      />
                      <Input
                        aria-label={`Header ${index + 1} value`}
                        value={row.value}
                        onChange={(event) => set(rows.map((r, i) => (i === index ? { ...r, value: event.target.value } : r)))}
                        placeholder="wheelsai"
                      />
                      <button
                        type="button"
                        onClick={() => set(rows.filter((_, i) => i !== index))}
                        aria-label={`Remove header ${index + 1}`}
                        className={rowButton}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                  <button type="button" onClick={() => set([...rows, { name: "", value: "" }])} className={addButton}>
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    Add a header
                  </button>
                </div>
              );
              break;
            }
            case "sources": {
              const rows = Array.isArray(value) ? (value as SourceRow[]) : [];
              const set = (next: SourceRow[]) => onChange(field.key, next);
              control = (
                <div className="space-y-2">
                  {rows.map((row, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <Input
                        aria-label={`Source ${index + 1} URL`}
                        value={row.url}
                        onChange={(event) => set(rows.map((r, i) => (i === index ? { ...r, url: event.target.value } : r)))}
                        placeholder="https://example.com/docs/pricing"
                        type="url"
                      />
                      <Input
                        aria-label={`Source ${index + 1} title (optional)`}
                        value={row.title}
                        onChange={(event) => set(rows.map((r, i) => (i === index ? { ...r, title: event.target.value } : r)))}
                        placeholder="Title (optional)"
                        className="max-w-[11rem]"
                      />
                      <button
                        type="button"
                        onClick={() => set(rows.filter((_, i) => i !== index))}
                        aria-label={`Remove source ${index + 1}`}
                        className={rowButton}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                  {(field.max === undefined || rows.length < field.max) && (
                    <button type="button" onClick={() => set([...rows, { url: "", title: "" }])} className={addButton}>
                      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                      Add a source
                    </button>
                  )}
                </div>
              );
              break;
            }
            case "knowledge_base":
              control = (
                <ResourceSelect
                  id={id}
                  value={text}
                  onChange={(next) => onChange(field.key, next)}
                  required={field.required}
                  noun="knowledge base"
                  invalid={Boolean(error)}
                  items={options.knowledgeBases?.map((k) => ({ id: k.id, label: k.name })) ?? null}
                />
              );
              break;
            case "deployment":
              control = (
                <ResourceSelect
                  id={id}
                  value={text}
                  onChange={(next) => onChange(field.key, next)}
                  required={field.required}
                  noun="deployment"
                  invalid={Boolean(error)}
                  items={options.deployments?.map((d) => ({ id: d.id, label: `${d.name} (${d.status})` })) ?? null}
                />
              );
              break;
            case "monitor":
              control = (
                <ResourceSelect
                  id={id}
                  value={text}
                  onChange={(next) => onChange(field.key, next)}
                  required={field.required}
                  noun="uptime monitor"
                  invalid={Boolean(error)}
                  items={options.monitors?.map((m) => ({ id: m.id, label: m.name })) ?? null}
                />
              );
              break;
            case "alert_channel":
              control = (
                <ResourceSelect
                  id={id}
                  value={text}
                  onChange={(next) => onChange(field.key, next)}
                  required={field.required}
                  noun="alert channel"
                  invalid={Boolean(error)}
                  items={options.alertChannels?.map((c) => ({ id: c.id, label: `${c.name} (${c.type})` })) ?? null}
                />
              );
              break;
            default:
              control = (
                <Input
                  id={id}
                  value={text}
                  onChange={(event) => onChange(field.key, event.target.value)}
                  type={field.kind === "url" ? "url" : "text"}
                  placeholder={field.kind === "url" ? "https://" : undefined}
                  maxLength={field.max}
                  aria-invalid={Boolean(error)}
                />
              );
          }

          return (
            <div key={field.key}>
              {field.kind !== "boolean" && label}
              {control}
              {field.help && <p className="mt-1 text-xs text-muted-foreground">{field.help}</p>}
              {error && (
                <p role="alert" className="mt-1 text-xs text-danger">
                  {error}
                </p>
              )}
            </div>
          );
        })}
    </>
  );
}
