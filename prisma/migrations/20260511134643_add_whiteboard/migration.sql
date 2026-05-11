-- CreateTable
CREATE TABLE "whiteboards" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "elements" JSONB NOT NULL DEFAULT '[]',
    "app_state" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whiteboards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whiteboards_workspace_id_key" ON "whiteboards"("workspace_id");

-- AddForeignKey
ALTER TABLE "whiteboards" ADD CONSTRAINT "whiteboards_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
