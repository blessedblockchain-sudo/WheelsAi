/**
 * How GPU deployment outcomes are worded. Run with:
 *   cd apps/web && npx tsx --test src/lib/deployments.unit.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ApiError } from "./api";
import {
  COMPUTE_PAUSED_MESSAGE,
  deploymentEndNote,
  isComputePaused,
  stopConfirmation,
} from "./deployments";

const here = dirname(fileURLToPath(import.meta.url));
const page = (path: string) =>
  readFileSync(join(here, "../app/(dashboard)/dashboard/deployments", path), "utf8");

const paused = (reason: string) =>
  new ApiError(503, "Service Unavailable", {
    error: "compute_capacity_unavailable",
    reason,
    message: "New GPU deployments are paused while the platform's compute balance is topped up. Nothing was reserved.",
  });

test("503 compute_capacity_unavailable is 'paused', whatever the reason", () => {
  for (const reason of ["nosana_credits_low", "nosana_credits_unavailable", "nosana_auth_failed", "gpu_price_below_cost", "gpu_cost_unavailable"]) {
    assert.equal(isComputePaused(paused(reason)), true);
  }
});

test("other failures are not 'paused'", () => {
  assert.equal(isComputePaused(new ApiError(503, "Service Unavailable", { error: "nosana_unavailable" })), false);
  assert.equal(isComputePaused(new ApiError(402, "Payment Required", { error: "insufficient_credits" })), false);
  assert.equal(isComputePaused(new ApiError(500, "x", { error: "compute_capacity_unavailable" })), false);
  assert.equal(isComputePaused(new ApiError(503, "x", "<html>bad gateway</html>")), false);
  assert.equal(isComputePaused(new Error("network")), false);
  assert.equal(isComputePaused(null), false);
});

test("the paused message states no amount and no provider", () => {
  assert.equal(COMPUTE_PAUSED_MESSAGE, "GPU deployments are paused right now. Nothing was charged.");
});

test("a run that ended because the platform's compute balance ran out says so, and that the owner was not charged", () => {
  const note = deploymentEndNote("failed", "nosana_insufficient_funds");
  assert.ok(note);
  assert.match(note.body, /platform's compute balance ran out/);
  assert.match(note.body, /not charged for time after the stop/);
  assert.match(note.body, /start it again/);
});

test("a run refused inside the submit explains itself from the code, not the stored detail", () => {
  const note = deploymentEndNote(
    "failed",
    "nosana_credits_low: The platform's Nosana credits do not cover this deployment and the required floor",
  );
  assert.ok(note);
  assert.match(note.body, /GPU capacity was paused/);
  assert.doesNotMatch(`${note.title} ${note.body}`, /nosana|credits do not cover|floor/i);
});

test("the owner's own credits running out is told apart from the platform's", () => {
  const note = deploymentEndNote("stopped", "insufficient_credits");
  assert.ok(note);
  assert.match(note.title, /your credits ran out/);
});

test("no note for a deployment the owner stopped, a live one, or a reason this page does not know", () => {
  assert.equal(deploymentEndNote("stopped", "user_stopped"), null);
  assert.equal(deploymentEndNote("running", "nosana_insufficient_funds"), null);
  assert.equal(deploymentEndNote("failed", "nosana_create_failed: upstream said something internal"), null);
  assert.equal(deploymentEndNote("failed", null), null);
  assert.equal(deploymentEndNote("failed", undefined), null);
});

test("the stop toast does not promise a release the API has not confirmed", () => {
  assert.equal(stopConfirmation({ fundsReleased: true }), "Deployment stopped");
  assert.equal(stopConfirmation({}), "Deployment stopped");
  assert.equal(stopConfirmation({ fundsReleased: false }), "Deployment stopped. Its GPUs are winding down.");
});

test("no note or message mentions how the platform pays for GPUs", () => {
  const texts = [
    COMPUTE_PAUSED_MESSAGE,
    stopConfirmation({ fundsReleased: false }),
    ...["nosana_insufficient_funds", "nosana_credits_low", "insufficient_credits"].flatMap((r) => {
      const n = deploymentEndNote("failed", r)!;
      return [n.title, n.body];
    }),
  ];
  for (const text of texts) assert.doesNotMatch(text, /vault|wallet|\bNOS\b|nosana|api key/i);
});

test("the new-deployment page shows the paused message, disables Deploy and never prints the reason", () => {
  const source = page("new/page.tsx");
  assert.match(source, /isComputePaused\(error\)/);
  assert.match(source, /\{COMPUTE_PAUSED_MESSAGE\}/);
  assert.match(source, /disabled=\{computePaused\}/);
  assert.doesNotMatch(source, /\.reason\b/);
});

test("the deployment page explains an ended run and has no vault wording", () => {
  const source = page("[id]/page.tsx");
  assert.match(source, /deploymentEndNote\(deployment\.status, deployment\.statusReason\)/);
  assert.match(source, /stopConfirmation\(/);
  assert.match(source, /isComputePaused\(error\)/);
  for (const path of ["[id]/page.tsx", "new/page.tsx", "page.tsx"]) {
    assert.doesNotMatch(page(path), /vault/i, `${path} must not say vault`);
  }
});
