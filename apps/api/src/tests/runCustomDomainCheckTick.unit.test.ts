import assert from "node:assert/strict";
import test from "node:test";

import type {
  AddressObservation,
  CustomDomainCheckRow,
  CustomDomainPatch,
  DomainEventInput,
  TlsProbeOutcome,
  TxtObservation,
} from "../services/customDomainRules.js";
import { CLAIMED_ELSEWHERE_MESSAGE } from "../services/customDomainRules.js";
import {
  checkCustomDomain,
  runCustomDomainCheckTick,
  type CustomDomainCheckTickDeps,
  type PersistOutcome,
} from "../services/runCustomDomainCheckTick.js";

// services/runCustomDomainCheckTick.ts - the check core, driven with fakes.
// What it must guarantee around the pure rules: rows are isolated from each
// other, nothing is laid over a row that changed underneath, the handshake
// goes only to the edge, and an edge outage cannot pause the fleet.

const NOW = new Date("2026-10-06T12:00:00Z");
const DAY = 86_400_000;
const EDGE = { ipv4: ["137.66.10.1", "137.66.10.2"], ipv6: ["2a09:8280:1::a:1"] };
const EDGE_ADDRESSES = [...EDGE.ipv4, ...EDGE.ipv6];

function row(id: string, over: Partial<CustomDomainCheckRow> = {}): CustomDomainCheckRow {
  return {
    id,
    orgId: "org1",
    domain: `${id}.customer.com`,
    targetType: "agent",
    targetId: "a1",
    verificationToken: `token-${id}`,
    verificationStatus: "pending",
    verificationError: null,
    verifiedDomain: null,
    verifiedAt: null,
    verificationStartedAt: new Date(NOW.getTime() - 600_000),
    verificationLostAt: null,
    routingStatus: "pending",
    routingFailures: 0,
    routingError: null,
    observedAddresses: [],
    isApex: false,
    sslStatus: "pending",
    sslFailures: 0,
    sslProvisioningSince: null,
    sslExpiresAt: null,
    sslFingerprint256: null,
    sslError: null,
    enabled: true,
    isActive: false,
    pausedReason: null,
    ...over,
  };
}

/** Verified, routed, certificate observed, serving. */
function serving(id: string, over: Partial<CustomDomainCheckRow> = {}): CustomDomainCheckRow {
  return row(id, {
    verificationStatus: "verified",
    verifiedDomain: `${id}.customer.com`,
    verifiedAt: new Date(NOW.getTime() - 30 * DAY),
    routingStatus: "ok",
    observedAddresses: ["137.66.10.1"],
    sslStatus: "active",
    sslExpiresAt: new Date(NOW.getTime() + 60 * DAY),
    sslFingerprint256: "AA:BB",
    isActive: true,
    ...over,
  });
}

const VALID: TlsProbeOutcome = {
  kind: "valid",
  proof: "ok",
  certificate: {
    issuer: "Let's Encrypt R11",
    validFrom: new Date(NOW.getTime() - DAY),
    validTo: new Date(NOW.getTime() + 89 * DAY),
    fingerprint256: "AA:BB",
    altNames: [],
  },
};
const REFUSED: TlsProbeOutcome = { kind: "handshake_refused", code: "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR", message: "alert" };
const INVALID: TlsProbeOutcome = { kind: "certificate_invalid", code: "CERT_HAS_EXPIRED", message: "expired" };
const UNREACHABLE: TlsProbeOutcome = { kind: "unreachable", code: "ECONNREFUSED", message: "refused" };

interface World {
  due: CustomDomainCheckRow[];
  /** TXT answer per domain; default = the row's token is published. */
  txt: Record<string, TxtObservation>;
  addresses: Record<string, AddressObservation>;
  entitlements: Record<string, boolean>;
  missingTargets: Set<string>;
  /** Probe result per domain id; a function may look at the address. */
  probes: Record<string, TlsProbeOutcome | ((address: string) => TlsProbeOutcome)>;
  persistOutcome: Record<string, PersistOutcome | "throw">;
  caa: Record<string, string | null>;
  failEntitlements: boolean;
  throwOnTargetOf: Set<string>;
}

