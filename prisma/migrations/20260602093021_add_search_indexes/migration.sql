-- Global search: full-text indexes.
--
-- We index the searchable text columns with functional GIN indexes over
-- `to_tsvector('english', ...)`. This keeps the Prisma schema untouched (no
-- generated `tsvector` columns), stays purely additive, and lets Postgres
-- answer `@@ to_tsquery(...)` lookups from the index instead of scanning the
-- whole table — so search stays fast once a workspace has months of history.
--
-- Every statement is idempotent (`IF NOT EXISTS`): this DB has drifted from
-- migration history before, so re-running must never fail.

-- Messages: chat content.
CREATE INDEX IF NOT EXISTS "messages_content_fts_idx"
  ON "messages" USING gin (to_tsvector('english', "content"));

-- Files: filename.
CREATE INDEX IF NOT EXISTS "files_name_fts_idx"
  ON "files" USING gin (to_tsvector('english', "name"));

-- File comments: contextual discussion on a file.
CREATE INDEX IF NOT EXISTS "file_comments_body_fts_idx"
  ON "file_comments" USING gin (to_tsvector('english', "body"));

-- Shared tasks: collaborative todo titles.
CREATE INDEX IF NOT EXISTS "shared_tasks_title_fts_idx"
  ON "shared_tasks" USING gin (to_tsvector('english', "title"));

-- Private tasks: freelancer-only todo titles.
CREATE INDEX IF NOT EXISTS "private_tasks_title_fts_idx"
  ON "private_tasks" USING gin (to_tsvector('english', "title"));

-- Shared links: title and url combined so a search hits either.
CREATE INDEX IF NOT EXISTS "shared_links_text_fts_idx"
  ON "shared_links" USING gin (to_tsvector('english', coalesce("title", '') || ' ' || "url"));

-- Whiteboard comments: notes pinned to board elements.
CREATE INDEX IF NOT EXISTS "whiteboard_comments_body_fts_idx"
  ON "whiteboard_comments" USING gin (to_tsvector('english', "body"));
