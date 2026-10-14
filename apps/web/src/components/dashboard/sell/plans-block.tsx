"use client";

import { useEffect, useId, useRef } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import {
  PLAN_WORDS,
  TRIAL_WORDS,
  addPlanRow,
  canAddPlan,
  endPlanDialog,
  endTrialDialog,
  endingPlanLines,
  planChangedNote,
  planEarnLine,
  planPerUseLine,
  removePlanLabel,
  removePlanRow,
  trialEndingLine,
  trialFormOf,
  trialNote,
  trialProblemOf,
  withPlanRow,
  withTrial,
  type PlanEnding,
  type PlanErrors,
  type PlanField,
  type PlanLimits,
  type PlanRow,
  type PlansForm,
  type SavedPlan,
} from "@/lib/sell-plans";

export interface PlansBlockProps {
  form: PlansForm;
  onChange: (form: PlansForm) => void;
  /** Problems, each under the input of the row it is about. */
  errors: PlanErrors;
  limits: PlanLimits;
  /** The plans the listing has now, each with its subscribers; null when they were not read. */
  saved: readonly SavedPlan[] | null;
  /** The listing's price per use as it is typed in the same form. */
  perUsePrice: string;
  disabled?: boolean;
}

/**
 * "Plans": up to four rows under "Pay per use", each a name, a price for 30
 * days, a number of uses and what happens when they run out. Nothing is
 * saved here: the rows go with the listing's own save, and a plan that was
 * taken away ends then.
 *
 * Under the rows, one switch: the listing's trial of some uses at no price,
 * which a buyer starts once. It goes with the same save as one more plan.
 */
