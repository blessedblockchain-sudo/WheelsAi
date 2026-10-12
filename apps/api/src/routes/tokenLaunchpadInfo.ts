/**
 * GET /api/tokens/launchpad — what a launch on this server will be: which
 * launchpad, on which network, the curve presets a creator can pick from,
 * and the launch gate's numbers in force.
 *
 * Public: the wizard reads it before anyone is asked to connect a wallet,
 * and nothing in it is private.
 */

import type { FastifyPluginAsync } from "fastify";

export const tokenLaunchpadInfoRoutes: FastifyPluginAsync = async (_app) => {
  // Filled in with the meteora adapter.
};
