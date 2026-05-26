-- CreateTable
CREATE TABLE "auth_exchange_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_exchange_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auth_exchange_codes_code_key" ON "auth_exchange_codes"("code");

-- CreateIndex
CREATE INDEX "auth_exchange_codes_expires_at_idx" ON "auth_exchange_codes"("expires_at");
