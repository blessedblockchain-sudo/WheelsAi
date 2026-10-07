/**
 * Start-up warnings, in operator language, for optional settings whose
 * absence switches a customer-facing feature off. Customers read only that
 * the feature is temporarily unavailable; the setting at fault is named here,
 * once per process, so an operator finds it in the server log.
 *
 * Fine-tuning has its own readiness log (services/buildTrainingDeps.ts
 * logTrainingReadiness) and an operator section on GET /api/platform/compute.
 * An invalid skills configuration is logged by config/skills.ts; this file
 * covers the settings that are simply unset.
 */

import { env } from "../config/env.js";
import { getSkillsConfig } from "../config/skills.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("operator-readiness");

export interface OperatorReadinessInput {
  /** TRIAL_FUNDED_MESSAGE_CENTS, or undefined when unset. */
  trialFundedMessageCents: number | undefined;
  /** TAVILY_API_KEY is set (and the skills configuration parsed). */
  webSearchConfigured: boolean;
  /** SANDBOX_RUNNER_URL is set (and the skills configuration parsed). */
  sandboxConfigured: boolean;
  /** The skills configuration failed to parse; config/skills.ts logs that. */
  skillsConfigInvalid: boolean;
}

export interface OperatorReadinessWarning {
  setting: string;
  message: string;
}

/** The warnings for one configuration, without logging them. */
export function operatorReadinessWarnings(input: OperatorReadinessInput): OperatorReadinessWarning[] {
  const warnings: OperatorReadinessWarning[] = [];
  if (input.trialFundedMessageCents === undefined) {
    warnings.push({
      setting: "TRIAL_FUNDED_MESSAGE_CENTS",
      message:
        "TRIAL_FUNDED_MESSAGE_CENTS is not set: publishers cannot pay for Try it messages above the free daily ones (PATCH trial settings answers 501 trial_funding_not_configured)",
    });
  }
  // An invalid skills configuration is already logged with its reason.
  if (!input.skillsConfigInvalid) {
    if (!input.webSearchConfigured) {
      warnings.push({
        setting: "TAVILY_API_KEY",
        message: "TAVILY_API_KEY is not set: the web_search skill is unavailable",
      });
    }
    if (!input.sandboxConfigured) {
      warnings.push({
        setting: "SANDBOX_RUNNER_URL",
        message:
          "SANDBOX_RUNNER_URL is not set: the code_interpreter skill is unavailable and graph `code` nodes are refused",
      });
    }
  }
  return warnings;
}

function readInput(): OperatorReadinessInput {
  const skills = getSkillsConfig();
  return {
    trialFundedMessageCents: env.TRIAL_FUNDED_MESSAGE_CENTS,
    webSearchConfigured: skills.error === null && Boolean(skills.config.tavilyApiKey),
    sandboxConfigured: skills.error === null && skills.config.sandbox !== null,
    skillsConfigInvalid: skills.error !== null,
  };
}

/** Logs one warning per unset setting, once, at start-up. Never throws. */
export function logOperatorReadiness(
  log: { warn: (context: Record<string, unknown>, message: string) => void } = logger,
  read: () => OperatorReadinessInput = readInput,
): void {
  try {
    for (const warning of operatorReadinessWarnings(read())) {
      log.warn({ setting: warning.setting }, warning.message);
    }
  } catch (err) {
    log.warn({ err }, "Operator readiness could not be read at start-up");
  }
}
