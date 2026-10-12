"use client";

import { Check } from "lucide-react";

import type { CurvePreset } from "@/lib/api";
import { curveSvgPath, presetFacts } from "@/lib/token-curve";
import { cn } from "@/lib/utils";

const DRAWING_WIDTH = 120;
const DRAWING_HEIGHT = 48;

/** The shape of a preset's curve: price against the share of the supply sold. A drawing, not a chart to read figures from. */
function CurveDrawing({ preset }: { preset: CurvePreset }) {
  const path = curveSvgPath(preset.points, DRAWING_WIDTH, DRAWING_HEIGHT);
  if (!path) return null;
  return (
    <svg
      viewBox={`0 0 ${DRAWING_WIDTH} ${DRAWING_HEIGHT}`}
      width={DRAWING_WIDTH}
      height={DRAWING_HEIGHT}
      className="shrink-0 text-primary"
      role="img"
      aria-label={`How the price of the ${preset.name} curve rises as tokens are sold`}
    >
      <path d={path} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** One curve a creator can choose: its name, what it is for, four facts and the drawing. */
export function CurvePresetCard({
  preset,
  selected,
  onSelect,
}: {
  preset: CurvePreset;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "w-full rounded-lg border p-4 text-left transition-colors",
        selected ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
      )}
      data-testid={`curve-preset-${preset.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-48">
          <p className="flex items-center gap-2 font-medium">
            {preset.name}
            {selected && <Check className="h-4 w-4 text-primary" aria-hidden />}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{preset.summary}</p>
        </div>
        <CurveDrawing preset={preset} />
      </div>
      <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
        {presetFacts(preset).map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
    </button>
  );
}
