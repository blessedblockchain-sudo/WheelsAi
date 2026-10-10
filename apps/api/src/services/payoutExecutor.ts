/**
 * Sending a creator's payout: the pieces the payout worker is made of.
 *
 * Requesting a payout reserves the creator's earnings into a `pending`
 * creator_payouts row. services/runPayoutExecutorTick.ts decides what
 * happens to that row on each run; this file holds what it decides with:
 *
 *   credits       the processing -> completed compare-and-set and the grant
 *                 run in ONE database transaction, so the row is never
 *                 completed without the credits or the credits granted
 *                 twice. The credit ledger row is "payout_credit".
 *
 *   a wallet      reading the address, working out the amount in base units
 *   (USDC, SOL)   (USDC exactly; SOL from a live quote, never a fallback
 *                 number), checking that the paying wallet covers it, and
 *                 building and signing the transfer WITHOUT sending it. The
 *                 signed bytes are stored by the claim before anything is
 *                 broadcast, and the same bytes are what is sent again.
 *
 * Nothing here changes a payout's status or a creator's balance, and nothing
 * here broadcasts.
 */

import {
  ACCOUNT_SIZE,
  AccountLayout,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type AccountInfo,
  type Commitment,
} from "@solana/web3.js";
import bs58 from "bs58";

import {
  grantCredits,
  type CreditGrantTxClient,
} from "./creditGrant.js";
import {
  lamportsToSendForCents,
  solMicroUsdRate,
  type SolPriceResult,
} from "./solPrice.js";

export const USDC_DECIMALS = 6;
/** USDC base units in one cent: 6 decimals less the 2 a cent already has. */
const USDC_BASE_UNITS_PER_CENT = 10_000n;

/** The chain's fee for a transfer with one signature and no priority fee. */
export const PAYOUT_FEE_LAMPORTS = 5_000n;
/**
 * SOL the paying wallet keeps after any payout. An account left with less
 * than its rent-exempt minimum (890,880 lamports) makes the transfer fail,
 * so a payout that would dip under this waits instead of being signed.
 */
export const PAYING_WALLET_KEEP_LAMPORTS = 1_000_000n;

export type WalletPayoutMethod = "crypto_sol" | "crypto_usdc";

export function isWalletPayoutMethod(method: string): method is WalletPayoutMethod {
  return method === "crypto_sol" || method === "crypto_usdc";
}

// ============================================
// Credits payout
// ============================================

export type PayoutSettleResult =
  | { outcome: "completed"; balanceAfterCents: bigint }
  /** Another run already completed this payout: nothing was granted here. */
  | { outcome: "already_settled" };

export interface PayoutCreditsTxClient extends CreditGrantTxClient {
  creatorPayout: {
    updateMany: (args: {
      where: { id: string; status: string };
      data: { status: string; processedAt: Date };
    }) => Promise<{ count: number }>;
  };
}

export interface PayoutCreditsDb {
  $transaction: <T>(fn: (tx: PayoutCreditsTxClient) => Promise<T>) => Promise<T>;
}

export interface SettleCreditsInput {
  payoutId: string;
  publisherId: string;
  amountCents: bigint;
  now?: () => Date;
}

/** The credit ledger type of a payout taken as credits. */
export const PAYOUT_CREDIT_LEDGER_TYPE = "payout_credit";

/**
 * Grants a credits payout exactly once. The processing -> completed
 * compare-and-set and the grant commit together; losing the compare-and-set
 * (another run already settled it) grants nothing.
 */
export function makeSettleCreditsPayout(db: PayoutCreditsDb) {
  return async function settleCreditsPayout(
    input: SettleCreditsInput,
  ): Promise<PayoutSettleResult> {
    const now = input.now ?? (() => new Date());
    return db.$transaction(async (tx) => {
      const claimed = await tx.creatorPayout.updateMany({
        where: { id: input.payoutId, status: "processing" },
        data: { status: "completed", processedAt: now() },
      });
      if (claimed.count === 0) {
        return { outcome: "already_settled" };
      }
      const granted = await grantCredits(tx, {
        orgId: input.publisherId,
        amountCents: input.amountCents,
        referenceId: input.payoutId,
        description: "Creator payout (credits)",
        ledgerType: PAYOUT_CREDIT_LEDGER_TYPE,
      });
      return {
        outcome: "completed",
        balanceAfterCents: granted.balanceAfterCents,
      };
    });
  };
}

