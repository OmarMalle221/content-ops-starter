import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../../src/bootstrap';
import { PrismaService } from '../../src/common/prisma/prisma.service';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

const TABLES = [
  'RegulatoryGateEvent',
  'RegulatoryGate',
  'JobLease',
  'AuthChallenge',
  'MfaRecoveryCode',
  'WebAuthnCredential',
  'WebhookDelivery',
  'WebhookSubscription',
  'ApiRequestLog',
  'ApiCredential',
  'IdempotencyRecord',
  'InvoicePayment',
  'InvoiceLine',
  'Invoice',
  'QuoteLine',
  'Quote',
  'TransferEvent',
  'Transfer',
  'FXQuote',
  'Beneficiary',
  'MaintenanceRun',
  'DigitalAssetSimulation',
  'RiskAlertAction',
  'RiskAlert',
  'Notification',
  'AuditLog',
  'DisputeDecision',
  'DisputeMessage',
  'Evidence',
  'Dispute',
  'ContractAcceptance',
  'ContractVersion',
  'Contract',
  'Milestone',
  'Document',
  'TransactionEvent',
  'ProviderEvent',
  'FundingRequest',
  'TransactionParty',
  'Transaction',
  'Transfer',
  'FXQuote',
  'DigitalAssetSimulation',
  'ApiCredential',
  'WebhookSubscription',
  'ReconciliationDifference',
  'ReconciliationJob',
  'BalanceSnapshot',
  'LedgerEntry',
  'LedgerTransaction',
  'Wallet',
  'LedgerAccount',
  'Counterparty',
  'BusinessVerification',
  'IdentityVerification',
  'OrganizationInvitation',
  'OrganizationMember',
  'Organization',
  'Session',
  'User',
  'PaymentProvider',
  'Currency',
];

export async function resetDatabase(prisma: PrismaService) {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(',')} CASCADE`);
}

export async function bootTestApp(): Promise<TestContext> {
  const { app } = await createApp();
  await app.init();
  const prisma = app.get(PrismaService);
  return {
    app,
    prisma,
    http: () => request(app.getHttpServer()),
    close: async () => {
      await app.close();
    },
  };
}

/** Cookie-jar aware client bound to one user. */
export class Client {
  private cookie = '';
  constructor(private readonly ctx: TestContext) {}

  private withCookie(r: request.Test) {
    return this.cookie ? r.set('Cookie', this.cookie) : r;
  }
  private capture(res: request.Response) {
    const set = res.headers['set-cookie'] as unknown as string[] | undefined;
    if (set?.length) this.cookie = set.map((c) => c.split(';')[0]).join('; ');
    return res;
  }
  get(url: string) {
    return this.withCookie(this.ctx.http().get(url)).then((r) => this.capture(r));
  }
  post(url: string, body?: unknown) {
    return this.withCookie(
      this.ctx
        .http()
        .post(url)
        .send(body ?? {}),
    ).then((r) => this.capture(r));
  }
  patch(url: string, body?: unknown) {
    return this.withCookie(
      this.ctx
        .http()
        .patch(url)
        .send(body ?? {}),
    ).then((r) => this.capture(r));
  }
  put(url: string, body?: unknown) {
    return this.withCookie(
      this.ctx
        .http()
        .put(url)
        .send(body ?? {}),
    ).then((r) => this.capture(r));
  }
  delete(url: string) {
    return this.withCookie(this.ctx.http().delete(url)).then((r) => this.capture(r));
  }
  upload(url: string, fields: Record<string, string>, file: { name: string; buffer: Buffer; type: string }) {
    let r = this.ctx.http().post(url);
    if (this.cookie) r = r.set('Cookie', this.cookie);
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r
      .attach('file', file.buffer, { filename: file.name, contentType: file.type })
      .then((res) => this.capture(res));
  }
}

export const PASSWORD = 'CorrectHorse42Battery';

export async function registerUser(ctx: TestContext, email: string, overrides: Record<string, unknown> = {}) {
  const client = new Client(ctx);
  const res = await client.post('/v1/auth/register', {
    email,
    password: PASSWORD,
    firstName: overrides.firstName ?? 'Test',
    lastName: overrides.lastName ?? email.split('@')[0],
    country: overrides.country ?? 'CA',
    locale: 'fr',
    acceptTerms: true,
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { client, user: res.body.user as any };
}

export async function promote(ctx: TestContext, email: string, role: 'ADMIN' | 'COMPLIANCE') {
  await ctx.prisma.user.update({ where: { email }, data: { globalRole: role } });
}

/** Minimal valid PDF bytes for upload tests. */
export const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
);
export const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);
