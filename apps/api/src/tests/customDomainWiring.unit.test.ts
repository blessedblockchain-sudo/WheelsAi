import "./unitEnv.js";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import test from "node:test";

import Fastify from "fastify";

import { loadCustomDomainConfig } from "../config/customDomains.js";
import { createCustomDomainEdgeRuntime } from "../routes/customDomainEdgeBindings.js";
import type { CustomDomainEdgeDeps } from "../services/buildCustomDomainEdgeDeps.js";
import type { DomainRequestCount } from "../services/customDomainRouteTable.js";

// How custom domains are wired into the API process. Part of this reads
// source: the order of three lines in index.ts decides whether a request on a
// customer's hostname is held to that customer's organization, and nothing
// else in the test suite would notice them moving.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const CONFIGURED = loadCustomDomainConfig({
  CUSTOM_DOMAIN_EDGE_HOSTNAME: "edge.wheelsai.example.org",
  CUSTOM_DOMAIN_EDGE_IPV4: "137.66.10.1",
  CUSTOM_DOMAIN_ASK_TOKEN: "ask-token-0123456789abcdef0123456789abcdef",
  CUSTOM_DOMAIN_EDGE_SECRET: "edge-secret-0123456789abcdef0123456789abcdef",
});

/** The text of every `data: { ... }` object literal in a source file. */
function dataBlocks(source: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf("data: {", from);
    if (start === -1) return blocks;
    let depth = 0;
    let end = start + "data: ".length;
    do {
      if (source[end] === "{") depth += 1;
      if (source[end] === "}") depth -= 1;
      end += 1;
    } while (depth > 0 && end < source.length);
    blocks.push(source.slice(start, end));
    from = end;
  }
}

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

function fakeDeps() {
  const used = { loadRoutes: 0 };
  const written: DomainRequestCount[] = [];
  const deps: CustomDomainEdgeDeps = {
    loadRoutes: async () => {
      used.loadRoutes += 1;
      return [
        { domainId: "d1", orgId: "org1", domain: "api.customer.com", targetType: "deployment", targetSlug: "llama-prod", serving: true, headers: {} },
      ];
    },
    findVerifiedDomain: async () => null,
    isEntitled: async () => true,
    targetExists: async () => true,
    grantIssuance: async () => ({ granted: true }),
    increment: async (entry) => void written.push(entry),
  };
  return { deps, used, written };
}

const edgeRequest = (url: string, token = CONFIGURED.edge!.edgeSecret) =>
  ({
    url,
    method: "POST",
    headers: { "x-wheels-edge-token": token, "x-wheels-custom-host": "api.customer.com", "x-wheels-edge-proto": "https" },
  }) as unknown as IncomingMessage;

// ============================================
// index.ts
// ============================================