// ============================================
// The address
// ============================================

export type PayoutAddressReading =
  | { ok: true; recipient: PublicKey }
  | { ok: false; code: "missing_address" | "invalid_address" };

/**
 * The receiving wallet of a payout row. An ordinary wallet address decodes
 * to 32 bytes and is on the curve; anything else is refused, the same rule
 * the request applies. A program-derived address is refused too: it has no
 * key that could ever move what is sent to it.
 */
export function readPayoutAddress(address: string | null | undefined): PayoutAddressReading {
  if (typeof address !== "string" || address.trim().length === 0) {
    return { ok: false, code: "missing_address" };
  }
  let recipient: PublicKey;
  try {
    const bytes = bs58.decode(address.trim());
    if (bytes.length !== 32) return { ok: false, code: "invalid_address" };
    recipient = new PublicKey(bytes);
  } catch {
    return { ok: false, code: "invalid_address" };
  }
  if (!PublicKey.isOnCurve(recipient.toBytes())) {
    return { ok: false, code: "invalid_address" };
  }
  return { ok: true, recipient };
}

// ============================================
// The amount, in base units
// ============================================

/** USDC is exact: one cent is 10,000 base units. No price, no rounding. */
export function usdcBaseUnitsForCents(amountCents: bigint): bigint {
  if (typeof amountCents !== "bigint" || amountCents <= 0n) {
    throw new Error("usdcBaseUnitsForCents: the amount must be a bigint of cents above zero");
  }
  return amountCents * USDC_BASE_UNITS_PER_CENT;
}

/** The price a SOL amount was worked out from, as it is stored on the row. */
export interface PayoutQuote {
  /** Micro-dollars per SOL, as the money-out direction valued it. */
  priceMicroUsd: bigint;
  publishTime: Date;
  source: string;
}

export type SolPayoutAmount =
  | { ok: true; lamports: bigint; quote: PayoutQuote }
  /** No number: `detail` is for the log, never for a creator. */
  | { ok: false; detail: string };

/**
 * The lamports to send for a payout of `amountCents`, from a price answer
 * (services/buildSolPriceDeps.ts getSolQuote). A refused price, or a price
 * the amount cannot be worked out from, is no amount at all: the payout
 * waits. SOL is valued high and the lamports rounded down, as every
 * money-out sum is (services/solPrice.ts).
 */
export function solPayoutAmount(
  price: SolPriceResult,
  amountCents: bigint,
  marginBps: number,
): SolPayoutAmount {
  if (!price.ok) {
    return { ok: false, detail: `no price: ${price.code}${price.detail ? ` (${price.detail})` : ""}` };
  }
  const sum = lamportsToSendForCents(price.quote, amountCents, marginBps);
  if (!sum.ok) return { ok: false, detail: `no amount from the price: ${sum.code}` };
  const rate = solMicroUsdRate(price.quote, "out", marginBps);
  if (!rate.ok) return { ok: false, detail: `no rate from the price: ${rate.code}` };
  return {
    ok: true,
    lamports: sum.lamports,
    quote: {
      priceMicroUsd: rate.microUsdPerSol,
      publishTime: new Date(price.quote.publishTime * 1000),
      source: price.quote.source,
    },
  };
}

// ============================================
// Does the paying wallet cover it
// ============================================

export interface PayingWalletFunds {
  /** The paying wallet's SOL. */
  solLamports: bigint;
  /** The paying wallet's USDC, base units. Zero when it has no USDC account. */
  usdcBaseUnits: bigint;
  /** USDC only: whether the receiving wallet already has a USDC account. */
  recipientHasUsdcAccount: boolean;
  /** USDC only: the rent to open one, when it has none. */
  usdcAccountRentLamports: bigint;
}

