-- Monotonic insertion sequence on ledger entries (commit order under the account lock) so that
-- balance snapshots and reconciliation partition entries on `seq` instead of timestamps.
ALTER TABLE "LedgerEntry" ADD COLUMN "seq" BIGSERIAL NOT NULL;
CREATE UNIQUE INDEX "LedgerEntry_seq_key" ON "LedgerEntry"("seq");

-- Highest entry sequence included in a snapshot (NULL for snapshots taken before this migration).
ALTER TABLE "BalanceSnapshot" ADD COLUMN "lastSeq" BIGINT;
