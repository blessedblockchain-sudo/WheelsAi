/**
 * Bags launchpad adapter (Option B: platform-signed config, single
 * browser signature).
 *
 * MAINNET-ONLY: the Bags Fee Share V1/V2 programs + the Bags global LUT are
 * not on devnet (only Meteora DBC/DAMM are). See memory/bags-ecosystem-eval
 * and scripts/bags-spike.ts.
 *
 * SPIKE-GATED: BAGS_ADAPTER_IMPLEMENTED stays `false` until the mainnet
 * spike answers Q1 (does the launch tx require the mint to sign?) and Q2
 * (does Bags accept a config payer ≠ launchWallet?). The boot guard in
 * src/index.ts refuses LAUNCHPAD=bags while the flag is false, so this code
 * cannot run in production until validated. If Q1/Q2 fail, switch to Option
 * A (return an array of txs + signAllTransactions in the wizard).
 *
 * Flow (Option B):
 *   prepareLaunch
 *     1. createTokenInfoAndMetadata({ imageUrl, name, symbol, description })
 *        → { tokenMint, tokenMetadata }. Bags uploads image+metadata itself,
 *        so (unlike pump.fun) there's no manual IPFS step.
 *     2. createBagsFeeShareConfig({ feeClaimers: [{ user: <platform fee
 *        wallet>, userBps: 10_000 }], payer: <platform configPayer>,
 *        baseMint }) → { transactions, bundles, meteoraConfigKey }.
 *     3. Sign + send + confirm the config tx(s) SERVER-SIDE with configPayer
 *        (the browser never sees them).
 *     4. createLaunchTransaction({ metadataUrl, tokenMint, launchWallet:
 *        <user wallet>, initialBuyLamports, configKey }) → one tx for the
 *        browser to sign.
 *     → { partialSignedTxBase64, mintAddress, creatorPubkey,
 *         context: { configKey, metadataUrl, feeClaimer } }
 *   broadcastLaunch: validate the signed tx references the expected
 *     mint+creator and the creator slot is signed, then submit.
 *
 * The fee wallet (feeClaimerPubkey) must be platform-controlled so the Bags
 * fee-claim sweep can claim into the agent-treasury PDA (see the sweep
 * worker). It defaults to the fee-router wallet; never TREASURY_WALLET_ADDRESS.
 */

