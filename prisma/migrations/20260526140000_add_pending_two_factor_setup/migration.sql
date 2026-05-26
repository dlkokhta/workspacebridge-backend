-- CreateTable
CREATE TABLE "pending_two_factor_setups" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_two_factor_setups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pending_two_factor_setups_user_id_key" ON "pending_two_factor_setups"("user_id");

-- CreateIndex
CREATE INDEX "pending_two_factor_setups_expires_at_idx" ON "pending_two_factor_setups"("expires_at");
