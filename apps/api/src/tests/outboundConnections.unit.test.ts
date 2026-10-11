import "./unitEnv.js";

import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { validateEnv } from "../config/env.js";
import { allowOutboundConnectAttempts } from "../lib/outboundConnections.js";

// The time one attempt to connect out is given (lib/outboundConnections.ts)
// and the setting that carries it (OUTBOUND_CONNECT_ATTEMPT_TIMEOUT_MS).

const BASE = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai",
  JWT_SECRET: "12345678901234567890123456789012",
};

test("the allowance becomes the process default for every connection", () => {
  const before = net.getDefaultAutoSelectFamilyAttemptTimeout();
  try {
    allowOutboundConnectAttempts(2_500);
    assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), 2_500);
    allowOutboundConnectAttempts(700);
    assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), 700);
  } finally {
    net.setDefaultAutoSelectFamilyAttemptTimeout(before);
  }
});

test("the setting defaults to 2500 ms", () => {
  assert.equal(validateEnv({ ...BASE }).OUTBOUND_CONNECT_ATTEMPT_TIMEOUT_MS, 2_500);
});

test("the setting takes whole milliseconds from 250 to 30000", () => {
  for (const ok of ["250", "2500", "30000"]) {
    assert.equal(
      validateEnv({ ...BASE, OUTBOUND_CONNECT_ATTEMPT_TIMEOUT_MS: ok }).OUTBOUND_CONNECT_ATTEMPT_TIMEOUT_MS,
      Number(ok),
    );
  }
  for (const refused of ["249", "0", "-1", "30001", "2500.5", "soon"]) {
    assert.throws(
      () => validateEnv({ ...BASE, OUTBOUND_CONNECT_ATTEMPT_TIMEOUT_MS: refused }),
      /OUTBOUND_CONNECT_ATTEMPT_TIMEOUT_MS/,
      refused,
    );
  }
});
