"use client";

import { curveMarkPoint, curveSvgPath, formatPriceSol } from "@/lib/token-curve";

const CHART_WIDTH = 700;
const CHART_HEIGHT = 260;
const CHART_PADDING = 12;

/**
 * The curve of a token on Meteora, drawn from the pool's own settings, with
 * a mark where the price is now. It stands in for the price chart while
 * there is no price history to draw. A drawing, not a chart to read figures
 * from: the one figure is the price, said under it.
 */
export function TokenCurveChart({
  points,
  priceSol,
}: {
  /** Absent from an API older than the member. */
  points: ReadonlyArray<{ soldPercent: number; priceSol: number }> | null | undefined;
  priceSol: string | null | undefined;
}) {
  const usable = Array.isArray(points) ? points : [];
  const path = curveSvgPath(usable, CHART_WIDTH, CHART_HEIGHT, CHART_PADDING);
  if (!path) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        There is no price history to draw yet.
      </div>
    );
  }
  const mark = curveMarkPoint(usable, priceSol, CHART_WIDTH, CHART_HEIGHT, CHART_PADDING);
  return (
    <div className="flex h-full flex-col gap-2" data-testid="token-curve-chart">
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className="min-h-0 w-full flex-1 text-primary"
        role="img"
        aria-label="How this token's price rises along its curve as tokens are sold, with a mark at the price now"
      >
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {mark && (
          <circle
            cx={mark.x}
            cy={mark.y}
            r={7}
            className="fill-green-500 stroke-background"
            strokeWidth={3}
          />
        )}
      </svg>
      <p className="text-xs text-muted-foreground">
        The line is this token&apos;s curve: the price rises from left to right as more of the
        supply is sold.
        {mark ? ` The dot is the price now, ${formatPriceSol(priceSol)} SOL.` : ""}
      </p>
    </div>
  );
}
