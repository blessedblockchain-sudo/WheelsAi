import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";
import { nosanaJobUrl, nosanaNetworkOfCredential, nosanaRecord } from "../services/nosanaExplorer.js";

// Nosana's own page for a job: only for an address that is one by its form,
// and only on the network whose link Nosana documents.

const ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

test("nosanaJobUrl: a Solana address on mainnet gets Nosana's page; devnet gets none", () => {
  assert.equal(nosanaJobUrl(ADDRESS, "mainnet"), `https://explore.nosana.com/jobs/${ADDRESS}`);
  assert.equal(nosanaJobUrl(ADDRESS, "devnet"), null);
  // The shortest and the longest an address can be.
  assert.equal(nosanaJobUrl("1".repeat(32), "mainnet"), `https://explore.nosana.com/jobs/${"1".repeat(32)}`);
  assert.equal(nosanaJobUrl("z".repeat(44), "mainnet"), `https://explore.nosana.com/jobs/${"z".repeat(44)}`);
});

test("nosanaJobUrl: anything that is not an address by its form is null, never a link", () => {
  const refused: Array<[string, string | null | undefined]> = [
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["too short", ADDRESS.slice(0, 31)],
    ["too long", `${ADDRESS}1`],
    ["a zero", `0${ADDRESS.slice(1)}`],
    ["a capital O", `O${ADDRESS.slice(1)}`],
    ["a capital I", `I${ADDRESS.slice(1)}`],
    ["a small l", `l${ADDRESS.slice(1)}`],
    ["a slash", `${ADDRESS.slice(0, 20)}/${ADDRESS.slice(21)}`],
    ["a path that climbs", `../${ADDRESS.slice(3)}`],
    ["a query", `${ADDRESS.slice(0, 36)}?x=1`],
    ["a fragment", `${ADDRESS.slice(0, 40)}#top`],
    ["a space before it", ` ${ADDRESS.slice(1)}`],
    ["a line break after it", `${ADDRESS.slice(0, 43)}\n`],
    ["a whole address and a line break", `${ADDRESS.slice(0, 40)}\n`],
    ["a URL", "https://explore.nosana.com/jobs/abc"],
  ];
  for (const [what, address] of refused) {
    assert.equal(nosanaJobUrl(address, "mainnet"), null, what);
    assert.equal(nosanaJobUrl(address, "devnet"), null, what);
  }
  // A value that is not a string at all, as a careless caller could hand in.
  assert.equal(nosanaJobUrl(42 as never, "mainnet"), null);
});

test("nosanaNetworkOfCredential: each credential's own network, and none for a backend that is not Nosana's", () => {
  const config = { walletNetwork: "devnet", apiNetwork: "mainnet" } as const;
  assert.equal(nosanaNetworkOfCredential("wallet", config), "devnet");
  assert.equal(nosanaNetworkOfCredential("api_key", config), "mainnet");
  // Nosana's own backend, written out, is still Nosana.
  assert.equal(
    nosanaNetworkOfCredential("api_key", { ...config, apiUrl: "https://dashboard.k8s.prd.nos.ci" }),
    "mainnet",
  );
  // The development stand-in: its jobs are not on Nosana, so there is no page to link.
  assert.equal(nosanaNetworkOfCredential("api_key", { ...config, apiUrl: "http://127.0.0.1:4010" }), null);
  assert.equal(nosanaNetworkOfCredential("wallet", { ...config, apiUrl: "http://127.0.0.1:4010" }), null);
});

test("nosanaRecord: what a row stores, with a link only where there is one to give", () => {
  const mainnet = () => "mainnet" as const;
  assert.deepEqual(nosanaRecord({}, mainnet), { deploymentId: null, jobAddress: null, jobUrl: null });
  assert.deepEqual(
    nosanaRecord({ nosanaJobId: "dm_1", nosanaJobAddress: ADDRESS, nosanaAccessMode: "api_key" }, mainnet),
    { deploymentId: "dm_1", jobAddress: ADDRESS, jobUrl: `https://explore.nosana.com/jobs/${ADDRESS}` },
  );
  // A stored value that is not an address is shown as stored, without a link.
  assert.deepEqual(nosanaRecord({ nosanaJobId: "dm_1", nosanaJobAddress: "not/an?address" }, mainnet), {
    deploymentId: "dm_1",
    jobAddress: "not/an?address",
    jobUrl: null,
  });

  // The credential on the row picks the network; a null column is the wallet.
  const asked: string[] = [];
  const networkOf = (credential: "wallet" | "api_key") => {
    asked.push(credential);
    return credential === "api_key" ? ("mainnet" as const) : ("devnet" as const);
  };
  assert.ok(nosanaRecord({ nosanaJobAddress: ADDRESS, nosanaAccessMode: "api_key" }, networkOf).jobUrl);
  assert.equal(nosanaRecord({ nosanaJobAddress: ADDRESS, nosanaAccessMode: "wallet" }, networkOf).jobUrl, null);
  assert.equal(nosanaRecord({ nosanaJobAddress: ADDRESS, nosanaAccessMode: null }, networkOf).jobUrl, null);
  assert.deepEqual(asked, ["api_key", "wallet", "wallet"]);
});

test("nosanaRecord: nothing at all for a run Nosana has no record of", () => {
  const none = { deploymentId: null, jobAddress: null, jobUrl: null };
  const mainnet = () => "mainnet" as const;
  // Not on Nosana's own network (the development stand-in): no id, no address, no link.
  assert.deepEqual(
    nosanaRecord({ nosanaJobId: "dm_1", nosanaJobAddress: ADDRESS, nosanaAccessMode: "api_key" }, () => null),
    none,
  );
  // An id the development mock made up, whatever else the row holds.
  for (const mockId of ["mock_deploy_abc123", "mock_job_abc123"]) {
    assert.deepEqual(
      nosanaRecord({ nosanaJobId: mockId, nosanaJobAddress: ADDRESS, nosanaAccessMode: "api_key" }, mainnet),
      none,
      mockId,
    );
  }
  // The network is not asked for when the row holds nothing.
  let asked = 0;
  assert.deepEqual(
    nosanaRecord({ nosanaAccessMode: "api_key" }, () => {
      asked += 1;
      return "mainnet";
    }),
    none,
  );
  assert.equal(asked, 0);
  // A real deployment whose job has no address yet keeps its id.
  assert.deepEqual(nosanaRecord({ nosanaJobId: "dm_1", nosanaAccessMode: "api_key" }, mainnet), {
    deploymentId: "dm_1",
    jobAddress: null,
    jobUrl: null,
  });
});
