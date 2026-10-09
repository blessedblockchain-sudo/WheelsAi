/**
 * The Monitoring page's channel form. Run with:
 *   cd apps/web && npx tsx --test src/lib/alert-channel-form.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALERT_CHANNEL_MESSAGES,
  ALERT_CHANNEL_TARGETS,
  ALERT_CHANNEL_TYPES,
  alertChannelBody,
  alertChannelServerErrors,
  emailsOf,
} from "./alert-channel-form";

test("each kind of channel is saved under its own setting", () => {
  const link = "https://hooks.example.com/abc";
  assert.deepEqual(alertChannelBody({ name: " Team ", type: "slack", target: ` ${link} ` }), {
    body: { name: "Team", type: "slack", config: { webhookUrl: link } },
    errors: {},
  });
  assert.deepEqual(alertChannelBody({ name: "Team", type: "discord", target: link }).body.config, { webhookUrl: link });
  assert.deepEqual(alertChannelBody({ name: "Team", type: "webhook", target: link }).body.config, { url: link });
  assert.deepEqual(
    alertChannelBody({ name: "Team", type: "email", target: "a@example.com, b@example.com\nc@example.com" }).body.config,
    { emails: ["a@example.com", "b@example.com", "c@example.com"] },
  );
});

test("what is wrong goes under the input it is about", () => {
  assert.deepEqual(alertChannelBody({ name: "", type: "slack", target: "" }).errors, {
    name: ALERT_CHANNEL_MESSAGES.name,
    target: ALERT_CHANNEL_MESSAGES.link,
  });
  assert.equal(alertChannelBody({ name: "x", type: "webhook", target: "ftp://example.com" }).errors.target, ALERT_CHANNEL_MESSAGES.link);
  assert.equal(alertChannelBody({ name: "x", type: "email", target: " " }).errors.target, ALERT_CHANNEL_MESSAGES.noEmail);
  assert.equal(
    alertChannelBody({ name: "x", type: "email", target: "a@example.com, not-an-address" }).errors.target,
    '"not-an-address" is not an email address.',
  );
});

test("email addresses are split on commas, semicolons and spaces", () => {
  assert.deepEqual(emailsOf("a@x.io; b@x.io  c@x.io,"), ["a@x.io", "b@x.io", "c@x.io"]);
  assert.deepEqual(emailsOf(""), []);
});

test("every kind on the menu has a label for its input", () => {
  for (const type of ALERT_CHANNEL_TYPES) {
    assert.ok(ALERT_CHANNEL_TARGETS[type].label.length > 0);
    assert.ok(ALERT_CHANNEL_TARGETS[type].option.length > 0);
  }
});

test("a refusal's sentences go under the inputs, or to the form", () => {
  assert.deepEqual(
    alertChannelServerErrors({
      status: 400,
      data: { error: "validation_failed", message: "x", fields: { name: "Too long.", "config.webhookUrl": "Not a link." } },
    }),
    { name: "Too long.", target: "Not a link." },
  );
  assert.deepEqual(alertChannelServerErrors({ status: 400, data: { success: false, error: "name, type, and config are required" } }), {
    form: "name, type, and config are required",
  });
  assert.deepEqual(alertChannelServerErrors({ status: 400, data: { message: "That link was refused." } }), {
    form: "That link was refused.",
  });
  assert.deepEqual(alertChannelServerErrors(new Error("offline")), { form: ALERT_CHANNEL_MESSAGES.failed });
});
