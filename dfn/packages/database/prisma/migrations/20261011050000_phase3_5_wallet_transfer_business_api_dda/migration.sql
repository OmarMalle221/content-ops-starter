-- CreateEnum
CREATE TYPE "CurrencyKind" AS ENUM ('FIAT', 'SIMULATED_ASSET');

-- CreateEnum
CREATE TYPE "FxQuoteStatus" AS ENUM ('QUOTED', 'USED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BeneficiaryMethod" AS ENUM ('BANK_ACCOUNT', 'MOBILE_MONEY');

-- CreateEnum
CREATE TYPE "BeneficiaryStatus" AS ENUM ('ACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CONVERTED');

-- CreateEnum
CREATE TYPE "InvoicePaymentMethod" AS ENUM ('WALLET_SIMULATED', 'PROTECT_RELEASE', 'EXTERNAL_RECORDED');

-- CreateEnum
CREATE TYPE "MaintenanceJobName" AS ENUM ('BALANCE_SNAPSHOTS', 'RECONCILIATION', 'EXPIRE_STALE', 'ANONYMIZE_DELETED', 'TRANSFER_PROCESSING', 'WEBHOOK_RETRY', 'INVOICE_OVERDUE');

-- CreateEnum
CREATE TYPE "MaintenanceRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'EXHAUSTED');

-- CreateEnum
CREATE TYPE "DdaOperation" AS ENUM ('MINT', 'TRANSFER', 'REDEEM', 'RESERVE_ADJUSTMENT');

-- DropIndex
DROP INDEX "DigitalAssetSimulation_organizationId_idx";

-- DropIndex
DROP INDEX "FXQuote_organizationId_idx";

-- AlterTable
ALTER TABLE "ApiCredential" ADD COLUMN     "createdByUserId" UUID,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 120,
ADD COLUMN     "rotatedFromId" UUID;

-- AlterTable
ALTER TABLE "Currency" ADD COLUMN     "kind" "CurrencyKind" NOT NULL DEFAULT 'FIAT';

-- AlterTable
ALTER TABLE "DigitalAssetSimulation" ADD COLUMN     "counterpartyOrganizationId" UUID,
ADD COLUMN     "createdByUserId" UUID,
ADD COLUMN     "ledgerTransactionId" UUID,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "operation" "DdaOperation" NOT NULL DEFAULT 'MINT',
ADD COLUMN     "reference" TEXT NOT NULL,
ADD COLUMN     "reserveDeltaUsdMinor" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "FXQuote" ADD COLUMN     "createdByUserId" UUID,
ADD COLUMN     "destinationCountry" CHAR(2),
ADD COLUMN     "feeBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "fixedFeeMinor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "originCountry" CHAR(2),
ADD COLUMN     "status" "FxQuoteStatus" NOT NULL DEFAULT 'QUOTED';

-- AlterTable
ALTER TABLE "Transfer" ADD COLUMN     "authorizedAt" TIMESTAMP(3),
ADD COLUMN     "beneficiaryId" UUID,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "createdByUserId" UUID NOT NULL,
ADD COLUMN     "destinationAmountMinor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "destinationLedgerTransactionId" UUID,
ADD COLUMN     "externalRef" TEXT,
ADD COLUMN     "failedAt" TIMESTAMP(3),
ADD COLUMN     "feeMinor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "processingAt" TIMESTAMP(3),
ADD COLUMN     "purpose" TEXT,
ADD COLUMN     "quotedAt" TIMESTAMP(3),
ADD COLUMN     "rateDenominator" BIGINT NOT NULL DEFAULT 1,
ADD COLUMN     "rateNumerator" BIGINT NOT NULL DEFAULT 1,
ADD COLUMN     "reversalLedgerTransactionId" UUID,
ADD COLUMN     "reviewReason" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedByUserId" UUID,
ADD COLUMN     "riskScore" INTEGER,
ADD COLUMN     "settledAt" TIMESTAMP(3),
ADD COLUMN     "sourceLedgerTransactionId" UUID;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "anonymizedAt" TIMESTAMP(3),
ADD COLUMN     "deletionRequestedAt" TIMESTAMP(3),
ADD COLUMN     "securityPreferences" JSONB;

-- AlterTable
ALTER TABLE "WebhookSubscription" ADD COLUMN     "createdByUserId" UUID,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "failureCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastDeliveryAt" TIMESTAMP(3),
ADD COLUMN     "lastRotatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Beneficiary" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "country" CHAR(2) NOT NULL,
    "currencyCode" CHAR(3) NOT NULL,
    "method" "BeneficiaryMethod" NOT NULL,
    "accountIdentifierEnc" TEXT NOT NULL,
    "accountIdentifierMasked" TEXT NOT NULL,
    "institutionName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "status" "BeneficiaryStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "Beneficiary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransferEvent" (
    "id" UUID NOT NULL,
    "transferId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "actorUserId" UUID,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransferEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "counterpartyId" UUID,
    "transactionId" UUID,
    "quoteId" UUID,
    "number" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "currencyCode" CHAR(3) NOT NULL,
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "subtotalMinor" BIGINT NOT NULL DEFAULT 0,
    "taxMinor" BIGINT NOT NULL DEFAULT 0,
    "totalMinor" BIGINT NOT NULL DEFAULT 0,
    "paidMinor" BIGINT NOT NULL DEFAULT 0,
    "notes" TEXT,
    "sentAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPriceMinor" BIGINT NOT NULL,
    "totalMinor" BIGINT NOT NULL,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoicePayment" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "recordedByUserId" UUID NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "method" "InvoicePaymentMethod" NOT NULL,
    "reference" TEXT,
    "ledgerTransactionId" UUID,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoicePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "counterpartyId" UUID,
    "convertedTransactionId" UUID,
    "number" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT,
    "status" "QuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "currencyCode" CHAR(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "subtotalMinor" BIGINT NOT NULL DEFAULT 0,
    "taxMinor" BIGINT NOT NULL DEFAULT 0,
    "totalMinor" BIGINT NOT NULL DEFAULT 0,
    "notes" TEXT,
    "sentAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteLine" (
    "id" UUID NOT NULL,
    "quoteId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPriceMinor" BIGINT NOT NULL,
    "totalMinor" BIGINT NOT NULL,

    CONSTRAINT "QuoteLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceRun" (
    "id" UUID NOT NULL,
    "jobName" "MaintenanceJobName" NOT NULL,
    "status" "MaintenanceRunStatus" NOT NULL DEFAULT 'RUNNING',
    "triggeredBy" TEXT NOT NULL DEFAULT 'scheduler',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "summary" JSONB,
    "error" TEXT,

    CONSTRAINT "MaintenanceRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiRequestLog" (
    "id" UUID NOT NULL,
    "credentialId" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "ip" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiRequestLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "signature" TEXT NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastStatusCode" INTEGER,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Beneficiary_organizationId_status_idx" ON "Beneficiary"("organizationId", "status");

-- CreateIndex
CREATE INDEX "TransferEvent_transferId_createdAt_idx" ON "TransferEvent"("transferId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_quoteId_key" ON "Invoice"("quoteId");

-- CreateIndex
CREATE INDEX "Invoice_organizationId_status_idx" ON "Invoice"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Invoice_dueDate_idx" ON "Invoice"("dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_organizationId_number_key" ON "Invoice"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLine_invoiceId_position_key" ON "InvoiceLine"("invoiceId", "position");

-- CreateIndex
CREATE INDEX "InvoicePayment_invoiceId_idx" ON "InvoicePayment"("invoiceId");

-- CreateIndex
CREATE INDEX "Quote_organizationId_status_idx" ON "Quote"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_organizationId_number_key" ON "Quote"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteLine_quoteId_position_key" ON "QuoteLine"("quoteId", "position");

-- CreateIndex
CREATE INDEX "MaintenanceRun_jobName_startedAt_idx" ON "MaintenanceRun"("jobName", "startedAt");

-- CreateIndex
CREATE INDEX "ApiRequestLog_credentialId_createdAt_idx" ON "ApiRequestLog"("credentialId", "createdAt");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_scopeKey_idempotencyKey_key" ON "IdempotencyRecord"("scopeKey", "idempotencyKey");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_subscriptionId_createdAt_idx" ON "WebhookDelivery"("subscriptionId", "createdAt");

-- CreateIndex
CREATE INDEX "ApiCredential_keyPrefix_idx" ON "ApiCredential"("keyPrefix");

-- CreateIndex
CREATE UNIQUE INDEX "DigitalAssetSimulation_reference_key" ON "DigitalAssetSimulation"("reference");

-- CreateIndex
CREATE INDEX "DigitalAssetSimulation_organizationId_createdAt_idx" ON "DigitalAssetSimulation"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "FXQuote_organizationId_createdAt_idx" ON "FXQuote"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Transfer_status_updatedAt_idx" ON "Transfer"("status", "updatedAt");

-- AddForeignKey
ALTER TABLE "FXQuote" ADD CONSTRAINT "FXQuote_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Beneficiary" ADD CONSTRAINT "Beneficiary_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Beneficiary" ADD CONSTRAINT "Beneficiary_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_beneficiaryId_fkey" FOREIGN KEY ("beneficiaryId") REFERENCES "Beneficiary"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferEvent" ADD CONSTRAINT "TransferEvent_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoicePayment" ADD CONSTRAINT "InvoicePayment_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_convertedTransactionId_fkey" FOREIGN KEY ("convertedTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiCredential" ADD CONSTRAINT "ApiCredential_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiRequestLog" ADD CONSTRAINT "ApiRequestLog_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "ApiCredential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "WebhookSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigitalAssetSimulation" ADD CONSTRAINT "DigitalAssetSimulation_counterpartyOrganizationId_fkey" FOREIGN KEY ("counterpartyOrganizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigitalAssetSimulation" ADD CONSTRAINT "DigitalAssetSimulation_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

