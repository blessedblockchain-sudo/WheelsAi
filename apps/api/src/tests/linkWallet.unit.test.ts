// Linking a wallet to the signed-in account: POST /link-wallet/nonce and
// POST /link-wallet (routes/linkWallet.ts), with stand-ins for the nonce
// store and the users table. Signatures are real ed25519 signatures, checked
// by the same verifySolanaSignature wallet sign-in uses.
import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";
import bs58 from "bs58";
import nacl from "tweetnacl";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyJwt from "@fastify/jwt";
import { PublicKey } from "@solana/web3.js";
import { env } from "../config/env.js";
import { globalErrorHandler } from "../lib/errorHandler.js";
import { verifySolanaSignature, type JwtPayload, type NoncePurpose } from "../services/auth.js";
import { createLinkWalletRoutes, isSolanaAddress, type LinkWalletDeps } from "../routes/linkWallet.js";
import { makeLinkWallet, makeLoadSession, type LinkWalletDb } from "../routes/linkWalletBindings.js";

interface FakeUser {
  id: string;
  email?: string;
  walletAddress: string | null;
}

function newWallet() {
  const pair = nacl.sign.keyPair();
  return {
    address: new PublicKey(pair.publicKey).toBase58(),
    sign: (text: string) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(text), pair.secretKey)),
  };
}

/** The nonce store of services/auth.ts, in memory: one message, one wallet, one purpose, one use. */
function nonceStore() {
  const issued = new Map<string, string>();
  let n = 0;
  return {
    issued,
    generateNonce: async (walletAddress: string, purpose: NoncePurpose) => {
      const message = `test.local wants you to sign in with your Solana account:\n${walletAddress}\n\nNonce: ${++n}`;
      issued.set(message, `${purpose}:${walletAddress}`);
      return message;
    },
    claimNonce: async (walletAddress: string, message: string, purpose: NoncePurpose) => {
      const stored = issued.get(message);
      issued.delete(message);
      return stored === `${purpose}:${walletAddress}`;
    },
  };
}

function usersTable(users: FakeUser[]) {
  const writes: Array<{ id: string; walletAddress: string }> = [];
  const db: LinkWalletDb = {
    user: {
      findFirst: async ({ where }) =>
        users.find((u) => u.walletAddress === where.walletAddress && u.id !== where.id.not) ?? null,
      update: async ({ where, data }) => {
        const user = users.find((u) => u.id === where.id);
        if (!user) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
        user.walletAddress = data.walletAddress;
        writes.push({ id: where.id, walletAddress: data.walletAddress });
        return user;
      },
    },
  };
  return { db, writes };
}

const SESSION = { userId: "u1", orgId: "org1", email: "ada@example.com", role: "owner", type: "jwt" as const };

async function harness(opts: { users?: FakeUser[]; principal?: unknown; deps?: Partial<LinkWalletDeps> } = {}) {
  const users = opts.users ?? [{ id: "u1", email: "ada@example.com", walletAddress: null }];
  const nonces = nonceStore();
  const table = usersTable(users);
  const deps: LinkWalletDeps = {
    generateNonce: nonces.generateNonce,
    claimNonce: nonces.claimNonce,
    verifySignature: verifySolanaSignature,
    linkWallet: makeLinkWallet(table.db),
    loadSession: async ({ userId, orgId }) => {
      const user = users.find((u) => u.id === userId);
      if (!user || orgId !== "org1") return null;
      return { userId, orgId, email: user.email, walletAddress: user.walletAddress ?? undefined, role: "owner" };
    },
    ...opts.deps,
  };

  // The cookie and JWT plugins exactly as registerAuthPlugins sets them up;
  // the principal is put on the request directly, so no token is read.
  const app = Fastify();
  app.setErrorHandler(globalErrorHandler);
  await app.register(fastifyCookie, { secret: env.JWT_SECRET, hook: "onRequest" });
  await app.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_EXPIRES_IN },
    cookie: { cookieName: "wheelsai_token", signed: true },
  });
  app.decorateRequest("auth", null);
  const principal = "principal" in opts ? opts.principal : SESSION;
  app.addHook("onRequest", async (request) => {
    (request as any).auth = principal;
  });
  await app.register(createLinkWalletRoutes(deps), { prefix: "/api/settings" });

  const post = (url: string, payload: unknown) =>
    app.inject({ method: "POST", url: `/api/settings${url}`, payload: payload as any });
  const nonceFor = async (walletAddress: string) =>
    (await post("/link-wallet/nonce", { walletAddress })).json().nonce as string;
  /** The claims of the session cookie an answer set, or null when it set none. */
  const sessionOf = (res: { cookies: Array<{ name: string; value: string }> }): JwtPayload | null => {
    const cookie = res.cookies.find((c) => c.name === "wheelsai_token" && c.value);
    if (!cookie) return null;
    const unsigned = app.unsignCookie(cookie.value);
    assert.equal(unsigned.valid, true, "the session cookie is signed");
    return app.jwt.verify<JwtPayload>(unsigned.value!);
  };
  return { app, users, nonces, writes: table.writes, post, nonceFor, sessionOf };
}

