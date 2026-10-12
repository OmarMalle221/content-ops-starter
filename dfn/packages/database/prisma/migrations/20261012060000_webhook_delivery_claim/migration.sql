-- Webhook delivery claims are separated from the back-off schedule: an attempt owns the row through
-- a token until "claimedUntil", and only the holder of the token writes the outcome.
-- AlterTable
ALTER TABLE "WebhookDelivery" ADD COLUMN     "claimToken" UUID,
ADD COLUMN     "claimedUntil" TIMESTAMP(3);

-- Before this migration a claim was written to "nextAttemptAt". On a PENDING row (never attempted)
-- that column only ever held a claim: it moves to "claimedUntil" so that the claim keeps its expiry.
UPDATE "WebhookDelivery"
SET "claimedUntil" = "nextAttemptAt",
    "nextAttemptAt" = NULL
WHERE "status" = 'PENDING' AND "nextAttemptAt" IS NOT NULL;
