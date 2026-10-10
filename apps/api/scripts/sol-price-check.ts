/**
 * Read-only check of Pyth's SOL/USD price account. Sends nothing, spends
 * nothing, signs nothing.
 *
 *   cd apps/api && npx tsx scripts/sol-price-check.ts --rpc <url> [--watch <seconds>]
 *
 * Reads the price account and the clock sysvar in one getMultipleAccountsInfo
 * call (so both are from the same slot) and prints the decoded fields, the
 * age by the chain's own clock, and the verdict of services/solPrice.ts under
 * the default rules (max age 120 s, max uncertainty 1%, max distance from the
 * moving average 10%, no band).
 *
 * With --watch it samples every 2 seconds for that long and prints how often
 * publish_time changed: the count, and the shortest, longest and average gap.
 *
 * The RPC address comes only from --rpc. This script loads no .env and reads
 * no setting, and builds its own Connection.
 *
 * Exit code: 0 the price was read and accepted, 1 it was read and refused or
 * could not be read, 2 bad arguments.
 */

import { Connection, PublicKey } from "@solana/web3.js";

import {
  CLOCK_SYSVAR_ADDRESS,
  DEFAULT_SOL_PRICE_RULES,
  decodeClockUnixTimestamp,
  decodePriceUpdateV2,
  judgeSolPrice,
  solUsdRate,
  type SolPriceResult,
} from "../src/services/solPrice.js";

const USAGE = "Usage: npx tsx scripts/sol-price-check.ts --rpc <url> [--watch <seconds>]   (read-only)\n";
const SAMPLE_EVERY_MS = 2_000;

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

interface Args {
  rpc: string;
  watchSeconds: number | null;
}

function parseArgs(argv: string[]): Args | null {
  let rpc: string | null = null;
  let watchSeconds: number | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--rpc" && value) {
      rpc = value;
      i += 1;
    } else if (arg === "--watch" && value) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 2 || n > 86_400) return null;
      watchSeconds = n;
      i += 1;
    } else {
      return null;
    }
  }
  if (!rpc || !/^https?:\/\//.test(rpc)) return null;
  return { rpc, watchSeconds };
}

interface Sample {
  slot: number;
  publishTime: bigint | null;
  result: SolPriceResult;
  lines: string[];
}

async function readOnce(connection: Connection): Promise<Sample> {
  const response = await connection.getMultipleAccountsInfoAndContext(
    [new PublicKey(DEFAULT_SOL_PRICE_RULES.accountAddress), new PublicKey(CLOCK_SYSVAR_ADDRESS)],
    "confirmed"
  );
  const [priceInfo, clockInfo] = response.value;
  const lines: string[] = [`slot               ${response.context.slot}`];
  let publishTime: bigint | null = null;

  const chainNow = decodeClockUnixTimestamp(clockInfo?.data ?? null);
  if (!priceInfo) {
    lines.push("price account      missing");
  } else {
    lines.push(`owner              ${priceInfo.owner.toBase58()}`);
    lines.push(`data length        ${priceInfo.data.length}`);
    const decoded = decodePriceUpdateV2(priceInfo.data);
    if (!decoded.ok) {
      lines.push(`decode             refused: ${decoded.code} (${decoded.detail})`);
    } else {
      const u = decoded.update;
      publishTime = u.publishTime;
      lines.push(`write authority    ${new PublicKey(u.writeAuthority).toBase58()}`);
      lines.push(
        `verification       ${u.verification}${u.numSignatures === null ? "" : ` (${u.numSignatures} signatures)`}`
      );
      lines.push(`feed id            ${u.feedIdHex}`);
      lines.push(`price              ${u.price}`);
      lines.push(`conf               ${u.conf}`);
      lines.push(`exponent           ${u.exponent}`);
      lines.push(`publish_time       ${u.publishTime}`);
      lines.push(`prev_publish_time  ${u.prevPublishTime}`);
      lines.push(`ema_price          ${u.emaPrice}`);
      lines.push(`ema_conf           ${u.emaConf}`);
      lines.push(`posted_slot        ${u.postedSlot}`);
    }
  }
  lines.push(`chain clock        ${chainNow === null ? "missing" : chainNow}`);
  if (chainNow !== null && publishTime !== null) {
    lines.push(`age by chain clock ${chainNow - publishTime} s`);
  }

  const result = judgeSolPrice({
    source: "pyth",
    account: priceInfo ? { owner: priceInfo.owner.toBase58(), data: priceInfo.data } : null,
    clockData: clockInfo?.data ?? null,
    rules: DEFAULT_SOL_PRICE_RULES,
  });
  if (result.ok) {
    const q = result.quote;
    const rateIn = solUsdRate(q, "in", 0);
    const rateOut = solUsdRate(q, "out", 0);
    lines.push(
      `verdict            accepted: ${q.midMicroUsdPerSol} micro-dollars per SOL, uncertainty ${q.confMicroUsdPerSol}, age ${q.ageSeconds} s`
    );
    lines.push(
      `dollars per SOL    money in ${rateIn.ok ? rateIn.usdPerSol : "refused"}, money out ${rateOut.ok ? rateOut.usdPerSol : "refused"}`
    );
  } else {
    lines.push(`verdict            refused: ${result.code}${result.detail ? ` (${result.detail})` : ""}`);
  }
  return { slot: response.context.slot, publishTime, result, lines };
}