function harness(over: Partial<World> = {}) {
  const world: World = {
    due: [],
    txt: {},
    addresses: {},
    entitlements: { org1: true, org2: true },
    missingTargets: new Set(),
    probes: {},
    persistOutcome: {},
    caa: {},
    failEntitlements: false,
    throwOnTargetOf: new Set(),
    ...over,
  };
  const calls = {
    entitlements: [] as string[][],
    probes: [] as Array<{ id: string; address: string }>,
    persists: [] as Array<{ id: string; patch: CustomDomainPatch }>,
    events: [] as Array<{ id: string; events: DomainEventInput[] }>,
    txtNames: [] as string[],
    apex: [] as string[],
    caa: [] as string[],
  };
  const deps: CustomDomainCheckTickDeps = {
    edge: EDGE,
    loadDue: async () => world.due,
    lookupTxt: async (name) => {
      calls.txtNames.push(name);
      const domain = name.replace(/^_wheels-verification\./, "");
      const known = world.due.find((r) => r.domain === domain);
      return world.txt[domain] ?? { kind: "found", records: [[known?.verificationToken ?? `token-${domain.split(".")[0]}`]] };
    },
    lookupAddresses: async (name) => world.addresses[name] ?? { kind: "found", addresses: ["137.66.10.1"] },
    isZoneApex: async (name) => {
      calls.apex.push(name);
      return false;
    },
    caaDiagnostic: async (name) => {
      calls.caa.push(name);
      return world.caa[name] ?? null;
    },
    loadEntitlements: async (orgIds) => {
      calls.entitlements.push(orgIds);
      if (world.failEntitlements) throw new Error("database is down");
      return new Map(orgIds.filter((id) => id in world.entitlements).map((id) => [id, world.entitlements[id]!]));
    },
    targetExists: async (r) => {
      if (world.throwOnTargetOf.has(r.id)) throw new Error("query failed");
      return !world.missingTargets.has(r.id);
    },
    probeTls: async ({ address, row: r }) => {
      calls.probes.push({ id: r.id, address });
      const probe = world.probes[r.id] ?? VALID;
      return typeof probe === "function" ? probe(address) : probe;
    },
    persist: async (r, patch) => {
      const outcome = world.persistOutcome[r.id] ?? "ok";
      if (outcome === "throw") throw new Error("write failed");
      // The claimed-elsewhere answer only applies to the write that tries to take the claim.
      if (outcome === "claimed_elsewhere" && typeof patch.verifiedDomain !== "string") {
        calls.persists.push({ id: r.id, patch });
        return "ok";
      }
      if (outcome === "ok") calls.persists.push({ id: r.id, patch });
      return outcome;
    },
    logEvents: async (id, events) => {
      calls.events.push({ id, events });
    },
  };
  return { world, calls, deps };
}

const patchOf = (calls: { persists: Array<{ id: string; patch: CustomDomainPatch }> }, id: string) =>
  calls.persists.find((p) => p.id === id)?.patch;
const eventTypesOf = (calls: { events: Array<{ id: string; events: DomainEventInput[] }> }, id: string) =>
  calls.events.filter((e) => e.id === id).flatMap((e) => e.events.map((x) => x.eventType));

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

test("an empty tick does nothing, not even a plan lookup", async () => {
  const { deps, calls } = harness();
  const result = await runCustomDomainCheckTick({ now: NOW }, deps);
  assert.equal(result.due, 0);
  assert.deepEqual(calls.entitlements, []);
});

test("a pending domain whose record is published is verified; the lookup uses the verification name", async () => {
  const { deps, calls } = harness({ due: [row("d1")] });
  const result = await runCustomDomainCheckTick({ now: NOW }, deps);
  assert.equal(result.updated, 1);
  assert.deepEqual(calls.txtNames, ["_wheels-verification.d1.customer.com"]);
  const patch = patchOf(calls, "d1")!;
  assert.equal(patch.verificationStatus, "verified");
  assert.equal(patch.verifiedDomain, "d1.customer.com");
  // Verified and routed, but no handshake yet: provisioning, not active.
  assert.equal(patch.sslStatus, "provisioning");
  assert.equal(patch.isActive, undefined);
  assert.deepEqual(calls.probes, []);
});

test("one row throwing does not stop the others", async () => {
  const { deps, calls } = harness({
    due: [row("d1"), row("d2"), row("d3"), row("d4")],
    throwOnTargetOf: new Set(["d2"]),
    persistOutcome: { d3: "throw" },
  });
  const result = await runCustomDomainCheckTick({ now: NOW }, deps);
  assert.equal(result.due, 4);
  assert.equal(result.failed, 2);
  assert.equal(result.updated, 2);
  assert.deepEqual(calls.persists.map((p) => p.id).sort(), ["d1", "d4"]);
});

