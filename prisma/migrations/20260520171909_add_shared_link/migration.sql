-- CreateTable
CREATE TABLE "shared_links" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "added_by_id" TEXT,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shared_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shared_links_workspace_id_created_at_idx" ON "shared_links"("workspace_id", "created_at");

-- AddForeignKey
ALTER TABLE "shared_links" ADD CONSTRAINT "shared_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared_links" ADD CONSTRAINT "shared_links_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
