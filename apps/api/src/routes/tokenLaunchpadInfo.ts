/**
 * GET /api/tokens/launchpad: what a launch on this server will be: which
 * launchpad, on which network, the curve presets a creator can pick from,
 * and the launch gate's numbers in force.
 *
 * Public: the wizard reads it before anyone is asked to connect a wallet,
 * and nothing in it is private.
 */

import type { FastifyPluginAsync } from "fastify";

import { env } from "../config/env.js";
import {
  DEFAULT_PRESET_ID,
  listPresets,
  type PresetDescription,
  type SolanaNetwork,
} from "../services/launchpad/meteoraPresets.js";
import type { LaunchpadId } from "../services/launchpad/types.js";
import {
  CREATOR_LOCKUP_DAYS,
  launchGateThresholds,
} from "../services/tokenEligibility.js";

export interface TokenLaunchpadInfoDeps {
  launchpad: LaunchpadId;
  network: SolanaNetwork;
  /** The launch gate's two numbers in force, read at each request. */
  gate: () => { minReputation: number; minDeploymentAgeDays: number };
}

export interface TokenLaunchpadInfo {
  launchpad: LaunchpadId;
  network: SolanaNetwork;
  quote: "SOL";
  presets: PresetDescription[];
  defaultPreset: string;
  gate: {
    minReputation: number;
    minDeploymentAgeDays: number;
    creatorLockupDays: number;
  };
}

export function createTokenLaunchpadInfoRoutes(
  deps: TokenLaunchpadInfoDeps,
): FastifyPluginAsync {
  // Only our own curve has presets. They are the same for the life of the
  // process (pure numbers and the network), so they are built once, on the
  // first request, and not while the server is starting.
  let presets: PresetDescription[] | null = null;

  return async (app) => {
    app.get("/launchpad", async (_request, reply) => {
      if (presets === null) {
        presets = deps.launchpad === "meteora" ? listPresets(deps.network) : [];
      }
      const gate = deps.gate();
      const info: TokenLaunchpadInfo = {
        launchpad: deps.launchpad,
        network: deps.network,
        quote: "SOL",
        presets,
        defaultPreset: DEFAULT_PRESET_ID,
        gate: {
          minReputation: gate.minReputation,
          minDeploymentAgeDays: gate.minDeploymentAgeDays,
          creatorLockupDays: CREATOR_LOCKUP_DAYS,
        },
      };
      return reply.status(200).send(info);
    });
  };
}

export const tokenLaunchpadInfoRoutes: FastifyPluginAsync =
  createTokenLaunchpadInfoRoutes({
    launchpad: env.LAUNCHPAD,
    network: env.SOLANA_NETWORK,
    gate: () => launchGateThresholds(),
  });
