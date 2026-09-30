-- Email verification + password reset tokens (hash only), and the
-- once-per-organization signup bonus guard.

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN "signup_bonus_granted_at" TIMESTAMP(3);

-- Organizations created before this migration were granted the $5 bonus
-- at signup; mark them so verification never grants it twice.
UPDATE "organizations" o
SET "signup_bonus_granted_at" = o."created_at"
WHERE EXISTS (
  SELECT 1 FROM "credit_transactions" t
  WHERE t."org_id" = o."id" AND t."type" = 'bonus' AND t."description" = 'Signup bonus'
);

-- CreateTable
CREATE TABLE "email_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_tokens_token_hash_key" ON "email_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "email_tokens_user_id_purpose_idx" ON "email_tokens"("user_id", "purpose");

-- AddForeignKey
ALTER TABLE "email_tokens" ADD CONSTRAINT "email_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
