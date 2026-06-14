-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "email" TEXT,
ADD COLUMN     "ip" TEXT,
ADD COLUMN     "user_agent" TEXT;

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_action_idx" ON "audit_logs"("actor_id", "action");

-- CreateIndex
CREATE INDEX "audit_logs_email_idx" ON "audit_logs"("email");