test("a row that changed underneath (CAS count 0) is skipped: nothing written, nothing logged", async () => {
  const { deps, calls } = harness({ due: [row("d1"), row("d2")], persistOutcome: { d1: "conflict" } });
  const result = await runCustomDomainCheckTick({ now: NOW }, deps);
  assert.equal(result.conflicts, 1);
  assert.equal(result.updated, 1);
  assert.equal(patchOf(calls, "d1"), undefined);
  assert.deepEqual(eventTypesOf(calls, "d1"), []);
  assert.ok(eventTypesOf(calls, "d2").includes("verification_success"));
});

test("claimed by another organisation: stays pending with an honest error", async () => {
  const { deps, calls } = harness({ due: [row("d1")], persistOutcome: { d1: "claimed_elsewhere" } });
  const result = await runCustomDomainCheckTick({ now: NOW }, deps);
  assert.equal(result.claimedElsewhere, 1);
  assert.equal(result.updated, 0);
  const patch = patchOf(calls, "d1")!;
  assert.equal(patch.verificationError, CLAIMED_ELSEWHERE_MESSAGE);
  assert.equal(patch.verificationStatus, undefined);
  assert.equal(patch.verifiedDomain, undefined);
  assert.equal(patch.sslStatus, undefined);
  assert.deepEqual(eventTypesOf(calls, "d1"), ["claimed_elsewhere"]);
  // No success event for a verification that did not happen.
  assert.equal(eventTypesOf(calls, "d1").includes("verification_success"), false);
});

test("claimed elsewhere, seen again: the error is not logged a second time", async () => {
  const { deps, calls } = harness({
    due: [row("d1", { verificationError: CLAIMED_ELSEWHERE_MESSAGE })],
    persistOutcome: { d1: "claimed_elsewhere" },
  });
  await runCustomDomainCheckTick({ now: NOW }, deps);
  assert.deepEqual(calls.events, []);
});

test("events are logged only on transitions", async () => {
  const { deps, calls } = harness({ due: [serving("d1"), serving("d2", { sslFingerprint256: "OLD" })] });
  const result = await runCustomDomainCheckTick({ now: NOW }, deps);
  assert.equal(result.updated, 2);
  // d1 was observed exactly as stored: written (lastCheckedAt, nextCheckAt), not logged.
  assert.ok(patchOf(calls, "d1"));
  assert.deepEqual(eventTypesOf(calls, "d1"), []);
  assert.deepEqual(eventTypesOf(calls, "d2"), ["ssl_renewed"]);
});

test("TLS is probed only when the stored row is verified, routed, entitled, enabled and has its target", async () => {
  const { deps, calls } = harness({
    due: [
      serving("yes"),
      serving("provisioning", { sslStatus: "provisioning", isActive: false, sslProvisioningSince: NOW }),
      row("pending"),
      serving("noclaim", { verifiedDomain: null }),
      serving("misrouted", { routingStatus: "misrouted" }),
      serving("disabled", { enabled: false }),
      serving("starter", { orgId: "org2" }),
      serving("notarget"),
      row("expired", { verificationStatus: "expired" }),
    ],
    entitlements: { org1: true, org2: false },
    missingTargets: new Set(["notarget"]),
  });
  const result = await runCustomDomainCheckTick({ now: NOW }, deps);
  assert.deepEqual(calls.probes.map((p) => p.id).sort(), ["provisioning", "yes"]);
  assert.equal(result.probed, 2);
  assert.equal(result.failed, 0);
  assert.equal(patchOf(calls, "starter")!.pausedReason, "plan_inactive");
  assert.equal(patchOf(calls, "notarget")!.pausedReason, "target_missing");
});

test("the handshake goes to an edge address and to nothing else - never to what DNS returned", async () => {
  const { deps, calls } = harness({
    due: [serving("d1"), serving("d2"), serving("d3")],
    // The customer's DNS answers with addresses that are not the edge (d2:
    // first bad answer, so routing has not flipped and a probe still runs).
    addresses: {
      "d2.customer.com": { kind: "found", addresses: ["10.0.0.5", "169.254.169.254"] },
      "d3.customer.com": { kind: "found", addresses: ["137.66.10.1"] },
    },
    probes: { d3: UNREACHABLE },
  });
  await runCustomDomainCheckTick({ now: NOW }, deps);
  assert.ok(calls.probes.length >= 3);
  for (const probe of calls.probes) {
    assert.ok(EDGE_ADDRESSES.includes(probe.address), `probed ${probe.address}`);
  }
  assert.ok(calls.probes.some((p) => p.id === "d2"));
});

