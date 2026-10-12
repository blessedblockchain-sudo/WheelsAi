/**
 * What does the chain accept from us? A read-only probe of Meteora's Dynamic
 * Bonding Curve, for the `meteora` launchpad adapter.
 *
 * It builds the transactions WheelsAI would build (a launch, a buy, a sell,
 * a creator fee claim, the graduation steps) and asks the cluster to
 * SIMULATE them. Nothing is signed and nothing is sent: every simulation
 * runs with signature checks off, so no keypair is read or needed. The
 * payer is only named; it must hold some SOL for the simulation to pass.
 *
 *   npx tsx scripts/meteora-devnet-probe.ts --payer <address>
 *   npx tsx scripts/meteora-devnet-probe.ts --payer <address> --pool <pool address>
 *   npx tsx scripts/meteora-devnet-probe.ts --payer <address> --rpc <url>
 *
 * Without --pool it looks at the program's most recent transactions to find
 * a pool that exists, and tries the trade and claim steps against it.
 *
 * Exit 0 when every step it could try was accepted, 1 otherwise.
 */
/* eslint-disable no-console */

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Transaction,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DammV2DynamicFeeMode,
  DynamicBondingCurveClient,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurveWithMarketCap,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

const WSOL = new PublicKey("So11111111111111111111111111111111111111112");

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

let failed = false;
function report(step: string, ok: boolean | null, detail: string): void {
  const mark = ok === null ? "skip" : ok ? "ok  " : "FAIL";
  if (ok === false) failed = true;
  console.log(`${mark}  ${step}${detail ? `  (${detail})` : ""}`);
}

async function simulate(
  connection: Connection,
  payer: PublicKey,
  tx: Transaction,
): Promise<{ ok: boolean; detail: string; logs: string[] }> {
  const { blockhash } = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: tx.instructions,
  }).compileToV0Message();
  const versioned = new VersionedTransaction(message);
  const size = versioned.serialize().length;
  const result = await connection.simulateTransaction(versioned, {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  const logs = result.value.logs ?? [];
  const facts = `${tx.instructions.length} instructions, ${size} of 1232 bytes, ${message.header.numRequiredSignatures} signatures, ${result.value.unitsConsumed ?? "?"} units`;
  if (result.value.err === null) return { ok: true, detail: facts, logs };
  const why = logs.filter((line) => /Error|failed|custom program error/i.test(line)).slice(-2).join(" | ");
  return { ok: false, detail: `${facts}; ${JSON.stringify(result.value.err)} ${why}`.slice(0, 500), logs };
}

/** A curve shaped like the ones the adapter will offer, vesting included. */
function probeCurve() {
  return buildCurveWithMarketCap({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: 1_000_000_000,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: { startingFeeBps: 5000, endingFeeBps: 100, numberOfPeriod: 60, totalDuration: 600 },
      },
      dynamicFeeEnabled: true,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 50,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: {
        collectFeeMode: MigratedCollectFeeMode.QuoteToken,
        dynamicFee: DammV2DynamicFeeMode.Enabled,
        poolFeeBps: 100,
      },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 50,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: 100_000_000,
      numberOfVestingPeriod: 12,
      cliffUnlockAmount: 0,
      totalVestingDuration: 365 * 24 * 60 * 60,
      cliffDurationFromMigrationTime: 30 * 24 * 60 * 60,
    },
    activationType: ActivationType.Timestamp,
    initialMarketCap: 20,
    migrationMarketCap: 320,
  });
}

/** A pool of the program that exists now, from the program's latest transactions. */
async function findAPool(connection: Connection, client: DynamicBondingCurveClient): Promise<PublicKey | null> {
  const signatures = await connection.getSignaturesForAddress(DYNAMIC_BONDING_CURVE_PROGRAM_ID, { limit: 12 });
  for (const entry of signatures) {
    if (entry.err) continue;
    const tx = await connection.getTransaction(entry.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx) continue;
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys.get(i);
      if (!key) continue;
      try {
        const info = await connection.getAccountInfo(key);
        if (!info || !info.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID) || info.data.length < 300) continue;
        const pool = await client.state.getPool(key);
        if (pool) return key;
      } catch {
        // not a pool account
      }
    }
  }
  return null;
}

