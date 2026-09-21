-- DropIndex
DROP INDEX "ComplianceRule_module_state_version_key";

-- AlterTable
ALTER TABLE "ComplianceRule" ADD COLUMN     "consultantId" TEXT;

-- CreateIndex
CREATE INDEX "ComplianceRule_consultantId_idx" ON "ComplianceRule"("consultantId");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceRule_consultantId_module_state_version_key" ON "ComplianceRule"("consultantId", "module", "state", "version");

-- AddForeignKey
ALTER TABLE "ComplianceRule" ADD CONSTRAINT "ComplianceRule_consultantId_fkey" FOREIGN KEY ("consultantId") REFERENCES "Consultant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

