"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";

interface DataPoint {
  timestamp: string;
  priceUsd: number;
}

interface TokenChartProps {
  data: DataPoint[];
  width?: number;
  height?: number;
  className?: string;
  showAxes?: boolean;
  color?: string;
}

export function TokenChart({
  data,
  width = 400,
  height = 200,
  className,
  showAxes = true,
  color,
}: TokenChartProps) {
  const { path, areaPath, minPrice, maxPrice, priceChange } = useMemo(() => {
    if (data.length < 2) {
      return { path: "", areaPath: "", minPrice: 0, maxPrice: 0, priceChange: 0 };
    }

    const prices = data.map((d) => d.priceUsd);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min || 1;

    const padding = showAxes ? { top: 10, right: 10, bottom: 30, left: 60 } : { top: 2, right: 2, bottom: 2, left: 2 };
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    const points = data.map((d, i) => {
      const x = padding.left + (i / (data.length - 1)) * chartW;
      const y = padding.top + chartH - ((d.priceUsd - min) / range) * chartH;
      return { x, y };
    });

    const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
    const area =
      linePath +
      ` L ${points[points.length - 1]!.x} ${padding.top + chartH}` +
      ` L ${points[0]!.x} ${padding.top + chartH} Z`;

    const change = (((prices[prices.length - 1] ?? 0) - (prices[0] ?? 0)) / (prices[0] || 1)) * 100;

    return { path: linePath, areaPath: area, minPrice: min, maxPrice: max, priceChange: change };
  }, [data, width, height, showAxes]);

  const lineColor = color || (priceChange >= 0 ? "#22c55e" : "#ef4444");

  if (data.length < 2) {
    return (
      <div
        className={cn("flex items-center justify-center text-sm text-muted-foreground", className)}
        style={{ width, height }}
      >
        No chart data available
      </div>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={cn("w-full h-full", className)}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={`gradient-${lineColor}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={lineColor} stopOpacity="0.3" />
          <stop offset="100%" stopColor={lineColor} stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {/* Area fill */}
      <path d={areaPath} fill={`url(#gradient-${lineColor})`} />

      {/* Line */}
      <path d={path} fill="none" stroke={lineColor} strokeWidth={showAxes ? 2 : 1.5} strokeLinecap="round" strokeLinejoin="round" />

      {/* Axes labels */}
      {showAxes && (
        <>
          <text x={55} y={15} fill="currentColor" fontSize="10" textAnchor="end" className="fill-muted-foreground">
            ${maxPrice.toFixed(maxPrice < 0.01 ? 6 : 4)}
          </text>
          <text x={55} y={height - 25} fill="currentColor" fontSize="10" textAnchor="end" className="fill-muted-foreground">
            ${minPrice.toFixed(minPrice < 0.01 ? 6 : 4)}
          </text>
          <text x={60} y={height - 5} fill="currentColor" fontSize="10" className="fill-muted-foreground">
            {new Date(data[0]!.timestamp).toLocaleDateString()}
          </text>
          <text x={width - 10} y={height - 5} fill="currentColor" fontSize="10" textAnchor="end" className="fill-muted-foreground">
            {new Date(data[data.length - 1]!.timestamp).toLocaleDateString()}
          </text>
        </>
      )}
    </svg>
  );
}

interface SparkChartProps {
  data: number[];
  width?: number;
  height?: number;
  className?: string;
}

export function SparkChart({ data, width = 80, height = 30, className }: SparkChartProps) {
  const path = useMemo(() => {
    if (data.length < 2) return "";

    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;

    return data
      .map((v, i) => {
        const x = (i / (data.length - 1)) * width;
        const y = height - ((v - min) / range) * (height - 4) - 2;
        return `${i === 0 ? "M" : "L"} ${x} ${y}`;
      })
      .join(" ");
  }, [data, width, height]);

  if (data.length < 2) return null;

  const isPositive = (data[data.length - 1] ?? 0) >= (data[0] ?? 0);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={cn("inline-block", className)} style={{ width, height }}>
      <path
        d={path}
        fill="none"
        stroke={isPositive ? "#22c55e" : "#ef4444"}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