async function watch(connection: Connection, seconds: number, startAt: bigint | null): Promise<void> {
  const endAt = Date.now() + seconds * 1000;
  let samples = 0;
  let failedReads = 0;
  let accepted = 0;
  const refusals = new Map<string, number>();
  let last: bigint | null = startAt;
  const gaps: bigint[] = [];

  while (Date.now() < endAt) {
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_EVERY_MS));
    samples += 1;
    try {
      const sample = await readOnce(connection);
      if (sample.result.ok) accepted += 1;
      else refusals.set(sample.result.code, (refusals.get(sample.result.code) ?? 0) + 1);
      if (sample.publishTime !== null) {
        if (last !== null && sample.publishTime !== last) {
          gaps.push(sample.publishTime - last);
          out(`  publish_time ${last} -> ${sample.publishTime} (+${sample.publishTime - last} s) at slot ${sample.slot}`);
        }
        last = sample.publishTime;
      }
    } catch (err) {
      failedReads += 1;
      out(`  read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  out("");
  out(`watched            ${seconds} s, ${samples} samples every ${SAMPLE_EVERY_MS / 1000} s, ${failedReads} failed reads`);
  out(`accepted           ${accepted} of ${samples - failedReads} reads`);
  for (const [code, count] of refusals) out(`refused            ${code}: ${count}`);
  out(`publish_time changed ${gaps.length} times`);
  if (gaps.length > 0) {
    const sorted = [...gaps].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const total = gaps.reduce((sum, gap) => sum + gap, 0n);
    out(`shortest gap       ${sorted[0]} s`);
    out(`longest gap        ${sorted[sorted.length - 1]} s`);
    out(`average gap        ${(Number(total) / gaps.length).toFixed(1)} s`);
    out("(a gap is the step in publish_time between two samples; sampling is every 2 s, so steps shorter than that are merged)");
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write(USAGE);
    return 2;
  }
  const connection = new Connection(args.rpc, "confirmed");

  let first: Sample;
  try {
    const genesis = await connection.getGenesisHash();
    out(`genesis hash       ${genesis}`);
    out(`price account      ${DEFAULT_SOL_PRICE_RULES.accountAddress}`);
    first = await readOnce(connection);
  } catch (err) {
    process.stderr.write(`could not read: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  for (const line of first.lines) out(line);

  if (args.watchSeconds !== null) {
    out("");
    out(`watching for ${args.watchSeconds} s...`);
    await watch(connection, args.watchSeconds, first.publishTime);
  }
  return first.result.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  }
);
