-- Phase 7: KMS-managed data keys (envelope encryption), antivirus verdict and blob purge on
-- documents, operation-bound step-up challenges, new maintenance jobs.


-- CreateEnum
CREATE TYPE "EncryptionKeyStatus" AS ENUM ('STAGED', 'ACTIVE', 'DECRYPT_ONLY', 'RETIRED');

-- CreateEnum
CREATE TYPE "DocumentScanStatus" AS ENUM ('NOT_SCANNED', 'CLEAN', 'INFECTED', 'SKIPPED');

-- AlterEnum


ALTER TYPE "MaintenanceJobName" ADD VALUE 'KEY_LIFECYCLE';
ALTER TYPE "MaintenanceJobName" ADD VALUE 'DOCUMENT_PURGE';
ALTER TYPE "MaintenanceJobName" ADD VALUE 'STORAGE_MIGRATION';

-- AlterTable
ALTER TABLE "AuthChallenge" ADD COLUMN     "operation" TEXT;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "blobPurgedAt" TIMESTAMP(3),
ADD COLUMN     "scanEngine" TEXT,
ADD COLUMN     "scanStatus" "DocumentScanStatus" NOT NULL DEFAULT 'NOT_SCANNED',
ADD COLUMN     "scannedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "EncryptionKey" (
    "id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "status" "EncryptionKeyStatus" NOT NULL DEFAULT 'STAGED',
    "wrappedKey" BYTEA NOT NULL,
    "kmsProvider" TEXT NOT NULL,
    "kmsKeyRef" TEXT NOT NULL,
    "activateAfter" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "deactivatedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EncryptionKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EncryptionKey_purpose_status_idx" ON "EncryptionKey"("purpose", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EncryptionKey_purpose_keyId_key" ON "EncryptionKey"("purpose", "keyId");


-- At most one ACTIVE data key per purpose (lifecycle transitions are compare-and-set; this is the
-- database-level backstop against two replicas activating two keys at once).
CREATE UNIQUE INDEX "EncryptionKey_one_active_per_purpose" ON "EncryptionKey"("purpose") WHERE "status" = 'ACTIVE';
