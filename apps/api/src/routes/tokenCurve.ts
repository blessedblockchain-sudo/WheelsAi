/**
 * Routes under /api/tokens/:id for a token on a Meteora curve: the curve's
 * state, a quote, a buy or sell, a creator fee claim and graduation.
 *
 * Every transaction here is built by the server, signed by the browser
 * wallet, checked to be the one that was built, and only then sent.
 */

import type { FastifyPluginAsync } from "fastify";

export const tokenCurveRoutes: FastifyPluginAsync = async (_app) => {
  // Filled in with the curve service.
};
