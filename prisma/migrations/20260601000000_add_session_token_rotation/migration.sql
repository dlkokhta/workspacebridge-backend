-- Session refresh-token rotation columns.
-- These columns already exist in databases that were updated outside migration
-- history (via `db push`/manual change), including production. `IF NOT EXISTS`
-- makes this backfill safe to apply on such databases without erroring, while
-- still creating the columns on fresh databases.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "previous_refresh_token" TEXT;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "token_rotated_at" TIMESTAMP(3);
