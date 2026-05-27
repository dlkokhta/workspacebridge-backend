-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- AlterTable
ALTER TABLE "shared_tasks" RENAME CONSTRAINT "tasks_pkey" TO "shared_tasks_pkey";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE';

-- RenameForeignKey
ALTER TABLE "shared_tasks" RENAME CONSTRAINT "tasks_created_by_id_fkey" TO "shared_tasks_created_by_id_fkey";

-- RenameForeignKey
ALTER TABLE "shared_tasks" RENAME CONSTRAINT "tasks_workspace_id_fkey" TO "shared_tasks_workspace_id_fkey";

-- RenameIndex
ALTER INDEX "tasks_workspace_id_created_at_idx" RENAME TO "shared_tasks_workspace_id_created_at_idx";
