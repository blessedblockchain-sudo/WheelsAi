import assert from "node:assert/strict";
import test from "node:test";

import { nosanaNodesAreLocal, loadNosanaAccessConfig } from "../config/nosanaAccess.js";
import { resolveGpuFacingApiUrl } from "../config/training.js";
import { classifyGpuFacingUrl, gpuFacingOrigin, gpuFacingRefusal } from "../lib/gpuFacingUrl.js";
import { customS3EndpointOrigin, S3ObjectStore, storageLinkOrigin, type ObjectStore } from "../services/objectStore.js";

// "Can a container on a GPU node reach this address": the check that refuses
// a training job or a deployment before a GPU is rented. No network.

const verdict = (url: string) => {
  const result = classifyGpuFacingUrl(url);
  return result.reachable ? "reachable" : result.reason;
};

test("classifyGpuFacingUrl: a public address passes", () => {
  for (const url of [
    "https://api.example.com",
    "https://api.example.com/",
    "http://api.example.com:8080/api/training/jobs/1/events?n=abc",
    "https://API.Example.COM.",
    "https://name.trycloudflare.com",
    "https://bucket.s3.eu-west-1.amazonaws.com/key?X-Amz-Signature=abc",
    "http://8.8.8.8:4000",
    "https://[2606:4700:4700::1111]/",
    // Reserved test names are deliberately not refused.
    "https://api.test",
    "https://store.example",
  ]) {
    assert.equal(verdict(url), "reachable", url);
  }
});

test("classifyGpuFacingUrl: what does not parse, another scheme, or a user name is refused", () => {
  for (const url of ["", "not an address", "api.example.com", "//api.example.com", "http://"]) {
    assert.equal(verdict(url), "invalid", url);
  }
  for (const url of ["ftp://x.example.com", "file:///etc/passwd", "ws://api.example.com", "javascript:alert(1)"]) {
    assert.equal(verdict(url), "scheme", url);
  }
  for (const url of ["https://user:pw@api.example.com", "https://user@api.example.com", "http://:pw@api.example.com"]) {
    assert.equal(verdict(url), "credentials", url);
  }
});

test("classifyGpuFacingUrl: an address of this machine or a private network is refused, in every spelling", () => {
  for (const url of [
    "http://127.0.0.1:4000",
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f.0.0.1/",
    "http://0.0.0.0:4000",
    "http://10.0.0.5",
    "http://172.16.4.1:9000",
    "http://192.168.1.20:9000",
    "http://169.254.169.254/latest",
    "http://100.64.0.1",
    "http://[::1]:4000",
    "http://[::]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
  ]) {
    assert.equal(verdict(url), "private_address", url);
  }
});

test("classifyGpuFacingUrl: a name only a local resolver knows is refused", () => {
  for (const url of [
    "http://localhost:4000",
    "http://LOCALHOST:4000",
    "http://localhost.:4000",
    "http://api.localhost:4000",
    "http://printer.local",
    "http://host.docker.internal:4000",
    "http://minio.internal.:9000",
    "http://nas.lan",
    "http://router.home.arpa",
    // A single label: a compose service or a machine on the same network.
    "http://minio:9000",
    "http://api",
    "https://api./",
  ]) {
    assert.equal(verdict(url), "local_name", url);
  }
  // The local suffix itself, with no label before it.
  assert.equal(verdict("http://home.arpa:4000"), "local_name");
  // The suffix is a whole label, not the end of another word.
  assert.equal(verdict("https://my-local.example.com"), "reachable");
  assert.equal(verdict("https://notlocalhost.example.com"), "reachable");
  assert.equal(verdict("https://example.plan"), "reachable");
});

test("classifyGpuFacingUrl: a name with an empty label is refused, however many dots end it", () => {
  // One trailing dot is removed; a second leaves an empty label, and
  // "localhost.." must not pass as a name with a dot in it.
  for (const url of ["http://localhost..:4000", "http://minio..:9000", "http://api..internal..", "http://a..example.com"]) {
    assert.equal(verdict(url), "invalid", url);
  }
});

test("classifyGpuFacingUrl: other spellings of a local address do not pass", () => {
  for (const url of [
    "http://[::ffff:7f00:1]:4000",
    "http://[0:0:0:0:0:ffff:10.0.0.1]/",
    "http://[64:ff9b::7f00:1]/",
    "http://017700000001/",
    "http://127.0.0.1.:4000",
    "http://0/",
  ]) {
    assert.equal(verdict(url), "private_address", url);
  }
  // A zone id names a local interface; the parser refuses it outright.
  assert.equal(verdict("http://[fe80::1%25eth0]:4000"), "invalid");
  assert.equal(verdict("http://local%68ost:4000"), "local_name");
  // A public address written the same ways still passes.
  assert.equal(verdict("http://[::ffff:8.8.8.8]:4180"), "reachable");
  assert.equal(verdict("http://8.8.8.8.:4180"), "reachable");
});

test("gpuFacingOrigin: scheme, host and port only; never a path, a query or a user name", () => {
  assert.equal(gpuFacingOrigin("http://localhost:4000/api/storage/t/secret-token?x=1"), "http://localhost:4000");
  assert.equal(gpuFacingOrigin("https://user:pw@api.example.com/x"), "https://api.example.com");
  assert.equal(gpuFacingOrigin("http://[::1]:4000/"), "http://[::1]:4000");
  assert.equal(gpuFacingOrigin("not an address with a secret"), "the configured address");
});