test("an unreachable edge address is retried on the next one, at most twice", async () => {
  const { deps, calls } = harness({
    due: [serving("d1"), serving("d2")],
    probes: {
      d1: (address) => (address === "137.66.10.1" ? UNREACHABLE : VALID),
      d2: UNREACHABLE,
    },
  });
  await runCustomDomainCheckTick({ now: NOW }, deps);
  assert.deepEqual(calls.probes.filter((p) => p.id === "d1").map((p) => p.address), ["137.66.10.1", "137.66.10.2"]);
  assert.deepEqual(calls.probes.filter((p) => p.id === "d2").map((p) => p.address), ["137.66.10.1", "137.66.10.2"]);
});

test("entitlement is looked up once per tick with each organisation once", async () => {
  const { deps, calls } = harness({
    due: [serving("d1"), serving("d2"), serving("d3", { orgId: "org2" }), row("d4", { orgId: "org2" })],
  });
  await runCustomDomainCheckTick({ now: NOW }, deps);
  assert.equal(calls.entitlements.length, 1);
  assert.deepEqual([...calls.entitlements[0]!].sort(), ["org1", "org2"]);
});

test("a failed entitlement lookup leaves every row unchanged", async () => {
  const { deps, calls } = harness({ due: [serving("d1"), row("d2")], failEntitlements: true });
  const result = await runCustomDomainCheckTick({ now: NOW }, deps);
  assert.equal(result.entitlementUnknown, 2);
  assert.equal(result.updated, 0);
  assert.deepEqual(calls.persists, []);
  assert.deepEqual(calls.events, []);
  assert.deepEqual(calls.probes, []);
});

test("an organisation the lookup did not answer for is left unchanged; the others proceed", async () => {
  const { deps, calls } = harness({
    due: [serving("d1"), serving("d2", { orgId: "org-unknown" })],
  });
  const result = await runCustomDomainCheckTick({ now: NOW }, deps);
  assert.equal(result.entitlementUnknown, 1);
  assert.equal(result.updated, 1);
  assert.deepEqual(calls.persists.map((p) => p.id), ["d1"]);
});

test("circuit breaker: when most handshakes are unreachable, failed handshakes change nothing", async () => {
  const { deps, calls } = harness({
    due: [
      serving("u1"),
      serving("u2"),
      serving("u3"),
      // Two more failures away from 'failed': without the breaker this
      // refusal would be counted against the certificate.
      serving("refused", { sslFailures: 2 }),
      serving("ok", { sslFingerprint256: "OLD" }),
    ],
    probes: { u1: UNREACHABLE, u2: UNREACHABLE, u3: UNREACHABLE, refused: REFUSED, ok: VALID },
  });
  const result = await runCustomDomainCheckTick({ now: NOW }, deps);
  assert.equal(result.edgeOutageSuspected, true);
  assert.equal(result.probed, 5);
  const refused = patchOf(calls, "refused")!;
  assert.equal(refused.sslStatus, undefined);
  assert.equal(refused.sslFailures, undefined);
  assert.equal(refused.isActive, undefined);
  assert.deepEqual(eventTypesOf(calls, "refused"), []);
  // A valid handshake is still an observation.
  assert.equal(patchOf(calls, "ok")!.sslFingerprint256, "AA:BB");
  // Nothing was paused.
  assert.equal(calls.persists.some((p) => p.patch.isActive === false), false);
});

test("without an outage the same refusal is counted and flips the certificate", async () => {
  const { deps, calls } = harness({
    due: [serving("ok1"), serving("ok2"), serving("refused", { sslFailures: 2 }), serving("u1")],
    probes: { refused: REFUSED, u1: UNREACHABLE },
    caa: { "refused.customer.com": "CAA says no." },
  });
  const result = await runCustomDomainCheckTick({ now: NOW }, deps);
  assert.equal(result.edgeOutageSuspected, false);
  const refused = patchOf(calls, "refused")!;
  assert.equal(refused.sslStatus, "failed");
  assert.equal(refused.isActive, false);
  assert.match(refused.sslError ?? "", /CAA says no\./);
  assert.deepEqual(calls.caa, ["refused.customer.com"]);
  assert.deepEqual(eventTypesOf(calls, "refused"), ["ssl_invalid", "serving_stopped"]);
  // Unreachable on its own never flips anything.
  assert.equal(patchOf(calls, "u1")!.isActive, undefined);
});

