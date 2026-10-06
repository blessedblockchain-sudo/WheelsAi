"use client";

import { useRef } from "react";

import { Textarea } from "@/components/ui/textarea";
import type { VariableChip } from "./workflow-model";

/**
 * A prompt template with insert-variable chips. A chip puts its
 * `{{reference}}` at the cursor, so authors never type a step name by
 * hand (or mistype one).
 */
export function TemplateField({
  id,
  value,
  onChange,
  variables,
  placeholder,
  rows = 6,
  invalid = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  variables: VariableChip[];
  placeholder?: string;
  rows?: number;
  invalid?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  function insert(text: string) {
    const element = ref.current;
    const start = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + text + value.slice(end));
    // Put the cursor after the inserted variable once React has re-rendered.
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(start + text.length, start + text.length);
    });
  }

  return (
    <div className="space-y-2">
      <Textarea
        id={id}
        ref={ref}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={rows}
        aria-invalid={invalid}
        className={`font-mono text-xs ${invalid ? "border-danger" : ""}`}
      />
      <VariableChips variables={variables} onPick={(chip) => insert(chip.template)} />
    </div>
  );
}

export function VariableChips({
  variables,
  onPick,
  label = "Insert",
}: {
  variables: VariableChip[];
  onPick: (chip: VariableChip) => void;
  label?: string;
}) {
  if (variables.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {variables.map((chip) => (
        <button
          key={chip.template}
          type="button"
          onClick={() => onPick(chip)}
          title={chip.template}
          className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-foreground transition-colors hover:border-primary/50 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}
