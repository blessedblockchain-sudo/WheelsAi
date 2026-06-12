/**
 * pump.fun launchpad adapter.
 *
 * Conforms the existing pumpportal helpers to the LaunchpadAdapter seam
 * with no behavior change:
 *   - buildPumpfunCreateRequest  (pure body builder)
 *   - preparePumpfunCreate       (POST /api/trade-local + sign mint slot)
 *   - broadcastSignedPumpfunCreate (validate signers + RPC submit)
 *
 * Mint generation moves *into* the adapter (it was previously a route
 * dep) because mint ownership is launchpad-specific: pump.fun has the
 * client generate an ephemeral mint and the server signs its slot, while
 * Bags mints via its own authority. The route shouldn't know either way.
 *
 * The ephemeral mint keypair is discarded after prepare — its signature
 * is already baked into the serialized partial-signed tx.
 */

import { Keypair } from "@solana/web3.js";

import { buildPumpfunCreateRequest } from "../pumpfunTxBuilder.js";
import {
  preparePumpfunCreate,
  broadcastSignedPumpfunCreate,
} from "../preparePumpfunCreate.js";
import { fetchImageBytes } from "../fetchImageBytes.js";
import { uploadPumpfunMetadata } from "../pumpfunIpfs.js";
import type {
  LaunchpadAdapter,
  PrepareLaunchInput,
  PrepareLaunchResult,
  BroadcastLaunchInput,
  BroadcastLaunchResult,
} from "./types.js";

export interface PumpfunAdapterDeps {
  fetchFn: typeof fetch;
  sendRawTransaction: (raw: Uint8Array) => Promise<string>;
  /** Override for tests; defaults to a fresh random mint per launch. */
  generateMintKeypair?: () => Keypair;
}

export function createPumpfunAdapter(
  deps: PumpfunAdapterDeps,
): LaunchpadAdapter {
  const genMint = deps.generateMintKeypair ?? (() => Keypair.generate());

  return {
    id: "pumpfun",

    async prepareLaunch(
      input: PrepareLaunchInput,
    ): Promise<PrepareLaunchResult> {
      const mint = genMint();

      // pump.fun's on-chain create `uri` must point at IPFS *metadata JSON*
      // (name/symbol/description/image), NOT a raw image URL. Resolve it
      // here: fetch the agent icon bytes, then upload image + metadata to
      // IPFS and use the returned metadataUri. The description lives in that
      // JSON (pump.fun's create tx carries no description field).
      if (
        !input.metadata.imageUrl ||
        input.metadata.imageUrl.trim().length === 0
      ) {
        throw new Error(
          "image_required: the agent needs an icon image before it can launch a token",
        );
      }
      const image = await fetchImageBytes(input.metadata.imageUrl, {
        fetchFn: deps.fetchFn,
      });
      const metadataUri = await uploadPumpfunMetadata(
        {
          name: input.metadata.name,
          symbol: input.metadata.symbol,
          // pumpfun's IPFS upload requires a non-empty description; fall
          // back to the token name when the caller left it blank.
          description: input.metadata.description?.trim() || input.metadata.name,
          image,
          twitter: input.metadata.twitter,
          telegram: input.metadata.telegram,
          website: input.metadata.website,
        },
        { fetchFn: deps.fetchFn },
      );

      const body = buildPumpfunCreateRequest({
        creatorPubkey: input.creatorPubkey,
        mintPubkey: mint.publicKey.toBase58(),
        name: input.metadata.name,
        symbol: input.metadata.symbol,
        uri: metadataUri,
        twitter: input.metadata.twitter,
        telegram: input.metadata.telegram,
        website: input.metadata.website,
        initialBuySol: input.initialBuySol,
      });

      const prepared = await preparePumpfunCreate(
        { body, mintKeypair: mint },
        { fetchFn: deps.fetchFn },
      );

      return {
        partialSignedTxBase64: prepared.partialSignedTxBase64,
        mintAddress: prepared.mintAddress,
        creatorPubkey: prepared.creatorPubkey,
        // pump.fun needs nothing extra threaded to submit — the mint and
        // creator already travel in the HMAC prepare token.
        context: {},
      };
    },

    async broadcastLaunch(
      input: BroadcastLaunchInput,
    ): Promise<BroadcastLaunchResult> {
      return broadcastSignedPumpfunCreate(
        {
          signedTxBase64: input.signedTxBase64,
          expectedMintAddress: input.expectedMintAddress,
          expectedCreatorPubkey: input.expectedCreatorPubkey,
        },
        { sendRawTransaction: deps.sendRawTransaction },
      );
    },
  };
}
