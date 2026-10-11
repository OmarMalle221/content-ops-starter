-- CreateEnum
CREATE TYPE "WebAuthnChallengePurpose" AS ENUM ('REGISTRATION', 'AUTHENTICATION', 'STEP_UP');

-- CreateEnum
CREATE TYPE "CounterpartyLinkStatus" AS ENUM ('NONE', 'PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED');

-- CreateEnum
CREATE TYPE "RegulatoryGateStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'PENDING_SECOND_APPROVAL', 'SATISFIED', 'REVOKED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MaintenanceJobName" ADD VALUE 'ENCRYPTION_KEY_ROTATION';
ALTER TYPE "MaintenanceJobName" ADD VALUE 'REVIEW_SLA';
ALTER TYPE "MaintenanceJobName" ADD VALUE 'AUTH_CLEANUP';

-- AlterTable
ALTER TABLE "Counterparty" ADD COLUMN     "linkDecidedAt" TIMESTAMP(3),
ADD COLUMN     "linkDecidedByUserId" UUID,
ADD COLUMN     "linkRequestedAt" TIMESTAMP(3),
ADD COLUMN     "linkRequestedOrganizationId" UUID,
ADD COLUMN     "linkStatus" "CounterpartyLinkStatus" NOT NULL DEFAULT 'NONE';

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "encryptionKeyId" TEXT,
ADD COLUMN     "storageDriver" TEXT NOT NULL DEFAULT 'local';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "taxBps" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "MaintenanceRun" ADD COLUMN     "heartbeatAt" TIMESTAMP(3),
ADD COLUMN     "instanceId" TEXT;

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "taxBps" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "RiskAlert" ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "assignedToUserId" UUID,
ADD COLUMN     "dueAt" TIMESTAMP(3),
ADD COLUMN     "firstActionAt" TIMESTAMP(3),
ADD COLUMN     "slaBreachedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mfaLastUsedStep" BIGINT;

-- CreateTable
CREATE TABLE "WebAuthnCredential" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "deviceType" TEXT,
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "aaguid" TEXT,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "WebAuthnCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthChallenge" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "sessionId" UUID,
    "purpose" "WebAuthnChallengePurpose" NOT NULL,
    "challenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MfaRecoveryCode" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaRecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobLease" (
    "jobName" "MaintenanceJobName" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "runId" UUID,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobLease_pkey" PRIMARY KEY ("jobName")
);

