/**
 * GitHub App authentication (W2).
 *
 * Two token types, and the distinction is the whole security model:
 *
 *   App JWT — signed with the App's private key, RS256, ≤10 min. Proves
 *     "I am this App". Used only to mint installation tokens.
 *   Installation token — minted per installation, expires in 1 hour, and
 *     GitHub scopes it to exactly that installation's repositories.
 *
 * We persist NEITHER. The installation *id* is stored (it is not a
 * secret); tokens are minted on demand and cached in memory until shortly
 * before expiry. That sidesteps token-at-rest entirely, and it is why the
 * tenant boundary is enforced by GitHub rather than by our own filtering:
 * an installation token simply cannot see another org's repositories.
 *
 * Contrast with what this replaces — a single platform PAT attached to
 * every user's import, where the only thing standing between one org and
 * another org's private code was our own query construction.
 *
 * No JWT dependency: the token is two base64url segments and an RS256
 * signature over them, which node:crypto signs directly.
 */

import { createPrivateKey, createSign, type KeyObject } from "node:crypto";

import { safeFetch } from "../lib/ssrfGuard.js";

const GITHUB_API = "https://api.github.com";
/** GitHub rejects an App JWT with exp more than 10 minutes out. */
const APP_JWT_TTL_SECONDS = 540;
/** Refresh an installation token this long before GitHub expires it. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface GitHubAppConfig {
  appId: string;
  /** PEM. Accepts base64-encoded PEM too — env transport mangles newlines. */
  privateKey: string;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Normalizes the configured key.
 *
 * A PEM carries real newlines, which most secret stores and .env files
 * mangle. Accepting base64-encoded PEM (and `\n` escapes) means the
 * operator does not have to discover that failure mode at runtime.
 */
export function loadPrivateKey(raw: string): KeyObject {
  let pem = raw.trim();
  if (!pem.includes("BEGIN")) {
    try {
      pem = Buffer.from(pem, "base64").toString("utf8");
    } catch {
      throw new Error("GITHUB_APP_PRIVATE_KEY is neither PEM nor base64-encoded PEM");
    }
  }
  pem = pem.replace(/\\n/g, "\n");
  return createPrivateKey(pem);
}

export function createAppJwt(
  config: GitHubAppConfig,
  now: () => Date = () => new Date(),
): string {
  const key = loadPrivateKey(config.privateKey);
  const issued = Math.floor(now().getTime() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      // 60s back-dated: GitHub rejects a JWT whose iat is in the future,
      // and small clock skew between us and them is normal.
      iat: issued - 60,
      exp: issued + APP_JWT_TTL_SECONDS,
      iss: config.appId,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(key);
  return `${header}.${payload}.${b64url(signature)}`;
}

export interface InstallationToken {
  token: string;
  expiresAt: Date;
}

export interface GitHubAppDeps {
  config: GitHubAppConfig;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/** In-process cache. Tokens are never written to the database. */
const tokenCache = new Map<string, InstallationToken>();

export function clearInstallationTokenCache(): void {
  tokenCache.clear();
}

export async function getInstallationToken(
  installationId: string,
  deps: GitHubAppDeps,
): Promise<InstallationToken> {
  const now = deps.now ?? (() => new Date());
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt.getTime() - now().getTime() > TOKEN_REFRESH_MARGIN_MS) {
    return cached;
  }

  const jwt = createAppJwt(deps.config, now);
  const res = await (deps.fetchImpl
    ? deps.fetchImpl(
        `${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${jwt}`,
            "User-Agent": "WheelsAI",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      )
    : safeFetch(
        `${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${jwt}`,
            "User-Agent": "WheelsAI",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      ));

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `failed to mint installation token (${res.status}): ${detail.slice(0, 200)}`,
    );
  }
  const body = (await res.json()) as { token?: string; expires_at?: string };
  if (!body.token || !body.expires_at) {
    throw new Error("installation token response missing token/expires_at");
  }

  const minted: InstallationToken = {
    token: body.token,
    expiresAt: new Date(body.expires_at),
  };
  tokenCache.set(installationId, minted);
  return minted;
}

/**
 * Confirms an installation is real and reachable by us.
 *
 * The callback receives `installation_id` as a QUERY PARAMETER, which is
 * to say from the user's browser. Persisting it unverified would let
 * anyone bind their org to an arbitrary installation id; minting a token
 * against it is the proof that the installation exists and is ours.
 */
export async function verifyInstallation(
  installationId: string,
  deps: GitHubAppDeps,
): Promise<{ ok: true; accountLogin: string } | { ok: false; error: string }> {
  let token: InstallationToken;
  try {
    token = await getInstallationToken(installationId, deps);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(`${GITHUB_API}/installation/repositories?per_page=1`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token.token}`,
      "User-Agent": "WheelsAI",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    return { ok: false, error: `installation not reachable (${res.status})` };
  }
  const body = (await res.json()) as {
    repositories?: Array<{ owner?: { login?: string } }>;
  };
  const login = body.repositories?.[0]?.owner?.login ?? "";
  return { ok: true, accountLogin: login };
}
