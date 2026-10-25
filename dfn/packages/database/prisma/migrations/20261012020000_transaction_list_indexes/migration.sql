-- CreateIndex
CREATE INDEX "Transaction_buyerOrganizationId_updatedAt_idx" ON "Transaction"("buyerOrganizationId", "updatedAt");

-- CreateIndex
CREATE INDEX "Transaction_sellerOrganizationId_updatedAt_idx" ON "Transaction"("sellerOrganizationId", "updatedAt");

-- CreateIndex
CREATE INDEX "Transaction_updatedAt_idx" ON "Transaction"("updatedAt");

