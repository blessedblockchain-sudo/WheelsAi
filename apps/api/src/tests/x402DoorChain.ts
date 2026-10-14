// A Solana chain for the x402 door's tests, reading the bytes a real x402
// client makes (tests/x402DoorStandIns.ts). Shared; not a test file. Nothing
// here opens a socket.
//
// What a lenient stand-in would hide, this one does not:
//   - an account it was not told about does not exist (the treasury's USDC
//     account, an unfunded fee payer);
//   - a simulation records its config, accepts only a VersionedTransaction
//     (a legacy object would be recompiled on a fresh blockhash), and
//     RETURNS its failure in value.err as a node does, never throwing it;
//   - a send deserializes the bytes and requires every signature to verify,
//     so a payment the fee payer did not sign, or signed over a recompiled
//     message, never reaches it;
//   - a blockhash lives 150 blocks; a transaction that never lands is dead
//     once the height passes its last valid block, by the rules of
//     services/signatureFate.ts, which answers the fate.

import {
  ACCOUNT_SIZE,
  AccountLayout,
  TOKEN_PROGRAM_ID,
  decodeTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, VersionedTransaction, type AccountInfo } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

import { signatureFate, type SignatureFateAnswer, type SignatureFateInput } from "../services/signatureFate.js";
import { instructionsOf } from "../services/x402Decode.js";

/** The life of a blockhash, in blocks. */
export const DOOR_BLOCKHASH_LIFE = 150n;
/** What a signature costs, in lamports. */
const LAMPORTS_PER_SIGNATURE = 5_000n;
const TOKEN_ACCOUNT_RENT = 2_039_280;

/** What a send does. */
export type DoorSendMode =
  /** The node takes it. */
  | "accepted"
  /** The node refuses it at preflight: it never reaches the chain. */
  | "refused"
  /** The call throws, and the transaction reached the chain all the same. */
  | "throws_but_reached"
  /** The node has it already ("This transaction has already been processed"). */
  | "duplicate";

/** What becomes of a transaction that reached the chain. */
export type DoorFateMode = "landed_ok" | "landed_failed" | "never";

interface DoorTransfer {
  signature: string;
  bytesB64: string;
  blockhash: string;
  landed: "ok" | "failed" | null;
  finalized: boolean;
}

function tokenAccountData(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}

function tokenAmount(info: AccountInfo<Buffer>): bigint {
  return AccountLayout.decode(info.data).amount;
}

function signaturesVerify(tx: VersionedTransaction): boolean {
  const message = tx.message.serialize();
  const keys = tx.message.staticAccountKeys;
  return tx.signatures.every((signature, i) => {
    const key = keys[i];
    return key !== undefined && nacl.sign.detached.verify(message, signature, key.toBytes());
  });
}

