/**
 * DNS lookups for custom domains.
 *
 * A thin adapter over node:dns/promises `Resolver` (its own instance, so the
 * configured servers and timeout never leak into the rest of the process).
 * Every method classifies and NEVER throws: a lookup either found records,
 * found authoritatively that there are none ("absent"), or learned nothing
 * ("transient" - SERVFAIL, timeout, refused). The check core treats transient
 * as no observation at all, so a resolver outage cannot move a domain.
 *
 * These lookups ask a recursive resolver about a customer's hostname; nothing
 * connects to the addresses that come back. The only thing that ever connects
 * anywhere is the certificate prober, and it connects to the configured edge
 * addresses only.
 */

import { Resolver } from "node:dns/promises";

import {
  caaForbidsIssuer,
  classifyDnsError,
  dnsErrorCode,
  type AddressObservation,
  type CaaRecordLike,
  type TxtObservation,
} from "./customDomainRules.js";

/** The slice of node:dns/promises `Resolver` this adapter uses. */
export interface DnsResolverLike {
  setServers: (servers: string[]) => void;
  resolveTxt: (name: string) => Promise<string[][]>;
  resolve4: (name: string) => Promise<string[]>;
  resolve6: (name: string) => Promise<string[]>;
  resolveSoa: (name: string) => Promise<unknown>;
  resolveCaa: (name: string) => Promise<CaaRecordLike[]>;
}

export interface DomainDnsOptions {
  /** Recursive resolvers to ask; empty = the host's. */
  servers?: readonly string[];
  timeoutMs?: number;
  tries?: number;
  /** Injected by tests. */
  createResolver?: (options: { timeout: number; tries: number }) => DnsResolverLike;
}

export type CaaObservation =
  | { kind: "found"; name: string; records: CaaRecordLike[] }
  | { kind: "absent" }
  | { kind: "transient"; code: string };

export interface DomainDns {
  lookupTxt: (name: string) => Promise<TxtObservation>;
  /** A and AAAA together, CNAMEs followed by the resolver. */
  lookupAddresses: (name: string) => Promise<AddressObservation>;
  /** True when the name is a zone apex (it has its own SOA); null = unknown. */
  isZoneApex: (name: string) => Promise<boolean | null>;
  /** The CAA records that govern a name: its own, or its closest parent's. */
  lookupCaa: (name: string) => Promise<CaaObservation>;
  /** A sentence for the customer when CAA forbids `issuer`, else null. */
  caaDiagnostic: (name: string, issuer: string) => Promise<string | null>;
}

export const DNS_TIMEOUT_MS = 3_000;
export const DNS_TRIES = 2;

type Lookup<T> = { kind: "found"; value: T } | { kind: "absent" } | { kind: "transient"; code: string };

async function attempt<T>(run: () => Promise<T>): Promise<Lookup<T>> {
  try {
    return { kind: "found", value: await run() };
  } catch (error) {
    return classifyDnsError(error) === "absent"
      ? { kind: "absent" }
      : { kind: "transient", code: dnsErrorCode(error) };
  }
}

export function createDomainDns(options: DomainDnsOptions = {}): DomainDns {
  const resolverOptions = {
    timeout: options.timeoutMs ?? DNS_TIMEOUT_MS,
    tries: options.tries ?? DNS_TRIES,
  };
  const servers = [...(options.servers ?? [])];

  // Built on first use: constructing a resolver or setting its servers can
  // throw on a bad address, and that must surface as "transient", not a crash.
  let resolver: DnsResolverLike | null = null;
  const get = (): DnsResolverLike => {
    if (!resolver) {
      const created = options.createResolver
        ? options.createResolver(resolverOptions)
        : (new Resolver(resolverOptions) as unknown as DnsResolverLike);
      if (servers.length > 0) created.setServers(servers);
      resolver = created;
    }
    return resolver;
  };

  const lookupCaa = async (name: string): Promise<CaaObservation> => {
    // CAA is inherited: the closest ancestor that has any decides. The walk
    // stops before the top-level domain.
    const labels = name.split(".");
    for (let i = 0; i < labels.length - 1; i++) {
      const candidate = labels.slice(i).join(".");
      const result = await attempt(async () => get().resolveCaa(candidate));
      if (result.kind === "transient") return result;
      if (result.kind === "found" && result.value.length > 0) {
        return { kind: "found", name: candidate, records: result.value };
      }
    }
    return { kind: "absent" };
  };

  return {
    lookupTxt: async (name) => {
      const result = await attempt(async () => get().resolveTxt(name));
      if (result.kind !== "found") return result;
      return result.value.length > 0 ? { kind: "found", records: result.value } : { kind: "absent" };
    },

    lookupAddresses: async (name) => {
      const [v4, v6] = await Promise.all([
        attempt(async () => get().resolve4(name)),
        attempt(async () => get().resolve6(name)),
      ]);
      // Half an answer cannot be called routed: the family that did not
      // answer may point somewhere else.
      if (v4.kind === "transient") return v4;
      if (v6.kind === "transient") return v6;
      const addresses = [
        ...(v4.kind === "found" ? v4.value : []),
        ...(v6.kind === "found" ? v6.value : []),
      ];
      return addresses.length > 0 ? { kind: "found", addresses } : { kind: "absent" };
    },

    isZoneApex: async (name) => {
      try {
        await get().resolveSoa(name);
        return true;
      } catch (error) {
        // ENODATA: the name exists and has no SOA of its own, so it sits
        // inside someone's zone. Anything else leaves the question open.
        return (error as { code?: unknown } | null)?.code === "ENODATA" ? false : null;
      }
    },

    lookupCaa,

    caaDiagnostic: async (name, issuer) => {
      const caa = await lookupCaa(name);
      if (caa.kind !== "found" || !caaForbidsIssuer(caa.records, issuer)) return null;
      return `CAA records on ${caa.name} do not allow ${issuer} to issue certificates; add 'issue "${issuer}"' or remove them.`;
    },
  };
}
