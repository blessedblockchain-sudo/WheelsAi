"use client";

import { TrendingUp } from "lucide-react";

interface BondingCurveProgressProps {
  status: "BONDING" | "GRADUATED" | "FAILED";
  marketCapUsd: number;
  graduationThreshold?: number;
  priceUsd: number;
  holders: number;
  volume24h: number;
}

const DEFAULT_GRADUATION_THRESHOLD = 69000; // $69K like pump.fun

export function BondingCurveProgress({
  status,
  marketCapUsd,
  graduationThreshold = DEFAULT_GRADUATION_THRESHOLD,
  priceUsd,
  holders,
  volume24h,
}: BondingCurveProgressProps) {
  const progress = Math.min((marketCapUsd / graduationThreshold) * 100, 100);
  const isGraduated = status === "GRADUATED";
  const isFailed = status === "FAILED";

  return (
    <div className="space-y-4">
      {/* Progress bar */}
      <div>
        <div className="flex items-center justify-between text-sm mb-2">
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {isGraduated ? "Graduated" : isFailed ? "Failed" : "Bonding Curve Progress"}
          </span>
          <span className="text-gray-500 dark:text-gray-400">
            {isGraduated
              ? "Trading on Raydium"
              : `$${formatCompact(marketCapUsd)} / $${formatCompact(graduationThreshold)}`}
          </span>
        </div>
        <div className="h-3 w-full rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              isGraduated
                ? "bg-green-500"
                : isFailed
                ? "bg-red-500"
                : "bg-gradient-to-r from-blue-500 to-purple-500"
            }`}
            style={{ width: `${isGraduated ? 100 : progress}%` }}
          />
        </div>
        {!isGraduated && !isFailed && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Graduates to Raydium AMM at ${formatCompact(graduationThreshold)} market cap
          </p>
        )}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4">
        <div className="text-center">
          <div className="text-lg font-bold text-gray-900 dark:text-gray-100">
            ${priceUsd < 0.01 ? priceUsd.toFixed(6) : priceUsd.toFixed(4)}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">Price</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-bold text-gray-900 dark:text-gray-100">
            {holders}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">Holders</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-bold text-gray-900 dark:text-gray-100">
            ${formatCompact(volume24h)}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">24h Volume</div>
        </div>
      </div>

      {/* How it works (collapsible info) */}
      {!isGraduated && !isFailed && (
        <div className="rounded-lg bg-blue-50 dark:bg-blue-900/20 p-3 border border-blue-200 dark:border-blue-800">
          <div className="flex items-start gap-2">
            <TrendingUp className="h-4 w-4 text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
            <div className="text-xs text-blue-700 dark:text-blue-300">
              <p className="font-medium">How bonding curves work</p>
              <ol className="mt-1 space-y-0.5 list-decimal list-inside text-blue-600 dark:text-blue-400">
                <li>Community buys tokens on the bonding curve</li>
                <li>Price increases as more tokens are purchased</li>
                <li>At ${formatCompact(graduationThreshold)} market cap, token graduates</li>
                <li>Liquidity moves to Raydium for open trading</li>
              </ol>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(2);
}
