import assert from "node:assert/strict";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/pumpfunIpfs.ts — two pieces:
//
//   buildPumpfunIpfsFields({name, symbol, description, image{bytes,mime,filename}, twitter?, telegram?, website?})
//     → pure: structured IpfsUploadFields { textFields, image } the
//     orchestrator hands to multipart FormData.
//
//   uploadPumpfunMetadata(input, { fetchFn })
//     → orchestrator: POSTs multipart to pumpportal /api/ipfs, returns
//     metadataUri.
//
// Both rejected-input cases must throw BEFORE constructing FormData so a
// caller bug surfaces locally, not as a confusing pumpportal 400.

const tinyPng = Uint8Array.from([
  // Minimal valid PNG header — first 8 bytes are the PNG signature.
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const happyInput = () => ({
  name: "Eliza Bot",
  symbol: "ELIZA",
  description: "Eliza is a chatty agent.",
  image: { bytes: tinyPng, mime: "image/png", filename: "eliza.png" },
});

// ============================================
// buildPumpfunIpfsFields — happy paths
// ============================================

test("buildPumpfunIpfsFields returns the required text fields + image binary", async () => {
  setupEnv();
  const { buildPumpfunIpfsFields } = await import("../services/pumpfunIpfs.js");
  const fields = buildPumpfunIpfsFields(happyInput());
  assert.equal(fields.textFields.name, "Eliza Bot");
  assert.equal(fields.textFields.symbol, "ELIZA");
  assert.equal(fields.textFields.description, "Eliza is a chatty agent.");
  // pumpfun convention — display the agent name on the coin.
  assert.equal(fields.textFields.showName, "true");
  // Image survives byte-for-byte.
  assert.equal(fields.image.mime, "image/png");
  assert.equal(fields.image.filename, "eliza.png");
  assert.deepEqual(Array.from(fields.image.bytes), Array.from(tinyPng));
});

test("buildPumpfunIpfsFields forwards optional socials to text fields", async () => {
  const { buildPumpfunIpfsFields } = await import("../services/pumpfunIpfs.js");
  const fields = buildPumpfunIpfsFields({
    ...happyInput(),
    twitter: "https://x.com/eliza",
    telegram: "https://t.me/eliza",
    website: "https://eliza.dev",
  });
  assert.equal(fields.textFields.twitter, "https://x.com/eliza");
  assert.equal(fields.textFields.telegram, "https://t.me/eliza");
  assert.equal(fields.textFields.website, "https://eliza.dev");
});

test("buildPumpfunIpfsFields omits optional socials when not supplied (no empty strings)", async () => {
  const { buildPumpfunIpfsFields } = await import("../services/pumpfunIpfs.js");
  const fields = buildPumpfunIpfsFields(happyInput());
  assert.ok(!("twitter" in fields.textFields));
  assert.ok(!("telegram" in fields.textFields));
  assert.ok(!("website" in fields.textFields));
});

// ============================================
// Validation
// ============================================

test("buildPumpfunIpfsFields rejects empty name", async () => {
  const { buildPumpfunIpfsFields } = await import("../services/pumpfunIpfs.js");
  assert.throws(
    () => buildPumpfunIpfsFields({ ...happyInput(), name: "" }),
    /name/i,
  );
});

test("buildPumpfunIpfsFields rejects empty symbol", async () => {
  const { buildPumpfunIpfsFields } = await import("../services/pumpfunIpfs.js");
  assert.throws(
    () => buildPumpfunIpfsFields({ ...happyInput(), symbol: "" }),
    /symbol/i,
  );
});

test("buildPumpfunIpfsFields rejects empty description", async () => {
  const { buildPumpfunIpfsFields } = await import("../services/pumpfunIpfs.js");
  assert.throws(
    () => buildPumpfunIpfsFields({ ...happyInput(), description: "" }),
    /description/i,
  );
});

test("buildPumpfunIpfsFields rejects missing image bytes (pumpfun requires an image)", async () => {
  const { buildPumpfunIpfsFields } = await import("../services/pumpfunIpfs.js");
  assert.throws(
    () =>
      buildPumpfunIpfsFields({
        ...happyInput(),
        image: { bytes: new Uint8Array(0), mime: "image/png", filename: "x.png" },
      }),
    /image/i,
  );
});

test("buildPumpfunIpfsFields rejects unsupported MIME types", async () => {
  const { buildPumpfunIpfsFields } = await import("../services/pumpfunIpfs.js");
  assert.throws(
    () =>
      buildPumpfunIpfsFields({
        ...happyInput(),
        image: { bytes: tinyPng, mime: "application/pdf", filename: "x.pdf" },
      }),
    /mime|image\/png/i,
  );
});

test("buildPumpfunIpfsFields accepts image/jpeg and image/gif alongside image/png", async () => {
  const { buildPumpfunIpfsFields } = await import("../services/pumpfunIpfs.js");
  for (const mime of ["image/jpeg", "image/gif", "image/webp"]) {
    const fields = buildPumpfunIpfsFields({
      ...happyInput(),
      image: { bytes: tinyPng, mime, filename: `x.${mime.split("/")[1]}` },
    });
    assert.equal(fields.image.mime, mime, `should accept ${mime}`);
  }
});

// ============================================
// uploadPumpfunMetadata — orchestrator
// ============================================

function fakeFetchOk(metadataUri: string) {
  const calls: Array<{ url: string; init: any }> = [];
  const fetchFn: typeof fetch = async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ metadataUri, metadata: {} });
      },
      async json() {
        return { metadataUri, metadata: {} };
      },
    } as any;
  };
  return { calls, fetchFn };
}

test("uploadPumpfunMetadata POSTs to pumpportal /api/ipfs and returns metadataUri", async () => {
  setupEnv();
  const { uploadPumpfunMetadata } = await import(
    "../services/pumpfunIpfs.js"
  );
  const { calls, fetchFn } = fakeFetchOk("ipfs://QmReturnedFromIpfs");

  const uri = await uploadPumpfunMetadata(happyInput(), { fetchFn });
  assert.equal(uri, "ipfs://QmReturnedFromIpfs");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://pump.fun/api/ipfs");
  assert.equal(calls[0]!.init.method, "POST");
  // FormData body — content-type starts with multipart/form-data
  // (can't easily assert further without parsing the multipart stream)
  assert.ok(calls[0]!.init.body instanceof FormData);
});

test("uploadPumpfunMetadata throws labeled error on non-2xx response", async () => {
  const { uploadPumpfunMetadata } = await import(
    "../services/pumpfunIpfs.js"
  );
  const fetchFn: typeof fetch = async () =>
    ({
      ok: false,
      status: 503,
      async text() {
        return "ipfs node down";
      },
    } as any);

  await assert.rejects(
    () => uploadPumpfunMetadata(happyInput(), { fetchFn }),
    /pumpfun_ipfs.*503/,
  );
});

test("uploadPumpfunMetadata throws when response is missing metadataUri", async () => {
  const { uploadPumpfunMetadata } = await import(
    "../services/pumpfunIpfs.js"
  );
  const fetchFn: typeof fetch = async () =>
    ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ metadata: { name: "x" } });
      },
      async json() {
        return { metadata: { name: "x" } };
      },
    } as any);

  await assert.rejects(
    () => uploadPumpfunMetadata(happyInput(), { fetchFn }),
    /metadataUri/,
  );
});
