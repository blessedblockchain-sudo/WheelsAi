/**
 * Runs the curve routes' own chain wiring (routes/tokenCurveBindings.ts)
 * against devnet: the reads as the routes make them, and every transaction
 * as the routes build it, handed to the cluster to simulate. Nothing is
 * signed and nothing is sent: simulations run with signature checks off, so
 * no keypair is read or needed. The payer is only named; it must hold some
 * SOL for the simulations to pass.
 *
 *   npx tsx scripts/meteora-bindings-probe.ts --payer <address> \
 *     --trading <pool> --locker-due <pool> --ready <pool> [--rpc <url>]
 *
 * Pools to pass are named in the header of meteora-devnet-probe.ts.
 * Exit 0 when every step it could try was accepted, 1 otherwise.
 */
/* eslint-disable no-console */
import { Connection, PublicKey, SystemProgram, type TransactionInstruction, type Keypair } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";

import { createSdkCurveChain } from "../src/routes/tokenCurveBindings.js";
import {
  CURVE_COMPUTE_UNIT_LIMIT,
  CURVE_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
  LOCKER_COMPUTE_UNIT_LIMIT,
  compileCurveTransaction,
  describeCurve,
  type CurveSnapshot,
} from "../src/services/meteoraCurve.js";

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

const plain = (value: unknown): string =>
  JSON.stringify(value, (_key, inner) => (typeof inner === "bigint" ? inner.toString() : inner));

