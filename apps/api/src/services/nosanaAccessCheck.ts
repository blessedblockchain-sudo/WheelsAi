/**
 * The read-only Nosana access check behind scripts/nosana-access-check.ts.
 *
 * It answers, without spending anything: which credential would pay for new
 * deployments, whether the API key is accepted, what the prepaid balance is,
 * what the account already runs, what a deployment's raw `owner` and `vault`
 * fields contain for this kind of account, and what each GPU tier costs.
 *
 * EVERY request it sends is a GET (see `get` below: the method is a literal,
 * there is no other way out of this module). It does not import the Nosana SDK
 * and never reads the wallet key's value: with wallet access it reports the
 * mode and the public market costs only, because listing a wallet's
 * deployments needs a wallet signature.
 *
 * Pure core: the environment, fetch and the output sink are injected.
 */

import { PublicKey } from "@solana/web3.js";

import {
  loadNosanaAccessConfig,
  NosanaAccessConfigError,
  type NosanaAccessConfig,
} from "../config/nosanaAccess.js";
import { toCreditBalance, microUsdToUsd, type FetchLike } from "./nosanaCredits.js";
import { parseMarketCost, type MarketCost } from "./nosanaMarketCosts.js";
import { MARKETS, resolveMarketAddress } from "./nosanaMarkets.js";
import { NOSANA_MAX_LIST_PAGES, NOSANA_PAGE_LIMIT, readNosanaPage } from "./nosanaPagination.js";

export const NAME_PREFIX = "wheelsai-";

/** The only arguments the script accepts. Anything else is refused before any request. */
export const ALLOWED_ARGS: ReadonlySet<string> = new Set(["--help", "-h"]);

export interface AccessCheckDeps {
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  print: (line: string) => void;
  now?: () => Date;
  timeoutMs?: number;
}

export interface AccessCheckResult {
  /** 0: everything asked for was read. 1: something could not be read. 2: refused. */
  exitCode: 0 | 1 | 2;
  mode: NosanaAccessConfig["primary"] | null;
  /** Every request sent, for the caller (and the test) to see. */
  requests: Array<{ method: "GET"; url: string; status: number | null }>;
}

/** Whether the arguments ask for anything other than a read. Null = fine. */
export function refusalFor(args: readonly string[]): string | null {
  const unknown = args.filter((a) => !ALLOWED_ARGS.has(a));
  if (unknown.length === 0) return null;
  return `This script only reads, and takes no arguments (got: ${unknown.join(" ")}). Nothing was requested.`;
}

function usd(value: number, decimals = 4): string {
  return `$${value.toFixed(decimals)}`;
}