import {
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { BagsSDK } from "@bagsfm/bags-sdk";

import type {
  LaunchpadAdapter,
  PrepareLaunchInput,
  PrepareLaunchResult,
  BroadcastLaunchInput,
  BroadcastLaunchResult,
} from "./types.js";

/**
 * Whether the Bags adapter is wired + validated against chain. Flipped to
 * `true` as the final step of finishing the adapter (after the mainnet spike
 * validates Q1/Q2). The boot guard in src/index.ts reads this to fail-fast
 * when LAUNCHPAD=bags is selected before the adapter is real, so a
 * misconfigured deploy dies on boot rather than at a user's first launch.
 */
export const BAGS_ADAPTER_IMPLEMENTED = false;

const LAMPORTS_PER_SOL = 1_000_000_000;
const FEE_CLAIMER_BPS = 10_000; // 100% to the platform fee wallet

export interface BagsAdapterDeps {
  sdk: BagsSDK;
  /** Platform-held wallet that pays + signs the fee-share config tx(s). */
  configPayer: Keypair;
  /** Platform-controlled fee claimer (the sweep claims from this wallet). */
  feeClaimerPubkey: PublicKey;
  /** Floor for the creator initial buy in lamports (so launches generate
   *  claimable fees even when the creator buys 0). Default 0. */
  initialBuyLamportsFloor?: number;
  sendRawTransaction: (raw: Uint8Array) => Promise<string>;
  /** Confirm a server-sent config tx before building the launch tx. */
  confirmTransaction: (signature: string) => Promise<void>;
}

function lamportsFromSol(sol: number | undefined): number {
  if (!sol || sol <= 0) return 0;
  return Math.round(sol * LAMPORTS_PER_SOL);
}

export function createBagsAdapter(deps: BagsAdapterDeps): LaunchpadAdapter {
  return {
    id: "bags",

    async prepareLaunch(
      input: PrepareLaunchInput,
    ): Promise<PrepareLaunchResult> {
      // 1) token info + metadata (Bags uploads internally from imageUrl).
      const info = await deps.sdk.tokenLaunch.createTokenInfoAndMetadata({
        name: input.metadata.name,
        symbol: input.metadata.symbol,
        description:
          input.metadata.description?.trim() || input.metadata.name,
        imageUrl: input.metadata.imageUrl,
        twitter: input.metadata.twitter,
        telegram: input.metadata.telegram,
        website: input.metadata.website,
      });
      const tokenMint = new PublicKey(info.tokenMint);

      // 2) fee-share config: 100% to the platform fee wallet.
      const cfg = await deps.sdk.config.createBagsFeeShareConfig({
        feeClaimers: [
          { user: deps.feeClaimerPubkey, userBps: FEE_CLAIMER_BPS },
        ],
        payer: deps.configPayer.publicKey,
        baseMint: tokenMint,
      });

      // 3) sign + send + confirm the config tx(s) server-side. A single
      //    100%-claimer config returns RPC-sendable `transactions`; if it
      //    ever returns Jito-only `bundles` (spike Q3), surface that loudly
      //    rather than silently dropping fee routing.
      if (cfg.transactions.length === 0 && cfg.bundles.length > 0) {
        throw new Error(
          "bags config returned Jito bundles but no transactions; the " +
            "sendBundle path is not wired (see scripts/bags-spike.ts Q3).",
        );
      }
      for (const tx of cfg.transactions) {
        tx.sign([deps.configPayer]);
        const sig = await deps.sendRawTransaction(tx.serialize());
        await deps.confirmTransaction(sig);
      }

      // 4) launch tx — creator slot (launchWallet) left for the browser.
      const initialBuyLamports = Math.max(
        deps.initialBuyLamportsFloor ?? 0,
        lamportsFromSol(input.initialBuySol),
      );
      const launchTx = await deps.sdk.tokenLaunch.createLaunchTransaction({
        metadataUrl: info.tokenMetadata,
        tokenMint,
        launchWallet: new PublicKey(input.creatorPubkey),
        initialBuyLamports,
        configKey: cfg.meteoraConfigKey,
      });

      return {
        partialSignedTxBase64: Buffer.from(launchTx.serialize()).toString(
          "base64",
        ),
        mintAddress: info.tokenMint,
        creatorPubkey: input.creatorPubkey,
        context: {
          configKey: cfg.meteoraConfigKey.toBase58(),
          metadataUrl: info.tokenMetadata,
          feeClaimer: deps.feeClaimerPubkey.toBase58(),
        },
      };
    },

    async broadcastLaunch(
      input: BroadcastLaunchInput,
    ): Promise<BroadcastLaunchResult> {
      let raw: Uint8Array;
      try {
        raw = new Uint8Array(Buffer.from(input.signedTxBase64, "base64"));
      } catch (err) {
        throw new Error(
          `bags broadcast: signedTxBase64 not valid base64 (${(err as Error).message})`,
        );
      }
      if (raw.length === 0) {
        throw new Error("bags broadcast: signed tx is empty");
      }

      let tx: VersionedTransaction;
      try {
        tx = VersionedTransaction.deserialize(raw);
      } catch (err) {
        throw new Error(
          `bags broadcast: failed to deserialize signed tx (${(err as Error).message})`,
        );
      }

      // Tampering checks: the signed tx must reference the mint + creator we
      // prepared, and the creator's signer slot must be populated.
      const staticKeys = tx.message.staticAccountKeys.map((k) => k.toBase58());
      let expectedMint: string;
      let expectedCreator: string;
      try {
        expectedMint = new PublicKey(input.expectedMintAddress).toBase58();
        expectedCreator = new PublicKey(
          input.expectedCreatorPubkey,
        ).toBase58();
      } catch (err) {
        throw new Error(
          `bags broadcast: invalid expected pubkey (${(err as Error).message})`,
        );
      }
      if (!staticKeys.includes(expectedMint)) {
        throw new Error(
          "bags broadcast: signed tx does not reference expected mint",
        );
      }
      const creatorIdx = staticKeys.indexOf(expectedCreator);
      if (creatorIdx < 0) {
        throw new Error(
          "bags broadcast: signed tx does not reference expected creator",
        );
      }
      const sigCount = tx.message.header.numRequiredSignatures;
      if (creatorIdx < sigCount) {
        const sig = tx.signatures[creatorIdx];
        if (!sig || sig.every((b) => b === 0)) {
          throw new Error(
            "bags broadcast: creator signer slot is unsigned",
          );
        }
      }

      let txSignature: string;
      try {
        txSignature = await deps.sendRawTransaction(tx.serialize());
      } catch (err) {
        throw new Error(`rpc_submit: ${(err as Error).message ?? "unknown"}`, {
          cause: err as Error,
        });
      }

      return { mintAddress: input.expectedMintAddress, txSignature };
    },
  };
}