test("the nonce route answers the message to sign and the wallet it is for", async () => {
  const h = await harness();
  const wallet = newWallet();
  const res = await h.post("/link-wallet/nonce", { walletAddress: wallet.address });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.json()).sort(), ["nonce", "walletAddress"]);
  assert.equal(res.json().walletAddress, wallet.address);
  assert.equal(h.nonces.issued.get(res.json().nonce), `link-wallet:${wallet.address}`);
  await h.app.close();
});

test("linking answers the wallet and a sentence, and sets a session cookie whose token carries the wallet", async () => {
  const h = await harness();
  const wallet = newWallet();
  const nonce = await h.nonceFor(wallet.address);
  const res = await h.post("/link-wallet", { walletAddress: wallet.address, signature: wallet.sign(nonce), nonce });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { walletAddress: wallet.address, message: "Wallet linked." });
  assert.deepEqual(h.writes, [{ id: "u1", walletAddress: wallet.address }]);

  const claims = h.sessionOf(res);
  assert.ok(claims, "a session cookie is set");
  assert.equal(claims.walletAddress, wallet.address);
  assert.equal(claims.userId, "u1");
  assert.equal(claims.orgId, "org1");
  assert.equal(claims.email, "ada@example.com");
  assert.equal(claims.role, "owner");
  assert.ok(claims.jti, "the token has its own id, so signing out can block it");

  const cookie = res.cookies.find((c) => c.name === "wheelsai_token") as any;
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.path, "/");
  await h.app.close();
});

test("a nonce works once", async () => {
  const h = await harness();
  const wallet = newWallet();
  const nonce = await h.nonceFor(wallet.address);
  const body = { walletAddress: wallet.address, signature: wallet.sign(nonce), nonce };

  assert.equal((await h.post("/link-wallet", body)).statusCode, 200);
  const again = await h.post("/link-wallet", body);
  assert.equal(again.statusCode, 401);
  assert.deepEqual(again.json(), {
    error: "invalid_nonce",
    message: "That request to link a wallet has expired. Try again.",
  });
  assert.equal(h.sessionOf(again), null);
  assert.equal(h.writes.length, 1);
  await h.app.close();
});

test("a nonce issued for another wallet is refused", async () => {
  const h = await harness();
  const wallet = newWallet();
  const other = newWallet();
  // The message was issued for `other`; `wallet` signs it and presents it as its own.
  const nonce = await h.nonceFor(other.address);
  const res = await h.post("/link-wallet", { walletAddress: wallet.address, signature: wallet.sign(nonce), nonce });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "invalid_nonce");
  assert.deepEqual(h.writes, []);
  assert.equal(h.sessionOf(res), null);
  await h.app.close();
});

test("a nonce issued for another purpose is refused", async () => {
  const h = await harness();
  const wallet = newWallet();
  const signInNonce = await h.nonces.generateNonce(wallet.address, "sign-in");
  const res = await h.post("/link-wallet", {
    walletAddress: wallet.address,
    signature: wallet.sign(signInNonce),
    nonce: signInNonce,
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "invalid_nonce");
  assert.deepEqual(h.writes, []);
  await h.app.close();
});

test("a message this server never issued is refused", async () => {
  const h = await harness();
  const wallet = newWallet();
  const nonce = "Link this wallet to your WheelsAI account.";
  const res = await h.post("/link-wallet", { walletAddress: wallet.address, signature: wallet.sign(nonce), nonce });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "invalid_nonce");
  await h.app.close();
});

test("a signature by another key is refused, and the nonce is not spent on it", async () => {
  const h = await harness();
  const wallet = newWallet();
  const thief = newWallet();
  const nonce = await h.nonceFor(wallet.address);
  const res = await h.post("/link-wallet", { walletAddress: wallet.address, signature: thief.sign(nonce), nonce });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), {
    error: "invalid_signature",
    message: "The wallet's signature could not be checked. Try again.",
  });
  assert.deepEqual(h.writes, []);
  assert.equal(h.sessionOf(res), null);

  // The signature is checked before the claim, as wallet sign-in does, so
  // the wallet's own signature still links with the same nonce.
  const good = await h.post("/link-wallet", { walletAddress: wallet.address, signature: wallet.sign(nonce), nonce });
  assert.equal(good.statusCode, 200);
  await h.app.close();
});

