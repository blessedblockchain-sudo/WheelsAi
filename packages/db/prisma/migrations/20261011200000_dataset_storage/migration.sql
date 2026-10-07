-- Dataset storage and validation (fine-tuning, object storage step).
--
-- Until now one column, "format", held three different things at different
-- times: the file's encoding, the row format the uploader declared, and
-- (after the first validation overwrote it) the row format that was detected.
-- A second validation then read the detected value as a file type and failed.
-- They are separate columns from here on:
--
--   file_type          jsonl | csv | parquet. Decides the parser.
--   format             what the uploader declared. Never overwritten again.
--   schema_format      what validation detected in the rows.
--
-- Also:
--   row_count_known    false when the rows could not be counted (a Parquet
--                      file whose footer could not be read). A flag, not a
--                      nullable row_count: every existing reader keeps
--                      compiling and keeps reading an integer. row_count is
--                      then a placeholder 0: nothing may show it as "empty"
--                      or work a price out from it.
--   avg_tokens_per_row,
--   total_tokens       measured by validation over every valid row, for the
--                      cost estimate.
--   content_sha256,
--   content_etag       what validation read: the sha256 of the object's bytes
--                      and the store's ETag at that moment. An upload link can
--                      be used again until it expires, so the counts are only
--                      good for these bytes; a training run pins the sha256.
--   deleted_at         soft delete. Finished training jobs keep their dataset
--                      row; the stored object is removed.
--   live_name          the name while the dataset is live, NULL once deleted.
--                      The unique index moves from (org_id, name) to
--                      (org_id, live_name): NULLs never collide, so a deleted
--                      dataset keeps its name for history and the name is free
--                      for a new upload.

-- AlterTable
ALTER TABLE "datasets"
    ADD COLUMN "live_name" TEXT,
    ADD COLUMN "file_type" TEXT NOT NULL DEFAULT 'jsonl',
    ADD COLUMN "schema_format" TEXT,
    ADD COLUMN "row_count_known" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "avg_tokens_per_row" INTEGER,
    ADD COLUMN "total_tokens" BIGINT,
    ADD COLUMN "content_sha256" TEXT,
    ADD COLUMN "content_etag" TEXT,
    ADD COLUMN "deleted_at" TIMESTAMP(3);

-- Backfill. Every existing dataset is live.
UPDATE "datasets" SET "live_name" = "name";

-- The file type of an existing row: its declared format when that names a
-- file type, otherwise the extension of the stored object.
UPDATE "datasets"
SET "file_type" = CASE
    WHEN "format" IN ('csv', 'parquet') THEN "format"
    WHEN lower("storage_url") LIKE '%.csv' THEN 'csv'
    WHEN lower("storage_url") LIKE '%.parquet' THEN 'parquet'
    ELSE 'jsonl'
END;

-- Rows validated by the old code had "format" replaced by the detected row
-- format; that value is the schema format. (On a row that was never
-- validated the same value is only a declaration, and stays one.)
UPDATE "datasets"
SET "schema_format" = "format"
WHERE "is_validated" AND "format" IN ('alpaca', 'sharegpt', 'completion', 'text');

-- The old validator accepted every Parquet file with a row count of 0.
-- Validating one again counts its rows from the footer.
UPDATE "datasets" SET "row_count_known" = false WHERE "file_type" = 'parquet';

-- DropIndex
DROP INDEX "datasets_org_id_name_key";

-- CreateIndex
CREATE UNIQUE INDEX "datasets_org_id_live_name_key" ON "datasets"("org_id", "live_name");
