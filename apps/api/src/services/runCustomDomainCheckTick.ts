/**
 * Custom-domain check core.
 *
 * One check of one domain = ask DNS for the ownership record and the
 * addresses, look up the plan and the target, (when the domain is already
 * verified and routed) make one TLS handshake with the edge, then hand all of
 * it to decideDomainTransition and write what it returns with a
 * compare-and-set. The check never decides anything itself, and it never
 * writes a status it did not observe.
 *
 *   checkCustomDomain          one row, on demand ("check now", "re-check the
 *                              certificate"); the caller says whether to probe
 *   runCustomDomainCheckTick   every row whose nextCheckAt is due
 *
 * Per-domain isolation: a row that throws is counted and skipped; the others
 * still run, and the failed row is simply due again next tick.
 *
 * Correlated failures: when most handshakes in one tick could not reach the
 * edge, the edge (or the path to it) is down, and whatever the remaining
 * handshakes reported is suspect. The tick then disregards every failed
 * handshake, so an outage cannot pause the fleet. A VALID handshake is still
 * an observation and still counts.
 */

import {
  claimedElsewhereDecision,
  decideDomainTransition,
  verificationRecordName,
  wantsTlsProbe,
  type AddressObservation,
  type CustomDomainCheckRow,
  type CustomDomainPatch,
  type DomainDecision,
  type DomainEventInput,
  type DomainObservation,
  type EdgeAddresses,
  type TlsProbeOutcome,
  type TxtObservation,
} from "./customDomainRules.js";

export type PersistOutcome =
  /** The row was as loaded and has been updated. */
  | "ok"
  /** The row changed since it was loaded; nothing was written. */
  | "conflict"
  /** Another organisation holds the verified claim on this name. */
  | "claimed_elsewhere";

export interface CustomDomainCheckDeps {
  /** The edge's addresses: what "routed" means and the only probe targets. */
  edge: EdgeAddresses;
  lookupTxt: (name: string) => Promise<TxtObservation>;
  lookupAddresses: (name: string) => Promise<AddressObservation>;
  isZoneApex: (name: string) => Promise<boolean | null>;
  /** A sentence when CAA forbids the edge's certificate authority, else null. */
  caaDiagnostic?: (name: string) => Promise<string | null>;
  /**
   * Whether each organisation's plan includes custom domains. Throws when the
   * answer is not known; an organisation must never be paused on a guess.
   */
  loadEntitlements: (orgIds: string[]) => Promise<Map<string, boolean>>;
  /** Does the agent or deployment the domain points at still exist in its org. */
  targetExists: (row: CustomDomainCheckRow) => Promise<boolean>;
  /** One TLS handshake with `address` for the row's hostname. Never throws. */
  probeTls: (input: { address: string; row: CustomDomainCheckRow }) => Promise<TlsProbeOutcome>;
  /** Compare-and-set write against the row as it was loaded. */
  persist: (row: CustomDomainCheckRow, patch: CustomDomainPatch) => Promise<PersistOutcome>;
  logEvents: (domainId: string, events: DomainEventInput[]) => Promise<void>;
}

export interface CustomDomainCheckTickDeps extends CustomDomainCheckDeps {
  /** Rows whose nextCheckAt has passed: bounded, and bounded per organization. */
  loadDue: (args: { now: Date }) => Promise<CustomDomainCheckRow[]>;
}

export type CheckOutcome =
  /** Observed and written. */
  | "updated"
  /** The row changed underneath the check; nothing was written. */
  | "conflict"
  /** The TXT record matched, but another organisation holds the name. */
  | "claimed_elsewhere"
  /** The plan could not be read; the row was left exactly as it was. */
  | "entitlement_unknown";

export interface CheckResult {
  outcome: CheckOutcome;
  /** What DNS answered, for the caller to report. Null when nothing was looked up. */
  observation: DomainObservation | null;
  /** The decision that was written. Null unless outcome is "updated". */
  decision: DomainDecision | null;
  /** True when the TXT or address lookup got no answer from DNS. */
  dnsTransient: boolean;
}

/** At most this many edge addresses are tried by one probe. */
const MAX_PROBE_ADDRESSES = 2;
/** How many rows are looked up at once inside a tick. */
const TICK_CONCURRENCY = 8;
/** The breaker needs at least this many handshakes to judge "most". */
const BREAKER_MIN_PROBES = 2;

async function probeEdge(row: CustomDomainCheckRow, deps: CustomDomainCheckDeps): Promise<TlsProbeOutcome> {
  // Only ever the configured edge addresses - never an address DNS returned.
  const addresses = [...deps.edge.ipv4, ...deps.edge.ipv6].slice(0, MAX_PROBE_ADDRESSES);
  let last: TlsProbeOutcome = {
    kind: "unreachable",
    code: "ENOADDRESS",
    message: "no edge address is configured",
  };
  for (const address of addresses) {
    last = await deps.probeTls({ address, row });
    // One address down is not the edge down: try the next before concluding.
    if (last.kind !== "unreachable") return last;
  }
  return last;
}

