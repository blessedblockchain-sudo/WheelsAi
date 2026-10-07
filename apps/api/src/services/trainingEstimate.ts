/**
 * The estimate shown before a training job starts: how long it is planned to
 * take, what that would cost, the run limit to suggest, and the most that
 * will be held.
 *
 * The time figures are PLANNING FIGURES (config/trainingCatalog.ts): nothing
 * has been measured on a GPU. The estimate says so in `basis`, and comes with
 * a low and a high bound so a page shows a range, not a promise. The money is
 * exact for a given time: the same per-second retail price a deployment on
 * the tier is billed at, in whole micro-dollars.
 *
 * Two clocks, kept apart:
 *   - the run limit counts from the trainer's start (model download, loading,
 *     training, the final upload); the trainer stops itself at it;
 *   - billable time counts from the Nosana job's start, which may include the
 *     image pull, and is capped by the hold (price x run limit).
 * So the suggested run limit is sized from the trainer's time alone, and the
 * cost estimate from the whole time, cut at the hold.
 *
 * Pure: every input is an argument.
 */

import {
  PLANNING_IMAGE_PULL_SECONDS,
  PLANNING_WRAP_UP_SECONDS,
  planningSetupSeconds,
  planningTokensPerSecond,
  TRAINING_FIGURES_BASIS,
  type TrainableModel,
  type TrainingMethod,
} from "../config/trainingCatalog.js";
import {
  resolveTrainingHyperparams,
  type TrainingHyperparams,
} from "./trainingJobDefinition.js";
import {
  trainingChargeCents,
  trainingHoldCents,
  trainingPriceMicroUsdPerSecond,
} from "./trainingBilling.js";

/** The run is planned to take between these multiples of the estimate. */
export const ESTIMATE_LOW_FACTOR = 0.6;
export const ESTIMATE_HIGH_FACTOR = 1.6;
/** The suggested run limit is this multiple of the trainer's planned time... */
export const SUGGESTED_RUN_LIMIT_FACTOR = 2;
/** ...and never under this. */
export const SUGGESTED_RUN_LIMIT_MIN_SECONDS = 900;

export interface TrainingEstimateInput {
  model: Pick<TrainableModel, "paramsBillions">;
  method: TrainingMethod;
  /** GB of GPU memory of the chosen tier. */
  tierVramGb: number;
  /** USD per second, retail: the tier's price in the table deployments are billed from. */
  pricePerSecondUsd: number;
  /** knownDatasetRowCount(dataset): a dataset whose rows are not counted cannot be estimated. */
  rows: number;
  /** Dataset.avgTokensPerRow from validation (characters / 4). */
  avgTokensPerRow: number;
  hyperparams: TrainingHyperparams;
  /** trainingRunLimitBounds(...): what the user may choose. */
  runLimit: { minSeconds: number; maxSeconds: number };
  /** The run limit the user chose, when they have. Otherwise the suggestion is used. */
  maxRuntimeSeconds?: number;
}

export interface TrainingEstimate {
  /** Always "planning" until the figures are measured. */
  basis: typeof TRAINING_FIGURES_BASIS;
  trainTokens: number;
  steps: number;
  tokensPerSecond: number;
  /** Planned seconds of each part. */
  seconds: {
    imagePull: number;
    setup: number;
    train: number;
    wrapUp: number;
    /** What the trainer's own clock is planned to count (setup + train + wrapUp). */
    trainer: number;
    /** What may be billed (imagePull + trainer). */
    total: number;
  };
  /** Planned billable seconds and their cost, each cut at the hold. */
  estimate: { seconds: number; cents: bigint };
  low: { seconds: number; cents: bigint };
  high: { seconds: number; cents: bigint };
  pricePerSecondUsd: number;
  priceMicroUsdPerSecond: bigint;
  runLimit: {
    minSeconds: number;
    maxSeconds: number;
    /** A whole number of minutes, inside the bounds. */
    suggestedSeconds: number;
    /** The limit the figures below are worked out for: the user's, else the suggestion. */
    appliedSeconds: number;
  };
  /** The hold: price x the applied run limit. The most the job can cost. */
  maximumCents: bigint;
  /**
   * True when even the high bound of the trainer's planned time fits in the
   * applied run limit. False means the run is planned to stop at its limit
   * with a partial adapter (and is still charged for the time run).
   */
  fitsRunLimit: boolean;
  /** True when the suggestion had to be cut to the longest limit allowed. */
  suggestionCapped: boolean;
}

export type TrainingEstimateResult =
  | { ok: true; estimate: TrainingEstimate }
  | { ok: false; code: "invalid_estimate_input" | "run_limit_out_of_range"; message: string };

const isPositiveFinite = (value: number) => Number.isFinite(value) && value > 0;

