import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";

import {
  GENESIS_HASHES,
  checkSolanaCluster,
  createClusterCheck,
  ensureSolanaCluster,
  getSolanaConnection,
  resetSolanaClusterCheckForTests,
  type ClusterCheckDeps,
} from "../lib/solana.js";

// Payments pass, batch 1: is the node behind SOLANA_RPC_URL on the cluster
// SOLANA_NETWORK names? Stand-ins only: nothing here reaches a node.

const MAINNET = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
// What a local validator answers: a genesis of its own.
const LOCAL = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

type Network = ClusterCheckDeps["network"];
type NodeEnv = ClusterCheckDeps["nodeEnv"];

function deps(
  network: Network,
  nodeEnv: NodeEnv,
  answers: Array<string | Error>,
): ClusterCheckDeps & { calls: () => number } {
  let calls = 0;
  return {
    network,
    nodeEnv,
    getGenesisHash: async () => {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      if (answer === undefined) throw new Error("no answer given");
      if (answer instanceof Error) throw answer;
      return answer;
    },
    calls: () => calls,
  };
}

const ENVIRONMENTS: NodeEnv[] = ["development", "staging", "production"];

test("the hashes are the ones read from the two clusters", () => {
  assert.equal(GENESIS_HASHES["mainnet-beta"], MAINNET);
  assert.equal(GENESIS_HASHES.devnet, DEVNET);
});

test("the right hash is ok, on each network in every environment", async () => {
  for (const nodeEnv of ENVIRONMENTS) {
    assert.deepEqual(await checkSolanaCluster(deps("devnet", nodeEnv, [DEVNET])), { ok: true });
    assert.deepEqual(await checkSolanaCluster(deps("mainnet-beta", nodeEnv, [MAINNET])), {
      ok: true,
    });
  }
});

test("the other cluster's hash is refused where it matters", async () => {
  const wrong = { ok: false, reason: "wrong_cluster" };
  for (const nodeEnv of ENVIRONMENTS) {
    // A devnet node behind a mainnet setting is refused everywhere,
    // development included.
    assert.deepEqual(await checkSolanaCluster(deps("mainnet-beta", nodeEnv, [DEVNET])), wrong);
    assert.deepEqual(await checkSolanaCluster(deps("mainnet-beta", nodeEnv, [LOCAL])), wrong);
  }
  for (const nodeEnv of ["staging", "production"] as const) {
    assert.deepEqual(await checkSolanaCluster(deps("devnet", nodeEnv, [MAINNET])), wrong);
    assert.deepEqual(await checkSolanaCluster(deps("devnet", nodeEnv, [LOCAL])), wrong);
  }
});

test("mainnet behind a devnet setting is refused in development too", async () => {
  // Since SOLANA_RPC_URL is followed on devnet, a development machine can
  // point at mainnet by mistake. That is a real chain, not a local one.
  assert.deepEqual(await checkSolanaCluster(deps("devnet", "development", [MAINNET])), {
    ok: false,
    reason: "wrong_cluster",
  });
  const d = deps("devnet", "development", [MAINNET]);
  const { check } = createClusterCheck(d);
  assert.deepEqual(await check(), { ok: false, reason: "wrong_cluster" });
  assert.deepEqual(await check(), { ok: false, reason: "wrong_cluster" });
  assert.equal(d.calls(), 2);
});

test("a local hash is accepted in development on devnet, and nowhere else", async () => {
  for (const hash of [LOCAL, DEVNET]) {
    assert.deepEqual(await checkSolanaCluster(deps("devnet", "development", [hash])), {
      ok: true,
    });
  }
  for (const nodeEnv of ENVIRONMENTS) {
    for (const network of ["devnet", "mainnet-beta"] as const) {
      if (nodeEnv === "development" && network === "devnet") continue;
      assert.deepEqual(
        await checkSolanaCluster(deps(network, nodeEnv, [LOCAL])),
        { ok: false, reason: "wrong_cluster" },
        `${nodeEnv} ${network}`,
      );
    }
  }
});

test("an RPC error is unreachable, never wrong_cluster and never a throw", async () => {
  for (const nodeEnv of ENVIRONMENTS) {
    for (const network of ["devnet", "mainnet-beta"] as const) {
      assert.deepEqual(
        await checkSolanaCluster(deps(network, nodeEnv, [new Error("fetch failed")])),
        { ok: false, reason: "unreachable" },
        `${nodeEnv} ${network}`,
      );
    }
  }
  // A synchronous throw and a non-Error rejection are the same answer.
  const throwsSync = {
    network: "devnet",
    nodeEnv: "production",
    getGenesisHash: () => {
      throw new Error("no socket");
    },
  } as ClusterCheckDeps;
  assert.deepEqual(await checkSolanaCluster(throwsSync), { ok: false, reason: "unreachable" });
  const rejectsOddly = {
    network: "devnet",
    nodeEnv: "production",
    getGenesisHash: () => Promise.reject("429"),
  } as ClusterCheckDeps;
  assert.deepEqual(await checkSolanaCluster(rejectsOddly), { ok: false, reason: "unreachable" });
});

