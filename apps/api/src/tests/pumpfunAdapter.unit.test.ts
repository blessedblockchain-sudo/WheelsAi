import assert from "node:assert/strict";
import test from "node:test";
import {
  Keypair,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import { createPumpfunAdapter } from "../services/launchpad/pumpfunAdapter.js";

const FIXED_MINT = Keypair.fromSeed(new Uint8Array(32).fill(9));
const CREATOR = "EeYpfM4mEYHRJV6w3WAyKVMv47o6sNFM4nXjN3JoEHbW";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const METADATA_URI = "ipfs://QmFakeMetadataUriForTest";

// A minimal unsigned v0 tx with the mint as the sole required signer, so
// preparePumpfunCreate can deserialize + sign the mint slot.
function unsignedTxBytes(mint: Keypair): Uint8Array {
  const msg = new TransactionMessage({
    payerKey: mint.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [],
  }).compileToV0Message();
  return new VersionedTransaction(msg).serialize();
}

// fetchFn routes by URL: image → png bytes, /api/ipfs → { metadataUri },
// trade-local → captures the request body + returns the unsigned tx.
function makeFetch(capture: { tradeLocalBody?: any; imageHit?: boolean }) {
  return (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes("/api/ipfs")) {
      return new Response(JSON.stringify({ metadataUri: METADATA_URI }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("trade-local")) {
      capture.tradeLocalBody = JSON.parse(init.body);
      return new Response(unsignedTxBytes(FIXED_MINT), { status: 200 });
    }
    capture.imageHit = true;
    return new Response(PNG, {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }) as unknown as typeof fetch;
}

test("prepareLaunch uploads metadata to IPFS and uses the metadataUri as the create uri", async () => {
  const capture: { tradeLocalBody?: any; imageHit?: boolean } = {};
  const adapter = createPumpfunAdapter({
    fetchFn: makeFetch(capture),
    sendRawTransaction: async () => "sig",
    generateMintKeypair: () => FIXED_MINT,
  });

  const result = await adapter.prepareLaunch({
    creatorPubkey: CREATOR,
    metadata: {
      name: "Eliza Token",
      symbol: "ELZ",
      imageUrl: "https://cdn.example.com/icon.png",
      description: "An agent token",
    },
    initialBuySol: 0,
  });

  assert.equal(capture.imageHit, true, "image URL was fetched for bytes");
  assert.equal(
    capture.tradeLocalBody.tokenMetadata.uri,
    METADATA_URI,
    "create body uri is the IPFS metadataUri, not the raw image URL",
  );
  assert.equal(result.mintAddress, FIXED_MINT.publicKey.toBase58());
  assert.equal(result.creatorPubkey, CREATOR);
  assert.deepEqual(result.context, {});
  assert.ok(
    typeof result.partialSignedTxBase64 === "string" &&
      result.partialSignedTxBase64.length > 0,
  );
});

test("prepareLaunch rejects when the agent has no icon (empty imageUrl)", async () => {
  const adapter = createPumpfunAdapter({
    fetchFn: makeFetch({}),
    sendRawTransaction: async () => "sig",
    generateMintKeypair: () => FIXED_MINT,
  });

  await assert.rejects(
    adapter.prepareLaunch({
      creatorPubkey: CREATOR,
      metadata: {
        name: "Eliza Token",
        symbol: "ELZ",
        imageUrl: "",
        description: "An agent token",
      },
    }),
    /image_required/,
  );
});