test("a single unreachable handshake is not 'most handshakes'", async () => {
  const { deps } = harness({ due: [serving("u1")], probes: { u1: UNREACHABLE } });
  const result = await runCustomDomainCheckTick({ now: NOW }, deps);
  assert.equal(result.edgeOutageSuspected, false);
});

test("the apex lookup runs only while the answer is unknown", async () => {
  const { deps, calls } = harness({ due: [row("d1", { isApex: null }), row("d2", { isApex: false }), row("d3", { isApex: true })] });
  await runCustomDomainCheckTick({ now: NOW }, deps);
  assert.deepEqual(calls.apex, ["d1.customer.com"]);
  assert.equal(patchOf(calls, "d1")!.isApex, false);
});

test("a failing CAA lookup does not fail the check", async () => {
  const { deps, calls } = harness({ due: [serving("d1")], probes: { d1: INVALID } });
  deps.caaDiagnostic = async () => {
    throw new Error("dns down");
  };
  const result = await runCustomDomainCheckTick({ now: NOW }, deps);
  assert.equal(result.updated, 1);
  assert.equal(patchOf(calls, "d1")!.sslFailures, 1);
});

// ---------------------------------------------------------------------------
// checkCustomDomain (one row, on demand)
// ---------------------------------------------------------------------------

test("checkCustomDomain with probeTls:false never makes a handshake", async () => {
  const { deps, calls } = harness();
  const result = await checkCustomDomain(serving("d1"), { probeTls: false, now: NOW }, deps);
  assert.equal(result.outcome, "updated");
  assert.deepEqual(calls.probes, []);
  assert.equal(result.decision!.isActive, true);
  assert.equal(result.dnsTransient, false);
});

test("checkCustomDomain with probeTls:true observes the certificate", async () => {
  const { deps, calls } = harness();
  const provisioning = serving("d1", { sslStatus: "provisioning", isActive: false, sslExpiresAt: null, sslFingerprint256: null });
  const result = await checkCustomDomain(provisioning, { probeTls: true, now: NOW }, deps);
  assert.equal(result.outcome, "updated");
  assert.equal(calls.probes.length, 1);
  assert.equal(result.decision!.sslStatus, "active");
  assert.equal(result.decision!.isActive, true);
  assert.deepEqual(eventTypesOf(calls, "d1"), ["ssl_observed", "serving_started"]);
});

test("checkCustomDomain reports a resolver error and leaves the verification state and token alone", async () => {
  const { deps, calls } = harness({
    txt: { "d1.customer.com": { kind: "transient", code: "ESERVFAIL" } },
    addresses: { "d1.customer.com": { kind: "transient", code: "ESERVFAIL" } },
  });
  const result = await checkCustomDomain(row("d1"), { probeTls: false, now: NOW }, deps);
  assert.equal(result.dnsTransient, true);
  assert.equal(result.outcome, "updated");
  const patch = patchOf(calls, "d1")!;
  assert.deepEqual(Object.keys(patch).sort(), ["lastCheckedAt", "nextCheckAt"]);
  assert.deepEqual(calls.events, []);
});

test("checkCustomDomain: plan unknown -> nothing looked up, nothing written", async () => {
  const { deps, calls } = harness({ failEntitlements: true });
  const result = await checkCustomDomain(serving("d1"), { probeTls: true, now: NOW }, deps);
  assert.equal(result.outcome, "entitlement_unknown");
  assert.equal(result.observation, null);
  assert.deepEqual(calls.persists, []);
  assert.deepEqual(calls.txtNames, []);
  assert.deepEqual(calls.probes, []);
});

test("checkCustomDomain: conflict and claimed_elsewhere are reported, not thrown", async () => {
  const conflict = harness({ persistOutcome: { d1: "conflict" } });
  assert.equal((await checkCustomDomain(row("d1"), { probeTls: false, now: NOW }, conflict.deps)).outcome, "conflict");

  const claimed = harness({ persistOutcome: { d1: "claimed_elsewhere" } });
  const result = await checkCustomDomain(row("d1"), { probeTls: false, now: NOW }, claimed.deps);
  assert.equal(result.outcome, "claimed_elsewhere");
  assert.equal(result.decision, null);
});
