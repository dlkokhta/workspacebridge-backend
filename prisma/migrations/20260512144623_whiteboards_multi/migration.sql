-- DropIndex
DROP INDEX "whiteboards_workspace_id_key";

-- AlterTable
ALTER TABLE "whiteboards" ADD COLUMN     "name" TEXT NOT NULL DEFAULT 'Untitled board';

-- CreateIndex
CREATE INDEX "whiteboards_workspace_id_idx" ON "whiteboards"("workspace_id");
