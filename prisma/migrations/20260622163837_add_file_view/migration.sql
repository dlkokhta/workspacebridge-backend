-- CreateTable
CREATE TABLE "file_views" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "file_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "file_views_workspace_id_idx" ON "file_views"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "file_views_workspace_id_user_id_key" ON "file_views"("workspace_id", "user_id");

-- AddForeignKey
ALTER TABLE "file_views" ADD CONSTRAINT "file_views_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_views" ADD CONSTRAINT "file_views_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
