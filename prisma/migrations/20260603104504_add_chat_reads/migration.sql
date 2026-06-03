-- CreateTable
CREATE TABLE "chat_reads" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "last_read_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_reads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_reads_workspace_id_idx" ON "chat_reads"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_reads_workspace_id_user_id_key" ON "chat_reads"("workspace_id", "user_id");

-- AddForeignKey
ALTER TABLE "chat_reads" ADD CONSTRAINT "chat_reads_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_reads" ADD CONSTRAINT "chat_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