-- CreateTable
CREATE TABLE "RegulatoryGate" (
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "referenceDoc" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "status" "RegulatoryGateStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "evidenceRef" TEXT,
    "notes" TEXT,
    "firstApproverId" UUID,
    "firstApprovedAt" TIMESTAMP(3),
    "secondApproverId" UUID,
    "secondApprovedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegulatoryGate_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "RegulatoryGateEvent" (
    "id" UUID NOT NULL,
    "gateCode" TEXT NOT NULL,
    "actorUserId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "fromStatus" "RegulatoryGateStatus",
    "toStatus" "RegulatoryGateStatus" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegulatoryGateEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebAuthnCredential_credentialId_key" ON "WebAuthnCredential"("credentialId");

-- CreateIndex
CREATE INDEX "WebAuthnCredential_userId_idx" ON "WebAuthnCredential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthChallenge_challenge_key" ON "AuthChallenge"("challenge");

-- CreateIndex
CREATE INDEX "AuthChallenge_userId_idx" ON "AuthChallenge"("userId");

-- CreateIndex
CREATE INDEX "AuthChallenge_expiresAt_idx" ON "AuthChallenge"("expiresAt");

-- CreateIndex
CREATE INDEX "MfaRecoveryCode_userId_idx" ON "MfaRecoveryCode"("userId");

-- CreateIndex
CREATE INDEX "RegulatoryGateEvent_gateCode_createdAt_idx" ON "RegulatoryGateEvent"("gateCode", "createdAt");

-- CreateIndex
CREATE INDEX "Counterparty_linkRequestedOrganizationId_linkStatus_idx" ON "Counterparty"("linkRequestedOrganizationId", "linkStatus");

-- CreateIndex
CREATE INDEX "RiskAlert_assignedToUserId_status_idx" ON "RiskAlert"("assignedToUserId", "status");

-- CreateIndex
CREATE INDEX "RiskAlert_status_dueAt_idx" ON "RiskAlert"("status", "dueAt");

-- AddForeignKey
ALTER TABLE "RiskAlert" ADD CONSTRAINT "RiskAlert_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebAuthnCredential" ADD CONSTRAINT "WebAuthnCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaRecoveryCode" ADD CONSTRAINT "MfaRecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegulatoryGate" ADD CONSTRAINT "RegulatoryGate_firstApproverId_fkey" FOREIGN KEY ("firstApproverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegulatoryGate" ADD CONSTRAINT "RegulatoryGate_secondApproverId_fkey" FOREIGN KEY ("secondApproverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegulatoryGateEvent" ADD CONSTRAINT "RegulatoryGateEvent_gateCode_fkey" FOREIGN KEY ("gateCode") REFERENCES "RegulatoryGate"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegulatoryGateEvent" ADD CONSTRAINT "RegulatoryGateEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- Data backfill (phase 6)
-- ─────────────────────────────────────────────────────────────────────────────

-- Persisted tax rate, recovered from the stored amounts (half-up). New rows store it directly.
UPDATE "Invoice"
SET "taxBps" = CASE WHEN "subtotalMinor" > 0 THEN ROUND("taxMinor" * 10000.0 / "subtotalMinor")::int ELSE 0 END;
UPDATE "Quote"
SET "taxBps" = CASE WHEN "subtotalMinor" > 0 THEN ROUND("taxMinor" * 10000.0 / "subtotalMinor")::int ELSE 0 END;

-- Links created before the consent workflow existed are kept as accepted.
UPDATE "Counterparty"
SET "linkStatus" = 'ACCEPTED', "linkDecidedAt" = "updatedAt"
WHERE "linkedOrganizationId" IS NOT NULL;

-- Review-queue SLA for alerts still open (HIGH 24 h, MEDIUM 72 h, LOW 168 h).
UPDATE "RiskAlert"
SET "dueAt" = "createdAt" + CASE "severity"
    WHEN 'HIGH' THEN INTERVAL '24 hours'
    WHEN 'MEDIUM' THEN INTERVAL '72 hours'
    ELSE INTERVAL '168 hours' END
WHERE "status" IN ('OPEN', 'REVIEWING', 'CONTESTED') AND "dueAt" IS NULL;

-- Regulatory gates R1–R10 (ROADMAP §10). Tracking only: no status ever switches DFN_MODE.
INSERT INTO "RegulatoryGate" ("code", "title", "jurisdiction", "referenceDoc", "level", "updatedAt") VALUES
  ('R1', 'Avis juridique écrit sur la qualification des activités (Protect, Wallet, Transfer) et le modèle « fonds détenus par un partenaire agréé »', 'Canada, Québec, Sénégal, Guinée', 'docs/compliance/README.md', 'BLOCKING', CURRENT_TIMESTAMP),
  ('R2', 'Fournisseur KYC/KYB et criblage sanctions contractualisé ; fin des statuts SIMULATED_* en production', 'Toutes', 'docs/compliance/KYC_KYB.md', 'BLOCKING', CURRENT_TIMESTAMP),
  ('R3', 'Inscription ESM auprès de CANAFE (ou confirmation écrite de non-assujettissement) ; programme LBC/FT approuvé', 'Canada', 'docs/compliance/CANADA_CANAFE.md', 'BLOCKING', CURRENT_TIMESTAMP),
  ('R4', 'Enregistrement fournisseur de services de paiement (Banque du Canada, LAPD) ou analyse d''exclusion validée ; protection des fonds', 'Canada', 'docs/compliance/CANADA_BANQUE_DU_CANADA.md', 'BLOCKING', CURRENT_TIMESTAMP),
  ('R5', 'Permis d''entreprise de services monétaires (AMF) ou confirmation de non-assujettissement', 'Québec', 'docs/compliance/QUEBEC_ESM.md', 'BLOCKING', CURRENT_TIMESTAMP),
  ('R6', 'Partenariat avec une banque / un EME agréé BCEAO et conformité change ; équivalent BCRG pour la Guinée', 'UEMOA, Guinée', 'docs/compliance/SENEGAL_BCEAO.md', 'BLOCKING', CURRENT_TIMESTAMP),
  ('R7', 'Protection des données : EFVP (Loi 25), déclarations CDP, transferts transfrontaliers, registre d''incidents', 'Toutes', 'docs/compliance/DATA_PROTECTION.md', 'BLOCKING', CURRENT_TIMESTAMP),
  ('R8', 'Audit de sécurité indépendant (test d''intrusion, revue du registre et des gardes), plan de reprise testé', '—', 'SECURITY.md', 'BLOCKING', CURRENT_TIMESTAMP),
  ('R9', 'Assurance responsabilité / cyber, conditions d''utilisation et politique de litiges validées par un conseil', 'Canada, Québec', 'docs/compliance/DISPUTE_HANDLING.md', 'STRONG', CURRENT_TIMESTAMP),
  ('R10', 'Activité DDA : avis juridique spécifique, aucun lancement sans cadre explicite', 'Canada, UEMOA', 'docs/compliance/STABLECOIN_RISKS.md', 'ABSOLUTE', CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
