import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import {
  logOperatorReadiness,
  operatorReadinessWarnings,
  type OperatorReadinessInput,
} from "../services/operatorReadiness.js";

// The start-up log for optional settings whose absence switches a
// customer-facing feature off. Customers read "temporarily unavailable"; the
// operator reads the setting here.

const allSet: OperatorReadinessInput = {
  trialFundedMessageCents: 2,
  webSearchConfigured: true,
  sandboxConfigured: true,
  skillsConfigInvalid: false,
};

test("nothing is logged when every optional setting is present", () => {
  assert.deepEqual(operatorReadinessWarnings(allSet), []);
});

test("each unset setting is named once, in operator language", () => {
  const warnings = operatorReadinessWarnings({
    trialFundedMessageCents: undefined,
    webSearchConfigured: false,
    sandboxConfigured: false,
    skillsConfigInvalid: false,
  });
  assert.deepEqual(
    warnings.map((w) => w.setting),
    ["TRIAL_FUNDED_MESSAGE_CENTS", "TAVILY_API_KEY", "SANDBOX_RUNNER_URL"],
  );
  for (const warning of warnings) assert.match(warning.message, new RegExp(`^${warning.setting} is not set: `));
  assert.match(warnings[0]!.message, /trial_funding_not_configured/);
  assert.match(warnings[2]!.message, /`code` nodes are refused/);
});

test("an invalid skills configuration is not reported twice as unset settings", () => {
  const warnings = operatorReadinessWarnings({
    ...allSet,
    webSearchConfigured: false,
    sandboxConfigured: false,
    skillsConfigInvalid: true,
  });
  assert.deepEqual(warnings, []);
});

test("the start-up log writes one line per warning and never throws", () => {
  const lines: Array<{ context: Record<string, unknown>; message: string }> = [];
  logOperatorReadiness(
    { warn: (context, message) => lines.push({ context, message }) },
    () => ({ ...allSet, trialFundedMessageCents: undefined }),
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.context.setting, "TRIAL_FUNDED_MESSAGE_CENTS");

  const failures: string[] = [];
  logOperatorReadiness({ warn: (_context, message) => failures.push(message) }, () => {
    throw new Error("unreadable");
  });
  assert.deepEqual(failures, ["Operator readiness could not be read at start-up"]);
});
