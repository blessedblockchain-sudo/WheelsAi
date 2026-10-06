import type { GpuTier, WheelsAI } from "@wheelsai/sdk";

import { CliError } from "../errors.js";

export interface TierChoice {
  /** The tier id to send. */
  id: string;
  /** What the API says about it, when it is in the API's list. */
  tier?: GpuTier;
  /** Why this one: explicit flag, or the cheapest the API offers. */
  reason: "requested" | "cheapest";
  /** True when the API listed no deployable tiers at all and the requested id was sent unchecked. */
  unverified?: boolean;
}

export function describeTier(tier: GpuTier): string {
  return `${tier.name}, ${tier.vram} GB, $${tier.pricePerHour.toFixed(2)}/hr`;
}

/**
 * Choose the GPU tier to deploy on, from the API's own list of deployable tiers.
 *  - `--gpu-tier` must be one of them. If the API lists none (nothing is deployable
 *    on that server), the request is still sent so the API can answer with the real reason.
 *  - Without `--gpu-tier`, the cheapest listed tier is used.
 */
export function chooseTier(tiers: GpuTier[], requested: string | undefined): TierChoice {
  if (requested) {
    if (tiers.length === 0) return { id: requested, reason: "requested", unverified: true };
    const match = tiers.find((tier) => tier.id === requested);
    if (!match) {
      throw new CliError(`"${requested}" is not a deployable GPU tier.`, {
        hint: `Available on this server: ${tiers.map((tier) => tier.id).join(", ")}.`,
      });
    }
    return { id: match.id, tier: match, reason: "requested" };
  }

  if (tiers.length === 0) {
    throw new CliError("The API lists no deployable GPU tiers, so there is nothing to choose.", {
      hint: "Pass --gpu-tier <id> to send a request anyway, or check that compute is configured on the server.",
    });
  }
  const cheapest = tiers.reduce((best, tier) => (tier.pricePerHour < best.pricePerHour ? tier : best));
  return { id: cheapest.id, tier: cheapest, reason: "cheapest" };
}

export async function loadTiers(wheels: WheelsAI): Promise<GpuTier[]> {
  return wheels.models.gpuTiers();
}
