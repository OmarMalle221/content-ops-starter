/* eslint-disable no-console */
/**
 * Demo seed — SANDBOX ONLY. Every amount is fictitious ("Données fictives — Aucun fonds réel").
 *
 * Phases 0–5: demo accounts, a business organisation and three Protect transactions at different
 * stages, with balanced ledger postings.
 * Phase 6 (extended demo data, see README « Données de démonstration étendues (phase 6) »):
 * beneficiaries, wallet deposits, Diaspora Transfer transfers (SETTLED, PROCESSING,
 * REVIEW_REQUIRED) with the same two-leg postings as TransfersService, Dakar Auto Import invoices
 * (draft, sent, partially paid, paid) and quotes, an ACCEPTED counterparty link, a sandbox API
 * key (secret printed once, only its hash is stored), a disabled webhook subscription and two
 * assigned risk alerts. The run ends with LedgerService.reconcile() and fails on any difference.
 *
 * Idempotent: every phase 6 record is looked up by a stable seed key before being created, and
 * every ledger posting carries a fixed idempotency key — re-running the seed changes nothing.
 *
 * Demo password: set SEED_DEMO_PASSWORD, otherwise a strong default is used and printed once.
 * Accounts: admin@demo.dfn, compliance@demo.dfn, moussa@demo.dfn (buyer, Montréal),
 *           awa@demo.dfn (seller, Dakar Auto Import), ibrahima@demo.dfn (business member).
 *
 * Beneficiary identifiers and webhook secrets are sealed like the API does (key ring of
 * apps/api/src/common/keyring.ts): DOCUMENT_ENCRYPTION_KEY / ENCRYPTION_KEYRING must therefore be
 * the API's values. Unset variables are read from the monorepo root `.env` when it exists.
 */
