/**
 * Meteora launchpad adapter: an agent's token on Meteora's Dynamic Bonding
 * Curve, on a curve config WheelsAI builds for that token from a named
 * preset (launchpad/meteoraPresets.ts). Devnet and mainnet.
 *
 * Nobody on our side holds a wallet. The server builds the transaction, the
 * browser wallet signs it, and the server sends it only after checking that
 * what came back is the transaction it built.
 *
 * Flow:
 *   prepareLaunch
 *     1. Refuse what cannot be launched: a preset that is not offered here,
 *        a first buy (it is made on the token's page after launch), a token
 *        with no picture, a name or symbol longer than the chain holds.
 *     2. Make two fresh keypairs: the curve config's and the mint's. Both
 *        must sign the launch, and both are thrown away when this call
 *        returns: their signatures are already in the transaction.
 *     3. Upload the picture and the metadata, and take the metadata's URI.
 *     4. Build ONE transaction that creates the config and the pool
 *        (client.partner.createConfigAndPool). The payer and the pool's
 *        creator are the creator's wallet; the fee claimer and the leftover
 *        receiver are the platform's configured addresses.
 *     5. Compile it to a v0 transaction with the creator as fee payer, sign
 *        with the two fresh keypairs, leave the creator's slot empty.
 *     → context: { configKey, poolAddress, preset, curveSupply,
 *                  reservedSupply, messageHash, lastValidBlockHeight }
 *   broadcastLaunch
 *     The signed transaction must carry the same message, byte for byte
 *     (its sha256 is compared with context.messageHash), name the expected
 *     mint and creator, and have every signature slot filled. Then it is
 *     sent and confirmed. Anything else is refused before it is sent.
 *
 * The launch carries no compute-budget instruction: one would cost 52
 * bytes the launch does not have. It does not need one for a wallet's sake
 * either. A wallet adds its own fee instructions only to a transaction
 * nobody has signed yet, and this one reaches the wallet already signed by
 * the config and the mint, so the wallet must leave it as it is. That is
 * why the check at broadcast can stay strict.
 *
 * What the creator can fix is refused with a LaunchRefusal (a code and a
 * plain sentence, launchpad/launchRefusal.ts), which the route answers as a
 * 400. A sent launch whose confirmation was not seen is a
 * LaunchNotConfirmed that carries the signature.
 *
 * Every chain and network call sits behind MeteoraAdapterDeps, so the tests
 * run with no network (tests/meteoraAdapter.unit.test.ts).
 */

import { createHash } from "node:crypto";

