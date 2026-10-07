import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import "./unitEnv.js";

// Drives queues/custom-domain-check.queue.ts. The worker must not start, and
// must NOT open a Redis connection, when the edge is not configured or the
// interval is 0 (so this test process exits cleanly - nothing to close).

const EDGE_ENV = {
  CUSTOM_DOMAIN_EDGE_HOSTNAME: "edge.wheelsai.io",
  CUSTOM_DOMAIN_EDGE_IPV4: "137.66.10.1",
  CUSTOM_DOMAIN_ASK_TOKEN: "a".repeat(32),
  CUSTOM_DOMAIN_EDGE_SECRET: "b".repeat(32),
};
const CUSTOM_DOMAIN_VARS = [
  ...Object.keys(EDGE_ENV),
  "CUSTOM_DOMAIN_EDGE_IPV6",
  "CUSTOM_DOMAIN_CHECK_INTERVAL_MS",
  "CUSTOM_DOMAIN_PROBE_EXTRA_CA_PEM",
];

async function withEnv(env: Record<string, string>, run: () => Promise<void>) {
  const { resetCustomDomainConfigCache } = await import("../config/customDomains.js");
  const saved = Object.fromEntries(CUSTOM_DOMAIN_VARS.map((name) => [name, process.env[name]]));
  for (const name of CUSTOM_DOMAIN_VARS) delete process.env[name];
  Object.assign(process.env, env);
  resetCustomDomainConfigCache();
  try {
    await run();
  } finally {
    for (const name of CUSTOM_DOMAIN_VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    resetCustomDomainConfigCache();
  }
}

test("start and stop are exported, from the module and from the queue index", async () => {
  const mod = await import("../queues/custom-domain-check.queue.js");
  assert.equal(typeof mod.startCustomDomainCheckQueue, "function");
  assert.equal(typeof mod.stopCustomDomainCheckQueue, "function");
  const index = readFileSync(new URL("../queues/index.ts", import.meta.url), "utf8");
  assert.match(index, /startCustomDomainCheckQueue,\s+stopCustomDomainCheckQueue,\s+\} from "\.\/custom-domain-check\.queue\.js"/);
});

test("with no edge configured the worker is disabled and opens no connection", async () => {
  await withEnv({}, async () => {
    const mod = await import("../queues/custom-domain-check.queue.js");
    await mod.startCustomDomainCheckQueue();
    await mod.stopCustomDomainCheckQueue();
    await mod.stopCustomDomainCheckQueue(); // idempotent
  });
});

test("with a misconfigured edge the worker is disabled", async () => {
  await withEnv({ ...EDGE_ENV, CUSTOM_DOMAIN_EDGE_SECRET: "too-short" }, async () => {
    const mod = await import("../queues/custom-domain-check.queue.js");
    await mod.startCustomDomainCheckQueue();
    await mod.stopCustomDomainCheckQueue();
  });
});

test("with CUSTOM_DOMAIN_CHECK_INTERVAL_MS=0 the worker is disabled even with an edge", async () => {
  await withEnv({ ...EDGE_ENV, CUSTOM_DOMAIN_CHECK_INTERVAL_MS: "0" }, async () => {
    const { getCustomDomainConfig } = await import("../config/customDomains.js");
    assert.ok(getCustomDomainConfig().edge);
    const mod = await import("../queues/custom-domain-check.queue.js");
    await mod.startCustomDomainCheckQueue();
    await mod.stopCustomDomainCheckQueue();
    await mod.stopCustomDomainCheckQueue();
  });
});

test("the API starts and stops the worker with the others", () => {
  const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(index, /await startCustomDomainCheckQueue\(\);/);
  assert.match(index, /await stopCustomDomainCheckQueue\(\);/);
});

test("regression pin: no timer marks a certificate active", () => {
  const service = readFileSync(new URL("../services/domains.ts", import.meta.url), "utf8");
  // The fabricated "SSL active after two seconds" lived here.
  assert.equal(/setTimeout/.test(service), false);
  assert.equal(/startSslProvisioning/.test(service), false);
  // It still READS the status (stats, the enable guard) but never invents one.
  assert.equal(/sslExpiresAt:\s*expiresAt/.test(service), false);
  assert.equal(/lets_encrypt/.test(service), false);

  // Only the rules write a certificate status, and "active" in one place.
  for (const file of ["runCustomDomainCheckTick.ts", "buildCustomDomainCheckTickDeps.ts", "domainDns.ts", "tlsCertificateProbe.ts"]) {
    const source = readFileSync(new URL(`../services/${file}`, import.meta.url), "utf8");
    assert.equal(/sslStatus:\s*"active"/.test(source), false, file);
    assert.equal(/setTimeout\([^)]*sslStatus/.test(source), false, file);
  }
  const rules = readFileSync(new URL("../services/customDomainRules.ts", import.meta.url), "utf8");
  assert.equal((rules.match(/sslStatus:\s*"active"/g) ?? []).length, 1);
});
