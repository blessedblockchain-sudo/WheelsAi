/**
 * Feature flags. Flags default to off and must be explicitly enabled via
 * NEXT_PUBLIC_* env vars so production builds never ship an in-progress feature
 * by accident.
 *
 * Token UI (pump.fun integration, tokenize modal, token marketplace, bonding-curve
 * panels) is flagged off until the real createToken path lands. See plan item A1.
 */

function readBool(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

export const featureFlags = {
  tokenUi: readBool(process.env.NEXT_PUBLIC_ENABLE_TOKEN_UI),
  // In-app bonding-curve trading. Off until the server-prepared trade flow
  // lands — the previous client-built instructions were unsafe (see
  // lib/pumpfun-trade.ts).
  trading: readBool(process.env.NEXT_PUBLIC_ENABLE_TRADING),
} as const;

export type FeatureFlag = keyof typeof featureFlags;

export function isEnabled(flag: FeatureFlag): boolean {
  return featureFlags[flag];
}