import {
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Transaction,
} from "@solana/web3.js";
import {
  deriveDbcPoolAddress,
  type CreateConfigAndPoolParams,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

import { fetchImageBytes } from "../fetchImageBytes.js";
import { uploadPumpfunMetadata } from "../pumpfunIpfs.js";
import { LaunchNotConfirmed, LaunchRefusal } from "./launchRefusal.js";
import {
  DEFAULT_PRESET_ID,
  METEORA_QUOTE_MINT,
  buildPresetCurve,
  isPresetOffered,
  presetSupplySplit,
  type SolanaNetwork,
} from "./meteoraPresets.js";
import type {
  LaunchpadAdapter,
  LaunchTokenMetadata,
  PrepareLaunchInput,
  PrepareLaunchResult,
  BroadcastLaunchInput,
  BroadcastLaunchResult,
} from "./types.js";

/** The most bytes a Solana transaction may be on the wire. */
export const MAX_TRANSACTION_BYTES = 1232;

/**
 * The token's name and symbol are written into its on-chain metadata, which
 * holds 32 and 10 BYTES of them. The launch route counts characters, and a
 * letter with an accent or an emoji is more than one byte.
 */
export const MAX_TOKEN_NAME_BYTES = 32;
export const MAX_TOKEN_SYMBOL_BYTES = 10;

/** The one SDK call the launch needs. The real client satisfies it as is. */
export interface MeteoraLaunchClient {
  partner: {
    createConfigAndPool(params: CreateConfigAndPoolParams): Promise<Transaction>;
  };
}

export interface MeteoraBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface MeteoraAdapterDeps {
  client: MeteoraLaunchClient;
  /** Decides which presets are offered (the rehearsal one is devnet only). */
  network: SolanaNetwork;
  /** The platform's fee wallet, named in every curve config. An address only. */
  feeClaimer: PublicKey;
  /** Where a curve's unsold tokens go after graduation. */
  leftoverReceiver: PublicKey;
  /** Uploads the picture and the metadata; returns the metadata's URI. */
  uploadMetadata: (metadata: LaunchTokenMetadata) => Promise<string>;
  getLatestBlockhash: () => Promise<MeteoraBlockhash>;
  sendRawTransaction: (raw: Uint8Array) => Promise<string>;
  /** Resolves once the transaction is confirmed; throws when it failed or expired. */
  confirmTransaction: (signature: string, sentWith: MeteoraBlockhash) => Promise<void>;
  /** Override for tests; defaults to a fresh random keypair each time. */
  generateKeypair?: () => Keypair;
}

/**
 * The production metadata upload. A token's metadata has to live somewhere
 * public for good; pump.fun's upload gives an IPFS address for a picture
 * and its JSON, and the pump.fun adapter already uses it, so it is reused
 * here the same way: fetch the picture's bytes, then upload both.
 */
export function createMeteoraMetadataUploader(
  fetchFn: typeof fetch,
): (metadata: LaunchTokenMetadata) => Promise<string> {
  return async (metadata) => {
    const image = await fetchImageBytes(metadata.imageUrl, { fetchFn });
    return uploadPumpfunMetadata(
      {
        name: metadata.name,
        symbol: metadata.symbol,
        // The upload refuses an empty description; fall back to the name.
        description: metadata.description?.trim() || metadata.name,
        image,
        twitter: metadata.twitter,
        telegram: metadata.telegram,
        website: metadata.website,
      },
      { fetchFn },
    );
  };
}

/** sha256, in hex, of a compiled message's bytes. */
function messageHashOf(tx: VersionedTransaction): string {
  return createHash("sha256").update(tx.message.serialize()).digest("hex");
}

function isEmptySignature(signature: Uint8Array | undefined): boolean {
  return !signature || signature.every((byte) => byte === 0);
}

export function createMeteoraAdapter(deps: MeteoraAdapterDeps): LaunchpadAdapter {
  const generateKeypair = deps.generateKeypair ?? (() => Keypair.generate());
  const quoteMint = new PublicKey(METEORA_QUOTE_MINT);

  return {
    id: "meteora",

    async prepareLaunch(input: PrepareLaunchInput): Promise<PrepareLaunchResult> {
      const preset = input.preset?.trim() || DEFAULT_PRESET_ID;
      if (!isPresetOffered(preset, deps.network)) {
        throw new LaunchRefusal(
          "invalid_preset",
          `"${preset}" is not a curve that can be chosen here.`,
        );
      }
      if (input.initialBuySol !== undefined && input.initialBuySol > 0) {
        throw new LaunchRefusal(
          "first_buy_not_supported",
          "The first buy is made on the token's page after the launch, not in the launch itself.",
        );
      }
      if (!input.metadata.imageUrl || input.metadata.imageUrl.trim().length === 0) {
        throw new LaunchRefusal(
          "picture_required",
          "The agent needs a picture before it can launch a token.",
        );
      }
      // Refused here, before the creator is asked to sign a launch the
      // chain would then turn down.
      const nameBytes = Buffer.byteLength(input.metadata.name, "utf8");
      if (nameBytes > MAX_TOKEN_NAME_BYTES) {
        throw new LaunchRefusal(
          "name_too_long",
          `The token's name is ${nameBytes} bytes and the chain holds ${MAX_TOKEN_NAME_BYTES}. Accented letters and emoji count for more than one.`,
        );
      }
      const symbolBytes = Buffer.byteLength(input.metadata.symbol, "utf8");
      if (symbolBytes > MAX_TOKEN_SYMBOL_BYTES) {
        throw new LaunchRefusal(
          "symbol_too_long",
          `The token's symbol is ${symbolBytes} bytes and the chain holds ${MAX_TOKEN_SYMBOL_BYTES}. Accented letters and emoji count for more than one.`,
        );
      }
      let creator: PublicKey;
      try {
        creator = new PublicKey(input.creatorPubkey);
      } catch (err) {
        throw new Error(
          `invalid_creator: the creator's wallet address cannot be read (${(err as Error).message})`,
        );
      }

      const config = generateKeypair();
      const mint = generateKeypair();

      // A link the fetch refuses is the creator's to fix and passes through
      // as it is. Anything else that stops the upload is not their doing:
      // it gets its own code so the screen can say "try again".
      let metadataUri: string;
      try {
        metadataUri = await deps.uploadMetadata(input.metadata);
      } catch (err) {
        if (err instanceof LaunchRefusal) throw err;
        throw new LaunchRefusal(
          "picture_upload_failed",
          `The token's picture could not be uploaded (${(err as Error).message ?? "unknown"}).`,
          { cause: err },
        );
      }

      const built = await deps.client.partner.createConfigAndPool({
        ...buildPresetCurve(preset),
        config: config.publicKey,
        feeClaimer: deps.feeClaimer,
        leftoverReceiver: deps.leftoverReceiver,
        quoteMint,
        payer: creator,
        preCreatePoolParam: {
          name: input.metadata.name,
          symbol: input.metadata.symbol,
          uri: metadataUri,
          poolCreator: creator,
          baseMint: mint.publicKey,
        },
      });

      const latest = await deps.getLatestBlockhash();
      const message = new TransactionMessage({
        payerKey: creator,
        recentBlockhash: latest.blockhash,
        instructions: built.instructions,
      }).compileToV0Message();

      // Refused here, with a sentence, rather than at the wallet with none.
      // The size is counted by hand (one byte for the number of signatures,
      // 64 for each, then the message) because the library's own encoder
      // throws on anything too long instead of saying how long it is. Every
      // signature slot counts, the creator's empty one too, so this is the
      // size the signed transaction will have.
      //
      // The name and the symbol were held to the chain's limits above, and a
      // launch with both at their longest fits. What is left to vary in
      // length is the link to the uploaded metadata, so that is what the
      // refusal names.
      let size: number;
      try {
        size =
          1 +
          64 * message.header.numRequiredSignatures +
          message.serialize().length;
      } catch (err) {
        throw new LaunchRefusal(
          "metadata_link_too_long",
          `The launch does not fit in one transaction of ${MAX_TRANSACTION_BYTES} bytes. It is the link to the token's uploaded metadata that is too long, not the name or the symbol.`,
          { cause: err },
        );
      }
      if (size > MAX_TRANSACTION_BYTES) {
        throw new LaunchRefusal(
          "metadata_link_too_long",
          `The launch is ${size} bytes and one transaction holds ${MAX_TRANSACTION_BYTES}. It is the link to the token's uploaded metadata that is too long, not the name or the symbol.`,
        );
      }
      const tx = new VersionedTransaction(message);

      tx.sign([config, mint]);

      // The server-held slots must be the only ones signed, and the only
      // one left empty must be the creator's, the fee payer at index 0.
      const empty = tx.signatures
        .map((signature, index) => (isEmptySignature(signature) ? index : -1))
        .filter((index) => index >= 0);
      if (empty.length !== 1 || empty[0] !== 0) {
        throw new Error(
          "unexpected_signers: the launch transaction asks for signatures other than the creator's, the config's and the mint's",
        );
      }

      // What is saved with the token: how many whole tokens this curve
      // sells before it is full, and the rest of the supply. Strings,
      // because the context travels as JSON inside the prepare token.
      const split = presetSupplySplit(preset);

      return {
        partialSignedTxBase64: Buffer.from(tx.serialize()).toString("base64"),
        mintAddress: mint.publicKey.toBase58(),
        creatorPubkey: creator.toBase58(),
        context: {
          configKey: config.publicKey.toBase58(),
          poolAddress: deriveDbcPoolAddress(
            quoteMint,
            mint.publicKey,
            config.publicKey,
          ).toBase58(),
          preset,
          curveSupply: split.curveSupply.toString(),
          reservedSupply: split.reservedSupply.toString(),
          messageHash: messageHashOf(tx),
          // Not a secret and not a decision: it lets the confirmation stop
          // waiting once the blockhash the transaction was built on is dead.
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
      };
    },

    async broadcastLaunch(input: BroadcastLaunchInput): Promise<BroadcastLaunchResult> {
      const raw = new Uint8Array(Buffer.from(input.signedTxBase64, "base64"));
      if (raw.length === 0) {
        throw new Error("meteora broadcast: the signed transaction is empty");
      }
      if (raw.length > MAX_TRANSACTION_BYTES) {
        throw new Error(
          `meteora broadcast: the signed transaction is ${raw.length} bytes and one transaction holds ${MAX_TRANSACTION_BYTES}`,
        );
      }

      let tx: VersionedTransaction;
      try {
        tx = VersionedTransaction.deserialize(raw);
      } catch (err) {
        throw new Error(
          `meteora broadcast: the signed transaction cannot be read (${(err as Error).message})`,
        );
      }

      // What is sent is the bytes the client gave. They must be this
      // transaction and nothing more: the reader above stops at the end of
      // the message and would let extra bytes after it through.
      if (!Buffer.from(tx.serialize()).equals(Buffer.from(raw))) {
        throw new Error(
          "meteora broadcast: the signed transaction has bytes that are not part of it",
        );
      }

      // 1. The same message. The message holds every account, every
      //    instruction and the blockhash, so an equal hash means the only
      //    thing a client could have changed is the signatures.
      const expectedHash = input.context.messageHash;
      const lastValidBlockHeight = input.context.lastValidBlockHeight;
      if (
        typeof expectedHash !== "string" ||
        expectedHash.length === 0 ||
        typeof lastValidBlockHeight !== "number"
      ) {
        throw new Error(
          "meteora broadcast: this launch was not prepared by the meteora launchpad",
        );
      }
      if (messageHashOf(tx) !== expectedHash) {
        throw new Error(
          "meteora broadcast: the signed transaction is not the one that was prepared",
        );
      }

      // 2. The expected mint and creator. They follow from the hash; they
      //    are checked on their own so a prepare token that names another
      //    mint or wallet than its transaction is refused too.
      let expectedMint: string;
      let expectedCreator: string;
      try {
        expectedMint = new PublicKey(input.expectedMintAddress).toBase58();
        expectedCreator = new PublicKey(input.expectedCreatorPubkey).toBase58();
      } catch (err) {
        throw new Error(
          `meteora broadcast: an expected address cannot be read (${(err as Error).message})`,
        );
      }
      const staticKeys = tx.message.staticAccountKeys.map((key) => key.toBase58());
      const required = tx.message.header.numRequiredSignatures;
      const mintIndex = staticKeys.indexOf(expectedMint);
      if (mintIndex < 0 || mintIndex >= required) {
        throw new Error(
          "meteora broadcast: the signed transaction does not create the expected mint",
        );
      }
      if (staticKeys[0] !== expectedCreator) {
        throw new Error(
          "meteora broadcast: the signed transaction is not paid for by the expected creator",
        );
      }

      // 3. Every signature slot filled.
      if (tx.signatures.length !== required) {
        throw new Error(
          "meteora broadcast: the signed transaction has the wrong number of signatures",
        );
      }
      if (tx.signatures.some((signature) => isEmptySignature(signature))) {
        throw new Error(
          "meteora broadcast: the transaction is not signed by everyone who must sign it",
        );
      }

      let txSignature: string;
      try {
        txSignature = await deps.sendRawTransaction(raw);
      } catch (err) {
        throw new Error(`rpc_submit: ${(err as Error).message ?? "unknown"}`, {
          cause: err as Error,
        });
      }

      try {
        await deps.confirmTransaction(txSignature, {
          blockhash: tx.message.recentBlockhash,
          lastValidBlockHeight,
        });
      } catch (err) {
        // The signature is carried, and named, so a launch that did land
        // after all can still be found and saved (POST /launch/reconcile).
        throw new LaunchNotConfirmed(
          txSignature,
          `not_confirmed: the launch was sent as ${txSignature} and was not confirmed (${(err as Error).message ?? "unknown"})`,
          { cause: err as Error },
        );
      }

      return { mintAddress: expectedMint, txSignature };
    },
  };
}
