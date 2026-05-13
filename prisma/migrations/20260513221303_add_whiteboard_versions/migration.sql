-- CreateEnum
CREATE TYPE "WhiteboardVersionType" AS ENUM ('MANUAL', 'AUTO');

-- CreateTable
CREATE TABLE "whiteboard_versions" (
    "id" TEXT NOT NULL,
    "whiteboard_id" TEXT NOT NULL,
    "elements" JSONB NOT NULL DEFAULT '[]',
    "app_state" JSONB,
    "files" JSONB,
    "label" TEXT,
    "type" "WhiteboardVersionType" NOT NULL DEFAULT 'MANUAL',
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whiteboard_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whiteboard_versions_whiteboard_id_created_at_idx" ON "whiteboard_versions"("whiteboard_id", "created_at");

-- AddForeignKey
ALTER TABLE "whiteboard_versions" ADD CONSTRAINT "whiteboard_versions_whiteboard_id_fkey" FOREIGN KEY ("whiteboard_id") REFERENCES "whiteboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whiteboard_versions" ADD CONSTRAINT "whiteboard_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
