import assert from "node:assert/strict";
import test from "node:test";

import { resolveToolMode } from "../services/skills/runMode.js";

// Drives services/skills/runMode.ts. `trial` mode withholds money-moving
// skills, but nothing ever SET it: the mode existed and was dead. A run of an
// agent that is a marketplace buyer's copy of someone else's work now gets it,
// whatever path the run came in on.

const args = (base: Parameters<typeof resolveToolMode>[0]["base"]) => ({
  agentId: "agent_1",
  orgId: "org_1",
  base,
});

test("a marketplace buyer's agent runs in trial mode, from every entry point", async () => {
  const deps = { isMarketplaceInstall: async () => true };
  for (const base of ["playground", "graph", "scheduled", "job"] as const) {
    assert.equal(await resolveToolMode(args(base), deps), "trial", base);
  }
});

test("an agent that is not an install keeps the mode the caller chose", async () => {
  const deps = { isMarketplaceInstall: async () => false };
  for (const base of ["playground", "graph", "scheduled", "job"] as const) {
    assert.equal(await resolveToolMode(args(base), deps), base);
  }
});

test("the lookup is scoped to this agent and this org", async () => {
  const seen: Array<{ agentId: string; orgId: string }> = [];
  await resolveToolMode(args("playground"), {
    isMarketplaceInstall: async (a) => {
      seen.push(a);
      return false;
    },
  });
  assert.deepEqual(seen, [{ agentId: "agent_1", orgId: "org_1" }]);
});

test("trial and test are never loosened, and skip the lookup entirely", async () => {
  let looked = false;
  const deps = {
    isMarketplaceInstall: async () => {
      looked = true;
      return false;
    },
  };
  assert.equal(await resolveToolMode(args("test"), deps), "test");
  assert.equal(await resolveToolMode(args("trial"), deps), "trial");
  assert.equal(looked, false);
});

test("if the install lookup fails the run is restricted, not trusted", async () => {
  const mode = await resolveToolMode(args("playground"), {
    isMarketplaceInstall: async () => {
      throw new Error("database unavailable");
    },
  });
  assert.equal(mode, "trial");
});
