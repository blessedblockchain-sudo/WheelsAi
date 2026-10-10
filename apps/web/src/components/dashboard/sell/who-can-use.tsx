"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import type { AgentKind } from "@/lib/api";
import {
  SELL_WORDS,
  asksForPayment,
  capacityLine,
  choicesOf,
  copiesDialog,
  copiesKeptLine,
  earningsLine,
  outboundToolsOf,
  switchToCopiesLine,
  withChoice,
  withCopies,
  withUse,
  type SellChoice,
  type SellChoiceId,
  type SellErrors,
  type SellForm,
  type SellLimits,
  type SellListing,
} from "@/lib/sell-choice";
import { cn } from "@/lib/utils";

export interface WhoCanUseProps {
  /** The agent the question is about: its kind decides the choices, its tools the switch. */
  agent: { agentKind: AgentKind; tools?: unknown };
  form: SellForm;
  onChange: (form: SellForm) => void;
  /** Problems, each under the input it is about. */
  errors?: SellErrors;
  limits: SellLimits;
  /** Answers a day on the platform's models on the owner's plan; null when it could not be read. */
  capacity?: number | null;
  /** "Keep a copy of what people send": left out, the switch is not shown. */
  keepCopy?: { checked: boolean; onChange: (checked: boolean) => void };
  /** The listing the agent has now, for what a change does to the people who already pay. */
  listing?: SellListing | null;
  /** Called after the copies dialog was confirmed, with the form as it then is. */
  onSoldAsCopies?: (form: SellForm) => void;
  /** More to offer under "More options", above "Sell copies instead". */
  moreOptions?: ReactNode;
  disabled?: boolean;
}

const PRICE_FIELD: Partial<Record<SellChoiceId, "perUsePrice" | "monthlyPrice">> = {
  per_use: "perUsePrice",
  monthly: "monthlyPrice",
};

/**
 * "Who can use it?": the one question that puts use of an agent on sale,
 * with its choices, the price, what the creator earns and what people who
 * pay get. The Sell tab and the listing wizard both show this.
 */
