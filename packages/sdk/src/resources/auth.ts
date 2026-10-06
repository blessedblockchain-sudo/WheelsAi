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

export interface ApiKeyInfo {
  id: string;
  keyPrefix: string;
  name: string | null;
  scopes: string[];
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

    /** Session credentials only. The returned `key` is shown once. */
    createApiKey: (input: { name?: string; scopes?: string[] } = {}) =>
      client.post<CreatedApiKey>("/api/auth/keys", input),

    /** Session credentials only. */
    revokeApiKey: (keyId: string) =>
      client.delete<{ message: string }>(`/api/auth/keys/${seg(keyId)}`),
  };
}
