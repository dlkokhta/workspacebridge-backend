-- CreateTable
CREATE TABLE "file_comments" (
    "id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "author_id" TEXT,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "file_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "file_comments_file_id_created_at_idx" ON "file_comments"("file_id", "created_at");

-- AddForeignKey
ALTER TABLE "file_comments" ADD CONSTRAINT "file_comments_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_comments" ADD CONSTRAINT "file_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
