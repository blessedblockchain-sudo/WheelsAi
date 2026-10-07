import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import {
  createJobNotifier,
  deliverableReadyEmail,
  jobEventPayload,
  type JobEvent,
  type JobForNotice,
  type JobNotifierDeps,
} from "../services/jobNotifications.js";
import { WEBHOOK_EVENTS } from "../services/webhooks.js";

// Who is told what about a job, and what the message may contain.

const JOB: JobForNotice = {
  id: "job_1",
  offeringId: "off_1",
  buyerId: "org_buyer",
  publisherId: "org_pub",
  status: "submitted",
  priceCents: 2_000n,
  deadlineAt: new Date("2026-10-06T13:00:00Z"),
  reviewDeadlineAt: new Date("2026-10-09T12:30:00Z"),
  title: 'Competitor <teardown> & "more"',
};

function setup(overrides: Partial<JobNotifierDeps> = {}) {
  const webhooks: Array<{ orgId: string; event: JobEvent; data: Record<string, unknown> }> = [];
  const emails: Array<{ to: string; subject: string; text: string; html: string }> = [];
  const errors: string[] = [];
  const notify = createJobNotifier({
    loadJob: async () => JOB,
    sendWebhook: async (orgId, event, data) => {
      webhooks.push({ orgId, event, data });
    },
    emailConfigured: () => true,
    ownerEmail: async () => "buyer@example.com",
    sendEmail: async (message) => {
      emails.push(message);
    },
    webUrl: "https://app.example.com/",
    onError: (what) => errors.push(what),
    ...overrides,
  });
  return { notify, webhooks, emails, errors };
}

test("every job event is one an organization can subscribe a webhook to", () => {
  for (const event of [
    "job.funded",
    "job.submitted",
    "job.completed",
    "job.rejected",
    "job.failed",
    "job.expired",
    "job.cancelled",
  ] as const) {
    assert.ok(WEBHOOK_EVENTS.includes(event), event);
  }
});

test("job.funded goes to the publisher, job.submitted to the buyer, the rest to both", async () => {
  const recipients = async (event: JobEvent) => {
    const s = setup();
    await s.notify(event, "job_1");
    return s.webhooks.map((w) => w.orgId).sort();
  };
  assert.deepEqual(await recipients("job.funded"), ["org_pub"]);
  assert.deepEqual(await recipients("job.submitted"), ["org_buyer"]);
  for (const event of ["job.completed", "job.rejected", "job.failed", "job.expired", "job.cancelled"] as const) {
    assert.deepEqual(await recipients(event), ["org_buyer", "org_pub"], event);
  }
});

test("a payload carries ids, status, price and deadlines, and nothing of the work", () => {
  assert.deepEqual(jobEventPayload(JOB), {
    jobId: "job_1",
    offeringId: "off_1",
    status: "submitted",
    priceCents: 2_000,
    deadlineAt: "2026-10-06T13:00:00.000Z",
    reviewDeadlineAt: "2026-10-09T12:30:00.000Z",
  });
});

test("the deliverable-ready email goes to the buyer's owner with the review deadline and a link", async () => {
  const s = setup();
  await s.notify("job.submitted", "job_1");
  assert.equal(s.emails.length, 1);
  const [email] = s.emails;
  assert.equal(email!.to, "buyer@example.com");
  assert.match(email!.text, /2026-10-09 12:30 UTC/);
  assert.match(email!.text, /https:\/\/app\.example\.com\/dashboard\/jobs\/job_1/);
  assert.match(email!.text, /completes by itself/);
  // The title is the publisher's text: escaped in the HTML part.
  assert.ok(email!.html.includes("Competitor &lt;teardown&gt; &amp; &quot;more&quot;"));
  assert.ok(!email!.html.includes("<teardown>"));

  // No other event emails anyone.
  const other = setup();
  await other.notify("job.completed", "job_1");
  assert.equal(other.emails.length, 0);
});

test("with no email provider configured no email is sent, and the webhook still is", async () => {
  const s = setup({ emailConfigured: () => false });
  await s.notify("job.submitted", "job_1");
  assert.equal(s.emails.length, 0);
  assert.equal(s.webhooks.length, 1);
  assert.deepEqual(s.errors, []);
});

test("without a dashboard URL the email has no link rather than a broken one", () => {
  const email = deliverableReadyEmail("a@example.com", JOB, null);
  assert.ok(!email.text.includes("http"));
  assert.ok(!email.html.includes("<a "));
});

test("a notification never throws: a failed webhook, email or load is reported and swallowed", async () => {
  const webhook = setup({
    sendWebhook: async () => {
      throw new Error("endpoint down");
    },
  });
  await webhook.notify("job.submitted", "job_1");
  assert.deepEqual(webhook.errors, ["webhook"]);
  // The email is still attempted.
  assert.equal(webhook.emails.length, 1);

  const email = setup({
    sendEmail: async () => {
      throw new Error("provider 500");
    },
  });
  await email.notify("job.submitted", "job_1");
  assert.deepEqual(email.errors, ["email"]);

  const load = setup({
    loadJob: async () => {
      throw new Error("db down");
    },
  });
  await load.notify("job.submitted", "job_1");
  assert.deepEqual(load.errors, ["load"]);

  const gone = setup({ loadJob: async () => null });
  await gone.notify("job.submitted", "job_1");
  assert.equal(gone.webhooks.length, 0);
});
