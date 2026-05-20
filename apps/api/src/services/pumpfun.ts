import { createLogger } from "../utils/logger.js";
import { env } from "../config/env.js";

const logger = createLogger("pumpfun-service");

const PUMPFUN_API_BASE = "https://pumpportal.fun/api";

// ============================================
// Types
// ============================================

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
