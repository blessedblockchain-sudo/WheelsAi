/**
 * Which buttons a credit pack shows. Run with:
 *   cd apps/web && npx tsx --test src/lib/credit-purchase.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { BillingRails } from "./api";
import { NO_WAY_TO_PAY, RAILS_NOT_READ, packPayment } from "./credit-purchase";

function rails(over: Partial<BillingRails> = {}): BillingRails {
  return {
    stripeCheckout: false,
    mockCheckout: false,
    wallet: false,
    walletAssets: [],
    network: "devnet",
    ...over,
  };
}

test("Purchase is shown only when a card rail is live", () => {
  assert.equal(packPayment(rails({ stripeCheckout: true })).card, true);
  assert.equal(packPayment(rails({ mockCheckout: true })).card, true);
  assert.equal(packPayment(rails()).card, false);
  // A Pro price being configured is not a way to buy a credit pack.
  assert.equal(packPayment(rails({ proSubscription: true })).card, false);
});

test("until the server has said which rails are live, a pack shows no button", () => {
  for (const unknown of [null, undefined]) {
    assert.deepEqual(packPayment(unknown), { card: false, wallet: false, notice: null });
  }
});

test("the wallet top-up stays as it is, with or without a card rail", () => {
  const walletOnly = packPayment(rails({ wallet: true, walletAssets: ["USDC"] }));
  assert.deepEqual(walletOnly, { card: false, wallet: true, notice: null });
  const both = packPayment(rails({ stripeCheckout: true, wallet: true, walletAssets: ["SOL", "USDC"] }));
  assert.deepEqual(both, { card: true, wallet: true, notice: null });
  // On, but with no asset to pay in: there is nothing to sign.
  assert.equal(packPayment(rails({ wallet: true, walletAssets: [] })).wallet, false);
  // Only an asset this page cannot pay with: the same, no button.
  assert.equal(packPayment(rails({ wallet: true, walletAssets: ["BONK"] })).wallet, false);
  assert.equal(packPayment(rails({ wallet: true, walletAssets: ["SOL"] })).wallet, true);
  // Assets named while the rail is off are not a way to pay.
  assert.equal(packPayment(rails({ wallet: false, walletAssets: ["USDC", "SOL"] })).wallet, false);
});

test("with no rail at all the page says so instead of drawing a dead button", () => {
  assert.deepEqual(packPayment(rails()), { card: false, wallet: false, notice: NO_WAY_TO_PAY });
});

test("when the rails could not be read the page says so, and still draws no button", () => {
  assert.deepEqual(packPayment(null, true), { card: false, wallet: false, notice: RAILS_NOT_READ });
  // Rails that were read win over an earlier failure.
  assert.deepEqual(packPayment(rails({ stripeCheckout: true }), true), { card: true, wallet: false, notice: null });
});
