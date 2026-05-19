/**
 * On-chain AgentReputation reader (plan A4).
 *
 * Fetches + deserializes the per-agent AgentReputation PDA from the
 * reputation-oracle program. Returns the cumulative on-chain state, or
 * null if the PDA isn't initialized yet (the worker only writes after
 * initialize_agent_reputation lands).
 *
 * Decoding strategy:
 *   - Anchor accounts begin with an 8-byte sha256("account:<Name>")[..8]
 *     discriminator. We verify it before trusting the layout.
 *   - All fields are fixed-size primitives, so a hand-rolled
 *     readUInt64LE / readInt64LE / readUInt32LE is simpler than a Borsh
 *     dep and faster on hot paths.
 *
 * No `@coral-xyz/anchor` — same reasoning as agentTreasury.ts: small
 * footprint, version-skew immunity, easy unit tests.
 */

import { PublicKey, type Connection } from "@solana/web3.js";

import { deriveAgentReputationPda } from "../lib/programs/reputationOracle.js";

// sha256("account:AgentReputation")[..8].
// Pinned by readAgentReputationFromChain.unit.test.ts; if the Rust
// account name changes, the test fails before the bug hits prod.
const ACCOUNT_DISCRIMINATOR = Buffer.from([
  245, 56, 239, 246, 36, 231, 227, 67,
]);

export interface OnChainAgentReputation {
  ownerTokenMint: string;
  cumulativeUptimeSeconds: bigint;
  cumulativeMessageCount: bigint;
  lastScore: number;
  lastAttestationUnixTs: bigint;
  attestationCount: number;
  bump: number;
}

export interface ReadAgentReputationDeps {
  connection: Pick<Connection, "getAccountInfo">;
}

export async function readAgentReputationFromChain(
  input: { mint: PublicKey },
  deps: ReadAgentReputationDeps,
): Promise<OnChainAgentReputation | null> {
  const [pda] = deriveAgentReputationPda(input.mint);
  const acc = await deps.connection.getAccountInfo(pda);
  if (!acc) return null;

  // The Rust SIZE constant reserves 8 (disc) + 32 + 8 + 8 + 4 + 8 + 4
  // + 1 + 64 (padding) = 137 bytes. Real data is 73 bytes; padding is
  // zero-init but rent-paid. The minimum we need to deserialize: 73.
  const data = Buffer.from(acc.data);
  if (data.length < 73) return null;
  if (!data.subarray(0, 8).equals(ACCOUNT_DISCRIMINATOR)) {
    return null;
  }

  let off = 8;

  const mintBytes = data.subarray(off, off + 32);
  off += 32;
  const cumulativeUptimeSeconds = data.readBigUInt64LE(off);
  off += 8;
  const cumulativeMessageCount = data.readBigUInt64LE(off);
  off += 8;
  const lastScore = data.readUInt32LE(off);
  off += 4;
  const lastAttestationUnixTs = data.readBigInt64LE(off);
  off += 8;
  const attestationCount = data.readUInt32LE(off);
  off += 4;
  const bump = data.readUInt8(off);

  return {
    ownerTokenMint: new PublicKey(mintBytes).toBase58(),
    cumulativeUptimeSeconds,
    cumulativeMessageCount,
    lastScore,
    lastAttestationUnixTs,
    attestationCount,
    bump,
  };
}