test("a base64 signature, which the route used to expect, is refused", async () => {
  const h = await harness();
  const pair = nacl.sign.keyPair();
  const address = new PublicKey(pair.publicKey).toBase58();
  const nonce = await h.nonceFor(address);
  const base64 = Buffer.from(nacl.sign.detached(new TextEncoder().encode(nonce), pair.secretKey)).toString("base64");
  const res = await h.post("/link-wallet", { walletAddress: address, signature: base64, nonce });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_signature");
  await h.app.close();
});

test("a wallet that signs in to another account is 409 and changes nothing", async () => {
  const wallet = newWallet();
  const users: FakeUser[] = [
    { id: "u1", email: "ada@example.com", walletAddress: null },
    { id: "u2", walletAddress: wallet.address },
  ];
  const h = await harness({ users });
  const nonce = await h.nonceFor(wallet.address);
  const res = await h.post("/link-wallet", { walletAddress: wallet.address, signature: wallet.sign(nonce), nonce });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), {
    error: "wallet_in_use",
    message:
      "This wallet already signs in to another WheelsAI account. Use that account, or link a different wallet.",
  });
  assert.deepEqual(h.writes, []);
  assert.deepEqual(users, [
    { id: "u1", email: "ada@example.com", walletAddress: null },
    { id: "u2", walletAddress: wallet.address },
  ]);
  assert.equal(h.sessionOf(res), null, "the session is not issued again");
  await h.app.close();
});

test("another account taking the wallet between the read and the write is still 409", async () => {
  const link = makeLinkWallet({
    user: {
      findFirst: async () => null,
      update: async () => {
        throw Object.assign(new Error("Unique constraint failed on the fields: (`wallet_address`)"), {
          code: "P2002",
        });
      },
    },
  });
  assert.equal(await link({ userId: "u1", walletAddress: newWallet().address }), "in_use");
});

test("linking the wallet the account already holds answers 200 again", async () => {
  const wallet = newWallet();
  const h = await harness({ users: [{ id: "u1", walletAddress: wallet.address }] });
  const nonce = await h.nonceFor(wallet.address);
  const res = await h.post("/link-wallet", { walletAddress: wallet.address, signature: wallet.sign(nonce), nonce });
  assert.equal(res.statusCode, 200);
  assert.equal(h.sessionOf(res)?.walletAddress, wallet.address);
  await h.app.close();
});

test("an address that is not a Solana public key is 400 on both routes", async () => {
  const h = await harness();
  const sentence = "That is not a Solana wallet address. Connect a wallet and try again.";
  for (const walletAddress of ["", "not-a-wallet", "0".repeat(40), "x".repeat(200), 42, undefined]) {
    const nonce = await h.post("/link-wallet/nonce", { walletAddress });
    assert.equal(nonce.statusCode, 400);
    assert.deepEqual(nonce.json(), { error: "invalid_wallet_address", message: sentence });

    const link = await h.post("/link-wallet", { walletAddress, signature: "sig", nonce: "nonce" });
    assert.equal(link.statusCode, 400);
    assert.deepEqual(link.json(), { error: "invalid_wallet_address", message: sentence });
  }
  assert.equal(h.nonces.issued.size, 0);
  assert.equal(isSolanaAddress(newWallet().address), true);
  await h.app.close();
});

test("a body without a nonce or without a signature gets the contract's refusals", async () => {
  const h = await harness();
  const wallet = newWallet();
  const noNonce = await h.post("/link-wallet", { walletAddress: wallet.address, signature: "sig" });
  assert.equal(noNonce.statusCode, 401);
  assert.equal(noNonce.json().error, "invalid_nonce");
  const noSignature = await h.post("/link-wallet", { walletAddress: wallet.address, nonce: "n" });
  assert.equal(noSignature.statusCode, 400);
  assert.equal(noSignature.json().error, "invalid_signature");
  await h.app.close();
});

test("a nonce or a signature that is not text gets its own refusal, not the address one", async () => {
  const h = await harness();
  const wallet = newWallet();
  const nonce = await h.nonceFor(wallet.address);
  for (const bad of [42, null, { a: 1 }, ["x"], ""]) {
    const badNonce = await h.post("/link-wallet", { walletAddress: wallet.address, signature: "sig", nonce: bad });
    assert.equal(badNonce.statusCode, 401);
    assert.equal(badNonce.json().error, "invalid_nonce");
    const badSignature = await h.post("/link-wallet", { walletAddress: wallet.address, signature: bad, nonce });
    assert.equal(badSignature.statusCode, 400);
    assert.equal(badSignature.json().error, "invalid_signature");
  }
  assert.deepEqual(h.writes, []);
  // None of those spent the nonce.
  const good = await h.post("/link-wallet", { walletAddress: wallet.address, signature: wallet.sign(nonce), nonce });
  assert.equal(good.statusCode, 200);
  await h.app.close();
});

