-- A version created with an API key has no user behind it. Record the key
-- that acted instead of requiring a user id.
-- AlterTable
ALTER TABLE "agent_versions" ADD COLUMN     "created_by_api_key_id" UUID,
ALTER COLUMN "created_by_id" DROP NOT NULL;
