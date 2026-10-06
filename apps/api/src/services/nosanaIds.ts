/**
 * Nosana id helpers shared by billing, routes and the status worker. Pure and
 * import-free so any of them (and their tests) can load it without the Nosana
 * SDK or env validation.
 */

/** Mock ids minted by the dev-only fallback. They never exist on Nosana. */
export function isMockNosanaId(id: string): boolean {
  // submitJob's fallback mints mock_job_*; createDeployment's mints mock_deploy_*.
  return id.startsWith("mock_job_") || id.startsWith("mock_deploy_");
}

/**
 * Whether the GPU billing worker bills this model deployment per GPU-second: it
 * has a REAL Nosana deployment id. (The worker additionally only bills rows
 * whose status is `running`.) Dev-mock deployments never consume a GPU, are
 * never GPU-billed, and therefore keep per-request billing on /v1.
 *
 * Used by /v1 so a deployment the org already pays for by the second is not
 * charged a second time per token (or by x402) for the same GPU.
 */
export function isGpuBilledDeployment(
  deployment: { nosanaJobIds?: readonly string[] | null },
): boolean {
  const id = Array.isArray(deployment.nosanaJobIds) ? deployment.nosanaJobIds[0] : undefined;
  return typeof id === "string" && id.length > 0 && !isMockNosanaId(id);
}