async function main(): Promise<void> {
  const payerArg = arg("payer");
  if (!payerArg) {
    console.error("usage: npx tsx scripts/meteora-devnet-probe.ts --payer <address with some SOL> [--pool <address>] [--rpc <url>]");
    process.exit(2);
  }
  const payer = new PublicKey(payerArg);
  const connection = new Connection(arg("rpc") ?? "https://api.devnet.solana.com", "confirmed");
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  console.log(`cluster ${connection.rpcEndpoint}; payer ${payer.toBase58()} holds ${((await connection.getBalance(payer)) / 1e9).toFixed(3)} SOL`);

  // 1. The launch: config and pool in one transaction.
  const config = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const curve = probeCurve();
  const launch = await client.partner.createConfigAndPool({
    ...curve,
    config,
    feeClaimer: payer,
    leftoverReceiver: payer,
    quoteMint: WSOL,
    payer,
    preCreatePoolParam: {
      name: "Probe Agent",
      symbol: "PROBE",
      uri: "https://example.com/token-metadata.json",
      poolCreator: payer,
      baseMint: mint,
    },
  });
  const launched = await simulate(connection, payer, launch);
  report("launch: a config and a pool in one transaction", launched.ok, launched.detail);
  console.log(`      curve: ${curve.curve.length} points, graduation at ${(Number(curve.migrationQuoteThreshold) / 1e9).toFixed(3)} SOL raised`);

  // 2. A pool that exists, for the steps that need one.
  const poolArg = arg("pool");
  const poolAddress = poolArg ? new PublicKey(poolArg) : await findAPool(connection, client);
  if (!poolAddress) {
    report("a pool to try the other steps against", null, "none found in the program's latest transactions; pass --pool");
    process.exit(failed ? 1 : 0);
  }
  const read = await client.state.getPool(poolAddress);
  if (!read) {
    report("read the pool", false, `${poolAddress.toBase58()} is not a pool this SDK can read`);
    process.exit(1);
  }
  // Since SDK 1.5.8 a pool's fields sit under poolState.
  const pool = read.poolState;
  const poolConfig = await client.state.getPoolConfig(pool.config);
  if (!poolConfig) {
    report("read the pool's config", false, pool.config.toBase58());
    process.exit(1);
  }
  const progress = await client.state.getPoolQuoteTokenCurveProgress(poolAddress);
  report(
    "read a pool and its config",
    true,
    `pool ${poolAddress.toBase58()}, mint ${pool.baseMint.toBase58().slice(0, 8)}..., ${(progress * 100).toFixed(1)}% of the way to graduation, migrated: ${pool.isMigrated}`,
  );
  const fees = await client.state.getPoolFeeBreakdown(poolAddress);
  report(
    "read what the creator and the partner can claim",
    true,
    `creator ${fees.creator.unclaimedQuoteFee.toString()} quote units, partner ${fees.partner.unclaimedQuoteFee.toString()}`,
  );

  const complete = progress >= 1;
  if (!complete && !pool.isMigrated) {
    // 3. A buy by the payer.
    const amountIn = new BN(10_000_000); // 0.01 SOL
    const buy = await client.pool.swap({
      owner: payer,
      pool: poolAddress,
      amountIn,
      minimumAmountOut: new BN(0),
      swapBaseForQuote: false,
      referralTokenAccount: null,
    });
    const bought = await simulate(connection, payer, buy);
    report("buy 0.01 SOL of the token", bought.ok, bought.detail);

    // 4. A sell, by the pool's creator when they hold some of the token (a
    // public RPC refuses the call that lists a token's largest holders).
    try {
      const held = await connection.getParsedTokenAccountsByOwner(pool.creator, { mint: pool.baseMint });
      const raw = held.value
        .map((entry) => new BN(entry.account.data.parsed.info.tokenAmount.amount as string))
        .reduce((sum, amount) => sum.add(amount), new BN(0));
      if (raw.isZero()) {
        report("sell", null, "the pool's creator holds none of the token; a sell uses the same instruction as the buy, the other way");
      } else {
        const sell = await client.pool.swap({
          owner: pool.creator,
          pool: poolAddress,
          amountIn: raw.divn(100).isZero() ? raw : raw.divn(100),
          minimumAmountOut: new BN(0),
          swapBaseForQuote: true,
          referralTokenAccount: null,
          payer,
        });
        const result = await simulate(connection, payer, sell);
        report("sell 1% of the creator's tokens", result.ok, result.detail);
      }
    } catch (error) {
      report("sell", null, `could not look up a holder: ${(error as Error).message.slice(0, 120)}`);
    }
  } else {
    report("buy and sell", null, "this pool's curve is complete; pass --pool with one that is still trading");
  }

  // 5. The creator's fee claim.
  const claim = await client.creator.claimCreatorTradingFee({
    creator: pool.creator,
    payer,
    pool: poolAddress,
    maxBaseAmount: new BN("18446744073709551615"),
    maxQuoteAmount: new BN("18446744073709551615"),
  });
  const claimed = await simulate(connection, payer, claim);
  report("the creator claims trading fees", claimed.ok, claimed.detail);

  // 6. Graduation, when this pool is ready for it.
  if (complete && !pool.isMigrated) {
    const option = poolConfig.migrationFeeOption as number;
    const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[option];
    try {
      const locker = await client.migration.createLocker({ payer, pool: poolAddress });
      const locked = await simulate(connection, payer, locker);
      report("graduation: the locker for vested tokens", locked.ok, locked.detail);
    } catch (error) {
      report("graduation: the locker for vested tokens", null, (error as Error).message.slice(0, 160));
    }
    const migration = await client.migration.migrateToDammV2({ payer, pool: poolAddress, dammConfig });
    const migrated = await simulate(connection, payer, migration.transaction);
    report("graduation: move the pool into DAMM v2", migrated.ok, migrated.detail);
  } else {
    report("graduation", null, pool.isMigrated ? "this pool has already graduated" : "this pool's curve is not complete yet");
  }

  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(`the probe itself failed: ${(error as Error).message}`);
  process.exit(1);
});
