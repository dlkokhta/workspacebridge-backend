-- CreateTable
CREATE TABLE "private_tasks" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "title" TEXT NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'TODO',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "private_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "private_tasks_user_id_workspace_id_created_at_idx" ON "private_tasks"("user_id", "workspace_id", "created_at");

-- AddForeignKey
ALTER TABLE "private_tasks" ADD CONSTRAINT "private_tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_tasks" ADD CONSTRAINT "private_tasks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