async function observe(
  row: CustomDomainCheckRow,
  entitled: boolean,
  options: { probeTls: boolean; now: Date },
  deps: CustomDomainCheckDeps,
): Promise<DomainObservation> {
  const [txt, addresses, isApex, targetExists] = await Promise.all([
    deps.lookupTxt(verificationRecordName(row.domain)),
    deps.lookupAddresses(row.domain),
    // Whether a name is a zone apex does not change; one answer is kept.
    row.isApex === null ? deps.isZoneApex(row.domain) : Promise.resolve(null),
    deps.targetExists(row),
  ]);

  const base = { txt, addresses, isApex, entitled, targetExists };
  if (!options.probeTls || !wantsTlsProbe(row, base, deps.edge, options.now)) {
    return { ...base, probe: null };
  }

  const probe = await probeEdge(row, deps);
  let caaDiagnostic: string | null = null;
  if (deps.caaDiagnostic && (probe.kind === "handshake_refused" || probe.kind === "certificate_invalid")) {
    // A diagnostic only: failing to fetch it must not fail the check.
    caaDiagnostic = await deps.caaDiagnostic(row.domain).catch(() => null);
  }
  return { ...base, probe, caaDiagnostic };
}

async function apply(
  row: CustomDomainCheckRow,
  observation: DomainObservation,
  now: Date,
  deps: CustomDomainCheckDeps,
): Promise<CheckResult> {
  const dnsTransient = observation.txt.kind === "transient" || observation.addresses.kind === "transient";
  const decision = decideDomainTransition(row, observation, deps.edge, now);
  const outcome = await deps.persist(row, decision.patch);

  if (outcome === "conflict") {
    // Someone else (the owner, another worker) moved the row. Their write
    // stands; this observation is dropped rather than laid over it.
    return { outcome: "conflict", observation, decision: null, dnsTransient };
  }
  if (outcome === "claimed_elsewhere") {
    const fallback = claimedElsewhereDecision(row, now);
    const written = await deps.persist(row, fallback.patch);
    if (written === "ok" && fallback.events.length > 0) await deps.logEvents(row.id, fallback.events);
    return { outcome: "claimed_elsewhere", observation, decision: null, dnsTransient };
  }
  if (decision.events.length > 0) await deps.logEvents(row.id, decision.events);
  return { outcome: "updated", observation, decision, dnsTransient };
}

/**
 * Checks one domain now. `probeTls: false` looks at DNS only ("check now"
 * must answer within the resolver's timeout and never waits on certificate
 * issuance); `probeTls: true` also makes the handshake when the domain
 * qualifies for one.
 */
export async function checkCustomDomain(
  row: CustomDomainCheckRow,
  options: { probeTls: boolean; now: Date },
  deps: CustomDomainCheckDeps,
): Promise<CheckResult> {
  let entitled: boolean | undefined;
  try {
    entitled = (await deps.loadEntitlements([row.orgId])).get(row.orgId);
  } catch {
    entitled = undefined;
  }
  if (entitled === undefined) {
    return { outcome: "entitlement_unknown", observation: null, decision: null, dnsTransient: false };
  }
  const observation = await observe(row, entitled, options, deps);
  return apply(row, observation, options.now, deps);
}

export interface CustomDomainCheckTickResult {
  due: number;
  updated: number;
  conflicts: number;
  claimedElsewhere: number;
  /** Rows left untouched because their organisation's plan could not be read. */
  entitlementUnknown: number;
  /** Rows whose check threw; due again next tick. */
  failed: number;
  probed: number;
  /** True when failed handshakes were disregarded as an edge outage. */
  edgeOutageSuspected: boolean;
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function runCustomDomainCheckTick(
  input: { now: Date },
  deps: CustomDomainCheckTickDeps,
): Promise<CustomDomainCheckTickResult> {
  const { now } = input;
  const due = await deps.loadDue({ now });
  const result: CustomDomainCheckTickResult = {
    due: due.length,
    updated: 0,
    conflicts: 0,
    claimedElsewhere: 0,
    entitlementUnknown: 0,
    failed: 0,
    probed: 0,
    edgeOutageSuspected: false,
  };
  if (due.length === 0) return result;

  // One plan lookup per organisation per tick, however many domains it has.
  let entitlements: Map<string, boolean>;
  try {
    entitlements = await deps.loadEntitlements([...new Set(due.map((row) => row.orgId))]);
  } catch {
    result.entitlementUnknown = due.length;
    return result;
  }

  // Phase 1: observe every row. Nothing is written yet, so the handshakes of
  // the whole tick can be judged together before any of them counts.
  const observed = await mapConcurrent(due, TICK_CONCURRENCY, async (row) => {
    const entitled = entitlements.get(row.orgId);
    if (entitled === undefined) return { row, kind: "entitlement_unknown" as const };
    try {
      const observation = await observe(row, entitled, { probeTls: true, now }, deps);
      return { row, kind: "observed" as const, observation };
    } catch {
      return { row, kind: "failed" as const };
    }
  });

  const probes = observed.flatMap((o) =>
    o.kind === "observed" && o.observation.probe ? [o.observation.probe] : [],
  );
  result.probed = probes.length;
  const unreachable = probes.filter((p) => p.kind === "unreachable").length;
  result.edgeOutageSuspected = probes.length >= BREAKER_MIN_PROBES && unreachable * 2 > probes.length;

  // Phase 2: decide and write, one row at a time.
  for (const entry of observed) {
    if (entry.kind === "entitlement_unknown") {
      result.entitlementUnknown += 1;
      continue;
    }
    if (entry.kind === "failed") {
      result.failed += 1;
      continue;
    }
    try {
      const { probe } = entry.observation;
      const observation =
        result.edgeOutageSuspected && probe !== null && probe.kind !== "valid"
          ? { ...entry.observation, probe: null, caaDiagnostic: null }
          : entry.observation;
      const checked = await apply(entry.row, observation, now, deps);
      if (checked.outcome === "updated") result.updated += 1;
      else if (checked.outcome === "conflict") result.conflicts += 1;
      else if (checked.outcome === "claimed_elsewhere") result.claimedElsewhere += 1;
    } catch {
      result.failed += 1;
    }
  }

  return result;
}
