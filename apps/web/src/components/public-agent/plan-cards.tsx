"use client";

import { Button } from "@/components/ui/button";
import type { PlanOffer } from "@/lib/api";
import { USE_PLAN_WORDS, planAfterLine, planPriceLine, planUsesLine } from "@/lib/use-plans";

export interface PlanCardsProps {
  /** The plans on offer, in the order they are shown. */
  cards: PlanOffer[];
  /** Whether each card has its button. False for anyone who may not start a plan: the cards are then only read. */
  canStart: boolean;
  /** A start, of a plan or per use, is on its way: no other can be pressed. */
  busy: boolean;
  /** The card that was pressed, the very object drawn here: what the dialog says and what is agreed to. */
  onStart(card: PlanOffer): void;
  /** What the list is called for someone who cannot see it. "Plans" unless the page says otherwise. */
  label?: string;
  /** The words on each card's button. Starting the plan unless the page says otherwise. */
  buttonLabel?: string;
}

/**
 * The plans of an agent, one card each: its name, its price, its uses, what
 * happens after them, and the button that starts it. Nothing is charged by a
 * press here: the page asks first, in its dialog.
 */
export function PlanCards({
  cards,
  canStart,
  busy,
  onStart,
  label = "Plans",
  buttonLabel = USE_PLAN_WORDS.startButton,
}: PlanCardsProps) {
  if (cards.length === 0) return null;
  return (
    <ul aria-label={label} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {cards.map((card) => {
        const nameId = `plan-${card.id}-name`;
        return (
          <li key={card.id} className="flex min-w-0 flex-col gap-3 rounded-lg border bg-background p-4">
            <div className="space-y-1">
              <h3 id={nameId} className="break-words text-sm font-semibold text-foreground">
                {card.name}
              </h3>
              <p className="text-base font-semibold text-foreground">{planPriceLine(card)}</p>
              <p className="text-sm text-muted-foreground">{planUsesLine(card)}</p>
              <p className="text-sm text-muted-foreground">{planAfterLine(card)}</p>
            </div>
            {canStart && (
              <Button
                type="button"
                variant="outline"
                className="mt-auto h-auto min-h-10 w-full whitespace-normal"
                aria-describedby={nameId}
                disabled={busy}
                onClick={() => onStart(card)}
              >
                {buttonLabel}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