export function PlansBlock({ form, onChange, errors, limits, saved, perUsePrice, disabled = false }: PlansBlockProps) {
  const id = useId();
  const confirm = useConfirm();
  const ending = endingPlanLines(form, saved);
  const trial = trialFormOf(form);
  const trialEnding = trialEndingLine(form, saved);
  const trialProblem = trialProblemOf(form, errors);
  const addRef = useRef<HTMLButtonElement>(null);
  const focusAdd = useRef(false);

  // A row was taken away and its button went with it: focus goes to the button that adds one, which is always there then.
  useEffect(() => {
    if (!focusAdd.current) return;
    focusAdd.current = false;
    addRef.current?.focus();
  }, [form.rows.length]);

  async function remove(row: PlanRow) {
    // A plan people are on: they are told what they keep before it goes.
    const dialog = endPlanDialog(row, saved);
    if (dialog && !(await confirm({ ...dialog, destructive: true }))) return;
    focusAdd.current = true;
    onChange(removePlanRow(form, row.key));
  }

  async function switchTrial(on: boolean) {
    // Switching off a trial people are on: they are told what those people keep before it goes.
    const dialog = on ? null : endTrialDialog(form, saved, limits);
    if (dialog && !(await confirm({ ...dialog, destructive: true }))) return;
    onChange(withTrial(form, { on }));
  }

  return (
    <section aria-labelledby={`${id}-title`} className="mt-5 space-y-3 sm:ml-7">
      <h3 id={`${id}-title`} className="text-sm font-semibold text-foreground">
        {PLAN_WORDS.title}
      </h3>

      {errors.set && (
        <p role="alert" className="text-sm text-danger">
          {errors.set}
        </p>
      )}

      {form.rows.map((row, index) => (
        <PlanRowFields
          key={row.key}
          id={`${id}-${row.key}`}
          number={index + 1}
          row={row}
          errors={errors.rows[index] ?? {}}
          limits={limits}
          perUsePrice={perUsePrice}
          changedNote={planChangedNote(row, saved)}
          disabled={disabled}
          onChange={(patch) => onChange(withPlanRow(form, row.key, patch))}
          onRemove={() => void remove(row)}
        />
      ))}

      {ending.map((line) => (
        <p key={line} role="status" className="text-sm text-muted-foreground">
          {line}
        </p>
      ))}

      {canAddPlan(form, limits) && (
        <Button ref={addRef} type="button" variant="outline" size="sm" onClick={() => onChange(addPlanRow(form, limits))} disabled={disabled}>
          <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
          {PLAN_WORDS.add}
        </Button>
      )}

      <div className="space-y-3 rounded-md border bg-card p-4">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor={`${id}-trial`} className="text-sm font-normal text-foreground">
            {TRIAL_WORDS.offer}
          </Label>
          <Switch id={`${id}-trial`} checked={trial.on} onCheckedChange={(on) => void switchTrial(on)} disabled={disabled} />
        </div>

        {/* Switched off, not yet saved: said beside the switch that did it. */}
        {trialEnding && (
          <p role="status" className="text-sm text-muted-foreground">
            {trialEnding}
          </p>
        )}

        {trial.on && (
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-trial-uses`}>{TRIAL_WORDS.uses}</Label>
            <Input
              id={`${id}-trial-uses`}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              className="max-w-48"
              value={trial.uses}
              placeholder="20"
              onChange={(event) => onChange(withTrial(form, { uses: event.target.value }))}
              aria-describedby={trialProblem ? `${id}-trial-error ${id}-trial-note` : `${id}-trial-note`}
              aria-invalid={trialProblem ? true : undefined}
              disabled={disabled}
            />
            {trialProblem && (
              <p id={`${id}-trial-error`} role="alert" className="text-sm text-danger">
                {trialProblem}
              </p>
            )}
            <p id={`${id}-trial-note`} className="text-sm text-muted-foreground">
              {trialNote(limits)}
            </p>
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">{PLAN_WORDS.noUnlimited}</p>
    </section>
  );
}

interface PlanRowFieldsProps {
  id: string;
  /** 1 for the first plan: the same number a problem names it by. */
  number: number;
  row: PlanRow;
  errors: Partial<Record<PlanField, string>>;
  limits: PlanLimits;
  perUsePrice: string;
  changedNote: string | null;
  disabled: boolean;
  onChange: (patch: Partial<Omit<PlanRow, "key" | "id">>) => void;
  onRemove: () => void;
}

function PlanRowFields({ id, number, row, errors, limits, perUsePrice, changedNote, disabled, onChange, onRemove }: PlanRowFieldsProps) {
  const earn = planEarnLine(row, limits);
  const perUse = planPerUseLine(row, perUsePrice);

  /** One labelled input with its sentence under it. */
  function field(
    name: "name" | "price" | "uses" | "extraPrice",
    label: string,
    options: { money?: boolean; placeholder?: string; inputMode?: "decimal" | "numeric" },
  ) {
    const inputId = `${id}-${name}`;
    const error = errors[name];
    return (
      <div className="min-w-0 space-y-1.5">
        <Label htmlFor={inputId}>{label}</Label>
        <div className="flex items-center gap-2">
          {options.money && (
            <span className="text-muted-foreground" aria-hidden="true">
              $
            </span>
          )}
          <Input
            id={inputId}
            type="text"
            inputMode={options.inputMode}
            autoComplete="off"
            value={row[name]}
            placeholder={options.placeholder}
            onChange={(event) => onChange({ [name]: event.target.value })}
            aria-describedby={error ? `${inputId}-error` : undefined}
            aria-invalid={error ? true : undefined}
            disabled={disabled}
          />
        </div>
        {error && (
          <p id={`${inputId}-error`} role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div role="group" aria-label={`Plan ${number}`} className="space-y-4 rounded-md border bg-card p-4">
      <div className="grid gap-4 sm:grid-cols-3">
        {field("name", PLAN_WORDS.name, { placeholder: "Starter" })}
        {field("price", PLAN_WORDS.price, { money: true, placeholder: "9.00", inputMode: "decimal" })}
        {field("uses", PLAN_WORDS.uses, { placeholder: "500", inputMode: "numeric" })}
      </div>

      <div className="space-y-2">
        <p id={`${id}-ending`} className="text-sm font-medium text-foreground">
          {PLAN_WORDS.whenOut}
        </p>
        <RadioGroup value={row.ending} onValueChange={(value) => onChange({ ending: value as PlanEnding })} className="gap-2">
          {(
            [
              ["stop", PLAN_WORDS.stop],
              ["extra", PLAN_WORDS.extra],
            ] as const
          ).map(([value, label]) => (
            <div key={value} className="flex items-center gap-2">
              <RadioGroupItem
                value={value}
                id={`${id}-ending-${value}`}
                className="shrink-0"
                aria-labelledby={`${id}-ending-${value}-label`}
                aria-describedby={`${id}-ending`}
                disabled={disabled}
              />
              <Label id={`${id}-ending-${value}-label`} htmlFor={`${id}-ending-${value}`} className="text-sm font-normal text-foreground">
                {label}
              </Label>
            </div>
          ))}
        </RadioGroup>
        {row.ending === "extra" && (
          <div className="max-w-48 sm:ml-6">
            {field("extraPrice", PLAN_WORDS.extraPrice, {
              money: true,
              placeholder: (limits.minExtraUsePriceCents / 100).toFixed(2),
              inputMode: "decimal",
            })}
          </div>
        )}
      </div>

      {errors.row && (
        <p role="alert" className="text-sm text-danger">
          {errors.row}
        </p>
      )}

      <div aria-live="polite" className="space-y-0.5">
        {earn && <p className="text-sm font-medium text-foreground">{earn}</p>}
        {perUse && <p className="text-sm text-muted-foreground">{perUse}</p>}
      </div>

      {changedNote && (
        <p role="status" className="text-sm text-muted-foreground">
          {changedNote}
        </p>
      )}

      <div className="flex justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={onRemove} disabled={disabled}>
          {removePlanLabel(row)}
          <span className="sr-only"> (plan {number})</span>
        </Button>
      </div>
    </div>
  );
}