test("the new session's claims come from the stored user and their membership of the session's organization", async () => {
  const stored = {
    id: "u1",
    email: "ada@example.com",
    walletAddress: "WalletJustLinked",
    memberships: [
      { role: "owner", org: { id: "org-own" } },
      { role: "member", org: { id: "org1" } },
    ],
  };
  const load = makeLoadSession(async (id) => (id === "u1" ? stored : null));
  assert.deepEqual(await load({ userId: "u1", orgId: "org1" }), {
    userId: "u1",
    orgId: "org1",
    email: "ada@example.com",
    walletAddress: "WalletJustLinked",
    role: "member",
  });
  // No longer a member of that organization, or no longer there at all.
  assert.equal(await load({ userId: "u1", orgId: "org-left" }), null);
  assert.equal(await load({ userId: "gone", orgId: "org1" }), null);
  // A wallet-only account has no email on its token.
  const walletOnly = makeLoadSession(async () => ({ ...stored, email: null }));
  assert.equal((await walletOnly({ userId: "u1", orgId: "org1" }))?.email, undefined);
});

test("without a session, and with an API key, both routes are 401", async () => {
  const wallet = newWallet();
  for (const principal of [null, { userId: null, orgId: "org1", type: "api_key" }]) {
    const h = await harness({ principal });
    assert.equal((await h.post("/link-wallet/nonce", { walletAddress: wallet.address })).statusCode, 401);
    const res = await h.post("/link-wallet", { walletAddress: wallet.address, signature: "s", nonce: "n" });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(h.writes, []);
    assert.equal(h.nonces.issued.size, 0);
    await h.app.close();
  }
});

test("text from a failing store or database never reaches the answer", async () => {
  const hostile = "ECONNREFUSED redis://10.0.0.7:6379 password=hunter2";
  const wallet = newWallet();

  const noStore = await harness({
    deps: {
      generateNonce: async () => {
        throw new Error(hostile);
      },
    },
  });
  const nonceRes = await noStore.post("/link-wallet/nonce", { walletAddress: wallet.address });
  assert.equal(nonceRes.statusCode, 503);
  assert.equal(nonceRes.json().error, "nonce_unavailable");
  assert.ok(!nonceRes.body.includes("hunter2") && !nonceRes.body.includes("ECONNREFUSED"));
  await noStore.app.close();

  const noDb = await harness({
    deps: {
      linkWallet: async () => {
        throw new Error(hostile);
      },
    },
  });
  const nonce = await noDb.nonceFor(wallet.address);
  const res = await noDb.post("/link-wallet", { walletAddress: wallet.address, signature: wallet.sign(nonce), nonce });
  assert.equal(res.statusCode, 500);
  assert.ok(!res.body.includes("hunter2") && !res.body.includes("ECONNREFUSED"));
  assert.equal(noDb.sessionOf(res), null);
  await noDb.app.close();
});

test("a member removed from the organization gets no new session", async () => {
  const h = await harness({ principal: { ...SESSION, orgId: "org-gone" } });
  const wallet = newWallet();
  const nonce = await h.nonceFor(wallet.address);
  const res = await h.post("/link-wallet", { walletAddress: wallet.address, signature: wallet.sign(nonce), nonce });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "membership_revoked");
  assert.equal(h.sessionOf(res), null);
  await h.app.close();
});

test("no sentence a person reads has an em dash or a raw status word", async () => {
  const h = await harness();
  const wallet = newWallet();
  const nonce = await h.nonceFor(wallet.address);
  const answers = [
    await h.post("/link-wallet", { walletAddress: "nope", signature: "s", nonce: "n" }),
    await h.post("/link-wallet", { walletAddress: wallet.address, signature: newWallet().sign(nonce), nonce }),
    await h.post("/link-wallet", { walletAddress: wallet.address, signature: wallet.sign("x"), nonce: "x" }),
    await h.post("/link-wallet", { walletAddress: wallet.address, signature: wallet.sign(nonce), nonce }),
  ];
  for (const res of answers) {
    const { message } = res.json();
    assert.equal(typeof message, "string");
    assert.ok(message.length > 0 && !message.includes("—"), message);
    assert.doesNotMatch(message, /invalid_|wallet_in_use|Unauthorized|Bad Request/);
  }
  await h.app.close();
});
