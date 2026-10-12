/**
 * Concrete-binding factory for createTokenCurveRoutes.
 *
 * The routes ship as a DI factory so they are testable in isolation; this
 * file is the production wiring. It knows Meteora's SDK, the Solana RPC,
 * Prisma and the prepare-token secret, and it is the ONLY implementation of
 * CurveChain outside the tests. The server holds no key: every method here
 * reads the chain, builds instructions, or passes on a transaction that a
 * browser wallet has signed.
 *
 * How many requests one pool reading costs (a public RPC limits them): one
 * for the pool account, one for its config the first time only (a config
 * never changes, so it is kept for the life of the process), and two for
 * the chain's clock. The routes keep a reading for METEORA_CURVE_CACHE_MS.
 * A submit asks once for the status of the transaction's signature before
 * it sends, and once more only when the wait for the confirmation failed.
 * Nothing here lists accounts: the pool's address comes from the token's
 * row, or is derived from its config and mint.
 */

import { PublicKey, type Connection } from "@solana/web3.js";
import BN from "bn.js";
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DynamicBondingCurveClient,
  SwapMode,
  TradeDirection,
  deriveDammV2PoolAddress,
  deriveDbcPoolAddress,
  getCurrentPoint,
  getTotalFeeNumeratorFromIncludedFeeAmount,
  type PoolConfig,
  type VirtualPool,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

import { prisma } from "@wheelsai/db";

import { env } from "../config/env.js";
import { getSolanaConnection } from "../lib/solana.js";
import { getSolQuote } from "../services/buildSolPriceDeps.js";
import { sampleCurvePoints } from "../services/launchpad/meteoraPresets.js";
import {
  CURVE_QUOTE_MINT,
  type ConfirmedTransactionRead,
  type CurveChain,
  type CurvePoint,
  type CurveSnapshot,
  type TokenBalanceRead,
} from "../services/meteoraCurve.js";
import { createLogger } from "../utils/logger.js";
import type { CurveTokenRow, TokenCurveRouteDeps } from "./tokenCurve.js";

const logger = createLogger("token-curve-chain");

// The most a u64 holds: "claim everything that is waiting".
const U64_MAX = new BN("18446744073709551615");

// A transaction that was just confirmed is sometimes not served yet by the
// node that is asked for it. A few short waits, then the caller's fallback.
const READ_BACK_ATTEMPTS = 4;
const READ_BACK_WAIT_MS = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SdkHandle {
  pool: VirtualPool;
  config: PoolConfig;
}

function toBigInt(value: { toString(): string }): bigint {
  return BigInt(value.toString());
}