import { PrismaClient, type Beneficiary, type Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { API_KEY_PREFIX, KeyPurpose, TransferEventType, minorToDecimalString } from '@dfn/shared';
// The ledger and FX helpers are consumed as TypeScript source (relative path): @dfn/database cannot
// depend on @dfn/financial-ledger (which depends on it) without a workspace cycle.
import {
  LedgerService,
  fxClearingCode,
  platformFeesCode,
  providerSettlementCode,
  walletAccountCode,
  type EnsureAccountInput,
} from '../../financial-ledger/src';
import { SandboxFxRateProvider, convertMinor, quoteTransferFee } from '../../payment-adapters/src/fx';

/** Fills unset variables from the monorepo root `.env` (never overrides the caller's environment). */
function loadRootEnv(): number {
  const file = resolve(__dirname, '../../../.env');
  if (!existsSync(file)) return 0;
  let loaded = 0;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^(['"])(.*)\1$/, '$2');
    loaded++;
  }
  return loaded;
}
const loadedFromDotEnv = loadRootEnv();

const prisma = new PrismaClient();
const ledger = new LedgerService(prisma);
const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'Demo-Sandbox-2026!Protect';
const SANDBOX_PROVIDER = 'SANDBOX_PARTNER';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const SANDBOX_NOTICE = 'Données fictives — Aucun fonds réel';

const CURRENCIES = [
  { code: 'CAD', name: 'Dollar canadien', exponent: 2, symbol: 'CA$' },
  { code: 'USD', name: 'Dollar américain', exponent: 2, symbol: 'US$' },
  { code: 'EUR', name: 'Euro', exponent: 2, symbol: '€' },
  { code: 'XOF', name: 'Franc CFA (BCEAO)', exponent: 0, symbol: 'FCFA' },
  { code: 'GNF', name: 'Franc guinéen', exponent: 0, symbol: 'FG' },
];

async function ensureAccount(
  code: string,
  name: string,
  type: 'ASSET' | 'LIABILITY' | 'REVENUE',
  normalBalance: 'DEBIT' | 'CREDIT',
  currencyCode: string,
  ownerType: 'PLATFORM' | 'PROVIDER' | 'ORGANIZATION' | 'TRANSACTION',
  ownerId?: string,
  allowNegative = false,
) {
  return ledger.ensureAccount({
    code,
    name,
    type,
    normalBalance,
    currencyCode,
    ownerType,
    ownerId: ownerId ?? null,
    allowNegative,
  });
}

/**
 * Balanced, idempotent posting through LedgerService (validation, account locks, negative balance
 * guard). Re-running the seed replays the same idempotency key and writes nothing.
 */
async function post(
  idempotencyKey: string,
  kind: 'FUNDING' | 'RELEASE' | 'DEPOSIT',
  description: string,
  reference: string,
  entries: Array<{
    accountId: string;
    direction: 'DEBIT' | 'CREDIT';
    amountMinor: bigint;
    currencyCode: string;
  }>,
) {
  return ledger.post({
    idempotencyKey,
    kind,
    description,
    reference,
    metadata: { simulated: true, seed: true },
    entries,
  });
}

async function user(
  email: string,
  firstName: string,
  lastName: string,
  country: string,
  globalRole: 'USER' | 'ADMIN' | 'COMPLIANCE',
  passwordHash: string,
) {
  const u = await prisma.user.upsert({
    where: { email },
    update: { globalRole },
    create: { email, passwordHash, firstName, lastName, country, locale: 'fr', globalRole },
  });
  const personal = await prisma.organization.findFirst({
    where: { type: 'PERSONAL', members: { some: { userId: u.id, role: 'OWNER' } } },
  });
  const org =
    personal ??
    (await prisma.organization.create({
      data: {
        name: `${firstName} ${lastName}`,
        type: 'PERSONAL',
        country,
        members: { create: { userId: u.id, role: 'OWNER' } },
      },
    }));
  return { user: u, org };
}

async function main() {
  console.log('Seeding DFN sandbox demo data…');
  for (const c of CURRENCIES) await prisma.currency.upsert({ where: { code: c.code }, update: c, create: c });
  const provider = await prisma.paymentProvider.upsert({
    where: { code: SANDBOX_PROVIDER },
    update: {},
    create: { code: SANDBOX_PROVIDER, name: 'Sandbox partner (simulated — no real funds)', mode: 'SANDBOX' },
  });
  const settlement: Record<string, { id: string }> = {};
  const fees: Record<string, { id: string }> = {};
  for (const c of CURRENCIES) {
    settlement[c.code] = await ensureAccount(
      `PROVIDER_SETTLEMENT:${SANDBOX_PROVIDER}:${c.code}`,
      `Sandbox partner settlement (${c.code})`,
      'ASSET',
      'DEBIT',
      c.code,
      'PROVIDER',
      undefined,
      true,
    );
    fees[c.code] = await ensureAccount(
      `PLATFORM_FEES:${c.code}`,
      `Platform fees (${c.code})`,
      'REVENUE',
      'CREDIT',
      c.code,
      'PLATFORM',
    );
  }

  const passwordHash = await argon2.hash(PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  const admin = await user('admin@demo.dfn', 'Aminata', 'Ba', 'CA', 'ADMIN', passwordHash);
  const compliance = await user('compliance@demo.dfn', 'Fatou', 'Sow', 'CA', 'COMPLIANCE', passwordHash);
  const buyer = await user('moussa@demo.dfn', 'Moussa', 'Ndiaye', 'CA', 'USER', passwordHash);
  const seller = await user('awa@demo.dfn', 'Awa', 'Diop', 'SN', 'USER', passwordHash);
  const member = await user('ibrahima@demo.dfn', 'Ibrahima', 'Fall', 'SN', 'USER', passwordHash);

  // Business organisation for the seller (vehicle exporter / importer)
  let business = await prisma.organization.findFirst({
    where: { name: 'Dakar Auto Import', type: 'BUSINESS' },
  });
  if (!business) {
    business = await prisma.organization.create({
      data: {
        name: 'Dakar Auto Import',
        type: 'BUSINESS',
        country: 'SN',
        legalName: 'Dakar Auto Import SARL',
        registrationNumber: 'SN-DKR-2021-B-1234',
        verificationStatus: 'SIMULATED_PASS',
        members: {
          create: [
            { userId: seller.user.id, role: 'OWNER' },
            { userId: member.user.id, role: 'MEMBER' },
          ],
        },
        businessVerifications: {
          create: {
            provider: 'sandbox',
            providerRef: 'sbx_biz_seed',
            status: 'SIMULATED_PASS',
            declaredData: { legalName: 'Dakar Auto Import SARL', registrationCountry: 'SN' },
            providerResponse: { simulated: true, notice: 'Seeded simulated result' },
          },
        },
      },
    });
  }

  // Simulated identity verifications for the demo buyer and seller
  for (const u of [buyer.user, seller.user, member.user]) {
    const exists = await prisma.identityVerification.findFirst({ where: { userId: u.id } });
    if (!exists) {
      await prisma.identityVerification.create({
        data: {
          userId: u.id,
          provider: 'sandbox',
          providerRef: `sbx_id_seed_${u.id.slice(0, 8)}`,
          status: 'SIMULATED_PASS',
          declaredData: { documentType: 'PASSPORT', issuingCountry: u.country },
          providerResponse: { simulated: true, notice: 'Seeded simulated result' },
          expiresAt: new Date(Date.now() + 365 * 86_400_000),
        },
      });
    }
  }

  // Wallets
  const wallet = async (orgId: string, ccy: string) => {
    const existing = await prisma.wallet.findUnique({
      where: { organizationId_currencyCode: { organizationId: orgId, currencyCode: ccy } },
    });
    if (existing) return existing;
    const account = await ensureAccount(
      `WALLET:${orgId}:${ccy}`,
      `Wallet ${orgId} (${ccy})`,
      'LIABILITY',
      'CREDIT',
      ccy,
      'ORGANIZATION',
      orgId,
    );
    return prisma.wallet.create({
      data: { organizationId: orgId, currencyCode: ccy, ledgerAccountId: account.id },
    });
  };
  const businessCad = await wallet(business.id, 'CAD');
  const buyerCad = await wallet(buyer.org.id, 'CAD');
  await post('seed:deposit:buyer:CAD', 'DEPOSIT', 'Sandbox demo deposit (simulated)', buyer.org.id, [
    { accountId: settlement.CAD.id, direction: 'DEBIT', amountMinor: 250_000n, currencyCode: 'CAD' },
    { accountId: buyerCad.ledgerAccountId, direction: 'CREDIT', amountMinor: 250_000n, currencyCode: 'CAD' },
  ]);

  const contractBody = (ref: string, title: string, amount: string) =>
    `CONVENTION DE PAIEMENT CONDITIONNEL — DIASPORA PROTECT (SANDBOX)\n\nDonnées fictives — Aucun fonds réel.\n\nRéférence: ${ref}\nObjet: ${title}\nMontant: ${amount} CAD\n\n(Contrat de démonstration généré par le seed.)`;

  async function transaction(opts: {
    reference: string;
    title: string;
    description: string;
    amountMinor: bigint;
    status: 'PENDING_ACCEPTANCE' | 'FUNDED' | 'SETTLED';
    milestones: Array<{
      title: string;
      amountMinor: bigint;
      status: 'PENDING' | 'RELEASED';
      evidence: string;
    }>;
  }) {
    const existing = await prisma.transaction.findUnique({ where: { reference: opts.reference } });
    if (existing) return existing;
    const feeMinor = (opts.amountMinor * 150n + 5_000n) / 10_000n;
    const accepted = opts.status !== 'PENDING_ACCEPTANCE';
    const token = randomBytes(24).toString('base64url');
    const tx = await prisma.transaction.create({
      data: {
        reference: opts.reference,
        createdByUserId: buyer.user.id,
        buyerOrganizationId: buyer.org.id,
        sellerOrganizationId: accepted ? business!.id : null,
        title: opts.title,
        description: opts.description,
        category: 'VEHICLE',
        currencyCode: 'CAD',
        amountMinor: opts.amountMinor,
        feeMinor,
        status: opts.status,
        originCountry: 'CA',
        destinationCountry: 'SN',
        acceptedAt: accepted ? new Date() : null,
        fundedAt: accepted ? new Date() : null,
        settledAt: opts.status === 'SETTLED' ? new Date() : null,
        expiresAt: new Date(Date.now() + 14 * 86_400_000),
        metadata: { corridorSupported: true, seed: true },
        parties: {
          create: [
            {
              role: 'BUYER',
              organizationId: buyer.org.id,
              userId: buyer.user.id,
              invitedEmail: buyer.user.email,
              invitedName: buyer.org.name,
              status: 'ACCEPTED',
              acceptedAt: new Date(),
            },
            accepted
              ? {
                  role: 'SELLER',
                  organizationId: business!.id,
                  userId: seller.user.id,
                  invitedEmail: seller.user.email,
                  invitedName: business!.name,
                  status: 'ACCEPTED',
                  acceptedAt: new Date(),
                }
              : {
                  role: 'SELLER',
                  invitedEmail: seller.user.email,
                  invitedName: business!.name,
                  status: 'INVITED',
                  inviteTokenHash: sha256(token),
                  inviteExpiresAt: new Date(Date.now() + 14 * 86_400_000),
                },
          ],
        },
        milestones: {
          create: opts.milestones.map((m, i) => ({
            sequence: i + 1,
            title: m.title,
            amountMinor: m.amountMinor,
            requiredEvidence: [m.evidence],
            status: m.status,
            releasedAt: m.status === 'RELEASED' ? new Date() : null,
          })),
        },
        events: {
          create: [{ type: 'transaction.created', actorUserId: buyer.user.id, payload: { seed: true } }],
        },
      },
      include: { parties: true, milestones: true },
    });
    const body = contractBody(tx.reference, tx.title, (Number(opts.amountMinor) / 100).toFixed(2));
    const contract = await prisma.contract.create({
      data: { transactionId: tx.id, status: accepted ? 'ACCEPTED' : 'PENDING_ACCEPTANCE' },
    });
    const version = await prisma.contractVersion.create({
      data: {
        contractId: contract.id,
        version: 1,
        templateCode: 'DFN_PROTECT_CONDITIONAL_PAYMENT',
        templateVersion: '1.0.0-sandbox',
        terms: { seed: true, totalAmount: (Number(opts.amountMinor) / 100).toFixed(2), currencyCode: 'CAD' },
        bodyText: body,
        contentHash: sha256(body),
        createdByUserId: buyer.user.id,
      },
    });
    await prisma.contract.update({ where: { id: contract.id }, data: { currentVersionId: version.id } });
    if (accepted) {
      for (const p of tx.parties)
        await prisma.contractAcceptance.create({
          data: { contractVersionId: version.id, partyId: p.id, userId: p.userId! },
        });
      const escrow = await ensureAccount(
        `ESCROW:${tx.id}:CAD`,
        `Escrow ${tx.reference} (CAD)`,
        'LIABILITY',
        'CREDIT',
        'CAD',
        'TRANSACTION',
        tx.id,
      );
      const fundingRef = `SBXF-${tx.reference}-SEED`;
      const funding = await post(
        `funding:seed:${tx.id}`,
        'FUNDING',
        `Funding of ${tx.reference} confirmed by ${SANDBOX_PROVIDER} (simulated)`,
        tx.id,
        [
          {
            accountId: settlement.CAD.id,
            direction: 'DEBIT',
            amountMinor: opts.amountMinor + feeMinor,
            currencyCode: 'CAD',
          },
          { accountId: escrow.id, direction: 'CREDIT', amountMinor: opts.amountMinor, currencyCode: 'CAD' },
          { accountId: fees.CAD.id, direction: 'CREDIT', amountMinor: feeMinor, currencyCode: 'CAD' },
        ],
      );
      await prisma.fundingRequest.create({
        data: {
          transactionId: tx.id,
          providerId: provider.id,
          reference: fundingRef,
          amountMinor: opts.amountMinor + feeMinor,
          currencyCode: 'CAD',
          status: 'CONFIRMED',
          confirmedAt: new Date(),
          expiresAt: new Date(Date.now() + 72 * 3600_000),
          ledgerTransactionId: funding.id,
          instructions: { type: 'BANK_TRANSFER_SIMULATED', notice: 'Données fictives — Aucun fonds réel' },
        },
      });
      await prisma.transactionEvent.create({
        data: {
          transactionId: tx.id,
          type: 'funding.confirmed',
          payload: { fundingReference: fundingRef, simulated: true },
        },
      });
      for (const m of tx.milestones.filter((x) => x.status === 'RELEASED')) {
        const release = await post(
          `release:seed:${m.id}`,
          'RELEASE',
          `Release of milestone ${m.sequence} for ${tx.reference} — simulated`,
          tx.id,
          [
            { accountId: escrow.id, direction: 'DEBIT', amountMinor: m.amountMinor, currencyCode: 'CAD' },
            {
              accountId: businessCad.ledgerAccountId,
              direction: 'CREDIT',
              amountMinor: m.amountMinor,
              currencyCode: 'CAD',
            },
          ],
        );
        await prisma.milestone.update({ where: { id: m.id }, data: { ledgerTransactionId: release.id } });
        await prisma.transactionEvent.create({
          data: {
            transactionId: tx.id,
            type: 'milestone.released',
            actorUserId: buyer.user.id,
            payload: { milestoneId: m.id, simulated: true },
          },
        });
      }
      if (opts.status === 'SETTLED')
        await prisma.transactionEvent.create({
          data: { transactionId: tx.id, type: 'transaction.settled', payload: { finalStatus: 'SETTLED' } },
        });
    }
    if (!accepted) console.log(`  invitation link for ${tx.reference}: /invite/${token}`);
    return tx;
  }

  await transaction({
    reference: 'DFN-2026-DEMO01',
    title: 'Toyota Hilux 2019 — Montréal → Dakar',
    description:
      'Pick-up double cabine, 85 000 km. Inspection avant embarquement, livraison au port autonome de Dakar.',
    amountMinor: 1_850_000n,
    status: 'FUNDED',
    milestones: [
      {
        title: 'Embarquement confirmé',
        amountMinor: 925_000n,
        status: 'PENDING',
        evidence: 'BILL_OF_LADING',
      },
      {
        title: 'Livraison au port de Dakar',
        amountMinor: 925_000n,
        status: 'PENDING',
        evidence: 'PROOF_OF_SHIPMENT',
      },
    ],
  });
  await transaction({
    reference: 'DFN-2026-DEMO02',
    title: 'Hyundai Tucson 2021 — Laval → Dakar',
    description: 'VUS compact, 42 000 km, carnet d’entretien complet.',
    amountMinor: 2_400_000n,
    status: 'SETTLED',
    milestones: [
      {
        title: 'Embarquement confirmé',
        amountMinor: 1_200_000n,
        status: 'RELEASED',
        evidence: 'BILL_OF_LADING',
      },
      {
        title: 'Livraison au port de Dakar',
        amountMinor: 1_200_000n,
        status: 'RELEASED',
        evidence: 'PROOF_OF_SHIPMENT',
      },
    ],
  });
  await transaction({
    reference: 'DFN-2026-DEMO03',
    title: 'Pièces détachées — lot de 40 pneus',
    description: 'Pneus toutes saisons 215/65R16, conteneur groupé.',
    amountMinor: 620_000n,
    status: 'PENDING_ACCEPTANCE',
    milestones: [
      {
        title: 'Livraison complète',
        amountMinor: 620_000n,
        status: 'PENDING',
        evidence: 'PROOF_OF_SHIPMENT',
      },
    ],
  });

  for (const u of [admin, compliance, buyer, seller, member]) {
    const welcomed = await prisma.notification.findFirst({
      where: { userId: u.user.id, type: 'system.welcome' },
      select: { id: true },
    });
    if (welcomed) continue;
    await prisma.notification.create({
      data: {
        userId: u.user.id,
        type: 'system.welcome',
        title: 'Bienvenue sur Diaspora Trust (sandbox)',
        body: 'Données fictives — Aucun fonds réel. Explorez les transactions de démonstration.',
        data: { seed: true },
      },
    });
  }

  const phase6 = await seedPhase6({
    provider,
    admin,
    compliance,
    buyer,
    seller,
    member,
    business,
    businessCad,
    buyerCad,
  });

  // The seed must leave a ledger that reconciles: every transaction balanced, no forbidden
  // negative balance, snapshot continuity intact.
  const reconciliation = await ledger.reconcile();
  if (reconciliation.differences.length || reconciliation.unbalancedTransactions.length) {
    console.error('Ledger reconciliation FAILED after seeding:', {
      differences: reconciliation.differences.map((d) => ({
        accountId: d.accountId,
        expected: d.expectedMinor.toString(),
        actual: d.actualMinor.toString(),
        note: d.note,
      })),
      unbalancedTransactions: reconciliation.unbalancedTransactions,
    });
    throw new Error('Seed aborted: the ledger does not reconcile');
  }

  await prisma.auditLog.create({
    data: {
      action: 'system.seed',
      entityType: 'System',
      metadata: {
        accounts: 5,
        transactions: 3,
        phase6: phase6.counts,
        reconciliationJobId: reconciliation.jobId,
        accountsChecked: reconciliation.accountsChecked,
        simulated: true,
      },
    },
  });

  console.log('\nDemo accounts (sandbox only — rotate before any shared deployment):');
  for (const e of [
    'admin@demo.dfn (ADMIN)',
    'compliance@demo.dfn (COMPLIANCE)',
    'moussa@demo.dfn (buyer, Montréal)',
    'awa@demo.dfn (seller — owner of Dakar Auto Import)',
    'ibrahima@demo.dfn (member of Dakar Auto Import)',
  ])
    console.log(`  - ${e}`);
  console.log(`  password: ${process.env.SEED_DEMO_PASSWORD ? '(from SEED_DEMO_PASSWORD)' : PASSWORD}`);
  console.log('\nSandbox wallet balances (fictitious, derived from the ledger):');
  for (const line of phase6.balances) console.log(`  - ${line}`);
  console.log(
    `\nLedger reconciliation: ${reconciliation.accountsChecked} accounts checked, 0 difference, 0 unbalanced transaction.`,
  );
  if (loadedFromDotEnv) console.log(`(${loadedFromDotEnv} unset variable(s) read from the root .env)`);
}

// ───────────────────────────── Phase 6 — extended demo data ─────────────────────────────

type SeedUser = {
  user: { id: string; email: string; firstName: string; lastName: string };
  org: { id: string };
};

interface Phase6Context {
  provider: { id: string; code: string };
  admin: SeedUser;
  compliance: SeedUser;
  buyer: SeedUser;
  seller: SeedUser;
  member: SeedUser;
  business: { id: string; name: string };
  businessCad: { id: string; ledgerAccountId: string };
  buyerCad: { id: string; ledgerAccountId: string };
}

const KEY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Seals a string exactly like KeyRing.sealString (apps/api/src/common/keyring.ts): with the active
 * key of the purpose from ENCRYPTION_KEYRING (`k2.<purpose>.<keyId>.<base64(iv|tag|ct)>`, purpose
 * and key id bound as GCM additional data), otherwise with DOCUMENT_ENCRYPTION_KEY in the legacy
 * layout. Returns null when no key is configured (the caller then skips the record).
 */
function sealString(purpose: KeyPurpose, plaintext: string): string | null {
  let active: { keyId: string; key: Buffer } | null = null;
  for (const raw of (process.env.ENCRYPTION_KEYRING ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [entryPurpose, keyId, hex, ...rest] = raw.split(':');
    if (
      rest.length ||
      !entryPurpose ||
      !keyId ||
      !hex ||
      !KEY_ID_RE.test(keyId) ||
      keyId === 'legacy' ||
      !/^[0-9a-f]{64}$/i.test(hex)
    ) {
      throw new Error('Invalid ENCRYPTION_KEYRING entry (expected purpose:keyId:hex64)');
    }
    if (entryPurpose === purpose && !active) active = { keyId, key: Buffer.from(hex, 'hex') };
  }
  const iv = randomBytes(12);
  if (active) {
    const cipher = createCipheriv('aes-256-gcm', active.key, iv);
    cipher.setAAD(Buffer.from(`${purpose}:${active.keyId}`, 'utf8'));
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const payload = Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
    return `k2.${purpose}.${active.keyId}.${payload}`;
  }
  const legacy = process.env.DOCUMENT_ENCRYPTION_KEY;
  if (!legacy || !/^[0-9a-f]{64}$/i.test(legacy)) return null;
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(legacy, 'hex'), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

/** Same layout as generateApiKey (apps/api/src/modules/api-platform/api-credentials.service.ts). */
function generateApiKey(): { key: string; keyPrefix: string; keyHash: string } {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(8);
  let keyPrefix = '';
  for (let i = 0; i < 8; i++) keyPrefix += alphabet[bytes[i]! % alphabet.length];
  const key = `${API_KEY_PREFIX}${keyPrefix}_${randomBytes(32).toString('base64url')}`;
  return { key, keyPrefix, keyHash: sha256(key) };
}

const maskIdentifier = (identifier: string) => `••••${identifier.replace(/\s+/g, '').slice(-4)}`;
const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);
const day = (d: Date) => d.toISOString().slice(0, 10);
const taxOf = (subtotalMinor: bigint, taxBps: number) => (subtotalMinor * BigInt(taxBps) + 5_000n) / 10_000n;

const FX_TTL_MS = 15 * 60_000;
const fx = new SandboxFxRateProvider();

async function seedPhase6(ctx: Phase6Context) {
  const { provider, admin, compliance, buyer, seller, business, businessCad, buyerCad } = ctx;
  const counts = {
    beneficiaries: 0,
    deposits: 0,
    transfers: 0,
    invoices: 0,
    quotes: 0,
    counterpartyLinks: 0,
    apiKeys: 0,
    webhooks: 0,
    riskAlerts: 0,
  };
  const year = new Date().getUTCFullYear();

  const walletFor = async (organizationId: string, currencyCode: string, db?: Prisma.TransactionClient) => {
    const client = db ?? prisma;
    const existing = await client.wallet.findUnique({
      where: { organizationId_currencyCode: { organizationId, currencyCode } },
    });
    if (existing) return existing;
    const account = await ledger.ensureAccount(
      {
        code: walletAccountCode(organizationId, currencyCode),
        name: `Wallet ${organizationId} (${currencyCode})`,
        type: 'LIABILITY',
        normalBalance: 'CREDIT',
        currencyCode,
        ownerType: 'ORGANIZATION',
        ownerId: organizationId,
      },
      client,
    );
    return client.wallet.create({ data: { organizationId, currencyCode, ledgerAccountId: account.id } });
  };
  const clearingAccount = (currencyCode: string, db: Prisma.TransactionClient) =>
    ledger.ensureAccount(
      {
        code: fxClearingCode(currencyCode),
        name: `FX clearing (${currencyCode}) — simulated`,
        type: 'EQUITY',
        normalBalance: 'CREDIT',
        currencyCode,
        ownerType: 'PLATFORM',
        allowNegative: true,
      } satisfies EnsureAccountInput,
      db,
    );

  // ── 1. Wallet deposits (simulated partner settlement → wallet), balances derived from the ledger.
  const deposits: Array<{ key: string; organizationId: string; currencyCode: string; amountMinor: bigint }> =
    [
      {
        key: 'seed:p6:deposit:buyer:CAD',
        organizationId: buyer.org.id,
        currencyCode: 'CAD',
        amountMinor: 1_000_000n,
      },
      {
        key: 'seed:p6:deposit:buyer:EUR',
        organizationId: buyer.org.id,
        currencyCode: 'EUR',
        amountMinor: 80_000n,
      },
      {
        key: 'seed:p6:deposit:business:XOF',
        organizationId: business.id,
        currencyCode: 'XOF',
        amountMinor: 2_500_000n,
      },
    ];
  for (const d of deposits) {
    const wallet = await walletFor(d.organizationId, d.currencyCode);
    const posted = await ledger.post({
      idempotencyKey: d.key,
      kind: 'DEPOSIT',
      description: `Sandbox demo deposit of ${minorToDecimalString(d.amountMinor, d.currencyCode)} ${d.currencyCode} (simulated — no real funds)`,
      reference: d.organizationId,
      metadata: {
        simulated: true,
        seed: true,
        organizationId: d.organizationId,
        currencyCode: d.currencyCode,
        amountMinor: d.amountMinor.toString(),
      },
      entries: [
        {
          accountCode: providerSettlementCode(SANDBOX_PROVIDER, d.currencyCode),
          direction: 'DEBIT',
          amountMinor: d.amountMinor,
          currencyCode: d.currencyCode,
        },
        {
          accountId: wallet.ledgerAccountId,
          direction: 'CREDIT',
          amountMinor: d.amountMinor,
          currencyCode: d.currencyCode,
        },
      ],
    });
    if (!posted.replayed) counts.deposits++;
  }

  // ── 2. Beneficiaries of the demo buyer (identifiers sealed with the beneficiaries key).
  const beneficiarySpecs = [
    {
      name: 'Awa Diop (démo)',
      country: 'SN',
      currencyCode: 'XOF',
      method: 'BANK_ACCOUNT' as const,
      identifier: 'SN08SN0100000000000000004521',
      institutionName: 'Banque fictive de Dakar (sandbox)',
      email: 'awa.diop.demo@example.invalid',
      phone: null,
    },
    {
      name: 'Mame Diarra Sarr (démo)',
      country: 'SN',
      currencyCode: 'XOF',
      method: 'MOBILE_MONEY' as const,
      identifier: '+221770004582',
      institutionName: 'Mobile money fictif (sandbox)',
      email: null,
      phone: '+221770004582',
    },
    {
      name: 'Mamadou Bah (démo)',
      country: 'GN',
      currencyCode: 'GNF',
      method: 'MOBILE_MONEY' as const,
      identifier: '+224620007314',
      institutionName: 'Mobile money fictif Conakry (sandbox)',
      email: null,
      phone: '+224620007314',
    },
  ];
  const beneficiaries: Beneficiary[] = [];
  for (const spec of beneficiarySpecs) {
    const masked = maskIdentifier(spec.identifier);
    const existing = await prisma.beneficiary.findFirst({
      where: { organizationId: buyer.org.id, name: spec.name, accountIdentifierMasked: masked },
    });
    if (existing) {
      beneficiaries.push(existing);
      continue;
    }
    const sealed = sealString(KeyPurpose.BENEFICIARIES, spec.identifier);
    if (!sealed) {
      console.warn(
        `  ! beneficiary "${spec.name}" skipped: DOCUMENT_ENCRYPTION_KEY / ENCRYPTION_KEYRING not set (cannot seal the identifier)`,
      );
      continue;
    }
    const created = await prisma.beneficiary.create({
      data: {
        organizationId: buyer.org.id,
        createdByUserId: buyer.user.id,
        name: spec.name,
        country: spec.country,
        currencyCode: spec.currencyCode,
        method: spec.method,
        accountIdentifierEnc: sealed,
        accountIdentifierMasked: masked,
        institutionName: spec.institutionName,
        phone: spec.phone,
        email: spec.email,
      },
    });
    await prisma.auditLog.create({
      data: {
        actorUserId: buyer.user.id,
        organizationId: buyer.org.id,
        action: 'beneficiary.created',
        entityType: 'Beneficiary',
        entityId: created.id,
        metadata: {
          method: created.method,
          country: created.country,
          currencyCode: created.currencyCode,
          accountIdentifierMasked: masked,
          seed: true,
        },
      },
    });
    beneficiaries.push(created);
    counts.beneficiaries++;
  }

  // ── 3. Transfers (CAD → beneficiary currency), postings identical to TransfersService.
  const byName = (name: string) => beneficiaries.find((b) => b.name === name) ?? null;
  const transferSpecs = [
    {
      seedKey: 'seed:p6:transfer:settled',
      reference: `DFT-${year}-DEMO01`,
      status: 'SETTLED' as const,
      beneficiary: byName('Awa Diop (démo)'),
      sourceAmountMinor: 30_000n,
      purpose: 'FAMILY_SUPPORT',
    },
    {
      seedKey: 'seed:p6:transfer:processing',
      reference: `DFT-${year}-DEMO02`,
      status: 'PROCESSING' as const,
      beneficiary: byName('Mame Diarra Sarr (démo)'),
      sourceAmountMinor: 45_000n,
      purpose: 'EDUCATION',
    },
    {
      seedKey: 'seed:p6:transfer:review',
      reference: `DFT-${year}-DEMO03`,
      status: 'REVIEW_REQUIRED' as const,
      beneficiary: byName('Mamadou Bah (démo)'),
      sourceAmountMinor: 940_000n,
      purpose: 'BUSINESS',
    },
  ];
  const transfers: Record<string, { id: string; reference: string; sourceAmountMinor: bigint }> = {};
  for (const spec of transferSpecs) {
    const existing = await prisma.transfer.findFirst({
      where: { metadata: { path: ['seedKey'], equals: spec.seedKey } },
      select: { id: true, reference: true, sourceAmountMinor: true },
    });
    if (existing) {
      transfers[spec.status] = existing;
      continue;
    }
    if (!spec.beneficiary) {
      console.warn(`  ! transfer ${spec.reference} skipped: its beneficiary could not be seeded`);
      continue;
    }
    const created = await seedTransfer(
      ctx,
      spec as typeof spec & { beneficiary: Beneficiary },
      clearingAccount,
    );
    transfers[spec.status] = created;
    counts.transfers++;
  }

  // ── 4. Risk alerts on the transfer held for review, assigned to compliance@demo.dfn.
  const review = transfers.REVIEW_REQUIRED;
  if (review) {
    const now = new Date();
    const operations = [transfers.SETTLED, transfers.PROCESSING, review].filter(Boolean);
    const sumMinor = operations.reduce((acc, t) => acc + t.sourceAmountMinor, 0n);
    const dedupKey = `STRUCTURING:OUTBOUND:ORGANIZATION:${buyer.org.id}:CAD`;
    const alertSpecs = [
      {
        seedKey: 'seed:p6:alert:structuring',
        ruleCode: 'STRUCTURING',
        severity: 'HIGH' as const,
        score: 45,
        slaHours: 24,
        status: 'OPEN' as const,
        explanation: {
          summary: `${operations.length} operations each below 10000.00 CAD total ${minorToDecimalString(sumMinor, 'CAD')} CAD within 24 h (same organisation) — possible structuring`,
          factors: {
            subjectType: 'ORGANIZATION',
            subjectId: buyer.org.id,
            currencyCode: 'CAD',
            flow: 'OUTBOUND',
            operationsCount: operations.length,
            sum: minorToDecimalString(sumMinor, 'CAD'),
            sumMinor: sumMinor.toString(),
            threshold: '10000.00',
            thresholdMinor: '1000000',
            windowHours: 24,
            kinds: 'TRANSFER',
            references: operations.map((t) => t.reference).join(', '),
            dedupKey,
          },
          recommendation:
            'Review the operations together (purpose, source of funds, links between them). Do not inform the customer of a possible report (tipping-off); escalate to the compliance officer if suspicion is reasonable.',
          evidence: operations.map((t) => ({
            kind: 'TRANSFER',
            reference: t.reference,
            amount: minorToDecimalString(t.sourceAmountMinor, 'CAD'),
            amountMinor: t.sourceAmountMinor.toString(),
            current: t.id === review.id,
          })),
          seed: true,
          seedKey: 'seed:p6:alert:structuring',
          transferReference: review.reference,
          notice: SANDBOX_NOTICE,
        },
      },
      {
        seedKey: 'seed:p6:alert:new-beneficiary',
        ruleCode: 'NEW_BENEFICIARY_HIGH_VALUE',
        severity: 'MEDIUM' as const,
        score: 20,
        slaHours: 72,
        status: 'REVIEWING' as const,
        explanation: {
          summary: 'High-value transfer to a beneficiary registered less than 24 hours ago',
          factors: {
            beneficiaryAgeHours: 0,
            amountMinor: review.sourceAmountMinor.toString(),
            currencyCode: 'CAD',
            destinationCountry: 'GN',
          },
          recommendation:
            'Confirm the beneficiary with the sender through a second channel before settlement.',
          seed: true,
          seedKey: 'seed:p6:alert:new-beneficiary',
          transferReference: review.reference,
          notice: SANDBOX_NOTICE,
        },
      },
    ];
    for (const spec of alertSpecs) {
      const existing = await prisma.riskAlert.findFirst({
        where: { explanation: { path: ['seedKey'], equals: spec.seedKey } },
        select: { id: true },
      });
      if (existing) continue;
      await prisma.$transaction(async (db) => {
        const alert = await db.riskAlert.create({
          data: {
            userId: buyer.user.id,
            organizationId: buyer.org.id,
            ruleCode: spec.ruleCode,
            severity: spec.severity,
            score: spec.score,
            explanation: spec.explanation as Prisma.InputJsonValue,
            status: spec.status,
            createdAt: now,
            dueAt: new Date(now.getTime() + spec.slaHours * 3_600_000),
            assignedToUserId: compliance.user.id,
            assignedAt: now,
            firstActionAt: spec.status === 'REVIEWING' ? now : null,
          },
        });
        await db.riskAlertAction.create({
          data: {
            alertId: alert.id,
            actorUserId: admin.user.id,
            action: 'ASSIGN',
            note: `${compliance.user.firstName} ${compliance.user.lastName}`,
          },
        });
        await db.auditLog.create({
          data: {
            actorUserId: admin.user.id,
            action: 'admin.risk_alert_assigned',
            entityType: 'RiskAlert',
            entityId: alert.id,
            metadata: { from: null, to: compliance.user.id, ruleCode: spec.ruleCode, seed: true },
          },
        });
        if (spec.status === 'REVIEWING') {
          await db.riskAlertAction.create({
            data: {
              alertId: alert.id,
              actorUserId: compliance.user.id,
              action: 'START_REVIEW',
              note: 'Revue démarrée (données de démonstration).',
            },
          });
        }
      });
      counts.riskAlerts++;
    }
  }

  // ── 5. Counterparty link Dakar Auto Import → Moussa (consent workflow: ACCEPTED by the buyer).
  let counterparty = await prisma.counterparty.findFirst({
    where: { organizationId: business.id, email: buyer.user.email },
  });
  if (!counterparty) {
    const now = new Date();
    counterparty = await prisma.counterparty.create({
      data: {
        organizationId: business.id,
        name: `${buyer.user.firstName} ${buyer.user.lastName}`,
        email: buyer.user.email,
        country: 'CA',
        notes: `Client de démonstration (seed). ${SANDBOX_NOTICE}.`,
        linkedOrganizationId: buyer.org.id,
        linkStatus: 'ACCEPTED',
        linkRequestedOrganizationId: buyer.org.id,
        linkRequestedAt: now,
        linkDecidedAt: now,
        linkDecidedByUserId: buyer.user.id,
      },
    });
    await prisma.auditLog.create({
      data: {
        actorUserId: buyer.user.id,
        organizationId: buyer.org.id,
        action: 'counterparty.link_accepted',
        entityType: 'Counterparty',
        entityId: counterparty.id,
        metadata: { requestedBy: business.id, seed: true },
      },
    });
    counts.counterpartyLinks++;
  }
  const linked = counterparty.linkStatus === 'ACCEPTED' && counterparty.linkedOrganizationId === buyer.org.id;

  // ── 6. Invoices of Dakar Auto Import (draft, sent, partially paid, paid) — taxBps persisted.
  const invoiceSpecs: Array<{
    notes: string;
    status: 'DRAFT' | 'SENT' | 'PARTIALLY_PAID' | 'PAID';
    toBuyer: boolean;
    customerName: string;
    customerEmail: string | null;
    taxBps: number;
    dueInDays: number;
    lines: Array<{ description: string; quantity: number; unitPriceMinor: bigint }>;
    payment?: {
      method: 'WALLET_SIMULATED' | 'EXTERNAL_RECORDED';
      amountMinor: bigint | 'FULL';
      reference?: string;
    };
  }> = [
    {
      notes: `Démo seed (phase 6) — facture brouillon. ${SANDBOX_NOTICE}.`,
      status: 'DRAFT',
      toBuyer: false,
      customerName: 'Garage Teranga (client fictif)',
      customerEmail: null,
      taxBps: 1800,
      dueInDays: 30,
      lines: [
        { description: 'Filtres à huile — lot de 10', quantity: 2, unitPriceMinor: 8_500n },
        { description: 'Frais de préparation', quantity: 1, unitPriceMinor: 4_000n },
      ],
    },
    {
      notes: `Démo seed (phase 6) — facture envoyée. ${SANDBOX_NOTICE}.`,
      status: 'SENT',
      toBuyer: true,
      customerName: `${buyer.user.firstName} ${buyer.user.lastName}`,
      customerEmail: buyer.user.email,
      taxBps: 0,
      dueInDays: 30,
      lines: [
        {
          description: 'Transport maritime Montréal → Dakar (conteneur partagé)',
          quantity: 1,
          unitPriceMinor: 120_000n,
        },
      ],
    },
    {
      notes: `Démo seed (phase 6) — facture partiellement payée. ${SANDBOX_NOTICE}.`,
      status: 'PARTIALLY_PAID',
      toBuyer: true,
      customerName: `${buyer.user.firstName} ${buyer.user.lastName}`,
      customerEmail: buyer.user.email,
      taxBps: 1800,
      dueInDays: 21,
      lines: [{ description: 'Dédouanement et frais portuaires', quantity: 1, unitPriceMinor: 90_000n }],
      payment: { method: 'WALLET_SIMULATED', amountMinor: 50_000n },
    },
    {
      notes: `Démo seed (phase 6) — facture payée. ${SANDBOX_NOTICE}.`,
      status: 'PAID',
      toBuyer: true,
      customerName: `${buyer.user.firstName} ${buyer.user.lastName}`,
      customerEmail: buyer.user.email,
      taxBps: 0,
      dueInDays: 14,
      lines: [{ description: 'Inspection avant embarquement', quantity: 1, unitPriceMinor: 35_000n }],
      payment: { method: 'EXTERNAL_RECORDED', amountMinor: 'FULL', reference: 'VIR-SBX-DEMO-0001' },
    },
  ];
  for (const spec of invoiceSpecs) {
    const existing = await prisma.invoice.findFirst({
      where: { organizationId: business.id, notes: spec.notes },
      select: { id: true },
    });
    if (existing) continue;
    if (spec.payment?.method === 'WALLET_SIMULATED' && !linked) {
      console.warn('  ! wallet-paid invoice skipped: the counterparty link is not ACCEPTED');
      continue;
    }
    const lines = spec.lines.map((l, i) => ({
      position: i + 1,
      description: l.description,
      quantity: l.quantity,
      unitPriceMinor: l.unitPriceMinor,
      totalMinor: l.unitPriceMinor * BigInt(l.quantity),
    }));
    const subtotalMinor = lines.reduce((acc, l) => acc + l.totalMinor, 0n);
    const taxMinor = taxOf(subtotalMinor, spec.taxBps);
    const totalMinor = subtotalMinor + taxMinor;
    const paymentMinor =
      spec.payment === undefined
        ? 0n
        : spec.payment.amountMinor === 'FULL'
          ? totalMinor
          : spec.payment.amountMinor;
    const now = new Date();
    await prisma.$transaction(
      async (db) => {
        const prefix = `INV-${year}-`;
        const count = await db.invoice.count({
          where: { organizationId: business.id, number: { startsWith: prefix } },
        });
        const number = `${prefix}${String(count + 1).padStart(4, '0')}`;
        const invoice = await db.invoice.create({
          data: {
            organizationId: business.id,
            createdByUserId: seller.user.id,
            counterpartyId: spec.toBuyer ? counterparty!.id : null,
            number,
            customerName: spec.customerName,
            customerEmail: spec.customerEmail,
            status: spec.status === 'DRAFT' ? 'DRAFT' : 'SENT',
            currencyCode: 'CAD',
            issueDate: now,
            dueDate: new Date(`${day(addDays(now, spec.dueInDays))}T00:00:00.000Z`),
            subtotalMinor,
            taxBps: spec.taxBps,
            taxMinor,
            totalMinor,
            notes: spec.notes,
            sentAt: spec.status === 'DRAFT' ? null : now,
            lines: { create: lines },
          },
        });
        await db.auditLog.create({
          data: {
            actorUserId: seller.user.id,
            organizationId: business.id,
            action: 'invoice.created',
            entityType: 'Invoice',
            entityId: invoice.id,
            metadata: { number, total: minorToDecimalString(totalMinor, 'CAD'), currency: 'CAD', seed: true },
          },
        });
        if (spec.status !== 'DRAFT') {
          await db.auditLog.create({
            data: {
              actorUserId: seller.user.id,
              organizationId: business.id,
              action: 'invoice.sent',
              entityType: 'Invoice',
              entityId: invoice.id,
              metadata: { number, seed: true },
            },
          });
          if (spec.toBuyer) {
            await db.notification.create({
              data: {
                userId: buyer.user.id,
                type: 'invoice.sent',
                title: `Facture ${number} reçue de ${business.name}`,
                body: `${minorToDecimalString(totalMinor, 'CAD')} CAD à régler avant le ${day(invoice.dueDate)}. ${SANDBOX_NOTICE}.`,
                data: { invoiceId: invoice.id, seed: true },
              },
            });
          }
        }
        if (spec.payment && paymentMinor > 0n) {
          const paymentId = randomUUID();
          let ledgerTransactionId: string | null = null;
          if (spec.payment.method === 'WALLET_SIMULATED') {
            const posted = await ledger.post(
              {
                idempotencyKey: `invoice-payment:${paymentId}`,
                kind: 'ADJUSTMENT',
                description: `Invoice ${number} paid from wallet by ${buyer.user.firstName} ${buyer.user.lastName} (simulated — no real funds)`,
                reference: invoice.id,
                metadata: {
                  purpose: 'INVOICE_PAYMENT',
                  invoiceId: invoice.id,
                  paymentId,
                  payerOrganizationId: buyer.org.id,
                  issuerOrganizationId: business.id,
                  by: buyer.user.id,
                  simulated: true,
                  seed: true,
                },
                entries: [
                  {
                    accountId: buyerCad.ledgerAccountId,
                    direction: 'DEBIT',
                    amountMinor: paymentMinor,
                    currencyCode: 'CAD',
                  },
                  {
                    accountId: businessCad.ledgerAccountId,
                    direction: 'CREDIT',
                    amountMinor: paymentMinor,
                    currencyCode: 'CAD',
                  },
                ],
              },
              db,
            );
            ledgerTransactionId = posted.id;
          }
          await db.invoicePayment.create({
            data: {
              id: paymentId,
              invoiceId: invoice.id,
              recordedByUserId: spec.payment.method === 'WALLET_SIMULATED' ? buyer.user.id : seller.user.id,
              amountMinor: paymentMinor,
              method: spec.payment.method,
              reference: spec.payment.reference ?? ledgerTransactionId,
              ledgerTransactionId,
              paidAt: now,
            },
          });
          const paid = paymentMinor >= totalMinor;
          await db.invoice.update({
            where: { id: invoice.id },
            data: {
              paidMinor: paymentMinor,
              status: paid ? 'PAID' : 'PARTIALLY_PAID',
              paidAt: paid ? now : null,
            },
          });
          await db.auditLog.create({
            data: {
              actorUserId: spec.payment.method === 'WALLET_SIMULATED' ? buyer.user.id : seller.user.id,
              organizationId: spec.payment.method === 'WALLET_SIMULATED' ? buyer.org.id : business.id,
              action:
                spec.payment.method === 'WALLET_SIMULATED'
                  ? 'invoice.paid_from_wallet'
                  : 'invoice.payment_recorded',
              entityType: 'InvoicePayment',
              entityId: paymentId,
              metadata: {
                invoiceId: invoice.id,
                method: spec.payment.method,
                amount: minorToDecimalString(paymentMinor, 'CAD'),
                currency: 'CAD',
                ledgerTransactionId,
                status: paid ? 'PAID' : 'PARTIALLY_PAID',
                simulated: true,
                seed: true,
              },
            },
          });
        }
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    counts.invoices++;
  }

  // ── 7. Quotes of Dakar Auto Import (draft, sent, accepted — ready to convert).
  const quoteSpecs: Array<{
    notes: string;
    status: 'DRAFT' | 'SENT' | 'ACCEPTED';
    taxBps: number;
    validForDays: number;
    lines: Array<{ description: string; quantity: number; unitPriceMinor: bigint }>;
  }> = [
    {
      notes: `Démo seed (phase 6) — devis brouillon. ${SANDBOX_NOTICE}.`,
      status: 'DRAFT',
      taxBps: 1800,
      validForDays: 30,
      lines: [
        {
          description: 'Export Toyota RAV4 2020 — logistique complète',
          quantity: 1,
          unitPriceMinor: 260_000n,
        },
      ],
    },
    {
      notes: `Démo seed (phase 6) — devis envoyé. ${SANDBOX_NOTICE}.`,
      status: 'SENT',
      taxBps: 0,
      validForDays: 21,
      lines: [
        { description: 'Pneus toutes saisons 215/65R16', quantity: 8, unitPriceMinor: 14_500n },
        { description: 'Groupage conteneur', quantity: 1, unitPriceMinor: 30_000n },
      ],
    },
    {
      notes: `Démo seed (phase 6) — devis accepté (à convertir). ${SANDBOX_NOTICE}.`,
      status: 'ACCEPTED',
      taxBps: 1800,
      validForDays: 14,
      lines: [{ description: 'Révision complète avant expédition', quantity: 1, unitPriceMinor: 48_000n }],
    },
  ];
  for (const spec of quoteSpecs) {
    const existing = await prisma.quote.findFirst({
      where: { organizationId: business.id, notes: spec.notes },
      select: { id: true },
    });
    if (existing) continue;
    const lines = spec.lines.map((l, i) => ({
      position: i + 1,
      description: l.description,
      quantity: l.quantity,
      unitPriceMinor: l.unitPriceMinor,
      totalMinor: l.unitPriceMinor * BigInt(l.quantity),
    }));
    const subtotalMinor = lines.reduce((acc, l) => acc + l.totalMinor, 0n);
    const taxMinor = taxOf(subtotalMinor, spec.taxBps);
    const now = new Date();
    await prisma.$transaction(async (db) => {
      const prefix = `QUO-${year}-`;
      const count = await db.quote.count({
        where: { organizationId: business.id, number: { startsWith: prefix } },
      });
      const number = `${prefix}${String(count + 1).padStart(4, '0')}`;
      const quote = await db.quote.create({
        data: {
          organizationId: business.id,
          createdByUserId: seller.user.id,
          counterpartyId: counterparty!.id,
          number,
          customerName: counterparty!.name,
          customerEmail: counterparty!.email,
          status: spec.status,
          currencyCode: 'CAD',
          validUntil: new Date(`${day(addDays(now, spec.validForDays))}T00:00:00.000Z`),
          subtotalMinor,
          taxBps: spec.taxBps,
          taxMinor,
          totalMinor: subtotalMinor + taxMinor,
          notes: spec.notes,
          sentAt: spec.status === 'DRAFT' ? null : now,
          acceptedAt: spec.status === 'ACCEPTED' ? now : null,
          lines: { create: lines },
        },
      });
      await db.auditLog.create({
        data: {
          actorUserId: seller.user.id,
          organizationId: business.id,
          action: 'quote.created',
          entityType: 'Quote',
          entityId: quote.id,
          metadata: { number, status: spec.status, seed: true },
        },
      });
    });
    counts.quotes++;
  }

  // ── 8. Sandbox API key of Dakar Auto Import: secret printed once, only the hash is stored.
  const keyName = 'Clé sandbox de démonstration (seed)';
  const existingKey = await prisma.apiCredential.findFirst({
    where: { organizationId: business.id, name: keyName, revokedAt: null },
    select: { keyPrefix: true },
  });
  if (existingKey) {
    console.log(
      `\nSandbox API key "${keyName}" already exists (${API_KEY_PREFIX}${existingKey.keyPrefix}_…): its secret is never shown again — rotate it from /developers if needed.`,
    );
  } else {
    const { key, keyPrefix, keyHash } = generateApiKey();
    const credential = await prisma.$transaction(async (db) => {
      const created = await db.apiCredential.create({
        data: {
          organizationId: business.id,
          createdByUserId: seller.user.id,
          name: keyName,
          description: `Clé de démonstration créée par le seed — lecture seule. ${SANDBOX_NOTICE}.`,
          keyPrefix,
          keyHash,
          scopes: ['transactions:read', 'wallets:read', 'transfers:read', 'invoices:read'],
          rateLimitPerMinute: 60,
          expiresAt: addDays(new Date(), 90),
        },
      });
      await db.auditLog.create({
        data: {
          actorUserId: seller.user.id,
          organizationId: business.id,
          action: 'api_credential.created',
          entityType: 'ApiCredential',
          entityId: created.id,
          metadata: { keyPrefix, scopes: created.scopes, rateLimitPerMinute: 60, seed: true },
        },
      });
      return created;
    });
    counts.apiKeys++;
    console.log('\n┌──────────────────────────────────────────────────────────────────────────────');
    console.log('│ SANDBOX API KEY — Dakar Auto Import (shown ONCE, only its SHA-256 hash is stored)');
    console.log(`│ ${key}`);
    console.log(`│ name: ${credential.name} · scopes: ${credential.scopes.join(', ')} · expires in 90 days`);
    console.log('│ SANDBOX ONLY — fictitious data, no real funds. Never use it outside the sandbox.');
    console.log('└──────────────────────────────────────────────────────────────────────────────');
  }

  // ── 9. Webhook subscription (disabled) towards a reserved, non-resolvable domain.
  const webhookUrl = 'https://example.invalid/webhooks';
  const existingWebhook = await prisma.webhookSubscription.findFirst({
    where: { organizationId: business.id, url: webhookUrl },
    select: { id: true },
  });
  if (!existingWebhook) {
    const secretEnc = sealString(KeyPurpose.WEBHOOKS, `whsec_${randomBytes(32).toString('base64url')}`);
    if (!secretEnc) {
      console.warn(
        '  ! webhook skipped: DOCUMENT_ENCRYPTION_KEY / ENCRYPTION_KEYRING not set (cannot seal the secret)',
      );
    } else {
      await prisma.$transaction(async (db) => {
        const created = await db.webhookSubscription.create({
          data: {
            organizationId: business.id,
            createdByUserId: seller.user.id,
            url: webhookUrl,
            description: `Webhook de démonstration (seed), désactivé — domaine réservé .invalid. ${SANDBOX_NOTICE}.`,
            secretEnc,
            events: ['invoice.paid', 'transfer.settled'],
            isActive: false,
          },
        });
        await db.auditLog.create({
          data: {
            actorUserId: seller.user.id,
            organizationId: business.id,
            action: 'webhook.created',
            entityType: 'WebhookSubscription',
            entityId: created.id,
            metadata: { url: webhookUrl, events: created.events, isActive: false, seed: true },
          },
        });
      });
      counts.webhooks++;
    }
  }

  // ── Balances for the console summary (always recomputed from the ledger).
  const balances: string[] = [];
  for (const [label, organizationId] of [
    ['moussa@demo.dfn (personnel)', buyer.org.id],
    ['Dakar Auto Import', business.id],
  ] as const) {
    const wallets = await prisma.wallet.findMany({
      where: { organizationId },
      orderBy: { currencyCode: 'asc' },
    });
    const parts: string[] = [];
    for (const w of wallets) {
      const b = await ledger.getBalance(w.ledgerAccountId);
      parts.push(`${minorToDecimalString(b.balanceMinor, w.currencyCode)} ${w.currencyCode}`);
    }
    balances.push(`${label}: ${parts.join(' · ') || '—'}`);
  }
  console.log(
    `\nPhase 6 demo data: ${Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')} (0 everywhere = already seeded)`,
  );
  return { counts, balances };
}

/** One demo transfer with the same events, provider events, audit records and postings as the API. */
async function seedTransfer(
  ctx: Phase6Context,
  spec: {
    seedKey: string;
    reference: string;
    status: 'SETTLED' | 'PROCESSING' | 'REVIEW_REQUIRED';
    beneficiary: Beneficiary;
    sourceAmountMinor: bigint;
    purpose: string;
  },
  clearingAccount: (currencyCode: string, db: Prisma.TransactionClient) => Promise<{ id: string }>,
) {
  const { provider, buyer, compliance, admin, buyerCad } = ctx;
  const src = 'CAD';
  const dst = spec.beneficiary.currencyCode;
  const rate = await fx.getRate(src, dst);
  const fee = quoteTransferFee(spec.sourceAmountMinor, src);
  const destinationAmountMinor = convertMinor(spec.sourceAmountMinor, rate, src, dst);
  const totalMinor = spec.sourceAmountMinor + fee.feeMinor;
  const source = minorToDecimalString(spec.sourceAmountMinor, src);
  const destination = minorToDecimalString(destinationAmountMinor, dst);
  const snapshot = {
    id: spec.beneficiary.id,
    name: spec.beneficiary.name,
    country: spec.beneficiary.country,
    currencyCode: spec.beneficiary.currencyCode,
    method: spec.beneficiary.method,
    accountIdentifierMasked: spec.beneficiary.accountIdentifierMasked,
    institutionName: spec.beneficiary.institutionName,
  };
  const reviewReason =
    'STRUCTURING: 3 operations each below 10000.00 CAD within 24 h (same organisation) — possible structuring | ' +
    'NEW_BENEFICIARY_HIGH_VALUE: High-value transfer to a beneficiary registered less than 24 hours ago';

  return prisma.$transaction(
    async (db) => {
      const now = new Date();
      const quote = await db.fXQuote.create({
        data: {
          organizationId: buyer.org.id,
          createdByUserId: buyer.user.id,
          originCountry: 'CA',
          destinationCountry: spec.beneficiary.country,
          sourceCurrency: src,
          destinationCurrency: dst,
          sourceAmountMinor: spec.sourceAmountMinor,
          rateNumerator: rate.numerator,
          rateDenominator: rate.denominator,
          feeBps: fee.feeBps,
          fixedFeeMinor: fee.fixedFeeMinor,
          feeMinor: fee.feeMinor,
          destinationAmountMinor,
          provider: rate.provider,
          status: 'USED',
          expiresAt: new Date(now.getTime() + FX_TTL_MS),
        },
      });
      const baseMetadata = {
        simulated: true,
        feeBps: fee.feeBps,
        fixedFeeMinor: fee.fixedFeeMinor.toString(),
        quoteExpiresAt: quote.expiresAt.toISOString(),
        provider: rate.provider,
        seed: true,
        seedKey: spec.seedKey,
      };
      const transfer = await db.transfer.create({
        data: {
          reference: spec.reference,
          organizationId: buyer.org.id,
          createdByUserId: buyer.user.id,
          providerId: provider.id,
          quoteId: quote.id,
          beneficiaryId: spec.beneficiary.id,
          originCountry: 'CA',
          destinationCountry: spec.beneficiary.country,
          sourceCurrency: src,
          destinationCurrency: dst,
          sourceAmountMinor: spec.sourceAmountMinor,
          feeMinor: fee.feeMinor,
          destinationAmountMinor,
          rateNumerator: rate.numerator,
          rateDenominator: rate.denominator,
          status: 'QUOTED',
          purpose: spec.purpose,
          beneficiary: snapshot,
          quotedAt: now,
          metadata: baseMetadata,
        },
      });
      const event = (type: string, actorUserId: string | null, payload: Record<string, unknown>) =>
        db.transferEvent.create({
          data: { transferId: transfer.id, type, actorUserId, payload: payload as Prisma.InputJsonValue },
        });
      const audit = (action: string, actorUserId: string | null, metadata: Record<string, unknown>) =>
        db.auditLog.create({
          data: {
            actorUserId,
            organizationId: buyer.org.id,
            action,
            entityType: 'Transfer',
            entityId: transfer.id,
            metadata: {
              reference: spec.reference,
              simulated: true,
              seed: true,
              ...metadata,
            } as Prisma.InputJsonValue,
          },
        });
      const notify = (userId: string, type: string, title: string, body: string) =>
        db.notification.create({
          data: {
            userId,
            type,
            title,
            body: `${body} ${SANDBOX_NOTICE}.`,
            data: { transferId: transfer.id, reference: spec.reference, seed: true },
          },
        });

      await event(TransferEventType.CREATED, buyer.user.id, {
        quoteId: quote.id,
        beneficiaryId: spec.beneficiary.id,
        purpose: spec.purpose,
      });
      await event(TransferEventType.QUOTED, buyer.user.id, {
        source,
        sourceCurrency: src,
        fee: minorToDecimalString(fee.feeMinor, src),
        destination,
        destinationCurrency: dst,
        quoteExpiresAt: quote.expiresAt.toISOString(),
        simulated: true,
      });
      await audit('transfer.created', buyer.user.id, {
        quoteId: quote.id,
        beneficiaryId: spec.beneficiary.id,
        accountIdentifierMasked: spec.beneficiary.accountIdentifierMasked,
        source,
        sourceCurrency: src,
        destinationCurrency: dst,
      });

      if (spec.status === 'REVIEW_REQUIRED') {
        // Held by the risk engine: nothing is debited until a compliance reviewer approves it.
        await db.transfer.update({
          where: { id: transfer.id },
          data: {
            status: 'REVIEW_REQUIRED',
            reviewReason,
            riskScore: 65,
            metadata: { ...baseMetadata, authorizationRequestedByUserId: buyer.user.id, mfaVerified: false },
          },
        });
        await event(TransferEventType.REVIEW_REQUIRED, buyer.user.id, {
          riskScore: 65,
          signals: ['STRUCTURING', 'NEW_BENEFICIARY_HIGH_VALUE'],
          reason: reviewReason,
        });
        await audit('transfer.review_required', buyer.user.id, {
          riskScore: 65,
          reviewReason,
          mfaVerified: false,
        });
        await notify(
          buyer.user.id,
          'transfer.review_required',
          `Transfert en revue de conformité — ${spec.reference}`,
          `Le transfert de ${source} ${src} vers « ${spec.beneficiary.name} » attend une revue par l'équipe conformité. Aucun fonds fictif n'a été débité.`,
        );
        for (const staff of [compliance, admin]) {
          await notify(
            staff.user.id,
            'transfer.review_required',
            `Revue requise — transfert ${spec.reference}`,
            `Score de risque 65 (STRUCTURING, NEW_BENEFICIARY_HIGH_VALUE). ${source} ${src} vers « ${spec.beneficiary.name} ».`,
          );
        }
        return { id: transfer.id, reference: spec.reference, sourceAmountMinor: spec.sourceAmountMinor };
      }

      // Source leg: wallet → FX clearing (+ platform fee).
      const srcClearing = await clearingAccount(src, db);
      const sourceLeg = await ledger.post(
        {
          idempotencyKey: `transfer-source:${transfer.id}`,
          kind: 'WITHDRAWAL',
          description: `Transfer ${spec.reference}: ${source} ${src} to ${spec.beneficiary.country} (simulated — no real funds)`,
          reference: transfer.id,
          metadata: {
            simulated: true,
            transferId: transfer.id,
            reference: spec.reference,
            organizationId: buyer.org.id,
            currencyCode: src,
            amountMinor: spec.sourceAmountMinor.toString(),
            feeMinor: fee.feeMinor.toString(),
            by: buyer.user.id,
            seed: true,
          },
          entries: [
            {
              accountId: buyerCad.ledgerAccountId,
              direction: 'DEBIT',
              amountMinor: totalMinor,
              currencyCode: src,
            },
            {
              accountId: srcClearing.id,
              direction: 'CREDIT',
              amountMinor: spec.sourceAmountMinor,
              currencyCode: src,
            },
            {
              accountCode: platformFeesCode(src),
              direction: 'CREDIT',
              amountMinor: fee.feeMinor,
              currencyCode: src,
            },
          ],
        },
        db,
      );
      const acceptedRef = `sbx_xfer_${spec.reference.slice(-6).toLowerCase()}_${randomBytes(3).toString('hex')}`;
      const authorizedAt = new Date();
      await db.transfer.update({
        where: { id: transfer.id },
        data: {
          status: 'PROCESSING',
          authorizedAt,
          processingAt: authorizedAt,
          sourceLedgerTransactionId: sourceLeg.id,
          riskScore: 0,
          metadata: {
            ...baseMetadata,
            authorizedByUserId: buyer.user.id,
            authorizedVia: 'AUTHORIZE',
            mfaVerified: false,
          },
        },
      });
      await event(TransferEventType.AUTHORIZED, buyer.user.id, {
        ledgerTransactionId: sourceLeg.id,
        debited: minorToDecimalString(totalMinor, src),
        currency: src,
        via: 'AUTHORIZE',
        mfaVerified: false,
        simulated: true,
      });
      await event(TransferEventType.PROCESSING, buyer.user.id, {
        provider: provider.code,
        externalRef: acceptedRef,
        simulated: true,
      });
      await db.providerEvent.create({
        data: {
          providerId: provider.id,
          type: 'transfer.accepted',
          externalRef: acceptedRef,
          idempotencyKey: `${provider.code}:${spec.reference}:ACCEPTED`,
          payload: {
            transferReference: spec.reference,
            amount: spec.sourceAmountMinor.toString(),
            currency: src,
            destinationAmount: destinationAmountMinor.toString(),
            destinationCurrency: dst,
            simulated: true,
          },
          status: 'PROCESSED',
          processedAt: authorizedAt,
        },
      });
      await audit('transfer.authorized', buyer.user.id, {
        ledgerTransactionId: sourceLeg.id,
        debited: minorToDecimalString(totalMinor, src),
        currency: src,
        riskScore: 0,
        mfaVerified: false,
      });

      if (spec.status === 'PROCESSING') {
        await notify(
          buyer.user.id,
          'transfer.processing',
          `Transfert en traitement (simulé) — ${spec.reference}`,
          `${minorToDecimalString(totalMinor, src)} ${src} fictifs ont été débités du portefeuille ; le partenaire simulé traite le transfert vers « ${spec.beneficiary.name} ».`,
        );
        return { id: transfer.id, reference: spec.reference, sourceAmountMinor: spec.sourceAmountMinor };
      }

      // Destination leg (simulated partner settlement): FX clearing → partner settlement.
      const settledRef = `sbx_settled_${randomBytes(6).toString('hex')}`;
      const providerEvent = await db.providerEvent.create({
        data: {
          providerId: provider.id,
          type: 'transfer.settled',
          externalRef: settledRef,
          idempotencyKey: `${provider.code}:${spec.reference}:SETTLED`,
          payload: {
            transferReference: spec.reference,
            outcome: 'SETTLED',
            triggeredBy: 'seed',
            simulated: true,
          },
        },
      });
      const dstClearing = await clearingAccount(dst, db);
      const destinationLeg = await ledger.post(
        {
          idempotencyKey: `transfer-dest:${transfer.id}`,
          kind: 'WITHDRAWAL',
          description: `Payout of ${spec.reference}: ${destination} ${dst} by ${provider.code} (simulated — no real funds)`,
          reference: transfer.id,
          metadata: {
            simulated: true,
            transferId: transfer.id,
            reference: spec.reference,
            providerEventId: providerEvent.id,
            externalRef: settledRef,
            seed: true,
          },
          entries: [
            {
              accountId: dstClearing.id,
              direction: 'DEBIT',
              amountMinor: destinationAmountMinor,
              currencyCode: dst,
            },
            {
              accountCode: providerSettlementCode(provider.code, dst),
              direction: 'CREDIT',
              amountMinor: destinationAmountMinor,
              currencyCode: dst,
            },
          ],
        },
        db,
      );
      const settledAt = new Date();
      await db.transfer.update({
        where: { id: transfer.id },
        data: {
          status: 'SETTLED',
          settledAt,
          externalRef: settledRef,
          destinationLedgerTransactionId: destinationLeg.id,
        },
      });
      await event(TransferEventType.SETTLED, null, {
        ledgerTransactionId: destinationLeg.id,
        destination,
        destinationCurrency: dst,
        externalRef: settledRef,
        triggeredBy: 'seed',
        simulated: true,
      });
      await db.providerEvent.update({
        where: { id: providerEvent.id },
        data: { status: 'PROCESSED', processedAt: settledAt },
      });
      await audit('transfer.settled', null, {
        ledgerTransactionId: destinationLeg.id,
        externalRef: settledRef,
        triggeredBy: 'seed',
      });
      await notify(
        buyer.user.id,
        'transfer.settled',
        `Transfert réglé (simulé) — ${spec.reference}`,
        `Le partenaire simulé a confirmé le versement de ${destination} ${dst} fictifs à « ${spec.beneficiary.name} ».`,
      );
      return { id: transfer.id, reference: spec.reference, sourceAmountMinor: spec.sourceAmountMinor };
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