export type FundsVerdict = { covered: true } | { covered: false; detail: string };

/**
 * What transfers that are already signed and may still land will take from
 * the paying wallet. A read of the chain does not show them yet, so the
 * funds check takes them off what the wallet holds: a wallet that covers
 * one payout is never signed against for two.
 */
export interface PayingWalletHeld {
  usdcBaseUnits: bigint;
  /** SOL being sent, and the fee of every transfer that is out. */
  lamports: bigint;
}

export const NOTHING_HELD: PayingWalletHeld = { usdcBaseUnits: 0n, lamports: 0n };

/**
 * Whether the paying wallet can send this payout and stay standing.
 *   USDC: its USDC covers the amount, and its SOL covers the fee, the rent
 *         of the receiver's USDC account when there is none yet, and what
 *         the wallet keeps.
 *   SOL:  its SOL covers the amount, the fee and what the wallet keeps.
 */
export function payingWalletCovers(
  method: WalletPayoutMethod,
  amountRaw: bigint,
  funds: PayingWalletFunds,
  held: PayingWalletHeld = NOTHING_HELD,
): FundsVerdict {
  const heldNote = (amount: bigint) => (amount > 0n ? `, with ${amount} held for transfers already out` : "");
  if (method === "crypto_usdc") {
    if (funds.usdcBaseUnits < amountRaw + held.usdcBaseUnits) {
      return {
        covered: false,
        detail: `USDC ${funds.usdcBaseUnits} is below the ${amountRaw} to send${heldNote(held.usdcBaseUnits)}`,
      };
    }
    const rent = funds.recipientHasUsdcAccount ? 0n : funds.usdcAccountRentLamports;
    const needed = PAYOUT_FEE_LAMPORTS + rent + PAYING_WALLET_KEEP_LAMPORTS + held.lamports;
    if (funds.solLamports < needed) {
      return {
        covered: false,
        detail: `SOL ${funds.solLamports} is below the ${needed} for the fee and rent${heldNote(held.lamports)}`,
      };
    }
    return { covered: true };
  }
  const needed = amountRaw + PAYOUT_FEE_LAMPORTS + PAYING_WALLET_KEEP_LAMPORTS + held.lamports;
  if (funds.solLamports < needed) {
    return {
      covered: false,
      detail: `SOL ${funds.solLamports} is below the ${needed} to send with its fee${heldNote(held.lamports)}`,
    };
  }
  return { covered: true };
}

/** The reads a funds check makes. A Connection satisfies it. */
export interface PayoutFundsConnection {
  getMultipleAccountsInfo: (
    publicKeys: PublicKey[],
    commitment?: Commitment,
  ) => Promise<(AccountInfo<Buffer> | null)[]>;
  getMinimumBalanceForRentExemption: (dataLength: number, commitment?: Commitment) => Promise<number>;
}

/** A token account's balance, or null when the bytes are not this mint's token account. */
function tokenAccountAmount(account: AccountInfo<Buffer>, mint: PublicKey): bigint | null {
  if (!account.owner.equals(TOKEN_PROGRAM_ID)) return null;
  if (account.data.length < ACCOUNT_SIZE) return null;
  const decoded = AccountLayout.decode(account.data.subarray(0, ACCOUNT_SIZE));
  if (!decoded.mint.equals(mint)) return null;
  return decoded.amount;
}

/**
 * What the paying wallet holds, in ONE read of the chain (so the SOL, the
 * USDC and the receiver's account are from the same moment), plus the rent
 * figure when a USDC account would have to be opened. Throws when a read
 * fails: the caller treats that as "the chain could not be read", never as
 * an empty wallet.
 */
