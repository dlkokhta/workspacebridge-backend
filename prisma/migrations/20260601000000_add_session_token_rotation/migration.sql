-- Session refresh-token rotation columns.
-- These columns already existed in databases updated outside migration history
-- (via `db push`/manual change); this migration backfills the history so that
-- fresh databases reproduce the same schema. On the existing dev database it is
-- recorded as already-applied via `prisma migrate resolve --applied`.
ALTER TABLE "sessions" ADD COLUMN "previous_refresh_token" TEXT;
ALTER TABLE "sessions" ADD COLUMN "token_rotated_at" TIMESTAMP(3);
