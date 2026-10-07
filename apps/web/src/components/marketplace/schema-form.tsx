"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { FREEFORM_FIELD, fieldsFromSchema, type FormValues, type SchemaField } from "@/lib/schema-form";

interface SchemaFormProps {
  /** The offering's input schema; null draws one JSON box. */
  schema: unknown;
  values: FormValues;
  onChange: (values: FormValues) => void;
  /** Field name -> problem, from buildInput() or the server (issuesByField). */
  errors?: Record<string, string>;
  disabled?: boolean;
  /** Keeps ids unique when two forms are on one page. */
  idPrefix?: string;
}

function hint(field: SchemaField): string | null {
  const parts: string[] = [];
  if (field.min !== undefined && field.max !== undefined) parts.push(`${field.min} to ${field.max}`);
  else if (field.min !== undefined) parts.push(`at least ${field.min}`);
  else if (field.max !== undefined) parts.push(`at most ${field.max}`);
  if (field.maxLength !== undefined && field.kind !== "enum") parts.push(`up to ${field.maxLength} characters`);
  if (field.kind === "string-array") parts.push("one per line");
  if (field.kind === "json") parts.push("JSON");
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * A form drawn from a JSON Schema: what a buyer fills in to hire an
 * offering, and what a publisher fills in to test-run their own. Holds no
 * state; the pure helpers in lib/schema-form.ts read and build the values.
 */
export function SchemaForm({ schema, values, onChange, errors = {}, disabled, idPrefix = "input" }: SchemaFormProps) {
  const { fields, freeform } = fieldsFromSchema(schema);
  const set = (name: string, value: string | boolean) => onChange({ ...values, [name]: value });

  if (freeform) {
    const id = `${idPrefix}-json`;
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id}>Input (JSON)</Label>
        <Textarea
          id={id}
          value={String(values[FREEFORM_FIELD] ?? "")}
          onChange={(e) => set(FREEFORM_FIELD, e.target.value)}
          disabled={disabled}
          rows={6}
          spellCheck={false}
          className="font-mono text-xs"
          error={errors[FREEFORM_FIELD]}
          aria-describedby={`${id}-hint`}
        />
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          This offering does not describe its input, so it takes any JSON object.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {errors[""] && (
        <p role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          {errors[""]}
        </p>
      )}
      {fields.map((field) => {
        const id = `${idPrefix}-${field.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
        const error = errors[field.name];
        const note = [field.description, hint(field)].filter(Boolean).join(" · ");
        const described = note ? `${id}-hint` : undefined;
        const value = values[field.name];
        const text = typeof value === "string" ? value : "";

        if (field.kind === "boolean") {
          return (
            <div key={field.name} className="flex items-start justify-between gap-4">
              <div>
                <Label htmlFor={id}>{field.title}</Label>
                {note && (
                  <p id={described} className="text-xs text-muted-foreground">
                    {note}
                  </p>
                )}
              </div>
              <Switch
                id={id}
                checked={value === true}
                onCheckedChange={(checked) => set(field.name, checked)}
                disabled={disabled}
                aria-describedby={described}
              />
            </div>
          );
        }

        return (
          <div key={field.name} className="space-y-1.5">
            <Label htmlFor={id}>
              {field.title}
              {field.required && (
                <span className="text-danger" aria-hidden>
                  {" "}
                  *
                </span>
              )}
            </Label>
            {field.kind === "enum" ? (
              <Select
                id={id}
                value={text}
                onChange={(e) => set(field.name, e.target.value)}
                disabled={disabled}
                required={field.required}
                error={error}
                aria-describedby={described}
              >
                <option value="">{field.required ? "Choose…" : "No preference"}</option>
                {field.options?.map((option) => (
                  <option key={String(option)} value={String(option)}>
                    {String(option)}
                  </option>
                ))}
              </Select>
            ) : field.kind === "text" || field.kind === "string-array" || field.kind === "json" ? (
              <Textarea
                id={id}
                value={text}
                onChange={(e) => set(field.name, e.target.value)}
                disabled={disabled}
                required={field.required}
                rows={field.kind === "text" ? 4 : 3}
                maxLength={field.kind === "text" ? field.maxLength : undefined}
                spellCheck={field.kind === "text"}
                className={field.kind === "json" ? "font-mono text-xs" : undefined}
                error={error}
                aria-describedby={described}
              />
            ) : (
              <Input
                id={id}
                type={
                  field.kind === "number" || field.kind === "integer"
                    ? "number"
                    : field.format === "email"
                      ? "email"
                      : field.format === "uri"
                        ? "url"
                        : "text"
                }
                inputMode={field.kind === "integer" ? "numeric" : field.kind === "number" ? "decimal" : undefined}
                step={field.kind === "integer" ? 1 : field.kind === "number" ? "any" : undefined}
                min={field.min}
                max={field.max}
                maxLength={field.kind === "string" ? field.maxLength : undefined}
                value={text}
                onChange={(e) => set(field.name, e.target.value)}
                disabled={disabled}
                required={field.required}
                error={error}
                aria-describedby={described}
              />
            )}
            {note && (
              <p id={described} className="text-xs text-muted-foreground">
                {note}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
