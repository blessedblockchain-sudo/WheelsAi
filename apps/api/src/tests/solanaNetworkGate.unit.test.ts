import assert from "node:assert/strict";
import test from "node:test";

// B7: SOLANA_RPC_URL defaults to the DEVNET endpoint. Before this gate,
// SOLANA_NETWORK=mainnet-beta with the URL unset (exactly what
// fly.production.toml shipped) made every consumer talk to devnet while
// believing it was on mainnet — payments "confirming" against the wrong
// chain. These pin the boot-fatal coupling.

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}
setupEnv();

const BASE: Record<string, string> = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://u:p@db:5432/app",
  JWT_SECRET: "a".repeat(32),
};

test("mainnet-beta with SOLANA_RPC_URL unset is boot-fatal (the default is devnet)", async () => {
  const { validateEnv, EnvValidationError } = await import("../config/env.js");
  assert.throws(
    () => validateEnv({ ...BASE, SOLANA_NETWORK: "mainnet-beta" }),
    EnvValidationError
  );
});

test("mainnet-beta with an explicitly devnet RPC URL is boot-fatal", async () => {
  const { validateEnv, EnvValidationError } = await import("../config/env.js");
  assert.throws(
    () =>
      validateEnv({
        ...BASE,
        SOLANA_NETWORK: "mainnet-beta",
        SOLANA_RPC_URL: "https://api.devnet.solana.com",
      }),
    EnvValidationError
  );
});

test("mainnet-beta with a real mainnet RPC passes", async () => {
  const { validateEnv } = await import("../config/env.js");
  assert.doesNotThrow(() =>
    validateEnv({
      ...BASE,
      SOLANA_NETWORK: "mainnet-beta",
      SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
    })
  );
});

test("devnet mode keeps working with all defaults", async () => {
  const { validateEnv } = await import("../config/env.js");
  const data = validateEnv({ ...BASE });
  assert.equal(data.SOLANA_NETWORK, "devnet");
  assert.ok(data.SOLANA_RPC_URL.includes("devnet"));
});