function handleOf(snapshot: CurveSnapshot): SdkHandle {
  return snapshot.handle as SdkHandle;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================
// The chain, through Meteora's SDK
// ============================================

export function createSdkCurveChain(deps: {
  connection: Connection;
  client: DynamicBondingCurveClient;
}): CurveChain {
  const { connection, client } = deps;
  const configs = new Map<string, PoolConfig>();

  async function configOf(address: PublicKey): Promise<PoolConfig> {
    const key = address.toBase58();
    const kept = configs.get(key);
    if (kept) return kept;
    const config = await client.state.getPoolConfig(address);
    if (!config) throw new Error(`the pool's config ${key} was not found`);
    configs.set(key, config);
    return config;
  }

  // A config never changes, so neither does the line its curve draws.
  const drawings = new Map<string, CurvePoint[]>();

  function pointsOf(address: PublicKey, config: PoolConfig): CurvePoint[] {
    const key = address.toBase58();
    const kept = drawings.get(key);
    if (kept) return kept;
    let points: CurvePoint[];
    try {
      // The same sampling the presets' cards use, on the config the chain
      // has: the unused slots of its curve are zeros, which it leaves out.
      points = sampleCurvePoints({
        sqrtStartPrice: config.sqrtStartPrice,
        migrationQuoteThreshold: config.migrationQuoteThreshold,
        curve: config.curve,
      });
    } catch (err) {
      // The line is for a drawing. A config it cannot be sampled from still
      // has a pool that can be read and traded, so the page gets no line.
      logger.warn({ err, config: key }, "the curve of a config could not be sampled; its drawing is left empty");
      points = [];
    }
    drawings.set(key, points);
    return points;
  }

  return {
    async readCurve(poolAddress) {
      const address = new PublicKey(poolAddress);
      const pool = await client.state.getPool(address);
      if (!pool) return null;
      // Since SDK 1.5.8 a pool's fields sit under poolState.
      const state = pool.poolState;
      const config = await configOf(state.config);
      // The DAMM v2 pool's address follows from the config's migration fee
      // option, the mint and the quote mint; it is known before graduation.
      const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption];
      const vesting = config.lockedVestingConfig;
      return {
        poolAddress: address.toBase58(),
        configAddress: state.config.toBase58(),
        mintAddress: state.baseMint.toBase58(),
        creatorAddress: state.creator.toBase58(),
        quoteVault: state.quoteVault.toBase58(),
        baseVault: state.baseVault.toBase58(),
        sqrtPrice: toBigInt(state.sqrtPrice),
        quoteReserve: toBigInt(state.quoteReserve),
        migrationQuoteThreshold: toBigInt(config.migrationQuoteThreshold),
        isMigrated: Number(state.isMigrated) !== 0,
        // A u8 the SDK gives no names to: see MIGRATION_PROGRESS_* in
        // services/meteoraCurve.ts for what its values mean.
        migrationProgress: Number(state.migrationProgress),
        finishCurveTimestamp: Number(state.finishCurveTimestamp.toString()),
        // What client.state.getPoolFeeMetrics returns as
        // total.totalTradingQuoteFee, from the pool account already read.
        tradingFeesLamports: toBigInt(state.metrics.totalTradingQuoteFee),
        // What client.state.getPoolFeeBreakdown returns as
        // creator.unclaimedQuoteFee. That call reads the pool and its config
        // again; both are in hand, so the field is taken as it is.
        creatorClaimableLamports: toBigInt(state.creatorQuoteFee),
        creatorFeeSharePercent: config.creatorTradingFeePercentage,
        lockedVesting: {
          amountPerPeriod: toBigInt(vesting.amountPerPeriod),
          cliffUnlockAmount: toBigInt(vesting.cliffUnlockAmount),
          cliffSeconds: Number(vesting.cliffDurationFromMigrationTime.toString()),
          periods: Number(vesting.numberOfPeriod.toString()),
          frequencySeconds: Number(vesting.frequency.toString()),
        },
        graduatedPoolAddress: dammConfig
          ? deriveDammV2PoolAddress(dammConfig, state.baseMint, config.quoteMint).toBase58()
          : null,
        curvePoints: pointsOf(state.config, config),
        handle: { pool, config } satisfies SdkHandle,
      };
    },

    async currentPoint(snapshot) {
      return toBigInt(await getCurrentPoint(connection, handleOf(snapshot).config.activationType));
    },

    tradeFeeNumerator(snapshot, currentPoint) {
      const { pool, config } = handleOf(snapshot);
      // The fee a buy pays at this moment: the schedule's base fee plus the
      // dynamic fee, the SDK's own sum. These curves use a fee schedule, so
      // the amount (which only a rate limiter looks at) does not matter.
      return toBigInt(
        getTotalFeeNumeratorFromIncludedFeeAmount(
          config.poolFees,
          pool.poolState.volatilityTracker,
          new BN(currentPoint.toString()),
          pool.poolState.activationPoint,
          new BN(0),
          TradeDirection.QuoteToBase,
        ),
      );
    },

    quoteSwap(snapshot, input) {
      const { pool, config } = handleOf(snapshot);
      // A buy is a partial fill: a buy that would run past the graduation
      // threshold takes only what fills the curve, where an exact-in swap
      // would keep the excess and give no tokens for it. A sell has no such
      // end to run past, so it is an exact amount in.
      const result = client.pool.swapQuote2({
        virtualPool: pool,
        config,
        swapBaseForQuote: input.sell,
        swapMode: input.sell ? SwapMode.ExactIn : SwapMode.PartialFill,
        amountIn: new BN(input.amountIn.toString()),
        // The allowance is applied by the caller, in whole numbers.
        slippageBps: 0,
        hasReferral: false,
        eligibleForFirstSwapWithMinFee: false,
        currentPoint: new BN(input.currentPoint.toString()),
      });
      return {
        // What the swap takes of the amount in, fees included. The rest
        // (the result's amountLeft) never leaves the wallet for good.
        amountInUsed: toBigInt(result.includedFeeInputAmount),
        amountOut: toBigInt(result.outputAmount),
        // CollectFeeMode.QuoteToken on every curve launched here: each of
        // the three fees is taken in SOL, whichever way the trade goes.
        feeLamports: toBigInt(result.tradingFee) + toBigInt(result.protocolFee) + toBigInt(result.referralFee),
        nextSqrtPrice: toBigInt(result.nextSqrtPrice),
      };
    },

    async buildSwap(input) {
      // The same modes as the quote. For a buy the SDK wraps the whole
      // amount in as SOL, the program takes what the curve has left to sell,
      // and the SDK's closing instruction gives the rest back to the wallet.
      const tx = await client.pool.swap2({
        owner: new PublicKey(input.wallet),
        pool: new PublicKey(input.poolAddress),
        swapMode: input.sell ? SwapMode.ExactIn : SwapMode.PartialFill,
        amountIn: new BN(input.amountIn.toString()),
        minimumAmountOut: new BN(input.minimumOut.toString()),
        swapBaseForQuote: input.sell,
        referralTokenAccount: null,
      });
      return tx.instructions;
    },

    async buildClaim(input) {
      const creator = new PublicKey(input.creator);
      const tx = await client.creator.claimCreatorTradingFee({
        creator,
        payer: creator,
        pool: new PublicKey(input.poolAddress),
        maxBaseAmount: U64_MAX,
        maxQuoteAmount: U64_MAX,
      });
      return tx.instructions;
    },

    async buildLocker(input) {
      const tx = await client.migration.createLocker({
        payer: new PublicKey(input.payer),
        pool: new PublicKey(input.poolAddress),
      });
      return tx.instructions;
    },

    async buildMigration(snapshot, input) {
      const { config } = handleOf(snapshot);
      const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption];
      if (!dammConfig) {
        throw new Error(`no DAMM v2 config is known for migration fee option ${config.migrationFeeOption}`);
      }
      const migration = await client.migration.migrateToDammV2({
        payer: new PublicKey(input.payer),
        pool: new PublicKey(snapshot.poolAddress),
        dammConfig,
      });
      return {
        instructions: migration.transaction.instructions,
        signers: [migration.firstPositionNftKeypair, migration.secondPositionNftKeypair],
      };
    },

    async latestBlockhash() {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      return { blockhash, lastValidBlockHeight };
    },

    send(raw) {
      // Preflight on: a trade the chain would refuse (not enough SOL, the
      // price moved past the allowance) is refused here and nothing lands.
      return connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed" });
    },

    async confirm(signature, sentWith) {
      const result = await connection.confirmTransaction(
        { signature, blockhash: sentWith.blockhash, lastValidBlockHeight: sentWith.lastValidBlockHeight },
        "confirmed",
      );
      if (result.value.err) {
        throw new Error(`the transaction failed on chain: ${JSON.stringify(result.value.err)}`);
      }
    },

    async readTransaction(signature) {
      for (let attempt = 0; attempt < READ_BACK_ATTEMPTS; attempt += 1) {
        const tx = await connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        if (tx && tx.meta) {
          const keys = tx.transaction.message.getAccountKeys({
            accountKeysFromLookups: tx.meta.loadedAddresses,
          });
          const accountKeys: string[] = [];
          for (let i = 0; i < keys.length; i += 1) accountKeys.push(keys.get(i)?.toBase58() ?? "");
          const balances = (list: typeof tx.meta.preTokenBalances): TokenBalanceRead[] =>
            (list ?? []).map((balance) => ({
              accountIndex: balance.accountIndex,
              mint: balance.mint,
              owner: balance.owner ?? null,
              amountRaw: balance.uiTokenAmount.amount,
            }));
          const read: ConfirmedTransactionRead = {
            blockTime: tx.blockTime ?? null,
            accountKeys,
            preTokenBalances: balances(tx.meta.preTokenBalances),
            postTokenBalances: balances(tx.meta.postTokenBalances),
          };
          return read;
        }
        if (attempt < READ_BACK_ATTEMPTS - 1) await wait(READ_BACK_WAIT_MS);
      }
      return null;
    },

    async signatureStatus(signature) {
      // One request. The history is searched too, so a transaction of a few
      // minutes ago that the node no longer keeps at hand is still found.
      const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const status = value[0];
      if (!status) return "not_seen";
      if (status.err) return "failed";
      // "processed" may still be dropped by the cluster: not yet a success.
      return status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized"
        ? "succeeded"
        : "not_seen";
    },
  };
}

