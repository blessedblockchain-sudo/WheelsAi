-- GPU-seconds on the ledger rows that charge for GPU time.
--
-- The Billing page showed "GPU hours" worked out from how long requests
-- took. What was charged for is known exactly when each row is written (the
-- seconds of the billing window and the replicas that ran; the seconds a
-- fine-tuning run was billed), and was kept only inside the row's
-- description. It now has its own column, so the page can add it up.
--
-- EXISTING ROWS. The figure is read back out of the description the API
-- itself wrote:
--   gpu_usage        "GPU usage (<tier> x<replicas>, <seconds>s[, ...])"
--                    gpu_seconds = replicas * seconds
--   training_usage   "Fine-tuning usage (<tier>, <seconds>s)"
--                    gpu_seconds = seconds
-- A row whose description does not have that shape keeps NULL: it is left
-- out of the hours rather than guessed at. No amount and no balance is
-- touched.

-- AlterTable
ALTER TABLE "credit_transactions" ADD COLUMN "gpu_seconds" BIGINT;

UPDATE "credit_transactions" t
SET "gpu_seconds" = (m.parts)[1]::BIGINT * (m.parts)[2]::BIGINT
FROM (
  SELECT "id", regexp_match("description", ' x(\d{1,6}), (\d{1,9})s') AS parts
  FROM "credit_transactions"
  WHERE lower("type") = 'gpu_usage'
) m
WHERE t."id" = m."id" AND m.parts IS NOT NULL;

UPDATE "credit_transactions" t
SET "gpu_seconds" = (m.parts)[1]::BIGINT
FROM (
  SELECT "id", regexp_match("description", ', (\d{1,9})s\)') AS parts
  FROM "credit_transactions"
  WHERE lower("type") = 'training_usage'
) m
WHERE t."id" = m."id" AND m.parts IS NOT NULL;
