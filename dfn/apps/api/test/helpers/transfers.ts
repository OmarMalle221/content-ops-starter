import { expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { LedgerService, providerSettlementCode, walletAccountCode } from '@dfn/financial-ledger';
import { SANDBOX_PROVIDER_CODE } from '@dfn/payment-adapters';
import { parseDecimalToMinor } from '@dfn/shared';
import { encryptString } from '../../src/common/crypto';
import { LEDGER } from '../../src/modules/ledger/ledger.provider';
import { WalletsService } from '../../src/modules/ledger/wallets.service';
import { Client, promote, registerUser, type TestContext } from './app';

export interface TransferActors {
  /** OWNER of her personal organisation (CA). */
  owner: Client;
  ownerUser: any;
  orgId: string;
  /** Member of none of the owner's organisations. */
  outsider: Client;
  outsiderUser: any;
  outsiderOrgId: string;
  /** Staff (COMPLIANCE) — may review transfers but is a member of no organisation under test. */
  compliance: Client;
  complianceUser: any;
}

export async function createTransferActors(ctx: TestContext, suffix = ''): Promise<TransferActors> {
  const o = await registerUser(ctx, `xfer-owner${suffix}@example.com`, {
    firstName: 'Aminata',
    lastName: 'Sarr',
    country: 'CA',
  });
  const x = await registerUser(ctx, `xfer-outsider${suffix}@example.com`, {
    firstName: 'Paul',
    lastName: 'Gagnon',
    country: 'CA',
  });
  const c = await registerUser(ctx, `xfer-compliance${suffix}@example.com`, {
    firstName: 'Rama',
    lastName: 'Seck',
    country: 'CA',
  });
  await promote(ctx, `xfer-compliance${suffix}@example.com`, 'COMPLIANCE');
  return {
    owner: o.client,
    ownerUser: o.user,
    orgId: o.user.organizations[0].id as string,
    outsider: x.client,
    outsiderUser: x.user,
    outsiderOrgId: x.user.organizations[0].id as string,
    compliance: c.client,
    complianceUser: c.user,
  };
}

/** Credits fictitious units to the organisation wallet straight through the ledger (test seed). */
export async function fundWallet(
  ctx: TestContext,
  organizationId: string,
  currencyCode: string,
  amount: string,
) {
  const ledger = ctx.app.get<LedgerService>(LEDGER);
  const wallets = ctx.app.get(WalletsService);
  const wallet = await wallets.ensureWallet(organizationId, currencyCode);
  const amountMinor = parseDecimalToMinor(amount, currencyCode);
  return ledger.post({
    idempotencyKey: `test-seed:${organizationId}:${currencyCode}:${randomUUID()}`,
    kind: 'DEPOSIT',
    description: 'Test seed deposit (simulated)',
    reference: organizationId,
    metadata: { simulated: true, test: true },
    entries: [
      {
        accountCode: providerSettlementCode(SANDBOX_PROVIDER_CODE, currencyCode),
        direction: 'DEBIT',
        amountMinor,
        currencyCode,
      },
      { accountId: wallet.ledgerAccountId, direction: 'CREDIT', amountMinor, currencyCode },
    ],
  });
}

export async function balanceOf(ctx: TestContext, accountCode: string): Promise<bigint> {
  const ledger = ctx.app.get<LedgerService>(LEDGER);
  const account = await ledger.getAccountByCode(accountCode);
  if (!account) return 0n;
  return (await ledger.getBalance(account.id)).balanceMinor;
}

export function walletBalance(ctx: TestContext, organizationId: string, currencyCode: string) {
  return balanceOf(ctx, walletAccountCode(organizationId, currencyCode));
}

/** Beneficiary rows are created directly (the beneficiaries API belongs to the wallet feature). */
export async function createBeneficiary(
  ctx: TestContext,
  input: { organizationId: string; createdByUserId: string } & Partial<{
    name: string;
    country: string;
    currencyCode: string;
    method: 'BANK_ACCOUNT' | 'MOBILE_MONEY';
    accountIdentifier: string;
    institutionName: string;
    status: 'ACTIVE' | 'REMOVED';
    createdAt: Date;
  }>,
) {
  const identifier = input.accountIdentifier ?? 'SN08SN0101520000001234567890';
  return ctx.prisma.beneficiary.create({
    data: {
      organizationId: input.organizationId,
      createdByUserId: input.createdByUserId,
      name: input.name ?? 'Awa Diop',
      country: input.country ?? 'SN',
      currencyCode: input.currencyCode ?? 'XOF',
      method: input.method ?? 'BANK_ACCOUNT',
      accountIdentifierEnc: encryptString(process.env.DOCUMENT_ENCRYPTION_KEY!, identifier),
      accountIdentifierMasked: `••••${identifier.slice(-4)}`,
      institutionName: input.institutionName ?? 'CBAO Groupe Attijariwafa bank',
      status: input.status ?? 'ACTIVE',
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
  });
}

export const CA_SN_QUOTE = {
  originCountry: 'CA',
  destinationCountry: 'SN',
  sourceCurrency: 'CAD',
  destinationCurrency: 'XOF',
  amount: '500.00',
};

export async function requestQuote(client: Client, overrides: Record<string, unknown> = {}) {
  const res = await client.post('/v1/transfers/quotes', { ...CA_SN_QUOTE, ...overrides });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

export async function createTransfer(
  client: Client,
  quoteId: string,
  beneficiaryId: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await client.post('/v1/transfers', {
    quoteId,
    beneficiaryId,
    purpose: 'FAMILY_SUPPORT',
    ...overrides,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

/** Quote + transfer in one go, for an organisation whose wallet is already funded. */
export async function quoteAndCreate(
  client: Client,
  beneficiaryId: string,
  quoteOverrides: Record<string, unknown> = {},
  transferOverrides: Record<string, unknown> = {},
) {
  const quote = await requestQuote(client, quoteOverrides);
  const transfer = await createTransfer(client, quote.id, beneficiaryId, transferOverrides);
  return { quote, transfer };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
