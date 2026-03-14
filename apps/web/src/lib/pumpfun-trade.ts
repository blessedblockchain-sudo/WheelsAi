import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

// pump.fun program ID
const PUMP_FUN_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

// pump.fun global state / fee account
const PUMP_FUN_FEE_ACCOUNT = new PublicKey(
  "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJyGKRXXfikR"
);

// pump.fun bonding curve seed
const BONDING_CURVE_SEED = "bonding-curve";

/**
 * Derive the bonding curve PDA for a given mint.
 */
function deriveBondingCurve(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(BONDING_CURVE_SEED), mint.toBuffer()],
    PUMP_FUN_PROGRAM
  );
}

/**
 * Derive the bonding curve token account (ATA owned by the bonding curve PDA).
 */
async function deriveBondingCurveAta(
  bondingCurve: PublicKey,
  mint: PublicKey
): Promise<PublicKey> {
  return getAssociatedTokenAddress(mint, bondingCurve, true);
}

/**
 * Build a buy transaction on the pump.fun bonding curve.
 */
export async function buildBuyTransaction(
  connection: Connection,
  buyer: PublicKey,
  mint: PublicKey,
  solAmount: number,
  slippageBps: number = 100
): Promise<Transaction> {
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  const maxSolCost = Math.floor(lamports * (1 + slippageBps / 10000));

  const [bondingCurve] = deriveBondingCurve(mint);
  const bondingCurveAta = await deriveBondingCurveAta(bondingCurve, mint);
  const buyerAta = await getAssociatedTokenAddress(mint, buyer);

  const tx = new Transaction();

  // Ensure buyer has an ATA for the token
  const buyerAtaInfo = await connection.getAccountInfo(buyerAta);
  if (!buyerAtaInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        buyer,
        buyerAta,
        buyer,
        mint
      )
    );
  }

  // pump.fun buy instruction
  // Discriminator for "buy" = first 8 bytes of sha256("global:buy")
  const discriminator = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);

  const data = Buffer.alloc(8 + 8 + 8);
  discriminator.copy(data, 0);
  // token_amount (u64) — 0 means "buy with SOL amount" on pump.fun
  data.writeBigUInt64LE(BigInt(0), 8);
  // max_sol_cost (u64)
  data.writeBigUInt64LE(BigInt(maxSolCost), 16);

  const keys = [
    { pubkey: PUMP_FUN_FEE_ACCOUNT, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: bondingCurveAta, isSigner: false, isWritable: true },
    { pubkey: buyerAta, isSigner: false, isWritable: true },
    { pubkey: buyer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  tx.add(
    new TransactionInstruction({
      programId: PUMP_FUN_PROGRAM,
      keys,
      data,
    })
  );

  tx.feePayer = buyer;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;

  return tx;
}

/**
 * Build a sell transaction on the pump.fun bonding curve.
 */
export async function buildSellTransaction(
  connection: Connection,
  seller: PublicKey,
  mint: PublicKey,
  tokenAmount: bigint,
  slippageBps: number = 100
): Promise<Transaction> {
  const [bondingCurve] = deriveBondingCurve(mint);
  const bondingCurveAta = await deriveBondingCurveAta(bondingCurve, mint);
  const sellerAta = await getAssociatedTokenAddress(mint, seller);

  // Discriminator for "sell" = first 8 bytes of sha256("global:sell")
  const discriminator = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

  const data = Buffer.alloc(8 + 8 + 8);
  discriminator.copy(data, 0);
  // token_amount (u64)
  data.writeBigUInt64LE(tokenAmount, 8);
  // min_sol_output (u64) — apply slippage
  data.writeBigUInt64LE(BigInt(0), 16); // 0 = accept any (slippage handled client-side)

  const keys = [
    { pubkey: PUMP_FUN_FEE_ACCOUNT, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: bondingCurveAta, isSigner: false, isWritable: true },
    { pubkey: sellerAta, isSigner: false, isWritable: true },
    { pubkey: seller, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  const tx = new Transaction();
  tx.add(
    new TransactionInstruction({
      programId: PUMP_FUN_PROGRAM,
      keys,
      data,
    })
  );

  tx.feePayer = seller;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;

  return tx;
}

/**
 * Get SPL token balance for a wallet.
 */
export async function getTokenBalance(
  connection: Connection,
  wallet: PublicKey,
  mint: PublicKey
): Promise<{ amount: bigint; uiAmount: number; decimals: number }> {
  try {
    const ata = await getAssociatedTokenAddress(mint, wallet);
    const info = await connection.getTokenAccountBalance(ata);
    return {
      amount: BigInt(info.value.amount),
      uiAmount: info.value.uiAmount ?? 0,
      decimals: info.value.decimals,
    };
  } catch {
    return { amount: BigInt(0), uiAmount: 0, decimals: 6 };
  }
}
