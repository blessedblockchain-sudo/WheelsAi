/**
 * Host routing for custom domains.
 *
 * The edge proxy terminates TLS for customer hostnames and forwards every
 * request to this API with two headers: the forwarding secret and the Host the
 * client asked for. Fastify's `rewriteUrl` runs before routing and must answer
 * synchronously, so routing reads an in-memory table of the verified domains:
 *
 *   createCustomDomainRouteTable   the table: refreshed on an interval, dropped
 *                                  from at once when an owner disables,
 *                                  re-verifies or deletes a domain, and
 *                                  distrusted entirely once it is too old
 *   createEdgeRewriteUrl           request -> canonical route, or one of the
 *                                  /__edge answers (not active, not found,
 *                                  redirect, proof, unavailable)
 *   createDomainRequestCounter     buffered per-domain request counts
 *
 * A request without the edge's header is not touched at all: the canonical
 * API host behaves exactly as it did before custom domains existed.
 *
 * Fail closed: an unknown host, a wrong secret, a table that could not be
 * refreshed for too long, or anything unexpected routes nowhere. The rewrite
 * can only ever produce a path from the fixed list in mapEdgeRequest, so no
 * other route of the API is reachable through a customer hostname.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import {
  mapEdgeRequest,
  normalizeEdgeHost,
  type EdgeAction,
  type EdgeRoute,
} from "./customDomainRules.js";

/** Set by the edge on every forwarded request; proves the request came through it. */
export const EDGE_TOKEN_HEADER = "x-wheels-edge-token";
/** The Host the client asked the edge for. */
export const EDGE_HOST_HEADER = "x-wheels-custom-host";
/** "https" or "http": how the client reached the edge. */
export const EDGE_PROTO_HEADER = "x-wheels-edge-proto";
/** Where every answer that is not a forwarded request is produced. */
export const EDGE_RESPOND_PATH = "/__edge/respond";

/** A table older than this is not trusted to say who a hostname belongs to. */
export const DEFAULT_MAX_STALE_MS = 60_000;

/** Same result for equal strings, in time that does not depend on where they differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  // Hashing first makes both inputs the same length, which timingSafeEqual needs.
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

// ============================================
// The table
// ============================================

export type RouteLookup =
  | { kind: "hit"; route: EdgeRoute }
  | { kind: "miss" }
  /** Never loaded, or not refreshed for longer than maxStaleMs. */
  | { kind: "unavailable" };

export interface CustomDomainRouteTableDeps {
  /** Every verified domain, with its target's slug and whether it serves. */
  load: () => Promise<EdgeRoute[]>;
  maxStaleMs?: number;
  now?: () => number;
  onRefreshError?: (error: unknown) => void;
}

export interface CustomDomainRouteTable {
  lookup: (host: string) => RouteLookup;
  /** Reloads the table. Resolves false when the load failed (the last good table is kept). */
  refresh: () => Promise<boolean>;
  /** Stops routing `host` on this machine now, then reloads. */
  drop: (host: string) => void;
  size: () => number;
}

