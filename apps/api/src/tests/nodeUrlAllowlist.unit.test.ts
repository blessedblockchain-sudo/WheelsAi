import assert from "node:assert/strict";
import test from "node:test";

import { isAllowedNodeUrl, loopbackNodeUrlsAllowed } from "../services/nodeUrlAllowlist.js";

// Drives apps/api/src/services/nodeUrlAllowlist.ts - the /v1 SSRF allowlist.
// The previous pattern `^https://[\w-]+\.nos\.ci` could not match the
// multi-label hosts Nosana actually serves, so every real endpoint 502'd.

test("accepts real multi-label Nosana endpoints", () => {
  for (const url of [
    "https://abc123.node.nos.ci",
    "https://3hYx9Qw.node.k8s.prd.nos.ci",
    "https://a.b.c.d.nos.ci",
    "https://x.nos.ci", // single label still fine
    "https://x-y-z.nos.ci:8443",
    "https://X.Node.Nos.Ci", // hostnames are case-insensitive
  ]) {
    assert.equal(isAllowedNodeUrl(url), true, url);
  }
});

test("accepts our OpenClaw domain, multi-label too", () => {
  for (const url of [
    "https://agent.openclaw.wheelsai.com",
    "https://a.b.openclaw.wheelsai.com",
    "https://agent.openclaw.wheelsai.com:8443",
  ]) {
    assert.equal(isAllowedNodeUrl(url), true, url);
  }
});

test("only nos.ci is accepted as a Nosana domain - NOT nosana.<any tld> (review #11)", () => {
  // Nosana serves compute endpoints only under nos.ci (SDK config + dashboard
  // API); nosana.io/.com are docs/marketing sites, and the old open
  // `nosana.[a-z]{2,24}` pattern accepted any TLD, e.g. x.nosana.lol.
  for (const url of [
    "https://x.nosana.lol",
    "https://x.nosana.io",
    "https://gw.nosana.com",
    "https://a.b.nosana.com:8080",
    "https://dashboard.nosana.com",
    "https://nosana.mypinata.cloud",
    "https://x.nosana.evil.com",
  ]) {
    assert.equal(isAllowedNodeUrl(url), false, url);
  }
  assert.equal(isAllowedNodeUrl("https://abc.node.k8s.prd.nos.ci"), true);
  assert.equal(isAllowedNodeUrl("https://abc.node.k8s.dev.nos.ci"), true, "devnet endpoints too");
});

test("rejects look-alike domains", () => {
  for (const url of [
    "https://nos.ci.evil.com",
    "https://evil-nos.ci",
    "https://x.nos.ci.evil.com",
    "https://nos.ci", // the bare apex is not a node host
    "https://notnos.ci",
    "https://x.nos.cc",
    "https://x.nosana.evil.com",
    "https://openclaw.wheelsai.com.evil.com",
  ]) {
    assert.equal(isAllowedNodeUrl(url), false, url);
  }
});

test("rejects non-https schemes", () => {
  for (const url of [
    "http://x.nos.ci",
    "ftp://x.nos.ci",
    "file:///etc/passwd",
    "//x.nos.ci",
    "x.nos.ci",
    "javascript:alert(1)",
  ]) {
    assert.equal(isAllowedNodeUrl(url), false, url);
  }
});

test("rejects userinfo tricks", () => {
  for (const url of [
    "https://x.nos.ci@evil.com",
    "https://evil.com@x.nos.ci",
    "https://user:pass@x.nos.ci",
    "https://x.nos.ci:pass@evil.com",
    "https://x.nos.ci%40evil.com",
    "https://x.nos.ci\\@evil.com",
  ]) {
    assert.equal(isAllowedNodeUrl(url), false, url);
  }
});

test("rejects paths, queries and fragments (origin only)", () => {
  for (const url of [
    "https://x.nos.ci/",
    "https://x.nos.ci/v1/chat/completions",
    "https://x.nos.ci?a=b",
    "https://x.nos.ci#frag",
    "https://x.nos.ci:443/",
    "https://x.nos.ci//evil.com",
  ]) {
    assert.equal(isAllowedNodeUrl(url), false, url);
  }
});

test("rejects bad ports", () => {
  for (const url of [
    "https://x.nos.ci:0",
    "https://x.nos.ci:65536",
    "https://x.nos.ci:99999",
    "https://x.nos.ci:",
    "https://x.nos.ci:abc",
    "https://x.nos.ci:-1",
  ]) {
    assert.equal(isAllowedNodeUrl(url), false, url);
  }
  assert.equal(isAllowedNodeUrl("https://x.nos.ci:65535"), true);
});

test("rejects IP literals, internal hosts and metadata endpoints", () => {
  for (const url of [
    "https://10.0.0.1",
    "https://172.16.0.1",
    "https://192.168.1.1",
    "https://169.254.169.254",
    "https://0.0.0.0",
    "https://[::1]",
    "https://2130706433",
    "https://metadata.google.internal",
  ]) {
    assert.equal(isAllowedNodeUrl(url), false, url);
  }
});

test("rejects whitespace, control characters, empty and oversized input", () => {
  for (const url of [
    "",
    " https://x.nos.ci",
    "https://x.nos.ci ",
    "https://x.nos.ci\n",
    "https://x.nos.ci\t.evil.com",
    "https://x.nos.ci\u0000",
    `https://${"a".repeat(300)}.nos.ci`,
    `https://${"a".repeat(64)}.nos.ci`, // label longer than 63
    "https://-x.nos.ci",
    "https://x-.nos.ci",
    "https://x..nos.ci",
    "https://.nos.ci",
  ]) {
    assert.equal(isAllowedNodeUrl(url), false, JSON.stringify(url));
  }
});

test("rejects non-strings without throwing", () => {
  assert.equal(isAllowedNodeUrl(undefined as never), false);
  assert.equal(isAllowedNodeUrl(null as never), false);
  assert.equal(isAllowedNodeUrl(123 as never), false);
});

test("loopback is denied by default and only allowed when explicitly enabled", () => {
  for (const url of [
    "http://localhost:8000",
    "http://127.0.0.1",
    "https://localhost",
    "http://127.0.0.1:11434",
  ]) {
    assert.equal(isAllowedNodeUrl(url), false, `${url} must be denied by default`);
    assert.equal(isAllowedNodeUrl(url, { allowLoopback: true }), true, `${url} dev-only`);
  }
  // even in dev mode the trick variants stay blocked
  assert.equal(isAllowedNodeUrl("http://localhost@evil.com", { allowLoopback: true }), false);
  assert.equal(isAllowedNodeUrl("http://127.0.0.1.evil.com", { allowLoopback: true }), false);
  assert.equal(isAllowedNodeUrl("http://localhost/x", { allowLoopback: true }), false);
});

test("loopbackNodeUrlsAllowed needs a development process AND an explicit opt-in (review #11)", () => {
  // NODE_ENV defaults to "development" (config/env.ts), so NODE_ENV alone must
  // never open localhost to a server-side fetch.
  assert.equal(loopbackNodeUrlsAllowed("development", true), true);
  assert.equal(loopbackNodeUrlsAllowed("development", false), false, "default: off");
  assert.equal(loopbackNodeUrlsAllowed("development", undefined), false);
  assert.equal(loopbackNodeUrlsAllowed("staging", true), false);
  assert.equal(loopbackNodeUrlsAllowed("production", true), false);
  assert.equal(loopbackNodeUrlsAllowed(undefined, true), false);
});