export function WhoCanUse({
  agent,
  form,
  onChange,
  errors = {},
  limits,
  capacity,
  keepCopy,
  listing,
  onSoldAsCopies,
  moreOptions,
  disabled = false,
}: WhoCanUseProps) {
  const id = useId();
  const confirm = useConfirm();
  const [moreOpen, setMoreOpen] = useState(false);
  const useInsteadRef = useRef<HTMLButtonElement>(null);
  const firstChoiceRef = useRef<HTMLButtonElement>(null);
  const previousSells = useRef(form.sells);

  const choices = choicesOf(form, agent.agentKind, limits);
  const paid = asksForPayment(form);
  const earnings = earningsLine(form, agent.agentKind, limits);
  const capacityText = form.sells === "use" ? capacityLine(capacity) : null;
  const hasOutboundTool = outboundToolsOf(agent.tools).length > 0;
  const copiesKept = form.sells === "use" ? copiesKeptLine(listing) : null;

  // What is sold changed: the control that did it is gone, so focus goes to what took its place.
  useEffect(() => {
    if (previousSells.current === form.sells) return;
    previousSells.current = form.sells;
    if (form.sells === "copies") useInsteadRef.current?.focus();
    else firstChoiceRef.current?.focus();
  }, [form.sells]);

  async function sellCopies() {
    const dialog = copiesDialog(agent.agentKind);
    const effect = switchToCopiesLine(listing);
    const ok = await confirm({
      title: dialog.title,
      description: effect ? (
        <>
          <span className="block">{dialog.description}</span>
          <span className="mt-2 block">{effect}</span>
        </>
      ) : (
        dialog.description
      ),
      confirmLabel: dialog.confirmLabel,
      destructive: true,
    });
    const next = withCopies(form, ok);
    if (next === form) return;
    onChange(next);
    onSoldAsCopies?.(next);
  }

  function priceField(choice: SellChoice) {
    const field = PRICE_FIELD[choice.id];
    if (!field || !choice.priceLabel) return null;
    const inputId = `${id}-${field}`;
    const error = errors[field];
    const described = [error ? `${inputId}-error` : null, choice.priceHint ? `${inputId}-hint` : null, earnings ? `${inputId}-earn` : null]
      .filter(Boolean)
      .join(" ");
    return (
      <div className="mt-4 space-y-1.5 sm:ml-7">
        <Label htmlFor={inputId}>{choice.priceLabel}</Label>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground" aria-hidden="true">
            $
          </span>
          <div className="w-32">
            <Input
              id={inputId}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={form[field]}
              onChange={(event) => onChange({ ...form, [field]: event.target.value })}
              placeholder={field === "perUsePrice" ? (limits.minPerUseCents / 100).toFixed(2) : "9.00"}
              aria-describedby={described || undefined}
              aria-invalid={error ? true : undefined}
              disabled={disabled}
            />
          </div>
        </div>
        {error && (
          <p id={`${inputId}-error`} role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {choice.priceHint && (
          <p id={`${inputId}-hint`} className="text-xs text-muted-foreground">
            {choice.priceHint}
          </p>
        )}
        <p id={`${inputId}-earn`} aria-live="polite" className="text-sm font-medium text-foreground">
          {earnings}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 id={`${id}-question`} className="text-lg font-semibold text-foreground">
          {SELL_WORDS.question}
        </h2>
        {form.sells === "use" && <p className="text-sm text-muted-foreground">{SELL_WORDS.lead}</p>}
      </div>

      {form.sells === "copies" && (
        <div className="flex flex-col gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-foreground">{SELL_WORDS.sellsCopies}</p>
          <Button
            ref={useInsteadRef}
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 self-start sm:self-auto"
            onClick={() => onChange(withUse(form, agent.agentKind))}
            disabled={disabled}
          >
            {SELL_WORDS.sellUseInstead}
          </Button>
        </div>
      )}

      {copiesKept && (
        <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-foreground">
          {copiesKept}
        </p>
      )}

      <fieldset className="min-w-0" disabled={disabled}>
        <legend className="sr-only">{SELL_WORDS.question}</legend>
        <RadioGroup
          value={form.choice}
          onValueChange={(value) => onChange(withChoice(form, value as SellChoiceId, choices))}
          className="space-y-3"
        >
          {choices.map((choice, index) => {
            const selected = form.choice === choice.id;
            const radioId = `${id}-choice-${choice.id}`;
            const open = choice.selectable && !disabled;
            return (
              <div
                key={choice.id}
                className={cn(
                  "rounded-lg border p-4 transition-colors",
                  selected ? "border-primary bg-primary/10" : open && "hover:bg-muted",
                  !choice.selectable && "bg-muted/40",
                )}
              >
                <div
                  className={cn("flex items-start gap-3", open && "cursor-pointer")}
                  onClick={open ? () => onChange(withChoice(form, choice.id, choices)) : undefined}
                >
                  <RadioGroupItem
                    ref={index === 0 ? firstChoiceRef : undefined}
                    value={choice.id}
                    id={radioId}
                    className="mt-1 shrink-0"
                    disabled={!open}
                    aria-labelledby={`${radioId}-title`}
                    aria-describedby={`${radioId}-sentence`}
                    onClick={(event) => {
                      // The row's own click selects; without this the choice would be picked twice.
                      event.stopPropagation();
                      onChange(withChoice(form, choice.id, choices));
                    }}
                  />
                  <div className="min-w-0">
                    <p
                      id={`${radioId}-title`}
                      className={cn("font-medium", choice.selectable ? "text-foreground" : "text-muted-foreground")}
                    >
                      {choice.title}
                    </p>
                    <p id={`${radioId}-sentence`} className="text-sm text-muted-foreground">
                      {choice.sentence}
                    </p>
                  </div>
                </div>
                {selected && priceField(choice)}
              </div>
            );
          })}
        </RadioGroup>
        {errors.choice && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {errors.choice}
          </p>
        )}
      </fieldset>

      {paid && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>{SELL_WORDS.modelCost}</li>
          <li>{SELL_WORDS.signIn}</li>
          <li>{SELL_WORDS.priceTurnsOffFree}</li>
        </ul>
      )}

      {capacityText && <p className="text-sm text-muted-foreground">{capacityText}</p>}

      {paid && (
        <div className="space-y-3 rounded-lg border p-4">
          <p className="text-sm text-foreground">{hasOutboundTool ? SELL_WORDS.forPayers : SELL_WORDS.forPayersNoOutbound}</p>
          {hasOutboundTool && (
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor={`${id}-outbound`} className="text-sm font-normal text-foreground">
                {SELL_WORDS.allowOutbound}
              </Label>
              <Switch
                id={`${id}-outbound`}
                checked={form.allowOutbound}
                onCheckedChange={(checked) => onChange({ ...form, allowOutbound: checked })}
                disabled={disabled}
              />
            </div>
          )}
          {keepCopy && (
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor={`${id}-keep`} className="text-sm font-normal text-foreground">
                {SELL_WORDS.keepCopy}
              </Label>
              <Switch
                id={`${id}-keep`}
                checked={keepCopy.checked}
                onCheckedChange={keepCopy.onChange}
                disabled={disabled}
              />
            </div>
          )}
        </div>
      )}

      {(moreOptions || form.sells === "use") && (
        <div className="rounded-lg border">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 rounded-lg px-4 py-3 text-left text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={moreOpen}
            aria-controls={`${id}-more`}
            onClick={() => setMoreOpen((open) => !open)}
          >
            {SELL_WORDS.moreOptions}
            <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform", moreOpen && "rotate-180")} aria-hidden="true" />
          </button>
          {moreOpen && (
            <div id={`${id}-more`} className="space-y-5 border-t px-4 py-4">
              {moreOptions}
              {form.sells === "use" && (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-foreground">{SELL_WORDS.copiesInstead}</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 self-start sm:self-auto"
                    onClick={() => void sellCopies()}
                    disabled={disabled}
                  >
                    {SELL_WORDS.copiesConfirm}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
