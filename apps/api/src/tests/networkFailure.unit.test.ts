import assert from "node:assert/strict";
import test from "node:test";

import {
  NETWORK_FAILURE_CODES,
  isNetworkFailure,
  networkFailureCode,
} from "../services/networkFailure.js";

// The one rule for "the network failed" (services/networkFailure.ts): what is
// sent again by the chat runtime and by the Nosana lifecycle.

const CODES = [
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
];

const coded = (code: string, message = "") => Object.assign(new Error(message), { code });

test("the codes are these and no others", () => {
  assert.deepEqual([...NETWORK_FAILURE_CODES].sort(), [...CODES].sort());
});

for (const code of CODES) {
  test(`${code} is a network failure on the error, on a cause and inside an AggregateError`, () => {
    assert.equal(networkFailureCode(coded(code)), code);

    // What fetch throws: "fetch failed" with the socket error as its cause.
    const wrapped = new TypeError("fetch failed", { cause: coded(code, `connect ${code}`) });
    assert.equal(networkFailureCode(wrapped), code);
    assert.equal(isNetworkFailure(new Error("outer", { cause: wrapped })), true);

    // One error for every address tried, with no code of its own.
    const members = new AggregateError([new Error("no code"), coded(code)], "");
    assert.equal(networkFailureCode(members), code);
    assert.equal(isNetworkFailure(new TypeError("fetch failed", { cause: members })), true);
  });
}

test("Node's failure to connect to any address in time is one: the code is the AggregateError's own", () => {
  const noAddress = Object.assign(new AggregateError([new Error("a"), new Error("b")], ""), {
    code: "ETIMEDOUT",
  });
  assert.equal(noAddress.message, "");
  assert.equal(networkFailureCode(new TypeError("fetch failed", { cause: noAddress })), "ETIMEDOUT");
});

test("an abort is not a network failure, whatever it carries", () => {
  assert.equal(isNetworkFailure(new DOMException("This operation was aborted", "AbortError")), false);
  assert.equal(isNetworkFailure(AbortSignal.abort().reason), false);
  const nodeAbort = Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });
  assert.equal(isNetworkFailure(nodeAbort), false);
  const abortOverReset = Object.assign(new Error("aborted", { cause: coded("ECONNRESET") }), { name: "AbortError" });
  assert.equal(isNetworkFailure(abortOverReset), false);
  assert.equal(isNetworkFailure(new DOMException("The operation timed out", "TimeoutError")), false);
});

test("a plain error, an answer and a non-error are not network failures", () => {
  assert.equal(isNetworkFailure(new Error("fetch failed")), false);
  assert.equal(isNetworkFailure(new TypeError("fetch failed", { cause: new Error("something else") })), false);
  assert.equal(isNetworkFailure(Object.assign(new Error("Not found"), { status: 404 })), false);
  assert.equal(isNetworkFailure(coded("UND_ERR_HEADERS_TIMEOUT")), false);
  assert.equal(isNetworkFailure(new AggregateError([new Error("a")], "")), false);
  assert.equal(isNetworkFailure("ECONNRESET"), false);
  assert.equal(isNetworkFailure(null), false);
  assert.equal(isNetworkFailure(undefined), false);
});

test("a loop of causes or members ends, and a code buried too deep is not looked for", () => {
  const loop: { cause?: unknown; errors?: unknown[] } = {};
  loop.cause = loop;
  loop.errors = [loop];
  assert.equal(isNetworkFailure(loop), false);

  let deep: Error = coded("ECONNRESET");
  for (let i = 0; i < 6; i += 1) deep = new Error("wrap", { cause: deep });
  assert.equal(isNetworkFailure(deep), false);
});
