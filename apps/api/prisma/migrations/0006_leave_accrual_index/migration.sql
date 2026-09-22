-- CreateIndex
CREATE INDEX "LeaveTransaction_companyId_leaveTypeId_type_note_idx" ON "LeaveTransaction"("companyId", "leaveTypeId", "type", "note");
