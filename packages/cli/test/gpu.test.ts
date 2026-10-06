import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CliError } from "../src/errors.js";
import { chooseTier } from "../src/lib/gpu.js";
import { TIERS } from "./helpers.js";

describe("chooseTier", () => {
  it("takes the cheapest tier the API lists when none is requested", () => {
    const choice = chooseTier(TIERS, undefined);
    assert.equal(choice.id, "3060");
    assert.equal(choice.reason, "cheapest");
  });

  it("accepts a requested tier the API lists", () => {
    const choice = chooseTier(TIERS, "4090");
    assert.equal(choice.id, "4090");
    assert.equal(choice.tier?.vram, 24);
    assert.equal(choice.reason, "requested");
    assert.equal(choice.unverified, undefined);
  });

  it("rejects an id the API does not list, naming the valid ones (rtx-4090 is not a tier)", () => {
    assert.throws(() => chooseTier(TIERS, "rtx-4090"), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.match(err.message, /"rtx-4090" is not a deployable GPU tier/);
      assert.match(err.hint ?? "", /4090, 3060/);
      return true;
    });
  });

  it("with an empty list, sends a requested tier unchecked so the API can say why it cannot run", () => {
    assert.deepEqual(chooseTier([], "3060"), { id: "3060", reason: "requested", unverified: true });
  });

  it("with an empty list and no request, there is nothing to choose", () => {
    assert.throws(() => chooseTier([], undefined), /no deployable GPU tiers/);
  });
});
