-- Fine-tuning: the training job lifecycle, its billing, and its result.
--
-- training_jobs gains what a job needs to be submitted, watched, cancelled
-- and paid for exactly once:
--
--   hyperparams            exactly the HYPERPARAMS object sent to the trainer.
--   dataset_sha256         the dataset bytes the run is pinned to.
--   failure_code           why a job failed, as a stable machine string.
--   current_step,
--   total_steps            progress as the trainer reports it.
--   max_runtime_seconds    the run limit the user chose: the trainer's own
--                          limit and what the credit hold is sized by.
--   nosana_timeout_seconds that plus the set-up allowance: the Nosana timeout.
--   submit_nonce,
--   submit_started_at      one submit attempt. The nonce is part of the
--                          deployment name, so a deployment whose id was never
--                          stored can still be found on Nosana.
--   queued_at,
--   cancel_requested_at,
--   gpu_stopped_at         lifecycle stamps. A cancelled run is never billed
--                          past cancel_requested_at.
--   last_event_seq,
--   last_event_at          the highest trainer event stored, and when.
--   reported_outcome       the trainer's own terminal event, as reported. A
--                          report, not a state.
--   last_reconciled_at     when the poller last took the job up: it takes the
--                          least recently examined first, so none is starved.
--   nosana_job_address     the on-chain job of the deployment.
--   reservation_cents      the hold taken when the job was created.
--   price_micro_usd_per_second
--                          the retail rate the job was admitted at.
--   billed_seconds,
--   settled_at             the settlement. settled_at is its idempotency key:
--                          the terminal compare-and-set requires it NULL.
--                          actual_cost_cents (already there) is the charge.
--
-- Existing rows keep every value they have. Their new columns are NULL
-- (last_event_seq is 0), their status is one of the six the old routes wrote
-- ('pending', 'queued', 'running', 'completed', 'failed', 'cancelled'), all of
-- which are still valid states, and nothing is backfilled: an old row never
-- held credits, so reservation_cents NULL is the truth and settling it moves
-- no money.
--
-- fine_tuned_models is the result of a completed job: an adapter the
-- organization owns. It is not a row of "models", the global catalog. It is
-- unique on training_job_id, so finalising a job twice finds the first row.
-- live_slug is the slug while the model is live and NULL once it is deleted
-- (the pattern of datasets.live_name): the unique index is on it.
--
-- deployments.fine_tuned_model_id names the adapter a deployment serves on
-- top of its base model. NULL for every existing deployment.
--
-- The two foreign keys that protect a referenced row are NO ACTION, not
-- RESTRICT: both refuse the delete, but NO ACTION is checked at the end of
-- the statement, so deleting an organization can cascade through both tables.

-- AlterTable
ALTER TABLE "training_jobs"
  ADD COLUMN "hyperparams" JSONB,
  ADD COLUMN "dataset_sha256" TEXT,
  ADD COLUMN "failure_code" TEXT,
  ADD COLUMN "current_step" INTEGER,
  ADD COLUMN "total_steps" INTEGER,
  ADD COLUMN "max_runtime_seconds" INTEGER,
  ADD COLUMN "nosana_timeout_seconds" INTEGER,
  ADD COLUMN "submit_nonce" TEXT,
  ADD COLUMN "submit_started_at" TIMESTAMP(3),
  ADD COLUMN "queued_at" TIMESTAMP(3),
  ADD COLUMN "cancel_requested_at" TIMESTAMP(3),
  ADD COLUMN "gpu_stopped_at" TIMESTAMP(3),
  ADD COLUMN "last_event_seq" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_event_at" TIMESTAMP(3),
  ADD COLUMN "reported_outcome" JSONB,
  ADD COLUMN "nosana_job_address" TEXT,
  ADD COLUMN "reservation_cents" BIGINT,
  ADD COLUMN "price_micro_usd_per_second" BIGINT,
  ADD COLUMN "billed_seconds" INTEGER,
  ADD COLUMN "settled_at" TIMESTAMP(3),
  ADD COLUMN "last_reconciled_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN "fine_tuned_model_id" UUID;

-- CreateTable
CREATE TABLE "fine_tuned_models" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "live_slug" TEXT,
    "base_model_id" TEXT NOT NULL,
    "base_model_hf_id" TEXT NOT NULL,
    "training_job_id" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "lora_r" INTEGER NOT NULL,
    "adapter_key" TEXT NOT NULL,
    "adapter_bytes" BIGINT NOT NULL,
    "adapter_sha256" TEXT NOT NULL,
    "metrics" JSONB,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "fine_tuned_models_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fine_tuned_models_training_job_id_key" ON "fine_tuned_models"("training_job_id");

-- CreateIndex
CREATE INDEX "fine_tuned_models_org_id_idx" ON "fine_tuned_models"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "fine_tuned_models_org_id_live_slug_key" ON "fine_tuned_models"("org_id", "live_slug");

-- CreateIndex
CREATE INDEX "deployments_fine_tuned_model_id_idx" ON "deployments"("fine_tuned_model_id");

-- CreateIndex
CREATE INDEX "training_jobs_org_id_status_idx" ON "training_jobs"("org_id", "status");

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_fine_tuned_model_id_fkey" FOREIGN KEY ("fine_tuned_model_id") REFERENCES "fine_tuned_models"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fine_tuned_models" ADD CONSTRAINT "fine_tuned_models_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fine_tuned_models" ADD CONSTRAINT "fine_tuned_models_base_model_id_fkey" FOREIGN KEY ("base_model_id") REFERENCES "models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fine_tuned_models" ADD CONSTRAINT "fine_tuned_models_training_job_id_fkey" FOREIGN KEY ("training_job_id") REFERENCES "training_jobs"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