/** The chain. */
export function doorChain(input: { mint: PublicKey }) {
  const chain = {
    height: 1_000n,
    send: "accepted" as DoorSendMode,
    fate: "landed_ok" as DoorFateMode,
    /** Every read throws while true. */
    readsFail: false,
    /** Every simulation's config, in order. */
    simulations: [] as Array<{ config: unknown }>,
    /** Every isBlockhashValid's config, in order. */
    blockhashChecks: [] as Array<{ blockhash: string; config: unknown }>,
    /** Every call to sendRawTransaction, in order. */
    sends: [] as Array<{ signature: string; bytesB64: string }>,
    blockhashesIssued: 0,
  };
  const lastValidOf = new Map<string, bigint>();
  const accounts = new Map<string, AccountInfo<Buffer>>();
  const transfers = new Map<string, DoorTransfer>();

  const live = (blockhash: string) => {
    const lastValid = lastValidOf.get(blockhash);
    return lastValid !== undefined && chain.height <= lastValid;
  };
  const failIfAsked = (what: string) => {
    if (chain.readsFail) throw new Error(`stand-in: ${what} failed`);
  };

  /** The TransferChecked of a payment, resolved from its own accounts. */
  function transferOf(tx: VersionedTransaction) {
    for (const ix of instructionsOf(tx.message)) {
      if (!ix.programId.equals(TOKEN_PROGRAM_ID)) continue;
      try {
        return decodeTransferCheckedInstruction(ix, TOKEN_PROGRAM_ID);
      } catch {
        return null;
      }
    }
    return null;
  }

  /** The chain includes a transfer it was handed: the money moves, and the fee is paid. */
  function include(transfer: DoorTransfer, how: "ok" | "failed") {
    transfer.landed = how;
    const tx = VersionedTransaction.deserialize(Buffer.from(transfer.bytesB64, "base64"));
    const feePayer = tx.message.staticAccountKeys[0];
    const payerInfo = feePayer ? accounts.get(feePayer.toBase58()) : undefined;
    if (feePayer && payerInfo) {
      const fee = LAMPORTS_PER_SIGNATURE * BigInt(tx.signatures.length);
      accounts.set(feePayer.toBase58(), { ...payerInfo, lamports: payerInfo.lamports - Number(fee) });
    }
    if (how !== "ok") return;
    const moved = transferOf(tx);
    if (!moved) return;
    const source = accounts.get(moved.keys.source.pubkey.toBase58());
    const destination = accounts.get(moved.keys.destination.pubkey.toBase58());
    if (!source || !destination) return;
    const amount = moved.data.amount;
    const from = AccountLayout.decode(source.data);
    const to = AccountLayout.decode(destination.data);
    accounts.set(moved.keys.source.pubkey.toBase58(), {
      ...source,
      data: tokenAccountData(from.mint, from.owner, from.amount - amount),
    });
    accounts.set(moved.keys.destination.pubkey.toBase58(), {
      ...destination,
      data: tokenAccountData(to.mint, to.owner, to.amount + amount),
    });
  }

  const connection = {
    getMultipleAccountsInfo: async (keys: PublicKey[], _commitment?: "confirmed") => {
      failIfAsked("getMultipleAccountsInfo");
      return keys.map((key) => accounts.get(key.toBase58()) ?? null);
    },

    isBlockhashValid: async (blockhash: string, config?: { commitment?: "confirmed" }) => {
      failIfAsked("isBlockhashValid");
      chain.blockhashChecks.push({ blockhash, config });
      return { context: { slot: Number(chain.height) }, value: live(blockhash) };
    },

    simulateTransaction: async (
      transaction: VersionedTransaction,
      config: { sigVerify: false; replaceRecentBlockhash: false; commitment: "confirmed" },
    ) => {
      failIfAsked("simulateTransaction");
      chain.simulations.push({ config });
      if (!(transaction instanceof VersionedTransaction)) {
        throw new Error("stand-in: only a VersionedTransaction is simulated as it is");
      }
      const asked = config as { sigVerify?: boolean; replaceRecentBlockhash?: boolean };
      if (asked.sigVerify && asked.replaceRecentBlockhash) {
        throw new Error("stand-in: sigVerify may not be used with replaceRecentBlockhash");
      }
      const result = (err: unknown) => ({
        context: { slot: Number(chain.height) },
        value: { err, logs: [] as string[], accounts: null, unitsConsumed: 6_000, returnData: null },
      });
      if (asked.sigVerify && !signaturesVerify(transaction)) return result("SignatureFailure");
      if (!asked.replaceRecentBlockhash && !live(transaction.message.recentBlockhash)) return result("BlockhashNotFound");
      const feePayer = transaction.message.staticAccountKeys[0];
      const payerInfo = feePayer ? accounts.get(feePayer.toBase58()) : undefined;
      if (!payerInfo || payerInfo.lamports <= 0) return result("AccountNotFound");
      const transfer = transferOf(transaction);
      if (!transfer) return result({ InstructionError: [2, "InvalidInstructionData"] });
      const source = accounts.get(transfer.keys.source.pubkey.toBase58());
      const destination = accounts.get(transfer.keys.destination.pubkey.toBase58());
      if (!source || !destination) return result({ InstructionError: [2, "InvalidAccountData"] });
      if (tokenAmount(source) < transfer.data.amount) return result({ InstructionError: [2, { Custom: 1 }] });
      return result(null);
    },

    sendRawTransaction: async (raw: Buffer | Uint8Array | number[], _options?: unknown) => {
      const bytes = Buffer.from(raw as Uint8Array);
      const tx = VersionedTransaction.deserialize(bytes);
      if (!signaturesVerify(tx)) throw new Error("stand-in: Transaction signature verification failure");
      const signature = bs58.encode(tx.signatures[0]!);
      const bytesB64 = bytes.toString("base64");
      chain.sends.push({ signature, bytesB64 });
      if (chain.send === "refused") {
        throw new Error("stand-in: Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.");
      }
      if (chain.send === "duplicate") throw new Error("stand-in: This transaction has already been processed");
      if (!live(tx.message.recentBlockhash)) throw new Error("stand-in: Blockhash not found");
      const transfer: DoorTransfer = transfers.get(signature) ?? {
        signature,
        bytesB64,
        blockhash: tx.message.recentBlockhash,
        landed: null,
        finalized: false,
      };
      transfers.set(signature, transfer);
      if (transfer.landed === null && chain.fate !== "never") {
        include(transfer, chain.fate === "landed_ok" ? "ok" : "failed");
      }
      if (chain.send === "throws_but_reached") throw new Error("stand-in: socket hang up");
      return signature;
    },
  };

  /** What became of a signature, by the rules of services/signatureFate.ts, in the blockhash form. */
  function readFate(fateInput: SignatureFateInput): Promise<SignatureFateAnswer> {
    return signatureFate(fateInput, {
      marginBlocks: 32,
      getFinalizedPosition: async () => {
        failIfAsked("getFinalizedPosition");
        return { slot: chain.height, blockHeight: chain.height };
      },
      getSignatureStatus: async (signature) => {
        failIfAsked("getSignatureStatus");
        const transfer = transfers.get(signature);
        if (!transfer || transfer.landed === null) return { status: null, contextSlot: chain.height };
        return {
          status: {
            confirmationStatus: transfer.finalized ? "finalized" : "confirmed",
            err: transfer.landed === "failed" ? { InstructionError: [2, { Custom: 1 }] } : null,
          },
          contextSlot: chain.height,
        };
      },
      isBlockhashValid: async (blockhash) => {
        failIfAsked("isBlockhashValid");
        return { valid: live(blockhash), contextSlot: chain.height };
      },
    });
  }

  return {
    chain,
    connection,
    readFate,
    /** A blockhash as the chain hands one out, alive for DOOR_BLOCKHASH_LIFE blocks from now. */
    issueBlockhash(): string {
      chain.blockhashesIssued += 1;
      const bytes = Buffer.alloc(32);
      bytes.writeUInt32LE(chain.blockhashesIssued, 0);
      bytes.fill(9, 28);
      const blockhash = bs58.encode(bytes);
      lastValidOf.set(blockhash, chain.height + DOOR_BLOCKHASH_LIFE);
      return blockhash;
    },
    advance(blocks: bigint | number) {
      chain.height += BigInt(blocks);
    },
    /** A wallet with SOL. */
    fundSol(owner: PublicKey, lamports: bigint) {
      accounts.set(owner.toBase58(), {
        lamports: Number(lamports),
        owner: SystemProgram.programId,
        data: Buffer.alloc(0),
        executable: false,
      });
    },
    /** A wallet's USDC account (its associated token account) holding `amount` atomic units. */
    openTokenAccount(owner: PublicKey, amount: bigint): PublicKey {
      const address = getAssociatedTokenAddressSync(input.mint, owner, true);
      accounts.set(address.toBase58(), {
        lamports: TOKEN_ACCOUNT_RENT,
        owner: TOKEN_PROGRAM_ID,
        data: tokenAccountData(input.mint, owner, amount),
        executable: false,
      });
      return address;
    },
    /** An account no longer exists. */
    close(address: PublicKey) {
      accounts.delete(address.toBase58());
    },
    lamportsOf(address: PublicKey): bigint | null {
      const info = accounts.get(address.toBase58());
      return info ? BigInt(info.lamports) : null;
    },
    usdcOf(owner: PublicKey): bigint | null {
      const info = accounts.get(getAssociatedTokenAddressSync(input.mint, owner, true).toBase58());
      return info ? tokenAmount(info) : null;
    },
    /** The chain finalizes a transaction that landed. */
    finalize(signature: string): boolean {
      const transfer = transfers.get(signature);
      if (!transfer || transfer.landed === null) return false;
      transfer.finalized = true;
      return true;
    },
    landed(signature: string): "ok" | "failed" | null {
      return transfers.get(signature)?.landed ?? null;
    },
  };
}

export type DoorChain = ReturnType<typeof doorChain>;
