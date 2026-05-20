-- DropForeignKey
ALTER TABLE "files" DROP CONSTRAINT "files_uploaded_by_id_fkey";

-- AlterTable
ALTER TABLE "files" ALTER COLUMN "uploaded_by_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