export async function readPayingWalletFunds(
  connection: PayoutFundsConnection,
  input: { method: WalletPayoutMethod; payer: PublicKey; recipient: PublicKey; usdcMint: PublicKey },
): Promise<PayingWalletFunds> {
  if (input.method === "crypto_sol") {
    const [payer] = await connection.getMultipleAccountsInfo([input.payer], "confirmed");
    return {
      solLamports: BigInt(payer?.lamports ?? 0),
      usdcBaseUnits: 0n,
      recipientHasUsdcAccount: false,
      usdcAccountRentLamports: 0n,
    };
  }
  const payerAta = getAssociatedTokenAddressSync(input.usdcMint, input.payer);
  const recipientAta = getAssociatedTokenAddressSync(input.usdcMint, input.recipient);
  const [payer, payerToken, recipientToken] = await connection.getMultipleAccountsInfo(
    [input.payer, payerAta, recipientAta],
    "confirmed",
  );
  const recipientHasUsdcAccount = recipientToken !== null && recipientToken !== undefined;
  const usdcAccountRentLamports = recipientHasUsdcAccount
    ? 0n
    : BigInt(await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, "confirmed"));
  return {
    solLamports: BigInt(payer?.lamports ?? 0),
    usdcBaseUnits: payerToken ? (tokenAccountAmount(payerToken, input.usdcMint) ?? 0n) : 0n,
    recipientHasUsdcAccount,
    usdcAccountRentLamports,
  };
}

// ============================================
// Building and signing the transfer
// ============================================

export interface BuildPayoutTransferInput {
  method: WalletPayoutMethod;
  payer: PublicKey;
  recipient: PublicKey;
  /** What to send, in base units: lamports, or USDC with 6 decimals. */
  amountRaw: bigint;
  /** The network's USDC mint. Needed for crypto_usdc only. */
  usdcMint?: PublicKey;
  blockhash: string;
  lastValidBlockHeight: number;
}

export function buildPayoutTransfer(input: BuildPayoutTransferInput): Transaction {
  if (typeof input.amountRaw !== "bigint" || input.amountRaw <= 0n) {
    throw new Error("buildPayoutTransfer: the amount must be a bigint of base units above zero");
  }
  const tx = new Transaction({
    feePayer: input.payer,
    blockhash: input.blockhash,
    lastValidBlockHeight: input.lastValidBlockHeight,
  });

  if (input.method === "crypto_sol") {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: input.payer,
        toPubkey: input.recipient,
        lamports: input.amountRaw,
      }),
    );
    return tx;
  }

  if (!input.usdcMint) {
    throw new Error("buildPayoutTransfer: usdcMint required for crypto_usdc");
  }
  const payerAta = getAssociatedTokenAddressSync(input.usdcMint, input.payer);
  const recipientAta = getAssociatedTokenAddressSync(
    input.usdcMint,
    input.recipient,
  );
  tx.add(
    // Opens the receiver's USDC account when there is none; does nothing
    // when there is one.
    createAssociatedTokenAccountIdempotentInstruction(
      input.payer,
      recipientAta,
      input.recipient,
      input.usdcMint,
    ),
    createTransferCheckedInstruction(
      payerAta,
      input.usdcMint,
      recipientAta,
      input.payer,
      input.amountRaw,
      USDC_DECIMALS,
    ),
  );
  return tx;
}

/** A signed transfer that has NOT been sent: what the claim stores. */
export interface SignedPayoutArtifact {
  txSignature: string;
  signedTxB64: string;
  lastValidBlockHeight: bigint;
}

/**
 * Builds the transfer and signs it with the paying wallet. Does not send:
 * the bytes go on the payout row first (the claim), and only the stored
 * bytes are ever broadcast.
 */
export function signPayoutTransfer(
  input: BuildPayoutTransferInput,
  payoutWallet: Keypair,
): SignedPayoutArtifact {
  if (!payoutWallet.publicKey.equals(input.payer)) {
    throw new Error("signPayoutTransfer: the paying wallet is not the payer of the transfer");
  }
  const tx = buildPayoutTransfer(input);
  tx.sign(payoutWallet);
  if (!tx.signature) {
    throw new Error("signPayoutTransfer: the transfer did not sign");
  }
  return {
    txSignature: bs58.encode(tx.signature),
    signedTxB64: tx.serialize().toString("base64"),
    lastValidBlockHeight: BigInt(input.lastValidBlockHeight),
  };
}