test("gpuFacingRefusal: a private address is called one, and an address that is not one is not", () => {
  for (const url of ["http://localhost:4000", "http://10.0.0.5", "http://minio:9000", "http://api.internal"]) {
    assert.equal(gpuFacingRefusal(url), "this machine or a private network", url);
  }
  // Another scheme, a user name, or nothing an address at all: not "a private network".
  for (const url of ["ftp://files.example.com", "https://user:pw@api.example.com", "not an address", "http://a..b"]) {
    assert.equal(gpuFacingRefusal(url), "not a plain http or https address", url);
  }
});

test("resolveGpuFacingApiUrl: the new setting wins, falls back, trims, strips trailing slashes", () => {
  assert.equal(
    resolveGpuFacingApiUrl({ GPU_FACING_API_URL: "https://door.example.com", PUBLIC_API_URL: "https://api.example.com" }),
    "https://door.example.com",
  );
  assert.equal(resolveGpuFacingApiUrl({ PUBLIC_API_URL: "https://api.example.com" }), "https://api.example.com");
  assert.equal(
    resolveGpuFacingApiUrl({ GPU_FACING_API_URL: "  https://door.example.com///  ", PUBLIC_API_URL: "https://api.example.com" }),
    "https://door.example.com",
  );
  assert.equal(resolveGpuFacingApiUrl({ PUBLIC_API_URL: " https://api.example.com/ " }), "https://api.example.com");
  // An empty value is an unset one.
  assert.equal(
    resolveGpuFacingApiUrl({ GPU_FACING_API_URL: "   ", PUBLIC_API_URL: "https://api.example.com" }),
    "https://api.example.com",
  );
  assert.equal(resolveGpuFacingApiUrl({}), null);
  assert.equal(resolveGpuFacingApiUrl({ GPU_FACING_API_URL: "", PUBLIC_API_URL: " " }), null);
});

test("nosanaNodesAreLocal: true only for the stand-in, a NOSANA_API_URL on a loopback host", () => {
  const KEY = "nos_0123456789abcdefghij";
  const config = (source: Record<string, string>) =>
    loadNosanaAccessConfig({ NODE_ENV: "development", NOSANA_API_KEY: KEY, ...source });
  assert.equal(nosanaNodesAreLocal(config({ NOSANA_API_URL: "http://127.0.0.1:4010" }), "development"), true);
  assert.equal(nosanaNodesAreLocal(config({ NOSANA_API_URL: "http://localhost:4010/api" }), "development"), true);
  assert.equal(nosanaNodesAreLocal(config({ NOSANA_API_URL: "http://[::1]:4010" }), "development"), true);
  assert.equal(nosanaNodesAreLocal(config({ NOSANA_API_URL: "https://dashboard.example.com" }), "development"), false);
  // Unset: the real Nosana backend.
  assert.equal(nosanaNodesAreLocal(config({}), "development"), false);
  // The in-process mock is not the stand-in.
  assert.equal(nosanaNodesAreLocal(config({ ALLOW_NOSANA_MOCK: "true" }), "development"), false);
  assert.equal(nosanaNodesAreLocal({ apiUrl: "not an address" }, "development"), false);
});

test("nosanaNodesAreLocal: never outside development, whatever NOSANA_API_URL says", () => {
  // parseApiUrl accepts https on any host, a loopback one included.
  const standIn = { apiUrl: "https://localhost:8443" };
  assert.equal(nosanaNodesAreLocal(standIn, "development"), true);
  // Unset means development, as everywhere else in the configuration.
  assert.equal(nosanaNodesAreLocal(standIn, undefined), true);
  for (const nodeEnv of ["production", "staging", "test", ""]) {
    assert.equal(nosanaNodesAreLocal(standIn, nodeEnv), false, nodeEnv);
  }
});

test("storageLinkOrigin: this API for the local driver, a custom S3_ENDPOINT for s3, null otherwise", () => {
  const s3 = (endpoint: string | undefined) =>
    new S3ObjectStore({
      driver: "s3",
      bucket: "datasets",
      region: "auto",
      endpoint,
      forcePathStyle: true,
      accessKeyId: "key",
      secretAccessKey: "secret",
    });
  const local = { kind: "local" } as ObjectStore;
  const apiOrigin = () => "http://localhost:4000";

  assert.equal(storageLinkOrigin(null, apiOrigin), null);
  assert.equal(storageLinkOrigin(local, apiOrigin), "http://localhost:4000");
  assert.equal(storageLinkOrigin(s3("http://minio:9000/some/path"), apiOrigin), "http://minio:9000");
  assert.equal(storageLinkOrigin(s3("https://acct.r2.cloudflarestorage.com"), apiOrigin), "https://acct.r2.cloudflarestorage.com");
  // The provider's own endpoint: configuration does not say where links point.
  assert.equal(storageLinkOrigin(s3(undefined), apiOrigin), null);

  assert.equal(customS3EndpointOrigin(local), null);
  assert.equal(customS3EndpointOrigin(null), null);
  assert.equal(customS3EndpointOrigin(s3("http://localhost:9000")), "http://localhost:9000");
});
