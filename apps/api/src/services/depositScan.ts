/**
 * What one finalized transaction did to one deposit address (payments
 * pass, batch 5). Pure: no I/O, no settings, no clock.
 *
 * The scan (services/runDepositScanTick.ts) hands in the plain facts of a
 * transaction and gets back what arrived at the address: lamports in, USDC
 * base units in for our mint at token accounts the address owns, the
 * prepared top-up its memo names if any, and what the address and its USDC
 * account held AFTER it. That last pair is what the scan stores beside its
 * cursor.
 *
 * Rules:
 *   - A failed transaction moved nothing in. Its balances are still read:
 *     they are what it left at the address.
 *   - A change below zero is a transfer OUT. It is reported as such and
 *     gets no receipt.
 *   - Nothing here judges who sent a transfer.
 *
 * For a version 0 transaction the account list is the static keys, then
 * the loaded writable addresses, then the loaded read-only ones: that is
 * the order the node reports balances in (orderedAccountKeys).
 */

/** Memo v2 and the older Memo v1: both carry plain text. */
export const MEMO_PROGRAM_IDS: readonly string[] = [
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
];

const TOPUP_MEMO_PREFIX = "wheelsai-topup:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One entry of a transaction's token balances, before or after. */
export interface TokenBalanceFact {
  /** Index into the transaction's account list. */
  accountIndex: number;
  mint: string;
  /** The owner of the token account, when the node reports it. */
  owner: string | null;
  /** Base units. */
  amountRaw: bigint;
}

/** The plain facts of one finalized transaction. */
export interface TransactionFacts {
  signature: string;
  /** True when the transaction failed on the chain. */
  failed: boolean;
  /** Every account, in the order the balances are in. */
  accountKeys: string[];
  preLamports: bigint[];
  postLamports: bigint[];
  preTokenBalances: TokenBalanceFact[];
  postTokenBalances: TokenBalanceFact[];
  signers: string[];
  memos: string[];
  slot: bigint | null;
  blockTime: Date | null;
}

/** What a transaction did to one deposit address. */
export interface DepositEffect {
  signature: string;
  failed: boolean;
  /** Lamports that arrived. 0 when none did, or the transaction failed. */
  lamportsIn: bigint;
  /** USDC base units that arrived. 0 when none did, or it failed. */
  usdcIn: bigint;
  /** Lamports that left (a transfer out). Never credited, never a receipt. */
  lamportsOut: bigint;
  usdcOut: bigint;
  /** The prepared top-up the memo names, or null. */
  topupId: string | null;
  /** What the address held before it and after it; null when the address
   * is not in it. */
  lamportsBefore: bigint | null;
  lamportsAfter: bigint | null;
  /** What the USDC account held before it and after it; null when that
   * account is not in it. An account in it with no token balance holds
   * nothing: one that the transaction opens held nothing before. */
  usdcBefore: bigint | null;
  usdcAfter: bigint | null;
  signers: string[];
  slot: bigint | null;
  blockTime: Date | null;
}

/**
 * The account list of a transaction in the order its balances are in:
 * the static keys, then the loaded writable addresses, then the loaded
 * read-only ones. A legacy transaction has only static keys.
 */
export function orderedAccountKeys(input: {
  staticKeys: readonly string[];
  loadedWritable?: readonly string[] | null;
  loadedReadonly?: readonly string[] | null;
}): string[] {
  return [
    ...input.staticKeys,
    ...(input.loadedWritable ?? []),
    ...(input.loadedReadonly ?? []),
  ];
}

/** The top-up id a memo names: "wheelsai-topup:<uuid>" and nothing else. */
export function topupIdFromMemos(memos: readonly string[]): string | null {
  for (const memo of memos) {
    const text = memo.trim();
    if (!text.startsWith(TOPUP_MEMO_PREFIX)) continue;
    const id = text.slice(TOPUP_MEMO_PREFIX.length);
    if (UUID.test(id)) return id.toLowerCase();
  }
  return null;
}

function amountAt(list: readonly bigint[], index: number): bigint {
  const value = list[index];
  return typeof value === "bigint" ? value : 0n;
}

