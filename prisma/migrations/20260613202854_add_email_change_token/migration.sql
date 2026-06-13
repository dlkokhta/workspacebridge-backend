-- AlterEnum
ALTER TYPE "TokenType" ADD VALUE 'EMAIL_CHANGE';

-- AlterTable
ALTER TABLE "tokens" ADD COLUMN     "user_id" TEXT;
