-- Per-account lockout of second-factor codes (TOTP / recovery): counted per user, not per IP.
ALTER TABLE "User" ADD COLUMN     "mfaFailedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mfaLockedUntil" TIMESTAMP(3);
