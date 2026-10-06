import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CliError } from "../src/errors.js";
import { deriveWebUrl, isLoopbackHost, listingUrl, normalizeUrl, parseBaseUrl, plainHttpWarning, sameOrigin } from "../src/lib/urls.js";

describe("parseBaseUrl", () => {
  it("accepts http(s) URLs and normalizes them, keeping a path prefix", () => {
    assert.equal(parseBaseUrl(" https://API.example.com// ", "--url"), "https://api.example.com");
    assert.equal(parseBaseUrl("https://example.com/wheels/", "--url"), "https://example.com/wheels");
    assert.equal(parseBaseUrl("http://localhost:4000", "--url"), "http://localhost:4000");
  });

  it("refuses anything that is not a plain http(s) base URL, naming where it came from", () => {
    for (const bad of ["", "not a url", "api.example.com", "localhost:4000", "ftp://example.com", "file:///etc/passwd", "javascript:alert(1)"]) {
      assert.throws(() => parseBaseUrl(bad, "WHEELSAI_API_URL"), (err: unknown) => {
        assert.ok(err instanceof CliError, bad);
        assert.match(err.message, /^WHEELSAI_API_URL /);
        return true;
      });
    }
    assert.throws(() => parseBaseUrl("https://user:secret@example.com", "--url"), /must not contain a user name or password/);
    assert.throws(() => parseBaseUrl("https://example.com/?next=x", "--url"), /query string or fragment/);
    assert.throws(() => parseBaseUrl("https://example.com/#x", "--url"), /query string or fragment/);
  });

  it("never repeats a password embedded in the URL", () => {
    assert.throws(() => parseBaseUrl("https://user:hunter2@example.com", "--url"), (err: unknown) => {
      assert.doesNotMatch((err as Error).message, /hunter2/);
      return true;
    });
  });
});

describe("plain http", () => {
  it("knows which hosts never leave this machine", () => {
    for (const host of ["localhost", "LOCALHOST", "api.localhost", "127.0.0.1", "127.8.9.10", "[::1]"]) assert.equal(isLoopbackHost(host), true, host);
    for (const host of ["example.com", "localhost.example.com", "10.0.0.5", "192.168.1.2", "staging", "128.0.0.1"]) assert.equal(isLoopbackHost(host), false, host);
  });

  it("warns about http to anything but this machine, and not about https or local http", () => {
    assert.match(plainHttpWarning("http://api.example.com") ?? "", /http:\/\/api\.example\.com is plain http: .* unencrypted/);
    assert.match(plainHttpWarning("http://staging:4000") ?? "", /plain http/);
    assert.match(plainHttpWarning("http://192.168.1.2:4000") ?? "", /plain http/);
    assert.equal(plainHttpWarning("https://api.example.com"), null);
    assert.equal(plainHttpWarning("http://localhost:4000"), null);
    assert.equal(plainHttpWarning("http://127.0.0.1:4000"), null);
    assert.equal(plainHttpWarning("http://[::1]:4000"), null);
  });
});

describe("sameOrigin", () => {
  it("compares scheme, host and port, and nothing else", () => {
    assert.equal(sameOrigin("https://api.example.com", "https://api.example.com/v2/"), true);
    assert.equal(sameOrigin("https://api.example.com", "https://api.example.com:443"), true);
    assert.equal(sameOrigin("https://api.example.com", "http://api.example.com"), false);
    assert.equal(sameOrigin("https://api.example.com", "https://api.example.com:8443"), false);
    assert.equal(sameOrigin("https://api.example.com", "https://api.example.com.evil.test"), false);
    assert.equal(sameOrigin("https://api.example.com", ""), false);
    assert.equal(sameOrigin("nonsense", "nonsense"), false);
  });
});

describe("deriveWebUrl", () => {
  it("pairs the local API port with the local web app", () => {
    assert.equal(deriveWebUrl("http://localhost:4000"), "http://localhost:3000");
    assert.equal(deriveWebUrl("http://localhost:4310"), "http://localhost:3000");
    assert.equal(deriveWebUrl("http://127.0.0.1:4000/"), "http://127.0.0.1:3000");
  });

  it("drops a leading api. label", () => {
    assert.equal(deriveWebUrl("https://api.example.com"), "https://example.com");
    assert.equal(deriveWebUrl("https://api.example.com:8443/v1"), "https://example.com:8443");
  });

  it("assumes the same origin otherwise", () => {
    assert.equal(deriveWebUrl("https://wheels.example.com/"), "https://wheels.example.com");
  });

  it("returns an unparseable URL unchanged (trimmed)", () => {
    assert.equal(deriveWebUrl(" not a url/ "), "not a url");
  });
});

describe("listingUrl and normalizeUrl", () => {
  it("joins the web URL and the slug the API returned", () => {
    assert.equal(listingUrl("http://localhost:3000/", "my-support-bot"), "http://localhost:3000/marketplace/my-support-bot");
  });

  it("encodes the slug", () => {
    assert.equal(listingUrl("https://x.test", "a b"), "https://x.test/marketplace/a%20b");
  });

  it("strips whitespace and trailing slashes", () => {
    assert.equal(normalizeUrl("  https://x.test// "), "https://x.test");
  });
});