/** What the SDK does with `owner` on every create, get and list: new PublicKey(owner). */
function parsesAsPublicKey(value: unknown): boolean {
  if (typeof value !== "string" || value === "") return false;
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

function show(value: unknown): string {
  if (value === undefined) return "(absent)";
  return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
}

export async function runNosanaAccessCheck(deps: AccessCheckDeps): Promise<AccessCheckResult> {
  const { print } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const timeoutMs = deps.timeoutMs ?? 15_000;
  const requests: AccessCheckResult["requests"] = [];
  let failed = false;

  /** The one way this module talks to anything: a GET, never redirected. */
  const get = async (
    url: string,
    apiKey?: string,
  ): Promise<{ ok: boolean; status: number | null; body: unknown; error?: string }> => {
    const entry: AccessCheckResult["requests"][number] = { method: "GET", url, status: null };
    requests.push(entry);
    try {
      const response = await deps.fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      entry.status = response.status;
      const body = await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, body };
    } catch (err) {
      return { ok: false, status: null, body: null, error: (err as Error).message };
    }
  };

  print("Nosana access check - read-only (GET requests only, nothing is created, started or stopped)");
  print(`time: ${now.toISOString()}`);

  let cfg: NosanaAccessConfig;
  try {
    cfg = loadNosanaAccessConfig(deps.env);
  } catch (err) {
    if (!(err instanceof NosanaAccessConfigError)) throw err;
    // The message names variables only, never a value.
    print(`configuration refused: ${err.message}`);
    print("The API would refuse to boot with this configuration. Nothing was requested.");
    return { exitCode: 1, mode: null, requests };
  }

  print("");
  print(`mode (pays for new deployments): ${cfg.primary}`);
  print(`network: ${cfg.network}${cfg.networkDerived ? " (derived from SOLANA_NETWORK)" : ""}`);
  print(`backend: ${cfg.backendUrl}`);
  print(`API key: ${cfg.hasApiKey ? `set, ends in ...${cfg.apiKeySuffix}` : "not set"}`);
  print(`wallet key: ${cfg.hasWallet ? "set (not read or used by this script)" : "not set"}`);
  print(
    `timeout unit sent to Nosana: ${cfg.timeoutUnit}${cfg.timeoutUnitExplicit ? "" : " (default; NOSANA_TIMEOUT_UNIT is not set)"}`,
  );
  for (const warning of cfg.warnings) print(`warning: ${warning}`);

  // ---- With an API key: balance, deployments, raw owner and vault ---------
  if (cfg.hasApiKey) {
    const key = cfg.apiKey!;

    print("");
    print("credits (GET /api/credits/balance)");
    const balance = await get(`${cfg.backendUrl}/api/credits/balance`, key);
    if (balance.status === 401 || balance.status === 403) {
      failed = true;
      print(`  REJECTED: HTTP ${balance.status}. The key is wrong, expired, for another network, or lacks the credits permission.`);
    } else if (!balance.ok) {
      failed = true;
      print(`  unreadable: ${balance.status !== null ? `HTTP ${balance.status}` : balance.error}`);
    } else {
      try {
        const b = toCreditBalance(balance.body, now);
        const floor = cfg.minCreditsMicroUsd;
        print(`  assigned:  ${usd(microUsdToUsd(b.assignedMicroUsd))}`);
        print(`  reserved:  ${usd(microUsdToUsd(b.reservedMicroUsd))}`);
        print(`  settled:   ${usd(microUsdToUsd(b.settledMicroUsd))}`);
        print(`  available: ${usd(microUsdToUsd(b.availableMicroUsd))}  (assigned - reserved - settled)`);
        print(`  floor (NOSANA_MIN_CREDITS_USD): ${usd(microUsdToUsd(floor), 2)}; warning below ${usd(microUsdToUsd(cfg.warnCreditsMicroUsd), 2)}`);
        print(
          b.availableMicroUsd < floor
            ? "  verdict: BELOW THE FLOOR - every new deployment would be refused"
            : b.availableMicroUsd < cfg.warnCreditsMicroUsd
              ? "  verdict: above the floor, below the warning threshold (a deployment also needs its own estimate on top of the floor)"
              : "  verdict: above the warning threshold",
        );
        print(`  raw: ${JSON.stringify(balance.body)}`);
      } catch (err) {
        failed = true;
        print(`  unreadable: ${(err as Error).message}`);
        print(`  raw: ${JSON.stringify(balance.body)}`);
      }
    }

    print("");
    print(`deployments (GET /api/deployments?limit=${NOSANA_PAGE_LIMIT}, every page)`);
    // The list is paginated: {deployments, pagination}; every page is read.
    const listed: unknown[] = [];
    let totalItems: number | null = null;
    let listFailure: string | null = null;
    let cursor: string | null = null;
    for (let pages = 1; ; pages += 1) {
      const page = await get(
        `${cfg.backendUrl}/api/deployments?limit=${NOSANA_PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        key,
      );
      if (page.status === 401 || page.status === 403) {
        listFailure = `REJECTED: HTTP ${page.status}. The key lacks the deployments permission, or is not accepted.`;
        break;
      }
      const parsed = page.ok ? readNosanaPage(page.body, "deployments") : null;
      if (!parsed) {
        listFailure = `unreadable: ${page.status !== null ? `HTTP ${page.status}${page.ok ? ", body is not a deployment list" : ""}` : page.error}`;
        break;
      }
      listed.push(...parsed.items);
      totalItems ??= parsed.totalItems;
      if (parsed.cursorNext === null) break;
      if (parsed.cursorNext === cursor || pages >= NOSANA_MAX_LIST_PAGES) {
        listFailure = `incomplete: stopped after ${pages} pages; the list was not read whole`;
        break;
      }
      cursor = parsed.cursorNext;
    }
    if (listFailure !== null) {
      failed = true;
      print(`  ${listFailure}`);
    } else {
      const rows = listed.filter(
        (r): r is Record<string, unknown> => typeof r === "object" && r !== null,
      );
      print(`  total: ${totalItems ?? rows.length}${totalItems !== null && totalItems !== rows.length ? ` (pagination.total_items; ${rows.length} rows read)` : ""}`);
      const byStatus = new Map<string, number>();
      for (const r of rows) {
        const status = typeof r.status === "string" ? r.status : "(none)";
        byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
      }
      if (byStatus.size > 0) {
        print(`  by status: ${[...byStatus].sort(([a], [b]) => a.localeCompare(b)).map(([s, n]) => `${s} ${n}`).join(", ")}`);
      }
      const ours = rows.filter((r) => typeof r.name === "string" && r.name.startsWith(NAME_PREFIX));
      print(`  named ${NAME_PREFIX}*: ${ours.length}`);
      for (const r of ours) {
        print(`    ${String(r.name)}  ${String(r.status)}  id ${String(r.id)}  created ${String(r.created_at)}`);
      }

      print("");
      print("raw fields of one existing deployment (what this kind of account returns)");
      // The newest of ours when there is one: after a first create, that is the one to read.
      const newestFirst = (list: Array<Record<string, unknown>>) =>
        [...list].sort((x, y) => String(y.created_at ?? "").localeCompare(String(x.created_at ?? "")));
      const sample = newestFirst(ours)[0] ?? newestFirst(rows)[0];
      if (!sample) {
        print("  none: the account has no deployment yet, so `owner` and `vault` cannot be read without creating one.");
        print("  The SDK parses `owner` as a Solana public key on every create; read it right after the first create.");
      } else {
        print(`  name:   ${show(sample.name)}`);
        print(`  id:     ${show(sample.id)}`);
        print(`  status: ${show(sample.status)}`);
        print(`  owner:  ${show(sample.owner)}`);
        print(`  vault:  ${show(sample.vault)}`);
        print(`  owner parses as a Solana public key: ${parsesAsPublicKey(sample.owner) ? "yes" : "NO - the SDK would throw on create, get and list"}`);
        print(`  vault equals owner: ${sample.vault !== undefined && sample.vault === sample.owner ? "yes" : "no"}`);
        print(`  timeout: ${show(sample.timeout)}  strategy: ${show(sample.strategy)}  replicas: ${show(sample.replicas)}`);
        print(`  fields: ${Object.keys(sample).sort().join(", ")}`);
      }
    }
  } else {
    print("");
    print(
      cfg.hasWallet
        ? "No API key is configured. Wallet access is not exercised by this script (it would need a wallet signature), so no balance or deployment list is read."
        : "No Nosana credential is configured: the API would answer 501 to a deployment. Only the public market list is read.",
    );
  }

  // ---- Public: cost per tier ----------------------------------------------
  print("");
  print("market cost per tier (GET /api/markets/, no credential sent)");
  const markets = await get(`${cfg.backendUrl}/api/markets/`);
  if (!markets.ok || !Array.isArray(markets.body)) {
    failed = true;
    print(`  unreadable: ${markets.status !== null ? `HTTP ${markets.status}` : markets.error}`);
  } else {
    const costs = new Map<string, MarketCost>();
    for (const row of markets.body) {
      const cost = parseMarketCost(row);
      if (cost) costs.set(cost.address, cost);
    }
    print(`  markets listed: ${markets.body.length}, priced: ${costs.size}`);
    print("  tier   market                                        host $/h  fee%   cost $/h  retail $/h  margin");
    for (const [tier, market] of Object.entries(MARKETS)) {
      let address: string | null = null;
      try {
        address = resolveMarketAddress(tier, cfg.network);
      } catch {
        address = null;
      }
      const retail = market.pricePerSecond * 3600;
      if (address === null) {
        print(`  ${tier.padEnd(6)} (no market configured on ${cfg.network})`.padEnd(88) + `${retail.toFixed(4).padStart(9)}`);
        continue;
      }
      const cost = costs.get(address);
      if (!cost) {
        print(`  ${tier.padEnd(6)} ${address.padEnd(45)} cost unknown (not in the list or not priced)  ${retail.toFixed(4)}`);
        continue;
      }
      const costPerHour = (Number(cost.costMicroUsdPerSecond) * 3600) / 1_000_000;
      const margin = retail > 0 ? ((retail - costPerHour) / retail) * 100 : 0;
      print(
        `  ${tier.padEnd(6)} ${address.padEnd(45)} ${cost.usdPerHour.toFixed(4).padStart(8)} ${String(cost.feePct).padStart(5)} ${costPerHour.toFixed(4).padStart(10)} ${retail.toFixed(4).padStart(11)} ${`${margin.toFixed(1)}%`.padStart(7)}${costPerHour > retail ? "  BELOW COST" : ""}`,
      );
    }
    if (cfg.network === "devnet") {
      print("  This is the devnet backend, which lists test markets. Set NOSANA_NETWORK=mainnet to read the mainnet costs.");
    }
    print("  cost = host reward x (1 + fee), rounded up to a whole micro-USD per second. Nosana charges the fee on credit-paid jobs.");
  }

  print("");
  print(`requests sent: ${requests.length}, all GET`);
  return { exitCode: failed ? 1 : 0, mode: cfg.primary, requests };
}
