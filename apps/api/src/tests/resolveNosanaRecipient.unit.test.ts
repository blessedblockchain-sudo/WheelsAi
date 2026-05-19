import assert from "node:assert/strict";
import test from "node:test";

import type { NosanaJob } from "../services/nosana.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

const HOST_PUBKEY = "9aE2qe8KzvLyxd5HPkdLVCDQyJ9LxhtzNPZkEmLbYEz4";

function makeJobFetcher(map: Record<string, NosanaJob | null | Error>) {
  return async (jobId: string): Promise<NosanaJob | null> => {
    const r = map[jobId];
    if (r === undefined) return null;
    if (r instanceof Error) throw r;
    return r;
  };
}

test("resolveNosanaRecipient: returns nodePubkey for an active job", async () => {
  setupEnv();
  const { resolveNosanaRecipient } = await import(
    "../services/resolveNosanaRecipient.js"
  );

  const recipient = await resolveNosanaRecipient("job-1", {
    getJobStatus: makeJobFetcher({
      "job-1": {
        id: "job-1",
        market: "M",
        status: "running",
        nodePubkey: HOST_PUBKEY,
        nodeUrl: `https://${HOST_PUBKEY}.node.nos.ci`,
      },
    }),
  });

  assert.equal(recipient, HOST_PUBKEY);
});

test("resolveNosanaRecipient: throws when job is queued (no host yet)", async () => {
  setupEnv();
  const { resolveNosanaRecipient } = await import(
    "../services/resolveNosanaRecipient.js"
  );

  await assert.rejects(
    () =>
      resolveNosanaRecipient("queued-job", {
        getJobStatus: makeJobFetcher({
          "queued-job": {
            id: "queued-job",
            market: "M",
            status: "queued",
            // nodePubkey omitted — getJobStatus filters the system-program
            // zero-pubkey out
          },
        }),
      }),
    /no host|nodePubkey|not assigned/i,
  );
});

test("resolveNosanaRecipient: throws when getJobStatus returns null", async () => {
  setupEnv();
  const { resolveNosanaRecipient } = await import(
    "../services/resolveNosanaRecipient.js"
  );

  await assert.rejects(
    () =>
      resolveNosanaRecipient("missing-job", {
        getJobStatus: makeJobFetcher({}),
      }),
    /not found|missing/i,
  );
});

test("resolveNosanaRecipient: re-throws fetch errors with job context", async () => {
  setupEnv();
  const { resolveNosanaRecipient } = await import(
    "../services/resolveNosanaRecipient.js"
  );

  await assert.rejects(
    () =>
      resolveNosanaRecipient("error-job", {
        getJobStatus: makeJobFetcher({
          "error-job": new Error("rpc timeout"),
        }),
      }),
    /rpc timeout/i,
  );
});

test("resolveNosanaRecipient: throws on empty pubkey string (corrupt SDK response)", async () => {
  setupEnv();
  const { resolveNosanaRecipient } = await import(
    "../services/resolveNosanaRecipient.js"
  );

  // If the SDK contract changed and we got an empty string instead of
  // undefined, fail loud rather than passing it down to a Solana SDK that
  // would build an invalid PublicKey.
  await assert.rejects(
    () =>
      resolveNosanaRecipient("blank-host", {
        getJobStatus: makeJobFetcher({
          "blank-host": {
            id: "blank-host",
            market: "M",
            status: "running",
            nodePubkey: "",
          },
        }),
      }),
    /no host|nodePubkey|not assigned/i,
  );
});

// ----------------------------------------------------------------------
// makeNosanaRecipientResolver — returns the right shape for buildSubmitPaymentsTickDeps
// ----------------------------------------------------------------------

test("makeNosanaRecipientResolver: returns an async function with the right signature", async () => {
  setupEnv();
  const { makeNosanaRecipientResolver } = await import(
    "../services/resolveNosanaRecipient.js"
  );

  const resolveRecipient = makeNosanaRecipientResolver({
    getJobStatus: makeJobFetcher({
      "job-x": {
        id: "job-x",
        market: "M",
        status: "running",
        nodePubkey: HOST_PUBKEY,
      },
    }),
  });

  const recipient = await resolveRecipient("job-x");
  assert.equal(recipient, HOST_PUBKEY);
});
