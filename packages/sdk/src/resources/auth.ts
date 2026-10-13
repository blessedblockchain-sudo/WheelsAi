import { seg, type WheelsAIClient } from "../client.js";

export interface AuthResponse {
  user: {
    id: string;
    /** Null for wallet-only accounts. */
    email?: string | null;
    walletAddress?: string | null;
    createdAt?: string;
  };
  organization: { id: string; name: string };
  /** Session token (JWT). Pass it to `setToken`. */
  token: string;
  /** Sent by `register` only. */
  emailVerificationSent?: boolean;
}

/** Login answers this instead of a session when the account has two-factor authentication on. */
export interface TwoFactorChallenge {
  requires2FA: true;
  challengeToken: string;
  expiresAt: string;
}

export type LoginResponse = AuthResponse | TwoFactorChallenge;

export function isTwoFactorChallenge(response: LoginResponse): response is TwoFactorChallenge {
  return (response as TwoFactorChallenge).requires2FA === true;
}

/** `GET /api/auth/me`: who the current credential belongs to. */
export interface WhoAmI {
  user: {
    /** Null when the credential is an API key (keys have no user). */
    id: string | null;
    email?: string | null;
    walletAddress?: string | null;
    emailVerified: boolean;
  };
  /** Only the id: the endpoint does not return the organization's name. */
  organization: { id: string };
  authType: "jwt" | "api_key";
}

/**
 * What a key may be granted. An ordinary scope is also held by a key with no scopes or with
 * `*`. The four that spend money (`jobs:hire`, `jobs:review`, `marketplace:install`, `agents:use`)
 * are held only by a key that lists them by name.
 */
export type ApiKeyScope =
  | "*"
  | "agents:invoke"
  | "workflows:invoke"
  | "offerings:write"
  | "jobs:read"
  | "jobs:hire"
  | "jobs:review"
  | "marketplace:install"
  | "agents:use";

export interface CreateApiKeyInput {
  name?: string;
  scopes?: ApiKeyScope[];
  /** Required with `jobs:hire`: the most one job may cost, in cents (1 to 100,000). */
  maxJobPriceCents?: number;
  /** Required with `agents:use`: the most one use of a paid agent may cost, in cents (1 to 100,000). */
  maxUsePriceCents?: number;
  /** Required with `jobs:hire` or `agents:use`: the most the key may spend in one UTC day, in cents. Hiring and paid use share the day. */
  dailySpendCapCents?: number;
}

export interface ApiKeyInfo {
  id: string;
  keyPrefix: string;
  name: string | null;
  scopes: string[];
  /** Spend caps of a key granted `jobs:hire`; null on any other key. */
  maxJobPriceCents: number | null;
  /** The most one use of a paid agent may cost, on a key granted `agents:use`; null on any other key. */
  maxUsePriceCents: number | null;
  dailySpendCapCents: number | null;
  /**
   * `listApiKeys`: what the key has spent in the current UTC day, in cents; 0 for a key that has spent
   * nothing today. null when it could not be read just now, which is not the same as nothing spent.
   */
  spentTodayCents?: number | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  status: "active";
}

export interface CreatedApiKey {
  id: string;
  /** The full key. Shown once; it cannot be retrieved again. */
  key: string;
  apiKey: ApiKeyInfo;
  message: string;
}

export interface OrganizationMembership {
  id: string;
  name: string;
  role: string;
  current: boolean;
}

export function authResource(client: WheelsAIClient) {
  return {
    register: (email: string, password: string) =>
      client.post<AuthResponse>("/api/auth/register", { email, password }),

    /** May return a `TwoFactorChallenge`: check with `isTwoFactorChallenge` and finish with `login2fa`. */
    login: (email: string, password: string) =>
      client.post<LoginResponse>("/api/auth/login", { email, password }),

    /** Second step of a login that answered `requires2FA`. */
    login2fa: (challengeToken: string, token: string) =>
      client.post<AuthResponse>("/api/auth/login/2fa", { challengeToken, token }),

    logout: () =>
      client.post<{ message: string }>("/api/auth/logout"),

    me: () =>
      client.get<WhoAmI>("/api/auth/me"),

    /** Session (JWT) credentials only; API keys are refused. */
    refresh: () =>
      client.post<{ token: string }>("/api/auth/refresh"),

    /** Session credentials only. */
    organizations: () =>
      client.get<{ organizations: OrganizationMembership[] }>("/api/auth/orgs"),

    /** Session credentials only. Returns a new token for the target organization. */
    switchOrg: (orgId: string) =>
      client.post<{ organization: { id: string; name: string }; role: string; token: string }>(
        "/api/auth/switch-org",
        { orgId },
      ),

    walletNonce: (walletAddress: string) =>
      client.post<{ nonce: string; walletAddress: string }>("/api/auth/wallet/nonce", { walletAddress }),

    /** May return a `TwoFactorChallenge`, like `login`. */
    walletVerify: (walletAddress: string, signature: string, nonce: string) =>
      client.post<LoginResponse>("/api/auth/wallet/verify", { walletAddress, signature, nonce }),

    /** Session credentials only. */
    listApiKeys: () =>
      client.get<{ keys: ApiKeyInfo[]; apiKeys: ApiKeyInfo[] }>("/api/auth/keys"),

    /**
     * Session credentials only. The returned `key` is shown once. A key with a spend scope can
     * be created only by an owner or admin, and `jobs:hire` needs both caps
     * (422 `spend_caps_required`); an unknown scope is 400 `invalid_scope`.
     */
    createApiKey: (input: CreateApiKeyInput = {}) =>
      client.post<CreatedApiKey>("/api/auth/keys", input),

    /** Session credentials only. */
    revokeApiKey: (keyId: string) =>
      client.delete<{ message: string }>(`/api/auth/keys/${seg(keyId)}`),
  };
}
