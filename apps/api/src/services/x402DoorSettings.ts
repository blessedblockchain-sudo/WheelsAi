// Whether the x402 door's settings are on, read from the process's settings
// alone. Light on purpose: the routes ask it of every request that presents
// no credential, and it must not load the door's binding
// (services/buildPaidUseX402Deps.ts), which reads the database, the chain
// and the master key once a use comes.

import { env, type Env } from "../config/env.js";
import { x402DoorOpen, type X402DoorSettings } from "./x402DoorRules.js";

/**
 * The settings the door reads. Each is optional: one that is not there
 * leaves the door closed, never open.
 */
export type X402DoorEnv = Partial<
  Pick<
    Env,
    | "X402_ENABLED"
    | "X402_SUBMIT_TRANSACTIONS"
    | "X402_SETTLEMENT_WORKER_ENABLED"
    | "PUBLIC_API_URL"
    | "WALLET_MASTER_KEY"
    | "SOLANA_NETWORK"
    | "TREASURY_WALLET_ADDRESS"
  >
>;

/** The settings as x402DoorOpen takes them. */
export function x402DoorSettingsOf(settings: X402DoorEnv): X402DoorSettings {
  return {
    x402Enabled: settings.X402_ENABLED === true,
    submitTransactions: settings.X402_SUBMIT_TRANSACTIONS === true,
    settlementWorkerEnabled: settings.X402_SETTLEMENT_WORKER_ENABLED === true,
    publicApiUrl: settings.PUBLIC_API_URL,
    walletMasterKey: settings.WALLET_MASTER_KEY,
    solanaNetwork: settings.SOLANA_NETWORK ?? "",
  };
}

/**
 * Whether the door's settings are on, read now. What the routes ask of a
 * request with no credential (middleware/auth.ts, x402DoorApplies). Never
 * throws: settings that cannot be read are a closed door.
 */
export function x402DoorOpenNow(settings: X402DoorEnv = env): boolean {
  try {
    return x402DoorOpen(x402DoorSettingsOf(settings));
  } catch {
    return false;
  }
}