export function estimateTraining(input: TrainingEstimateInput): TrainingEstimateResult {
  if (!Number.isSafeInteger(input.rows) || input.rows < 1) {
    return { ok: false, code: "invalid_estimate_input", message: "The dataset has no counted rows" };
  }
  if (!isPositiveFinite(input.avgTokensPerRow)) {
    return {
      ok: false,
      code: "invalid_estimate_input",
      message: "The dataset has no measured tokens per row",
    };
  }
  if (!isPositiveFinite(input.tierVramGb) || !Number.isFinite(input.pricePerSecondUsd) || input.pricePerSecondUsd < 0) {
    return { ok: false, code: "invalid_estimate_input", message: "The GPU tier is not usable" };
  }
  const { minSeconds, maxSeconds } = input.runLimit;
  if (!Number.isSafeInteger(minSeconds) || !Number.isSafeInteger(maxSeconds) || maxSeconds < minSeconds) {
    return {
      ok: false,
      code: "run_limit_out_of_range",
      message: "Fine-tuning is temporarily unavailable. Try again later.",
    };
  }
  if (
    input.maxRuntimeSeconds !== undefined &&
    (!Number.isSafeInteger(input.maxRuntimeSeconds) ||
      input.maxRuntimeSeconds < minSeconds ||
      input.maxRuntimeSeconds > maxSeconds)
  ) {
    return {
      ok: false,
      code: "run_limit_out_of_range",
      message: `The run limit must be from ${minSeconds} to ${maxSeconds} seconds`,
    };
  }

  const hp = resolveTrainingHyperparams(input.hyperparams);
  const tokensPerRow = Math.min(input.avgTokensPerRow, hp.maxSeqLength);
  const rowsPerStep = hp.batchSize * hp.gradientAccumulationSteps;
  const stepsPerEpoch = Math.ceil(input.rows / rowsPerStep);
  const fullSteps = stepsPerEpoch * hp.epochs;
  const steps = hp.maxSteps === null ? fullSteps : Math.min(fullSteps, hp.maxSteps);
  // maxSteps cuts the run short: only the rows those steps read are trained on.
  const trainTokens = Math.ceil(
    Math.min(input.rows * hp.epochs, steps * rowsPerStep) * tokensPerRow,
  );

  const tokensPerSecond = planningTokensPerSecond(input.model, input.method, input.tierVramGb);
  const setup = planningSetupSeconds(input.model);
  const train = Math.ceil(trainTokens / tokensPerSecond);
  const trainer = setup + train + PLANNING_WRAP_UP_SECONDS;
  const total = PLANNING_IMAGE_PULL_SECONDS + trainer;

  const wanted = Math.max(
    SUGGESTED_RUN_LIMIT_MIN_SECONDS,
    Math.ceil((trainer * SUGGESTED_RUN_LIMIT_FACTOR) / 60) * 60,
  );
  // Down to a whole minute inside the bounds, unless the bounds leave none.
  const cappedTo = Math.max(minSeconds, Math.floor(maxSeconds / 60) * 60);
  const suggestedSeconds = Math.min(Math.max(wanted, minSeconds), cappedTo);
  const appliedSeconds = input.maxRuntimeSeconds ?? suggestedSeconds;

  const priceMicroUsdPerSecond = trainingPriceMicroUsdPerSecond(input.pricePerSecondUsd);
  const maximumCents = trainingHoldCents(priceMicroUsdPerSecond, appliedSeconds);
  const priced = (seconds: number) => {
    const whole = Math.max(1, Math.round(seconds));
    return {
      // What is billed is cut at the run limit, as the charge is cut at the hold.
      seconds: Math.min(whole, appliedSeconds),
      cents: trainingChargeCents({
        priceMicroUsdPerSecond,
        billableMs: whole * 1000,
        holdCents: maximumCents,
      }),
    };
  };

  return {
    ok: true,
    estimate: {
      basis: TRAINING_FIGURES_BASIS,
      trainTokens,
      steps,
      tokensPerSecond,
      seconds: {
        imagePull: PLANNING_IMAGE_PULL_SECONDS,
        setup,
        train,
        wrapUp: PLANNING_WRAP_UP_SECONDS,
        trainer,
        total,
      },
      estimate: priced(total),
      low: priced(total * ESTIMATE_LOW_FACTOR),
      high: priced(total * ESTIMATE_HIGH_FACTOR),
      pricePerSecondUsd: input.pricePerSecondUsd,
      priceMicroUsdPerSecond,
      runLimit: { minSeconds, maxSeconds, suggestedSeconds, appliedSeconds },
      maximumCents,
      fitsRunLimit: trainer * ESTIMATE_HIGH_FACTOR <= appliedSeconds,
      suggestionCapped: wanted > cappedTo,
    },
  };
}
