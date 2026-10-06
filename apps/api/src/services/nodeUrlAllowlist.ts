/**
 * SSRF allowlist for inference node URLs.
 *
 * Node URLs come from our own DB (written by the deployment-status worker from
 * Nosana's reported endpoints), but they are fetched server-side with no auth,
 * so a compromised or poisoned record must never turn /v1 into an SSRF
 * primitive. Only https origins on the domains Nosana actually serves compute
 * endpoints on (or our own) are accepted: no userinfo, no path, no query, no
 * fragment.
 *
 * Real Nosana endpoints are MULTI-label hosts, e.g.
 * `https://<id>.node.nos.ci` or `https://<id>.node.k8s.prd.nos.ci`; the previous
 * single-label pattern (`[\w-]+\.nos\.ci`) matched none of them, so every real
 * endpoint would have been refused with a 502.
 *
 * Why only `nos.ci`: every Nosana host the SDK (0.4.74, dist/config.js and
 * NosanaClient's job node URLs) and the public dashboard API ever name is under
 * nos.ci (dashboard.k8s.prd.nos.ci, dashboard.k8s.dev.nos.ci, <node>.node.nos.ci).
 * nosana.io / nosana.com are docs and marketing sites and nosana.mypinata.cloud
 * is the IPFS gateway - none serves an inference endpoint, and an open
 * `nosana.<any tld>` pattern would also have accepted hosts like x.nosana.lol.
 */

/** One DNS label: alnum, inner hyphens allowed, 1-63 chars. */
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** One or more labels, each followed by a dot. */
const SUBDOMAINS = `(?:${LABEL}\\.)+`;
const PORT = "(?::([0-9]{1,5}))?";

const nodePattern = (domain: string): RegExp =>
  new RegExp(`^https://${SUBDOMAINS}${domain}${PORT}$`, "i");

/** Production patterns: https only. */
const PRODUCTION_PATTERNS: readonly RegExp[] = [
  nodePattern("nos\\.ci"),
  nodePattern("openclaw\\.wheelsai\\.com"),
];

/** Local development patterns (http or https). Never enabled in production. */
const LOOPBACK_PATTERN = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::([0-9]{1,5}))?$/i;

export interface NodeUrlAllowlistOptions {
  /**
   * Permit http(s)://localhost and 127.0.0.1. Callers derive it with
   * loopbackNodeUrlsAllowed(): development AND an explicit opt-in flag.
   */
  allowLoopback?: boolean;
}

function portInRange(port: string | undefined): boolean {
  if (port === undefined) return true;
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65_535;
}

export function isAllowedNodeUrl(
  url: string,
  options: NodeUrlAllowlistOptions = {},
): boolean {
  if (typeof url !== "string" || url.length === 0 || url.length > 255) return false;
  // Reject control characters, whitespace and backslashes outright: browsers
  // and WHATWG URL parsers normalise some of them into different hosts.
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  if (/[\s\\\u0000-\u001f\u007f]/.test(url)) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.search !== "" || parsed.hash !== "") return false;

  const patterns: RegExp[] = [...PRODUCTION_PATTERNS];
  if (options.allowLoopback === true) patterns.push(LOOPBACK_PATTERN);

  for (const pattern of patterns) {
    const match = pattern.exec(url);
    if (match && portInRange(match[1])) return true;
  }
  return false;
}

/**
 * Loopback node URLs are a local-development convenience and need BOTH a
 * development process and an explicit opt-in (ALLOW_LOOPBACK_NODE_URLS, parsed
 * by config/nosanaDeploy.ts). NODE_ENV alone is not enough: it defaults to
 * "development" (config/env.ts), so an unset variable would otherwise open
 * localhost to the /v1 proxy.
 */
export function loopbackNodeUrlsAllowed(
  nodeEnv: string | undefined,
  optIn: boolean | undefined,
): boolean {
  return nodeEnv === "development" && optIn === true;
}
