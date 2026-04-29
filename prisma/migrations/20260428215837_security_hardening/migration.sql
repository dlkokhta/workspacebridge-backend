/*
  Warnings:

  - The values [REGULAR] on the enum `UserRole` will be removed. If these variants are still used in the database, this will fail.
  - The `expires_at` column on the `accounts` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - A unique constraint covering the columns `[provider,provider_account_id]` on the table `accounts` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "UserRole_new" AS ENUM ('FREELANCER', 'CLIENT', 'ADMIN');
ALTER TABLE "public"."users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "role" TYPE "UserRole_new" USING (
  CASE "role"::text WHEN 'REGULAR' THEN 'FREELANCER' ELSE "role"::text END
)::"UserRole_new";
ALTER TYPE "UserRole" RENAME TO "UserRole_old";
ALTER TYPE "UserRole_new" RENAME TO "UserRole";
DROP TYPE "public"."UserRole_old";
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'FREELANCER';
COMMIT;

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "provider_account_id" TEXT,
DROP COLUMN "expires_at",
ADD COLUMN     "expires_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "tokens" ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "locked_until" TIMESTAMP(3),
ALTER COLUMN "role" SET DEFAULT 'FREELANCER';

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_provider_account_id_key" ON "accounts"("provider", "provider_account_id");

-- CreateIndex
CREATE INDEX "sessions_user_id_created_at_idx" ON "sessions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "tokens_email_type_idx" ON "tokens"("email", "type");

-- CreateIndex
CREATE INDEX "tokens_expires_in_idx" ON "tokens"("expires_in");