test("index.ts routes by customer hostname: rewriteUrl is passed to Fastify", () => {
  const index = read("../index.ts");
  assert.match(index, /const customDomainEdge = createCustomDomainEdgeProduction\(\);/);
  assert.match(index, /Fastify\(\{[^}]*rewriteUrl: customDomainEdge\.rewriteUrl,/s);
});

test("index.ts installs the organization guard after auth and before every route plugin", () => {
  const index = read("../index.ts");
  const create = index.indexOf("createCustomDomainEdgeProduction();");
  const fastify = index.indexOf("const app = Fastify({");
  const auth = index.indexOf("await registerAuthPlugins(app);");
  const install = index.indexOf("customDomainEdge.install(app);");
  const firstRoutes = index.indexOf("// Register routes");
  const firstRegister = index.indexOf('await app.register(healthRoutes');
  for (const [name, at] of Object.entries({ create, fastify, auth, install, firstRoutes, firstRegister })) {
    assert.notEqual(at, -1, `${name} not found in index.ts`);
  }
  assert.ok(create < fastify, "the runtime exists before the Fastify instance that uses its rewriteUrl");
  // The guard reads request.auth, which the auth plugin's hook sets first.
  assert.ok(auth < install, "installed after the auth plugin");
  // A plugin inherits only the hooks present when it is registered.
  assert.ok(install < firstRoutes && install < firstRegister, "installed before the route plugins");
  assert.equal(index.split("customDomainEdge.install(app);").length - 1, 1);
});

test("index.ts mounts the edge's routes always, and starts routing and the checker", () => {
  const index = read("../index.ts");
  assert.match(index, /await app\.register\(createCustomDomainEdgeRoutesProduction\(customDomainEdge\)\);/);
  // Not inside a feature flag or a configuration check.
  const line = index.split("\n").find((l) => l.includes("createCustomDomainEdgeRoutesProduction(customDomainEdge)"))!;
  assert.match(line, /^ {2}await app\.register/);
  assert.match(index, /await customDomainEdge\.start\(\);/);
  assert.match(index, /await startCustomDomainCheckQueue\(\);/);
  assert.match(index, /await stopCustomDomainCheckQueue\(\);/);
  assert.match(index, /app\.register\(domainsRoutes, \{ prefix: "\/api\/domains" \}\)/);
});

// ============================================
// Regression pins against the fake
// ============================================

test("the domains service has no timer, no invented CNAME target and no invented certificate", () => {
  const service = read("../services/domains.ts");
  assert.equal(/setTimeout|setInterval/.test(service), false);
  assert.equal(service.includes("domains.wheels.ai"), false);
  assert.equal(/lets_encrypt|Let's Encrypt/i.test(service), false);
  // It never writes a status itself: every `data:` it hands the database is
  // either a decision of the rules module or holds none of the observed columns.
  const written = dataBlocks(service);
  assert.ok(written.length >= 3, "the data blocks were found");
  for (const block of written) {
    assert.equal(
      /\b(sslStatus|sslExpiresAt|sslIssuer|sslProvider|sslFingerprint256|verificationStatus|verifiedDomain|verifiedAt|routingStatus|isActive|pausedReason)\b/.test(block),
      false,
      block,
    );
  }
  // And it reads no key material.
  for (const column of ["customKey", "customCert", "customCertChain"]) {
    assert.equal(new RegExp(`${column}:\\s*true`).test(service), false, column);
  }
});

test("the routes and the web-facing DNS instructions name no host the platform does not configure", () => {
  for (const file of ["../routes/domains.ts", "../routes/customDomainEdge.ts", "../services/customDomainRules.ts", "../services/customDomainRouteTable.ts"]) {
    const source = read(file);
    assert.equal(source.includes("domains.wheels.ai"), false, file);
    assert.equal(/setTimeout\(/.test(source), false, file);
  }
});

test("the domain routes are a factory, with the production plugin index.ts mounts", () => {
  const routes = read("../routes/domains.ts");
  assert.match(routes, /export function createDomainsRoutes\(/);
  assert.match(routes, /export const domainsRoutes: FastifyPluginAsync = createDomainsRoutes\(\);/);
});

// ============================================
// The edge proxy's files (infra/edge) against what the API reads
// ============================================

// The Caddyfile and the API agree on four strings and nothing checks them at
// build time. A header the edge does not send is not an error anywhere: the
// API simply sees no HTTPS and redirects every request, forever.

const repo = (path: string) => read(`../../../../${path}`);

test("the edge sends the three headers the API reads, on HTTPS and on plain HTTP", async () => {
  const { EDGE_HOST_HEADER, EDGE_PROTO_HEADER, EDGE_TOKEN_HEADER } = await import(
    "../services/customDomainRouteTable.js"
  );
  const caddyfile = repo("infra/edge/Caddyfile").toLowerCase();
  assert.ok(caddyfile.includes(`header_up ${EDGE_TOKEN_HEADER} {$custom_domain_edge_secret}`));
  assert.ok(caddyfile.includes(`header_up ${EDGE_HOST_HEADER} {host}`));
  assert.ok(caddyfile.includes(`header_up ${EDGE_PROTO_HEADER} {scheme}`));
  // One shared snippet, imported by both site blocks, so the two cannot drift.
  assert.match(caddyfile, /https:\/\/ \{[^}]*tls \{\s*on_demand\s*\}\s*import to_api\s*\}/);
  assert.match(caddyfile, /http:\/\/ \{\s*import to_api\s*\}/);
});

test("the edge asks the API's own path before a certificate, and never redirects by itself", async () => {
  const { EDGE_ASK_PATH } = await import("../routes/customDomainEdge.js");
  const caddyfile = repo("infra/edge/Caddyfile");
  assert.ok(caddyfile.includes(`ask {$WHEELS_API_INTERNAL}${EDGE_ASK_PATH}?token={$CUSTOM_DOMAIN_ASK_TOKEN}`));
  // The API answers plain HTTP (308 for a serving domain, 404 otherwise).
  assert.match(caddyfile, /auto_https disable_redirects/);
  // The forwarding secret never travels in the ask URL.
  assert.equal(/ask [^\n]*CUSTOM_DOMAIN_EDGE_SECRET/.test(caddyfile), false);
});

test("the edge image is pinned, and its Fly apps keep certificates on a volume behind raw TCP", () => {
  assert.match(repo("infra/edge/Dockerfile"), /^FROM caddy:\d+\.\d+\.\d+-alpine$/m);
  assert.match(repo("infra/edge/Dockerfile"), /caddy validate/);
  for (const env of ["staging", "production"]) {
    const toml = repo(`infra/edge/fly.${env}.toml`);
    assert.match(toml, /destination = "\/data"/, env);
    assert.equal((toml.match(/handlers = \["proxy_proto"\]/g) ?? []).length, 2, env);
    assert.equal(/handlers = \[[^\]]*"(tls|http)"/.test(toml), false, `${env}: Fly must not terminate TLS`);
    assert.match(toml, /WHEELS_API_INTERNAL = "http:\/\/wheelsai-api(-staging)?\.internal:4000"/, env);
    // The private network is IPv6 only; the API must listen there.
    assert.match(repo(`apps/api/fly.${env}.toml`), /API_HOST = "::"/, env);
  }
});

test(".env.example lists every custom-domain variable the configuration reads", () => {
  const config = read("../config/customDomains.ts");
  const example = repo(".env.example");
  const names = [...new Set(config.match(/CUSTOM_DOMAIN_[A-Z0-9]+(?:_[A-Z0-9]+)*/g) ?? [])].filter(
    // Mentioned in prose as a pair ("..._EDGE_IPV4/IPV6"), or the message constant.
    (name) => name !== "CUSTOM_DOMAIN_EDGE" && !name.startsWith("CUSTOM_DOMAINS"),
  );
  assert.ok(names.length >= 10, `found only ${names.join(", ")}`);
  for (const name of names) {
    assert.ok(example.includes(`# ${name}=`), `${name} is missing from .env.example`);
  }
});

// ============================================
// The runtime
// ============================================

test("unconfigured: nothing is loaded, no timer runs, and a claimed edge request routes nowhere", async () => {
  const { deps, used } = fakeDeps();
  let built = 0;
  const runtime = createCustomDomainEdgeRuntime({
    config: loadCustomDomainConfig({}),
    deps: () => {
      built += 1;
      return deps;
    },
    log: quiet,
  });
  await runtime.start();
  assert.equal(built, 0, "no database client is built");
  assert.equal(used.loadRoutes, 0);

  const app = Fastify();
  runtime.install(app);
  // The API's own host is untouched.
  assert.equal(runtime.rewriteUrl({ url: "/v1/models", method: "GET", headers: {} } as unknown as IncomingMessage), "/v1/models");
  assert.equal(runtime.rewriteUrl(edgeRequest("/v1/chat/completions")), "/__edge/respond");
  await runtime.stop();
  await app.close();
});

test("configured: nothing is forwarded until the guard is installed; then the hostname routes", async () => {
  const { deps, used } = fakeDeps();
  const runtime = createCustomDomainEdgeRuntime({ config: CONFIGURED, deps: () => deps, log: quiet });
  await runtime.start();
  assert.equal(used.loadRoutes, 1);

  assert.equal(runtime.rewriteUrl(edgeRequest("/v1/chat/completions")), "/__edge/respond");
  const app = Fastify();
  runtime.install(app);
  assert.equal(runtime.rewriteUrl(edgeRequest("/v1/chat/completions")), "/v1/llama-prod/chat/completions");
  assert.equal(runtime.rewriteUrl(edgeRequest("/v1/chat/completions", "wrong")), "/__edge/respond");
  assert.equal(runtime.rewriteUrl(edgeRequest("/api/auth/login")), "/__edge/respond");

  // start() twice does not stack timers or reload.
  await runtime.start();
  assert.equal(used.loadRoutes, 1);
  await app.close(); // the onClose hook stops the timers
});

test("a table that cannot be loaded at boot does not stop the API; custom hostnames answer 503", async () => {
  const { deps } = fakeDeps();
  const runtime = createCustomDomainEdgeRuntime({
    config: CONFIGURED,
    deps: () => ({
      ...deps,
      loadRoutes: async () => {
        throw new Error("database not ready");
      },
    }),
    log: quiet,
  });
  await runtime.start();
  const app = Fastify({ rewriteUrl: runtime.rewriteUrl });
  runtime.install(app);
  await app.register(runtime.routes);
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: edgeRequest("/").headers as Record<string, string>,
    payload: {},
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, "custom_domain_unavailable");
  await app.close();
});

test("closing the app writes the request counts still in the buffer", async () => {
  const { deps, written } = fakeDeps();
  const runtime = createCustomDomainEdgeRuntime({ config: CONFIGURED, deps: () => deps, log: quiet });
  await runtime.start();
  const tagged = Fastify({ rewriteUrl: runtime.rewriteUrl });
  tagged.decorateRequest("auth", null);
  tagged.addHook("onRequest", async (request) => {
    (request as { auth: unknown }).auth = { orgId: "org1", type: "api_key" };
  });
  runtime.install(tagged);
  tagged.post("/v1/:slug/chat/completions", async () => ({ ok: true }));
  const res = await tagged.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: edgeRequest("/").headers as Record<string, string>,
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  assert.equal(written.length, 0, "buffered, not written per request");
  await tagged.close();
  assert.deepEqual(written.map((w) => [w.domainId, w.count]), [["d1", 1]]);
});