export function depositEffect(
  facts: TransactionFacts,
  target: {
    /** The deposit address. */
    address: string;
    /** Its associated token account for our USDC mint. */
    usdcAccount: string;
    usdcMint: string;
  },
): DepositEffect {
  const keys = facts.accountKeys;

  // Lamports: the address's own balance, before and after.
  const addressIndex = keys.indexOf(target.address);
  let lamportsDelta = 0n;
  let lamportsBefore: bigint | null = null;
  let lamportsAfter: bigint | null = null;
  if (addressIndex >= 0 && addressIndex < facts.postLamports.length) {
    lamportsBefore = amountAt(facts.preLamports, addressIndex);
    lamportsAfter = amountAt(facts.postLamports, addressIndex);
    lamportsDelta = lamportsAfter - lamportsBefore;
  }

  // USDC: every token account of our mint that the address owns. An
  // entry with no owner reported counts only when it is the address's
  // own USDC account.
  const ours = (entry: TokenBalanceFact): boolean => {
    if (entry.mint !== target.usdcMint) return false;
    if (entry.owner !== null) return entry.owner === target.address;
    return keys[entry.accountIndex] === target.usdcAccount;
  };
  const before = new Map<number, bigint>();
  const after = new Map<number, bigint>();
  for (const entry of facts.preTokenBalances) {
    if (ours(entry)) before.set(entry.accountIndex, entry.amountRaw);
  }
  for (const entry of facts.postTokenBalances) {
    if (ours(entry)) after.set(entry.accountIndex, entry.amountRaw);
  }
  let usdcDelta = 0n;
  for (const index of new Set([...before.keys(), ...after.keys()])) {
    usdcDelta += (after.get(index) ?? 0n) - (before.get(index) ?? 0n);
  }

  const usdcAccountIndex = keys.indexOf(target.usdcAccount);
  const usdcBefore =
    usdcAccountIndex >= 0 ? (before.get(usdcAccountIndex) ?? 0n) : null;
  const usdcAfter =
    usdcAccountIndex >= 0 ? (after.get(usdcAccountIndex) ?? 0n) : null;

  // A failed transaction changed nothing but its fee payer's balance.
  // Nothing it shows is a transfer in.
  const moved = !facts.failed;

  return {
    signature: facts.signature,
    failed: facts.failed,
    lamportsIn: moved && lamportsDelta > 0n ? lamportsDelta : 0n,
    usdcIn: moved && usdcDelta > 0n ? usdcDelta : 0n,
    lamportsOut: lamportsDelta < 0n ? -lamportsDelta : 0n,
    usdcOut: usdcDelta < 0n ? -usdcDelta : 0n,
    topupId: topupIdFromMemos(facts.memos),
    lamportsBefore,
    lamportsAfter,
    usdcBefore,
    usdcAfter,
    signers: [...facts.signers],
    slot: facts.slot,
    blockTime: facts.blockTime,
  };
}

// ============================================
// From a node's answer to the plain facts
// ============================================

interface KeyLike {
  toBase58: () => string;
}

interface RpcTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

/** The part of getTransaction's answer (maxSupportedTransactionVersion 0)
 * the facts are read from. */
export interface RpcTransactionLike {
  slot: number;
  blockTime?: number | null;
  transaction: {
    message: {
      staticAccountKeys: readonly KeyLike[];
      header: { numRequiredSignatures: number };
      compiledInstructions: ReadonlyArray<{
        programIdIndex: number;
        data: Uint8Array;
      }>;
    };
  };
  meta: {
    err: unknown;
    preBalances: readonly number[];
    postBalances: readonly number[];
    preTokenBalances?: readonly RpcTokenBalance[] | null;
    postTokenBalances?: readonly RpcTokenBalance[] | null;
    loadedAddresses?: {
      writable: readonly KeyLike[];
      readonly: readonly KeyLike[];
    } | null;
  } | null;
}

function tokenFacts(
  list: readonly RpcTokenBalance[] | null | undefined,
): TokenBalanceFact[] {
  return (list ?? []).map((entry) => ({
    accountIndex: entry.accountIndex,
    mint: entry.mint,
    owner: typeof entry.owner === "string" ? entry.owner : null,
    amountRaw: BigInt(entry.uiTokenAmount.amount),
  }));
}

/**
 * The plain facts of a transaction as a node answered it. null when the
 * answer cannot be used (no answer, or one without its balances): the
 * caller treats that as "could not be loaded" and tries again later.
 */
export function transactionFactsFromRpc(
  signature: string,
  response: RpcTransactionLike | null | undefined,
): TransactionFacts | null {
  if (!response || !response.meta) return null;
  const { meta } = response;
  const message = response.transaction.message;
  const staticKeys = message.staticAccountKeys.map((key) => key.toBase58());
  const accountKeys = orderedAccountKeys({
    staticKeys,
    loadedWritable: meta.loadedAddresses?.writable.map((key) => key.toBase58()),
    loadedReadonly: meta.loadedAddresses?.readonly.map((key) => key.toBase58()),
  });
  if (
    meta.preBalances.length !== accountKeys.length ||
    meta.postBalances.length !== accountKeys.length
  ) {
    // The balances do not line up with the accounts: nothing can be read
    // from this answer safely.
    return null;
  }

  const memos: string[] = [];
  for (const instruction of message.compiledInstructions) {
    const program = accountKeys[instruction.programIdIndex];
    if (program && MEMO_PROGRAM_IDS.includes(program)) {
      memos.push(Buffer.from(instruction.data).toString("utf8"));
    }
  }

  return {
    signature,
    failed: meta.err !== null && meta.err !== undefined,
    accountKeys,
    preLamports: meta.preBalances.map((value) => BigInt(value)),
    postLamports: meta.postBalances.map((value) => BigInt(value)),
    preTokenBalances: tokenFacts(meta.preTokenBalances),
    postTokenBalances: tokenFacts(meta.postTokenBalances),
    signers: staticKeys.slice(0, message.header.numRequiredSignatures),
    memos,
    slot: Number.isFinite(response.slot) ? BigInt(response.slot) : null,
    blockTime:
      typeof response.blockTime === "number"
        ? new Date(response.blockTime * 1000)
        : null,
  };
}
