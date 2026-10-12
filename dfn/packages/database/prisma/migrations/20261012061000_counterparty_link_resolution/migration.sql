-- Phase 7: e-mail link requests are resolved after the response. "linkResolvedAt" stays null while the
-- target lookup is due; the sweep resumes requests left unresolved by a stopped process.
-- AlterTable
ALTER TABLE "Counterparty" ADD COLUMN     "linkResolvedAt" TIMESTAMP(3);

-- Requests made before this migration were resolved synchronously: mark them resolved, so the sweep
-- never re-runs an old lookup (an account created since must not receive a request it never had).
UPDATE "Counterparty" SET "linkResolvedAt" = "linkRequestedAt" WHERE "linkRequestedAt" IS NOT NULL;
