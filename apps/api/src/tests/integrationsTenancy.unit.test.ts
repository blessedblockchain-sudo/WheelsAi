import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Integration multi-tenancy (W2 pre-work).
//
// Nine service functions took an `orgId` parameter and never used it —
// they resolved by bare `id`. Route-level pre-checks covered most callers,
// but POST /api/integrations/:id/disconnect had none, which made it a
// LIVE cross-org IDOR: any authenticated user could clear any
// organization's integration credentials by id. The rest were one new
// caller away from the same thing.
//
// These are source-level pins. The behavior is enforced in the WHERE
// clause, and a WHERE clause is exactly the kind of thing that gets
// quietly widened during a refactor.

const servicePath = fileURLToPath(
  new URL("../services/integrations.ts", import.meta.url),
);
const routePath = fileURLToPath(new URL("../routes/webhooks.ts", import.meta.url));
const service = readFileSync(servicePath, "utf8");
const routes = readFileSync(routePath, "utf8");

/** The body of a top-level exported function, by name. */
function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start > -1, `${name} not found`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

const MUTATORS = ["updateIntegration", "deleteIntegration", "disconnectIntegration"];
const SENDERS = [
  "sendSlackMessage",
  "sendDiscordMessage",
  "triggerZapierWebhook",
  "triggerMakeWebhook",
  "triggerN8nWebhook",
];

test("every mutating integration function scopes its WHERE by orgId", () => {
  for (const name of MUTATORS) {
    const body = bodyOf(service, name);
    assert.match(
      body,
      /where:\s*\{\s*id:\s*integrationId,\s*orgId\s*\}/,
      `${name} must resolve by { id, orgId } — an id-only WHERE is a cross-org write`,
    );
    assert.doesNotMatch(
      body,
      /where:\s*\{\s*id:\s*integrationId\s*\}/,
      `${name} still has an id-only WHERE somewhere`,
    );
  }
});

test("every webhook SENDER resolves its integration scoped to the org", () => {
  // Firing another org's configured webhook is both an action-on-behalf
  // and, through the stored response, a read primitive.
  for (const name of SENDERS) {
    const body = bodyOf(service, name);
    assert.match(
      body,
      /findFirst\(\{\s*\n?\s*where:\s*\{\s*id:\s*integrationId,\s*orgId\s*\}/,
      `${name} must look up by { id, orgId }`,
    );
  }
});

test("every sender takes orgId as its first parameter, so callers cannot forget it", () => {
  for (const name of SENDERS) {
    const decl = service.slice(
      service.indexOf(`export async function ${name}(`),
      service.indexOf(")", service.indexOf(`export async function ${name}(`)) + 1,
    );
    assert.match(decl, /\(\s*\n\s*orgId: string,/, `${name} signature`);
  }
});

test("the disconnect route pre-checks ownership — its omission was the live IDOR", () => {
  const start = routes.indexOf('"/integrations/:integrationId/disconnect"');
  assert.ok(start > -1, "disconnect route not found");
  const block = routes.slice(start, start + 900);
  assert.match(
    block,
    /getIntegration\(orgId, integrationId\)/,
    "disconnect must pre-check ownership like the other mutating routes",
  );
  const guardIdx = block.indexOf("getIntegration(orgId, integrationId)");
  const actionIdx = block.indexOf("disconnectIntegration(orgId, integrationId)");
  assert.ok(
    guardIdx > -1 && actionIdx > guardIdx,
    "the ownership check must come BEFORE the disconnect",
  );
});

test("the forgeable OAuth state helpers are gone, not merely unused", () => {
  for (const name of ["generateOAuthState", "parseOAuthState", "completeOAuthFlow"]) {
    assert.doesNotMatch(
      service,
      new RegExp(`export (async )?function ${name}\\(`),
      `${name} must be deleted — an unsigned, forgeable state helper is a trap for the next caller`,
    );
  }
});

test("the timing-oracle webhook verifier is gone", () => {
  const webhooks = readFileSync(
    fileURLToPath(new URL("../services/webhooks.ts", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(webhooks, /export function verifyWebhookSignature\(/);
  // And nothing compares an HMAC with === anymore.
  assert.doesNotMatch(webhooks, /`sha256=\$\{expectedSignature\}` === signature/);
});

test("token encryption derives a 32-byte key by hash, not by hex-parsing a passphrase", () => {
  // Buffer.from(passphrase, "hex") stops at the first non-hex character,
  // silently yielding a short or empty key.
  assert.doesNotMatch(service, /Buffer\.from\(ENCRYPTION_KEY, "hex"\)/);
  assert.match(service, /createHash\("sha256"\)\.update\(secret\)\.digest\(\)/);
  // Read lazily so a rotated secret takes effect without a redeploy.
  assert.match(service, /function getEncryptionKey\(\): Buffer/);
});

test("outbound integration senders go through the SSRF guard", () => {
  // The URLs are user-supplied config, and zapier/n8n store the response
  // where the caller can read it — bare fetch here is a read primitive.
  assert.doesNotMatch(service, /await fetch\(config\.webhookUrl/);
  assert.match(service, /await safeFetch\(config\.webhookUrl/);
});
