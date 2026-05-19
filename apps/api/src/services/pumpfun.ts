import { createLogger } from "../utils/logger.js";
import { env } from "../config/env.js";

const logger = createLogger("pumpfun-service");

const PUMPFUN_API_BASE = "https://pumpportal.fun/api";
const PUMPFUN_FRONTEND_BASE = "https://pump.fun";

// ============================================
// Types
// ============================================

export interface CreateTokenParams {
  name: string;
  symbol: string;
  description: string;
  imageUri?: string;
  creatorAddress: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

export interface CreateTokenResult {
  mintAddress: string;
  bondingCurveAddress: string;
  pumpfunUrl: string;
  txSignature: string;
}

export interface TokenInfo {
  mintAddress: string;
  name: string;
  symbol: string;
  description: string;
  imageUri?: string;
  priceUsd: number;
  marketCapUsd: number;
  volume24h: number;
  holders: number;
  bondingCurveProgress: number; // 0-100
  isGraduated: boolean;
  raydiumPoolId?: string;
  createdAt: string;
}

export interface TokenTrade {
  txSignature: string;
  traderAddress: string;
  side: "buy" | "sell";
  solAmount: number;
  tokenAmount: number;
  priceUsd: number;
  timestamp: string;
}

export interface TokenHolder {
  walletAddress: string;
  balance: number;
  percentage: number;
}

// ============================================
// Pump.fun Client
// ============================================

export class PumpFunClient {
  private apiKey: string | undefined;

  constructor() {
    this.apiKey = env.PUMPFUN_API_KEY;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${PUMPFUN_API_BASE}${endpoint}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.apiKey ? { "Authorization": `Bearer ${this.apiKey}` } : {}),
      ...(options.headers as Record<string, string> || {}),
    };

    try {
      const res = await fetch(url, { ...options, headers });
      if (!res.ok) {
        const errorBody = await res.text();
        logger.error({ status: res.status, body: errorBody, endpoint }, "Pump.fun API error");
        throw new Error(`Pump.fun API error: ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as T;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Pump.fun API error")) {
        throw error;
      }
      logger.error({ error, endpoint }, "Pump.fun API request failed");
      throw new Error(`Failed to reach Pump.fun API: ${(error as Error).message}`);
    }
  }

  /**
   * Create a new token on pump.fun with bonding curve.
   * Real implementation requires a signed Solana transaction submitted via the
   * pump.fun SDK from the creator wallet — tracked in plan Phase 1 (A1).
   * Until that lands, we call pumpportal.fun's hosted endpoint. When it fails,
   * we only return a synthetic mint if ALLOW_PUMPFUN_MOCK is explicitly enabled
   * (dev-only, forced off in production by env.ts). Otherwise we throw so that
   * demos and screenshots never show a fake mint address.
   */
  async createToken(params: CreateTokenParams): Promise<CreateTokenResult> {
    logger.info({ name: params.name, symbol: params.symbol, creator: params.creatorAddress }, "Creating token on pump.fun");

    try {
      const result = await this.request<CreateTokenResult>("/create-token", {
        method: "POST",
        body: JSON.stringify({
          name: params.name,
          symbol: params.symbol,
          description: params.description,
          image_uri: params.imageUri,
          creator: params.creatorAddress,
          twitter: params.twitter,
          telegram: params.telegram,
          website: params.website,
        }),
      });
      return result;
    } catch (error) {
      if (!env.ALLOW_PUMPFUN_MOCK) {
        logger.error({ error }, "Pump.fun createToken failed and mock fallback is disabled");
        throw error;
      }
      logger.warn({ error }, "Pump.fun API unavailable — returning dev mock (ALLOW_PUMPFUN_MOCK=true)");
      const mockMint = `${params.symbol.toLowerCase()}${Date.now().toString(36)}mock`;
      return {
        mintAddress: mockMint,
        bondingCurveAddress: `curve_${mockMint}`,
        pumpfunUrl: `${PUMPFUN_FRONTEND_BASE}/coin/${mockMint}`,
        txSignature: `mock_tx_${Date.now().toString(36)}`,
      };
    }
  }

  /**
   * Get token information from pump.fun
   */
  async getTokenInfo(mintAddress: string): Promise<TokenInfo | null> {
    try {
      return await this.request<TokenInfo>(`/token/${mintAddress}`);
    } catch (error) {
      logger.warn({ mintAddress, error }, "Failed to get token info from pump.fun");
      return null;
    }
  }

  /**
   * Get recent trades for a token
   */
  async getTokenTrades(mintAddress: string, limit = 50, offset = 0): Promise<TokenTrade[]> {
    try {
      const result = await this.request<{ trades: TokenTrade[] }>(
        `/token/${mintAddress}/trades?limit=${limit}&offset=${offset}`
      );
      return result.trades;
    } catch (error) {
      logger.warn({ mintAddress, error }, "Failed to get token trades");
      return [];
    }
  }

  /**
   * Get token holders
   */
  async getTokenHolders(mintAddress: string): Promise<TokenHolder[]> {
    try {
      const result = await this.request<{ holders: TokenHolder[] }>(
        `/token/${mintAddress}/holders`
      );
      return result.holders;
    } catch (error) {
      logger.warn({ mintAddress, error }, "Failed to get token holders");
      return [];
    }
  }

  /**
   * Check if token has graduated from bonding curve to Raydium
   */
  async checkGraduation(mintAddress: string): Promise<{ graduated: boolean; raydiumPoolId?: string }> {
    try {
      const info = await this.getTokenInfo(mintAddress);
      if (!info) return { graduated: false };
      return {
        graduated: info.isGraduated,
        raydiumPoolId: info.raydiumPoolId,
      };
    } catch (error) {
      logger.warn({ mintAddress, error }, "Failed to check graduation status");
      return { graduated: false };
    }
  }
}

// Singleton
let clientInstance: PumpFunClient | null = null;

export function getPumpFunClient(): PumpFunClient {
  if (!clientInstance) {
    clientInstance = new PumpFunClient();
  }
  return clientInstance;
}