test("an answer that is not a hash is unreachable, in development on devnet too", async () => {
  for (const answer of ["", undefined, null, 7]) {
    const odd = {
      network: "devnet",
      nodeEnv: "development",
      getGenesisHash: async () => answer,
    } as unknown as ClusterCheckDeps;
    assert.deepEqual(await checkSolanaCluster(odd), { ok: false, reason: "unreachable" });
  }
});

test("a good answer is asked once", async () => {
  const d = deps("mainnet-beta", "production", [MAINNET]);
  const { check } = createClusterCheck(d);
  for (let i = 0; i < 5; i += 1) assert.deepEqual(await check(), { ok: true });
  assert.equal(d.calls(), 1);
});

test("an RPC error is asked again, and the good answer after it is remembered", async () => {
  const d = deps("mainnet-beta", "production", [new Error("timeout"), new Error("503"), MAINNET]);
  const { check } = createClusterCheck(d);
  assert.deepEqual(await check(), { ok: false, reason: "unreachable" });
  assert.equal(d.calls(), 1);
  assert.deepEqual(await check(), { ok: false, reason: "unreachable" });
  assert.equal(d.calls(), 2);
  assert.deepEqual(await check(), { ok: true });
  assert.equal(d.calls(), 3);
  assert.deepEqual(await check(), { ok: true });
  assert.equal(d.calls(), 3);
});

test("a wrong cluster is asked again every time", async () => {
  const d = deps("mainnet-beta", "production", [DEVNET]);
  const { check } = createClusterCheck(d);
  for (let i = 1; i <= 3; i += 1) {
    assert.deepEqual(await check(), { ok: false, reason: "wrong_cluster" });
    assert.equal(d.calls(), i);
  }
});

test("calls made while a read is in flight share it", async () => {
  const d = deps("devnet", "staging", [DEVNET]);
  const { check } = createClusterCheck(d);
  const answers = await Promise.all([check(), check(), check()]);
  assert.deepEqual(answers, [{ ok: true }, { ok: true }, { ok: true }]);
  assert.equal(d.calls(), 1);
});

test("reset forgets a good answer", async () => {
  const d = deps("devnet", "staging", [DEVNET, MAINNET]);
  const { check, reset } = createClusterCheck(d);
  assert.deepEqual(await check(), { ok: true });
  reset();
  assert.deepEqual(await check(), { ok: false, reason: "wrong_cluster" });
  assert.equal(d.calls(), 2);
});

test("a read that started before a reset does not mark the check as good", async () => {
  let release: (hash: string) => void = () => {};
  let calls = 0;
  const { check, reset } = createClusterCheck({
    network: "devnet",
    nodeEnv: "staging",
    getGenesisHash: () => {
      calls += 1;
      if (calls === 1) return new Promise<string>((resolve) => (release = resolve));
      return Promise.resolve(MAINNET);
    },
  });
  const first = check();
  reset();
  release(DEVNET);
  assert.deepEqual(await first, { ok: true });
  // Not remembered: the next call reads again.
  assert.deepEqual(await check(), { ok: false, reason: "wrong_cluster" });
  assert.equal(calls, 2);
});

test("the bound form reads the shared connection once and remembers", async () => {
  // unitEnv gives development on devnet unless the shell says otherwise,
  // so the devnet hash is right under either reading.
  const connection = getSolanaConnection() as unknown as {
    getGenesisHash: () => Promise<string>;
  };
  const original = connection.getGenesisHash;
  let calls = 0;
  let answer: string | Error = new Error("fetch failed");
  connection.getGenesisHash = async () => {
    calls += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  try {
    resetSolanaClusterCheckForTests();
    assert.deepEqual(await ensureSolanaCluster(), { ok: false, reason: "unreachable" });
    assert.equal(calls, 1);
    answer = process.env.SOLANA_NETWORK === "mainnet-beta" ? MAINNET : DEVNET;
    assert.deepEqual(await ensureSolanaCluster(), { ok: true });
    assert.deepEqual(await ensureSolanaCluster(), { ok: true });
    assert.equal(calls, 2);
    resetSolanaClusterCheckForTests();
    assert.deepEqual(await ensureSolanaCluster(), { ok: true });
    assert.equal(calls, 3);
  } finally {
    connection.getGenesisHash = original;
    resetSolanaClusterCheckForTests();
  }
});