// ============================================
// The token's row
// ============================================

async function loadToken(id: string): Promise<CurveTokenRow | null> {
  // The id column is a uuid: anything else is no token, not a query error.
  if (!UUID.test(id)) return null;
  const row = await prisma.agentToken.findUnique({
    where: { id },
    select: {
      id: true,
      mintAddress: true,
      launchpad: true,
      meteoraConfigKey: true,
      bondingCurveAddress: true,
      status: true,
    },
  });
  if (!row) return null;

  // For a meteora token bondingCurveAddress is the pool's address. A row
  // without it still has the config, and the pool follows from the config
  // and the mint without asking the chain.
  let poolAddress = row.bondingCurveAddress;
  if (!poolAddress && row.launchpad === "meteora" && row.meteoraConfigKey) {
    try {
      poolAddress = deriveDbcPoolAddress(
        new PublicKey(CURVE_QUOTE_MINT),
        new PublicKey(row.mintAddress),
        new PublicKey(row.meteoraConfigKey),
      ).toBase58();
    } catch {
      poolAddress = null;
    }
  }
  return {
    id: row.id,
    mintAddress: row.mintAddress,
    launchpad: row.launchpad,
    poolAddress,
    status: row.status,
  };
}

// ============================================
// Public factory
// ============================================

export function buildTokenCurveRouteDeps(): TokenCurveRouteDeps {
  // Making the client asks the chain nothing. A server whose launchpad is
  // not meteora mounts these routes too: they answer not_a_curve_token.
  const connection = getSolanaConnection();
  const chain = createSdkCurveChain({
    connection,
    client: new DynamicBondingCurveClient(connection, "confirmed"),
  });

  return {
    chain,
    loadToken,
    recordTrade: async (row) => {
      // tx_signature is unique: a repeat of the same signature writes nothing.
      const written = await prisma.agentTokenTrade.createMany({
        data: [
          {
            tokenId: row.tokenId,
            txSignature: row.txSignature,
            traderAddress: row.traderAddress,
            side: row.side,
            solAmount: row.solAmount,
            tokenAmount: row.tokenAmount,
            priceUsd: row.priceUsd,
            solLamports: row.solLamports,
            tokenAmountRaw: row.tokenAmountRaw,
            timestamp: row.timestamp,
          },
        ],
        skipDuplicates: true,
      });
      return { created: written.count > 0 };
    },
    markGraduated: async ({ tokenId, graduatedPoolAddress, at, creatorLockupEnd }) => {
      // Only a BONDING row graduates, so a repeat changes nothing.
      await prisma.agentToken.updateMany({
        where: { id: tokenId, status: "BONDING" },
        data: {
          status: "GRADUATED",
          graduatedAt: at,
          // The column's name is older than this use: for a meteora token it
          // holds the address of the Meteora DAMM v2 pool, not a Raydium one.
          raydiumPoolId: graduatedPoolAddress,
          // The creator's lock starts at graduation, so its date is first
          // known now. A config that locks nothing leaves the column alone.
          ...(creatorLockupEnd ? { creatorLockupEnd } : {}),
        },
      });
    },
    solUsd: async () => {
      // The service's SOL price (services/buildSolPriceDeps.ts). It never
      // throws; a refusal (the source is off, the price is stale) is "no price".
      const quote = await getSolQuote();
      return quote.ok ? Number(quote.quote.midMicroUsdPerSol) / 1_000_000 : null;
    },
    network: env.SOLANA_NETWORK,
    // The same derivation the launch uses, with its own separator, so a
    // launch token and a curve token can never be taken for one another.
    prepareTokenSecret: env.WALLET_MASTER_KEY ? `${env.WALLET_MASTER_KEY}::curve-prepare-token-v1` : null,
    cacheMs: env.METEORA_CURVE_CACHE_MS,
  };
}