export function createCustomDomainRouteTable(deps: CustomDomainRouteTableDeps): CustomDomainRouteTable {
  const maxStaleMs = deps.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
  const now = deps.now ?? Date.now;

  let routes = new Map<string, EdgeRoute>();
  let loadedAt: number | null = null;
  // A drop must survive a reload that started BEFORE it: that reload read the
  // database as it was and would bring the dropped host back.
  let sequence = 0;
  const dropped = new Map<string, number>();
  let inFlight: Promise<boolean> | null = null;
  let again = false;

  async function loadOnce(): Promise<boolean> {
    const startedAt = sequence;
    try {
      const loaded = await deps.load();
      const next = new Map<string, EdgeRoute>();
      for (const route of loaded) next.set(route.domain, route);
      for (const [host, droppedAt] of dropped) {
        if (droppedAt > startedAt) next.delete(host);
        else dropped.delete(host);
      }
      routes = next;
      loadedAt = now();
      return true;
    } catch (error) {
      deps.onRefreshError?.(error);
      return false;
    }
  }

  function refresh(): Promise<boolean> {
    if (inFlight) {
      // Whatever prompted this call happened after the running load began.
      again = true;
      return inFlight;
    }
    inFlight = (async () => {
      let ok = await loadOnce();
      while (again) {
        again = false;
        ok = await loadOnce();
      }
      return ok;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    lookup(host) {
      if (loadedAt === null || now() - loadedAt > maxStaleMs) return { kind: "unavailable" };
      const route = routes.get(host);
      return route ? { kind: "hit", route } : { kind: "miss" };
    },
    refresh,
    drop(host) {
      sequence += 1;
      dropped.set(host, sequence);
      routes.delete(host);
      void refresh();
    },
    size: () => routes.size,
  };
}

// ============================================
// The rewrite
// ============================================

/** What the rewrite decided about one request that came through the edge. */
export interface EdgeRequestContext {
  action: EdgeAction;
  /** The normalised hostname; null when the header did not hold one. */
  host: string | null;
  /** The domain the hostname belongs to; null for an unknown host. */
  route: EdgeRoute | null;
}

const contexts = new WeakMap<IncomingMessage, EdgeRequestContext>();

/** The edge context of a request, or undefined for a request to the canonical host. */
export function getEdgeContext(raw: IncomingMessage): EdgeRequestContext | undefined {
  return contexts.get(raw);
}

function single(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

export interface EdgeRewriteDeps {
  table: CustomDomainRouteTable;
  /** The forwarding secret; null while custom domains are not configured. */
  edgeSecret: string | null;
  /**
   * Whether the hooks that hold a forwarded request to the domain's own
   * organization are installed. Until they are, nothing is forwarded.
   */
  guardInstalled: () => boolean;
}

function decide(req: IncomingMessage, token: string, deps: EdgeRewriteDeps): EdgeRequestContext {
  const unrouted: EdgeRequestContext = { action: { kind: "unrouted" }, host: null, route: null };
  if (deps.edgeSecret === null || !constantTimeEqual(token, deps.edgeSecret)) return unrouted;

  const host = normalizeEdgeHost(single(req.headers[EDGE_HOST_HEADER]));
  if (host === null) return unrouted;

  const found = deps.table.lookup(host);
  if (found.kind === "unavailable") return { action: { kind: "unavailable" }, host, route: null };
  if (found.kind === "miss") return { action: { kind: "unrouted" }, host, route: null };

  const action = mapEdgeRequest({
    method: req.method ?? "GET",
    url: req.url ?? "/",
    // Anything but an explicit "https" is treated as plain HTTP and redirected.
    https: single(req.headers[EDGE_PROTO_HEADER])?.toLowerCase() === "https",
    route: found.route,
  });
  if (action.kind === "forward" && !deps.guardInstalled()) {
    return { action: { kind: "unavailable" }, host, route: found.route };
  }
  return { action, host, route: found.route };
}

/**
 * Fastify's `rewriteUrl`. Returns the URL unchanged unless the request carries
 * the edge's token header; with it, the request is routed by customer hostname
 * and by nothing the client put in the path.
 */
export function createEdgeRewriteUrl(deps: EdgeRewriteDeps): (req: IncomingMessage) => string {
  return (req) => {
    const header = req.headers[EDGE_TOKEN_HEADER];
    if (header === undefined) return req.url ?? "/";

    let context: EdgeRequestContext;
    try {
      context = decide(req, single(header) ?? "", deps);
    } catch {
      context = { action: { kind: "unavailable" }, host: null, route: null };
    }
    contexts.set(req, context);
    return context.action.kind === "forward" ? context.action.url : EDGE_RESPOND_PATH;
  };
}

// ============================================
// Request counts
// ============================================

export interface DomainRequestCount {
  domainId: string;
  count: number;
  lastRequestAt: Date;
}

export interface DomainRequestCounter {
  record: (domainId: string, at: Date) => void;
  /** Writes what was counted since the last flush. Never throws. */
  flush: () => Promise<void>;
  pending: () => number;
}

/**
 * Counts forwarded requests per domain in memory and writes them as
 * increments. A count that could not be written stays in the buffer for the
 * next flush, so a database blip neither loses requests nor counts one twice.
 */
export function createDomainRequestCounter(deps: {
  increment: (entry: DomainRequestCount) => Promise<void>;
  onError?: (error: unknown) => void;
  /** Beyond this many buffered domains new ones are not counted (memory bound). */
  maxDomains?: number;
}): DomainRequestCounter {
  const maxDomains = deps.maxDomains ?? 10_000;
  let buffer = new Map<string, { count: number; lastRequestAt: Date }>();

  function add(domainId: string, count: number, at: Date) {
    const entry = buffer.get(domainId);
    if (entry) {
      entry.count += count;
      if (at.getTime() > entry.lastRequestAt.getTime()) entry.lastRequestAt = at;
    } else if (buffer.size < maxDomains) {
      buffer.set(domainId, { count, lastRequestAt: at });
    }
  }

  return {
    record: (domainId, at) => add(domainId, 1, at),
    async flush() {
      const batch = buffer;
      buffer = new Map();
      for (const [domainId, entry] of batch) {
        try {
          await deps.increment({ domainId, ...entry });
        } catch (error) {
          deps.onError?.(error);
          add(domainId, entry.count, entry.lastRequestAt);
        }
      }
    },
    pending: () => [...buffer.values()].reduce((sum, entry) => sum + entry.count, 0),
  };
}
