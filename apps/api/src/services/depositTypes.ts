// What the scan of a deposit address answers, shared by the worker that
// finds transfers (services/runDepositScanTick.ts) and the routes that show
// them (routes/depositAddress.ts). Types and one label only: no I/O.

/** The two assets a deposit address is credited for. */
export type DepositAsset = "USDC" | "SOL";

/** A transfer this check credited. Amounts are base units and cents. */
export interface CreditedTransfer {
  asset: DepositAsset;
  /** What arrived: lamports, or USDC with 6 decimals. */
  amountRaw: bigint;
  /** What the transfer itself was worth, before any bonus. */
  creditedCents: bigint;
  bonusCents: bigint;
  txSignature: string;
}

/** A transfer that was seen and is not credited yet (SOL with no price). */
export interface WaitingTransfer {
  asset: DepositAsset;
  amountRaw: bigint;
  txSignature: string;
}

export type CheckDepositsResult =
  | { outcome: "scanned"; credited: CreditedTransfer[]; waiting: WaitingTransfer[] }
  /** The organization has no deposit address on this network. */
  | { outcome: "not_issued" }
  /** The chain could not be read, or is not the configured one. */
  | { outcome: "chain_unavailable" };

/** One check of one organization's address, on demand ("Check now"). */
export type CheckDepositsNow = (orgId: string) => Promise<CheckDepositsResult>;

export type ChainLabel = "solana:mainnet" | "solana:devnet";

/**
 * The label rows carry for the chain the settings name, the same one
 * wallet_topups.network uses. Pass env.SOLANA_NETWORK.
 */
export function chainLabel(solanaNetwork: string): ChainLabel {
  return solanaNetwork === "mainnet-beta" ? "solana:mainnet" : "solana:devnet";
}
