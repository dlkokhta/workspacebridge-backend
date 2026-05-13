-- CreateTable
CREATE TABLE "whiteboard_comments" (
    "id" TEXT NOT NULL,
    "whiteboard_id" TEXT NOT NULL,
    "element_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whiteboard_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whiteboard_comments_whiteboard_id_element_id_idx" ON "whiteboard_comments"("whiteboard_id", "element_id");

-- AddForeignKey
ALTER TABLE "whiteboard_comments" ADD CONSTRAINT "whiteboard_comments_whiteboard_id_fkey" FOREIGN KEY ("whiteboard_id") REFERENCES "whiteboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whiteboard_comments" ADD CONSTRAINT "whiteboard_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
