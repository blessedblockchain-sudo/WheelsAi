import type { WheelsAIClient } from "../client.js";

export interface AuthResponse {
  user: { id: string; email: string; walletAddress?: string };
  organization: { id: string; name: string };
  token: string;
}

export function authResource(client: WheelsAIClient) {
  return {
    register: (email: string, password: string) =>
      client.post<AuthResponse>("/api/auth/register", { email, password }),

    login: (email: string, password: string) =>
      client.post<AuthResponse>("/api/auth/login", { email, password }),

    logout: () =>
      client.post<{ message: string }>("/api/auth/logout"),

    me: () =>
      client.get<{ user: AuthResponse["user"]; organization: AuthResponse["organization"]; authType: string }>("/api/auth/me"),

    walletNonce: (walletAddress: string) =>
      client.post<{ nonce: string; walletAddress: string }>("/api/auth/wallet/nonce", { walletAddress }),

    walletVerify: (walletAddress: string, signature: string, nonce: string) =>
      client.post<AuthResponse>("/api/auth/wallet/verify", { walletAddress, signature, nonce }),

    refresh: () =>
      client.post<{ token: string }>("/api/auth/refresh"),
  };
}