async function main(): Promise<void> {
  const payer = arg("payer");
  if (!payer) {
    console.error("usage: npx tsx scripts/meteora-bindings-probe.ts --payer <address> [--trading <pool>] [--locker-due <pool>] [--ready <pool>] [--rpc <url>]");
    process.exit(1);
  }
  const connection = new Connection(arg("rpc") ?? "https://api.devnet.solana.com", "confirmed");
  const chain = createSdkCurveChain({ connection, client: new DynamicBondingCurveClient(connection, "confirmed") });

  async function simulate(
    step: string,
    instructions: TransactionInstruction[],
    options: { unitLimit?: number; signers?: Keypair[] },
  ): Promise<void> {
    try {
      const { blockhash } = await chain.latestBlockhash();
      const built = compileCurveTransaction({
        payer: payer as string,
        blockhash,
        instructions,
        signers: options.signers,
        computeBudget: options.unitLimit
          ? { unitLimit: options.unitLimit, microLamports: CURVE_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS }
          : undefined,
      });
      const result = await connection.simulateTransaction(built.tx, { sigVerify: false, replaceRecentBlockhash: true });
      const logs = result.value.logs ?? [];
      const why = logs.filter((line) => /Error|failed|custom program error/i.test(line)).slice(-2).join(" | ");
      const facts = `${built.tx.message.compiledInstructions.length} instructions, ${Buffer.from(built.base64, "base64").length} of 1232 bytes, ${built.tx.message.header.numRequiredSignatures} signatures, ${result.value.unitsConsumed ?? "?"} units`;
      report(step, result.value.err === null, result.value.err === null ? facts : `${facts}; ${JSON.stringify(result.value.err)} ${why}`.slice(0, 500));
    } catch (error) {
      report(step, false, (error as Error).message.slice(0, 300));
    }
  }

  async function read(label: string, pool: string): Promise<CurveSnapshot | null> {
    try {
      const snapshot = await chain.readCurve(pool);
      if (!snapshot) {
        report(`read the ${label} pool`, false, `${pool} was not found`);
        return null;
      }
      const currentPoint = await chain.currentPoint(snapshot);
      const feeNumerator = chain.tradeFeeNumerator(snapshot, currentPoint);
      const json = describeCurve({ snapshot, currentPoint, feeNumerator, readAt: new Date() }, "devnet");
      const { curvePoints, ...rest } = json as unknown as { curvePoints?: Array<{ soldPercent: number; priceSol: number }> } & Record<string, unknown>;
      report(
        `read the ${label} pool`,
        true,
        `progress value ${snapshot.migrationProgress}; ${plain(rest)}; ${curvePoints?.length ?? 0} curve points, first ${plain(curvePoints?.[0])}, last ${plain(curvePoints?.[(curvePoints?.length ?? 1) - 1])}`.slice(0, 1500),
      );
      return snapshot;
    } catch (error) {
      report(`read the ${label} pool`, false, (error as Error).message.slice(0, 300));
      return null;
    }
  }

  // The route builds a claim that the creator pays for and signs alone. That
  // can only be simulated for a pool whose creator is a plain wallet holding
  // SOL: a creator that is another program's account cannot pay for anything.
  async function claimFor(label: string, pool: string, snapshot: CurveSnapshot): Promise<void> {
    const step = `the creator's fee claim as the route builds it (${label} pool)`;
    const creator = await connection.getAccountInfo(new PublicKey(snapshot.creatorAddress));
    if (!creator || !creator.owner.equals(SystemProgram.programId) || creator.data.length > 0 || creator.lamports < 5_000_000) {
      report(step, null, `this pool's creator ${snapshot.creatorAddress} is not a plain wallet with SOL`);
      return;
    }
    try {
      const { blockhash } = await chain.latestBlockhash();
      const built = compileCurveTransaction({
        payer: snapshot.creatorAddress,
        blockhash,
        instructions: await chain.buildClaim({ poolAddress: pool, creator: snapshot.creatorAddress }),
        computeBudget: { unitLimit: CURVE_COMPUTE_UNIT_LIMIT, microLamports: CURVE_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS },
      });
      const result = await connection.simulateTransaction(built.tx, { sigVerify: false, replaceRecentBlockhash: true });
      const logs = result.value.logs ?? [];
      const why = logs.filter((line) => /Error|failed|custom program error/i.test(line)).slice(-2).join(" | ");
      const facts = `${built.tx.message.compiledInstructions.length} instructions, ${Buffer.from(built.base64, "base64").length} of 1232 bytes, ${built.tx.message.header.numRequiredSignatures} signatures, ${result.value.unitsConsumed ?? "?"} units, ${snapshot.creatorClaimableLamports} lamports to claim`;
      report(step, result.value.err === null, result.value.err === null ? facts : `${facts}; ${JSON.stringify(result.value.err)} ${why}`.slice(0, 500));
    } catch (error) {
      report(step, false, (error as Error).message.slice(0, 300));
    }
  }

  const trading = arg("trading");
  if (trading) {
    const snapshot = await read("trading", trading);
    if (snapshot) {
      const currentPoint = await chain.currentPoint(snapshot);
      for (const lamports of [10_000_000n, 1_000_000_000_000_000n]) {
        try {
          const quote = chain.quoteSwap(snapshot, { sell: false, amountIn: lamports, currentPoint });
          report(`quote a buy of ${lamports} lamports`, true, plain(quote));
        } catch (error) {
          report(`quote a buy of ${lamports} lamports`, false, (error as Error).message.slice(0, 300));
        }
      }
      try {
        const quote = chain.quoteSwap(snapshot, { sell: true, amountIn: 1_000_000n, currentPoint });
        report("quote a sell of 1 token (1,000,000 raw units)", true, plain(quote));
      } catch (error) {
        report("quote a sell of 1 token", false, (error as Error).message.slice(0, 300));
      }
      const buy = await chain.buildSwap({ poolAddress: trading, wallet: payer, sell: false, amountIn: 10_000_000n, minimumOut: 1n });
      await simulate("a buy of 0.01 SOL as the route builds it", buy, { unitLimit: CURVE_COMPUTE_UNIT_LIMIT });
      await claimFor("trading", trading, snapshot);
    }
  }

  const lockerDue = arg("locker-due");
  if (lockerDue) {
    const snapshot = await read("full, locker due", lockerDue);
    if (snapshot) {
      const locker = await chain.buildLocker({ poolAddress: lockerDue, payer });
      await simulate("the locker step as the route builds it", locker, { unitLimit: LOCKER_COMPUTE_UNIT_LIMIT });
      await claimFor("full, locker due", lockerDue, snapshot);
    }
  }

  const ready = arg("ready");
  if (ready) {
    const snapshot = await read("full, ready to move", ready);
    if (snapshot) {
      const migration = await chain.buildMigration(snapshot, { payer });
      await simulate("the move into DAMM v2 as the route builds it", migration.instructions, { signers: migration.signers });
      await claimFor("full, ready to move", ready, snapshot);
    }
  }

  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(`the probe itself failed: ${(error as Error).message}`);
  process.exit(1);
});
