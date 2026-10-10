/**
 * Token mints the money rails use, in one env-free leaf module so pure
 * services can import them without dragging in config/env.
 *
 * x402, the wallet top-up rail and the payout executor all read the USDC
 * mint from here: one source, so the rails cannot drift apart.
 */

import { PublicKey } from "@solana/web3.js";

export type SolanaNetwork = "devnet" | "mainnet-beta";

// USDC token addresses.
export const USDC_MINT = {
  mainnet: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  devnet: new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
};

// NOS token address
export const NOS_MINT = {
  mainnet: new PublicKey("nosXBVoaCTtYdLvKY6Csb4AC8JCdQKKAaWYtx2ZMoo7"),
  devnet: new PublicKey("nosXBVoaCTtYdLvKY6Csb4AC8JCdQKKAaWYtx2ZMoo7"),
};

/** The USDC mint for a network. Anything that is not mainnet-beta is devnet. */
export function usdcMintForNetwork(network: SolanaNetwork): PublicKey {
  return network === "mainnet-beta" ? USDC_MINT.mainnet : USDC_MINT.devnet;
}
