import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";

/**
 * Client-side pump.fun trading is DISABLED.
 *
 * The previous hand-rolled buy/sell builders here were constructed from a
 * guessed IDL and were unsafe to ship: the buy encoded token_amount=0 on an
 * invented "0 means spend SOL" semantic, the sell hardcoded min_sol_output=0
 * (unbounded slippage) while silently ignoring its slippageBps parameter,
 * and the account list did not match the program. Trading will return as a
 * server-prepared transaction flow (backend builds + quotes via the venue
 * API and the browser only signs), mirroring the launch flow.
 *
 * The builders are kept as throwing stubs so any code path that tries to
 * trade client-side fails loudly instead of losing funds.
 */

const TRADING_DISABLED_MESSAGE =
  "Client-side pump.fun trading is disabled. Trading will return as a server-prepared transaction flow.";

export async function buildBuyTransaction(
  _connection: Connection,
  _buyer: PublicKey,
  _mint: PublicKey,
  _solAmount: number,
  _slippageBps: number = 100
): Promise<Transaction> {
  throw new Error(TRADING_DISABLED_MESSAGE);
}

export async function buildSellTransaction(
  _connection: Connection,
  _seller: PublicKey,
  _mint: PublicKey,
  _tokenAmount: bigint,
  _slippageBps: number = 100
): Promise<Transaction> {
  throw new Error(TRADING_DISABLED_MESSAGE);
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
