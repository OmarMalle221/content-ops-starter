/* eslint-disable no-console */
/**
 * Demo seed — SANDBOX ONLY. Creates demo accounts, a business organisation and three
 * transactions at different stages, with balanced ledger postings.
 *
 * Demo password: set SEED_DEMO_PASSWORD, otherwise a strong default is used and printed once.
 * Accounts: admin@demo.dfn, compliance@demo.dfn, moussa@demo.dfn (buyer, Montréal),
 *           awa@demo.dfn (seller, Dakar Auto Import), ibrahima@demo.dfn (business member).
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';

const prisma = new PrismaClient();
const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'Demo-Sandbox-2026!Protect';
const SANDBOX_PROVIDER = 'SANDBOX_PARTNER';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

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
  return prisma.ledgerAccount.upsert({
    where: { code },
    update: {},
    create: {
      code,
      name,
      type,
      normalBalance,
      currencyCode,
      ownerType,
      ownerId: ownerId ?? null,
      allowNegative,
    },
  });
}

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
  const debits = entries.filter((e) => e.direction === 'DEBIT').reduce((a, e) => a + e.amountMinor, 0n);
  const credits = entries.filter((e) => e.direction === 'CREDIT').reduce((a, e) => a + e.amountMinor, 0n);
  if (debits !== credits) throw new Error(`Seed posting ${idempotencyKey} is unbalanced`);
  return prisma.ledgerTransaction.upsert({
    where: { idempotencyKey },
    update: {},
    create: {
      idempotencyKey,
      kind,
      description,
      reference,
      metadata: { simulated: true, seed: true },
      entries: { create: entries },
    },
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
  await prisma.auditLog.create({
    data: { action: 'system.seed', entityType: 'System', metadata: { accounts: 5, transactions: 3 } },
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
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
