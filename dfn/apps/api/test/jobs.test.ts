import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decryptString } from '../src/common/crypto';
import { ReferenceDataService } from '../src/modules/reference/reference-data.service';
import { JobRegistry } from '../src/modules/jobs/job-registry';
import { MaintenanceService } from '../src/modules/jobs/maintenance.service';
import { JobLeaseStore } from '../src/modules/jobs/job-lease';
import { JobsSchedulerService } from '../src/modules/jobs/jobs-scheduler.service';
import {
  ANONYMIZED_ORGANIZATION_NAME,
  anonymizationCutoff,
  anonymizeAfter,
  anonymizedEmail,
  buildAnonymizedUser,
} from '../src/modules/jobs/anonymization';
import {
  Client,
  PASSWORD,
  PDF_BYTES,
  bootTestApp,
  promote,
  registerUser,
  resetDatabase,
  type TestContext,
} from './helpers/app';
import { createActors, fundTransaction } from './helpers/protect';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DELETE_BODY = { password: PASSWORD, confirmation: 'DELETE' };

let ctx: TestContext;
beforeAll(async () => {
  // The anonymisation grace period must be zero for the ANONYMIZE_DELETED job to act in tests.
  process.env.ANONYMIZE_AFTER_DAYS = '0';
  ctx = await bootTestApp();
});
beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  await ctx.app.get(ReferenceDataService).ensure();
});
afterAll(async () => {
  await ctx.close();
});

describe('anonymisation rules (pure mapping)', () => {
  it('derives a non-routable unique email from the user id', () => {
    expect(anonymizedEmail('3F2B1C4D-1111-2222-3333-444444444444')).toBe(
      'deleted-3f2b1c4d@anonymized.invalid',
    );
  });

  it('replaces every identifying attribute and keeps the country', () => {
    const now = new Date('2026-10-11T10:00:00Z');
    const requested = new Date('2026-09-01T00:00:00Z');
    const fields = buildAnonymizedUser(
      { id: 'abcdef12-0000-0000-0000-000000000000', country: 'SN', deletionRequestedAt: requested },
      '$argon2id$random',
      now,
    );
    expect(fields).toEqual({
      email: 'deleted-abcdef12@anonymized.invalid',
      firstName: 'Utilisateur',
      lastName: 'Supprimé',
      phone: null,
      country: 'SN',
      mfaSecretEnc: null,
      mfaEnabled: false,
      mfaLastUsedStep: null,
      passwordHash: '$argon2id$random',
      securityPreferences: null,
      status: 'DEACTIVATED',
      failedLoginCount: 0,
      lockedUntil: null,
      deletionRequestedAt: requested,
      deletedAt: now,
      anonymizedAt: now,
    });
    expect(ANONYMIZED_ORGANIZATION_NAME).toBe('Compte supprimé');
  });

  it('computes the grace period boundaries', () => {
    const now = new Date('2026-10-11T10:00:00Z');
    expect(anonymizationCutoff(now, 30).toISOString()).toBe('2026-09-11T10:00:00.000Z');
    expect(anonymizationCutoff(now, 0).getTime()).toBe(now.getTime());
    expect(anonymizeAfter(null, 30)).toBeNull();
    expect(anonymizeAfter(now, 30)?.toISOString()).toBe('2026-11-10T10:00:00.000Z');
  });
});

describe('maintenance jobs', () => {
  it('runs BALANCE_SNAPSHOTS, RECONCILIATION and EXPIRE_STALE and records MaintenanceRun rows', async () => {
    const svc = ctx.app.get(MaintenanceService);
    const activeAccounts = await ctx.prisma.ledgerAccount.count({ where: { status: 'ACTIVE' } });
    expect(activeAccounts).toBeGreaterThan(0);

    const snapshots = await svc.run('BALANCE_SNAPSHOTS', 'test');
    expect(snapshots.status).toBe('COMPLETED');
    expect(snapshots.triggeredBy).toBe('test');
    expect(snapshots.finishedAt).not.toBeNull();
    expect((snapshots.summary as any).accounts).toBe(activeAccounts);
    expect(await ctx.prisma.balanceSnapshot.count()).toBe(activeAccounts);

    const reconciliation = await svc.run('RECONCILIATION', 'test');
    expect(reconciliation.status).toBe('COMPLETED');
    const summary = reconciliation.summary as any;
    expect(typeof summary.jobId).toBe('string');
    expect(summary.differences).toBe(0);
    expect(summary.unbalancedTransactions).toBe(0);
    expect(summary.notified).toBe(0);
    const job = await ctx.prisma.reconciliationJob.findUnique({ where: { id: summary.jobId } });
    expect(job?.status).toBe('COMPLETED');

    const { user } = await registerUser(ctx, 'fx@example.com');
    const organizationId = user.organizations[0].id as string;
    const quote = (expiresAt: Date) =>
      ctx.prisma.fXQuote.create({
        data: {
          organizationId,
          createdByUserId: user.id,
          sourceCurrency: 'CAD',
          destinationCurrency: 'XOF',
          sourceAmountMinor: 10_000n,
          rateNumerator: 450n,
          rateDenominator: 1n,
          feeBps: 100,
          fixedFeeMinor: 0n,
          feeMinor: 100n,
          destinationAmountMinor: 4_455_000n,
          provider: 'sandbox',
          status: 'QUOTED',
          expiresAt,
        },
      });
    const stale = await quote(new Date(Date.now() - 60_000));
    const fresh = await quote(new Date(Date.now() + 15 * 60_000));

    const expire = await svc.run('EXPIRE_STALE', 'test');
    expect(expire.status).toBe('COMPLETED');
    expect((expire.summary as any).fxQuotesExpired).toBe(1);
    expect((expire.summary as any).transactionsExpired).toBe(0);
    expect((await ctx.prisma.fXQuote.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('EXPIRED');
    expect((await ctx.prisma.fXQuote.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe('QUOTED');

    const runs = await ctx.prisma.maintenanceRun.findMany({ orderBy: { startedAt: 'asc' } });
    expect(runs.map((r) => r.jobName)).toEqual(['BALANCE_SNAPSHOTS', 'RECONCILIATION', 'EXPIRE_STALE']);
    expect(runs.every((r) => r.status === 'COMPLETED' && r.error === null)).toBe(true);
  });

  it('notifies active staff when the reconciliation detects anomalies', async () => {
    await registerUser(ctx, 'admin@example.com');
    await promote(ctx, 'admin@example.com', 'ADMIN');
    await registerUser(ctx, 'compliance@example.com');
    await promote(ctx, 'compliance@example.com', 'COMPLIANCE');
    await registerUser(ctx, 'plain@example.com');
    const account = await ctx.prisma.ledgerAccount.findFirstOrThrow({ orderBy: { code: 'asc' } });
    // A snapshot that does not match the entries breaks the continuity check.
    await ctx.prisma.balanceSnapshot.create({
      data: { accountId: account.id, balanceMinor: 12_345n, entryCount: 0 },
    });

    const run = await ctx.app.get(MaintenanceService).run('RECONCILIATION', 'test');
    expect(run.status).toBe('COMPLETED');
    expect((run.summary as any).differences).toBeGreaterThanOrEqual(1);
    expect((run.summary as any).notified).toBe(2);
    const notifications = await ctx.prisma.notification.findMany({
      where: { type: 'ledger.reconciliation_anomalies' },
      include: { user: { select: { email: true } } },
    });
    expect(notifications.map((n) => n.user.email).sort()).toEqual([
      'admin@example.com',
      'compliance@example.com',
    ]);
    expect(notifications[0].body).toContain('Données fictives');
  });

  it('serialises concurrent executions of the same job with a job lease', async () => {
    const registry = ctx.app.get(JobRegistry);
    const svc = ctx.app.get(MaintenanceService);
    registry.register('WEBHOOK_RETRY', async () => {
      await sleep(400);
      return { summary: { slow: true } };
    });
    const results = await Promise.allSettled([svc.run('WEBHOOK_RETRY', 'a'), svc.run('WEBHOOK_RETRY', 'b')]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0].value.status).toBe('COMPLETED');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.code).toBe('JOB_ALREADY_RUNNING');
    expect(rejected[0].reason.status).toBe(409);
    expect(await ctx.prisma.maintenanceRun.count({ where: { jobName: 'WEBHOOK_RETRY' } })).toBe(1);
    // The lock is released afterwards: the job can run again.
    expect((await svc.run('WEBHOOK_RETRY', 'c')).status).toBe('COMPLETED');
  });

  it('records a FAILED run with the error when a handler throws', async () => {
    ctx.app.get(JobRegistry).register('INVOICE_OVERDUE', async () => {
      throw new Error('boom: simulated handler failure');
    });
    const run = await ctx.app.get(MaintenanceService).run('INVOICE_OVERDUE', 'test');
    expect(run.status).toBe('FAILED');
    expect(run.error).toContain('boom');
    expect(run.finishedAt).not.toBeNull();
  });
});

describe('admin jobs console', () => {
  it('requires ADMIN_JOBS, lists jobs, runs them on demand and audits the trigger', async () => {
    const { client: plain } = await registerUser(ctx, 'plain@example.com');
    const { client: staff, user: staffUser } = await registerUser(ctx, 'compliance@example.com');
    await promote(ctx, 'compliance@example.com', 'COMPLIANCE');

    expect((await plain.get('/v1/admin/jobs')).status).toBe(403);
    expect((await plain.post('/v1/admin/jobs/BALANCE_SNAPSHOTS/run')).status).toBe(403);
    expect((await plain.get('/v1/admin/jobs/runs')).status).toBe(403);

    const list = await staff.get('/v1/admin/jobs');
    expect(list.status).toBe(200);
    expect(list.body.sandbox).toBe(true);
    expect(list.body.schedulerEnabled).toBe(false); // NODE_ENV=test
    expect(typeof list.body.intervalMinutes).toBe('number');
    expect(list.body.anonymizeAfterDays).toBe(0);
    const names = list.body.jobs.map((j: any) => j.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'BALANCE_SNAPSHOTS',
        'RECONCILIATION',
        'EXPIRE_STALE',
        'ANONYMIZE_DELETED',
        'TRANSFER_PROCESSING',
        'WEBHOOK_RETRY',
        'INVOICE_OVERDUE',
      ]),
    );
    const snapshotsJob = list.body.jobs.find((j: any) => j.name === 'BALANCE_SNAPSHOTS');
    expect(snapshotsJob.registered).toBe(true);
    expect(snapshotsJob.lastRun).toBeNull();

    const run = await staff.post('/v1/admin/jobs/BALANCE_SNAPSHOTS/run');
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    expect(run.body.status).toBe('COMPLETED');
    expect(run.body.triggeredBy).toBe(`manual:${staffUser.id}`);
    expect(run.body.summary.accounts).toBeGreaterThan(0);

    const after = await staff.get('/v1/admin/jobs');
    expect(after.body.jobs.find((j: any) => j.name === 'BALANCE_SNAPSHOTS').lastRun.id).toBe(run.body.id);

    const runs = await staff.get('/v1/admin/jobs/runs?jobName=BALANCE_SNAPSHOTS&page=1&pageSize=10');
    expect(runs.status).toBe(200);
    expect(runs.body.total).toBe(1);
    expect(runs.body.items[0].id).toBe(run.body.id);
    expect((await staff.get('/v1/admin/jobs/runs?jobName=NOPE')).status).toBe(400);

    const unknown = await staff.post('/v1/admin/jobs/NOT_A_JOB/run');
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('VALIDATION_FAILED');

    const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'admin.job_run' } });
    expect(audit?.actorUserId).toBe(staffUser.id);
    expect(audit?.entityId).toBe(run.body.id);
    expect((audit?.metadata as any).jobName).toBe('BALANCE_SNAPSHOTS');
  });
});

describe('account deletion', () => {
  it('refuses deletion while the user is party to an open transaction', async () => {
    const actors = await createActors(ctx);
    await fundTransaction(ctx, actors);

    const buyer = await actors.buyer.post('/v1/users/me/deletion-request', DELETE_BODY);
    expect(buyer.status).toBe(409);
    expect(buyer.body.code).toBe('ACCOUNT_HAS_OPEN_ITEMS');
    expect(buyer.body.details.openTransactions).toBe(1);
    const seller = await actors.seller.post('/v1/users/me/deletion-request', DELETE_BODY);
    expect(seller.status).toBe(409);
    expect(seller.body.details.openTransactions).toBe(1);

    const status = await actors.buyer.get('/v1/users/me/deletion-request/status');
    expect(status.status).toBe(200);
    expect(status.body.blockers.openTransactions).toBe(1);
    expect(status.body.canRequest).toBe(false);
    expect(status.body.anonymizeAfterDays).toBe(0);
    expect(status.body.deletionRequestedAt).toBeNull();
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: actors.buyerUser.id } });
    expect(user.status).toBe('ACTIVE');
    expect(user.deletionRequestedAt).toBeNull();
  });

  it('validates the password and the typed confirmation', async () => {
    const { client } = await registerUser(ctx, 'careful@example.com');
    const wrongPassword = await client.post('/v1/users/me/deletion-request', {
      password: 'NotMyPassword123',
      confirmation: 'DELETE',
    });
    expect(wrongPassword.status).toBe(400);
    const wrongWord = await client.post('/v1/users/me/deletion-request', {
      password: PASSWORD,
      confirmation: 'delete',
    });
    expect(wrongWord.status).toBe(400);
    expect(wrongWord.body.code).toBe('VALIDATION_FAILED');
    expect(
      (await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'careful@example.com' } })).status,
    ).toBe('ACTIVE');
  });

  it('refuses deletion when a personal wallet holds a balance or a business org depends on the owner', async () => {
    const { client: admin } = await registerUser(ctx, 'admin@example.com');
    await promote(ctx, 'admin@example.com', 'ADMIN');
    const { client: rich, user: richUser } = await registerUser(ctx, 'rich@example.com');
    const deposit = await admin.post('/v1/sandbox/wallets/deposit', {
      organizationId: richUser.organizations[0].id,
      currencyCode: 'CAD',
      amount: '100.00',
    });
    expect(deposit.status, JSON.stringify(deposit.body)).toBe(200);
    const blocked = await rich.post('/v1/users/me/deletion-request', DELETE_BODY);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('ACCOUNT_HAS_OPEN_ITEMS');
    expect(blocked.body.details.walletsWithBalance).toBe(1);

    const { client: owner } = await registerUser(ctx, 'owner@example.com');
    const org = await owner.post('/v1/organizations', {
      name: 'Dakar Auto Import',
      country: 'SN',
      legalName: 'Dakar Auto Import SARL',
      registrationNumber: 'SN-DKR-2021-B-1234',
    });
    expect(org.status).toBe(201);
    const invite = await owner.post(`/v1/organizations/${org.body.id}/members/invite`, {
      email: 'member@example.com',
      role: 'MEMBER',
    });
    expect(invite.status).toBe(201);
    const { client: member } = await registerUser(ctx, 'member@example.com');
    expect(
      (await member.post('/v1/organizations/invitations/accept', { token: invite.body.token })).status,
    ).toBe(201);
    const soleOwner = await owner.post('/v1/users/me/deletion-request', DELETE_BODY);
    expect(soleOwner.status).toBe(409);
    expect(soleOwner.body.details.soleOwnerOrganizations).toBe(1);
    // The plain member is free to leave: nothing depends on them.
    const memberStatus = await member.get('/v1/users/me/deletion-request/status');
    expect(memberStatus.body.canRequest).toBe(true);
  });

  it('refuses deletion while a transfer is in flight, an invoice or quote is open, or an API key is active', async () => {
    const { client, user } = await registerUser(ctx, 'busy@example.com');
    const organizationId = user.organizations[0].id as string;
    const blockers = async () => (await client.get('/v1/users/me/deletion-request/status')).body.blockers;
    const inAWeek = new Date(Date.now() + 7 * 86_400_000);

    const transfer = await ctx.prisma.transfer.create({
      data: {
        reference: 'TRF-TEST-00001',
        organizationId,
        createdByUserId: user.id,
        originCountry: 'CA',
        destinationCountry: 'SN',
        sourceCurrency: 'CAD',
        destinationCurrency: 'XOF',
        sourceAmountMinor: 10_000n,
        status: 'QUOTED',
        beneficiary: { name: 'Awa Diop', accountIdentifierMasked: '••••7890' },
      },
    });
    const blocked = await client.post('/v1/users/me/deletion-request', DELETE_BODY);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('ACCOUNT_HAS_OPEN_ITEMS');
    expect(blocked.body.details.openTransfers).toBe(1);
    await ctx.prisma.transfer.update({ where: { id: transfer.id }, data: { status: 'SETTLED' } });
    expect((await blockers()).openTransfers).toBe(0);

    const invoice = await ctx.prisma.invoice.create({
      data: {
        organizationId,
        createdByUserId: user.id,
        number: 'INV-0001',
        customerName: 'Client fictif',
        status: 'SENT',
        currencyCode: 'CAD',
        dueDate: inAWeek,
      },
    });
    const quote = await ctx.prisma.quote.create({
      data: {
        organizationId,
        createdByUserId: user.id,
        number: 'QUO-0001',
        customerName: 'Client fictif',
        status: 'SENT',
        currencyCode: 'CAD',
        validUntil: inAWeek,
      },
    });
    const open = await client.post('/v1/users/me/deletion-request', DELETE_BODY);
    expect(open.status).toBe(409);
    expect(open.body.details).toMatchObject({ openInvoices: 1, openQuotes: 1, openTransfers: 0 });
    await ctx.prisma.invoice.update({ where: { id: invoice.id }, data: { status: 'PAID' } });
    await ctx.prisma.quote.update({ where: { id: quote.id }, data: { status: 'DECLINED' } });
    expect(await blockers()).toMatchObject({ openInvoices: 0, openQuotes: 0 });

    const key = await client.post('/v1/api-credentials', { name: 'ERP', scopes: ['transactions:read'] });
    expect(key.status, JSON.stringify(key.body)).toBe(201);
    const keyed = await client.post('/v1/users/me/deletion-request', DELETE_BODY);
    expect(keyed.status).toBe(409);
    expect(keyed.body.details.activeApiCredentials).toBe(1);
    // Expired and revoked keys no longer count.
    await ctx.prisma.apiCredential.update({
      where: { id: key.body.credential.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await blockers()).activeApiCredentials).toBe(0);
    const second = await client.post('/v1/api-credentials', { name: 'ERP 2', scopes: ['transactions:read'] });
    expect(second.status).toBe(201);
    expect((await blockers()).activeApiCredentials).toBe(1);
    expect((await client.delete(`/v1/api-credentials/${second.body.credential.id}`)).status).toBe(200);
    const status = await client.get('/v1/users/me/deletion-request/status');
    expect(status.body.blockers.activeApiCredentials).toBe(0);
    expect(status.body.canRequest).toBe(true);
  });

  it('refuses deletion when a business organisation the user alone belongs to still holds a balance', async () => {
    const { client: admin } = await registerUser(ctx, 'admin@example.com');
    await promote(ctx, 'admin@example.com', 'ADMIN');
    const { client: solo } = await registerUser(ctx, 'solo@example.com');
    const org = await solo.post('/v1/organizations', {
      name: 'Solo Trading',
      country: 'SN',
      legalName: 'Solo Trading SARL',
      registrationNumber: 'SN-DKR-2023-B-0001',
    });
    expect(org.status).toBe(201);
    // Alone in the organisation with empty wallets: nothing depends on the user.
    expect((await solo.get('/v1/users/me/deletion-request/status')).body.canRequest).toBe(true);

    const deposit = await admin.post('/v1/sandbox/wallets/deposit', {
      organizationId: org.body.id,
      currencyCode: 'XOF',
      amount: '15000',
    });
    expect(deposit.status, JSON.stringify(deposit.body)).toBe(200);
    const blocked = await solo.post('/v1/users/me/deletion-request', DELETE_BODY);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('ACCOUNT_HAS_OPEN_ITEMS');
    expect(blocked.body.details).toMatchObject({
      soleMemberOrganizationsWithBalance: 1,
      soleOwnerOrganizations: 0,
      walletsWithBalance: 0,
    });
  });

  it('scrubs beneficiaries, counterparties, customer emails and session identifiers on anonymisation', async () => {
    const { client, user } = await registerUser(ctx, 'erase@example.com');
    const bankAccount = {
      country: 'SN',
      currencyCode: 'XOF',
      method: 'BANK_ACCOUNT',
      accountIdentifier: 'SN08SN0101520000001234567890',
      institutionName: 'CBAO',
    };
    const beneficiary = await client.post('/v1/beneficiaries', {
      ...bankAccount,
      name: 'Awa Diop',
      phone: '+221771234567',
      email: 'awa.diop@example.com',
    });
    expect(beneficiary.status, JSON.stringify(beneficiary.body)).toBe(201);

    // Another tenant keeps the user in its address book and bills them; its own data is retained.
    const { client: vendor, user: vendorUser } = await registerUser(ctx, 'vendor@example.com');
    const vendorOrgId = vendorUser.organizations[0].id as string;
    const contact = await vendor.post(`/v1/organizations/${vendorOrgId}/counterparties`, {
      name: 'Test erase',
      email: 'Erase@example.com',
      phone: '+1 514 555 0199',
    });
    expect(contact.status, JSON.stringify(contact.body)).toBe(201);
    const vendorBeneficiary = await vendor.post('/v1/beneficiaries', { ...bankAccount, name: 'Mamadou Ba' });
    expect(vendorBeneficiary.status).toBe(201);
    const inAWeek = new Date(Date.now() + 7 * 86_400_000);
    const invoice = await ctx.prisma.invoice.create({
      data: {
        organizationId: vendorOrgId,
        createdByUserId: vendorUser.id,
        counterpartyId: contact.body.id,
        number: 'INV-0001',
        customerName: 'Test erase',
        customerEmail: 'erase@example.com',
        status: 'DRAFT',
        currencyCode: 'CAD',
        dueDate: inAWeek,
      },
    });
    const quote = await ctx.prisma.quote.create({
      data: {
        organizationId: vendorOrgId,
        createdByUserId: vendorUser.id,
        counterpartyId: contact.body.id,
        number: 'QUO-0001',
        customerName: 'Test erase',
        customerEmail: 'ERASE@example.com',
        status: 'DRAFT',
        currencyCode: 'CAD',
        validUntil: inAWeek,
      },
    });

    // Authentication material that must not survive the account: a passkey and recovery codes.
    await ctx.prisma.webAuthnCredential.create({
      data: {
        userId: user.id,
        credentialId: 'cred-erase-1',
        publicKey: Buffer.from('pk'),
        transports: ['internal'],
        name: 'iPhone de Test',
      },
    });
    await ctx.prisma.mfaRecoveryCode.createMany({
      data: [
        { userId: user.id, codeHash: 'h1' },
        { userId: user.id, codeHash: 'h2' },
      ],
    });
    // The vendor's counterparty created with the user's email is a pending link request.
    expect(
      (await ctx.prisma.counterparty.findUniqueOrThrow({ where: { id: contact.body.id } })).linkStatus,
    ).toBe('PENDING');

    expect((await client.post('/v1/users/me/deletion-request', DELETE_BODY)).status).toBe(200);
    const run = await ctx.app.get(MaintenanceService).run('ANONYMIZE_DELETED', 'test');
    expect(run.status).toBe('COMPLETED');
    expect((run.summary as any).anonymized).toBe(1);
    expect(await ctx.prisma.webAuthnCredential.count({ where: { userId: user.id } })).toBe(0);
    expect(await ctx.prisma.mfaRecoveryCode.count({ where: { userId: user.id } })).toBe(0);

    const scrubbed = await ctx.prisma.beneficiary.findUniqueOrThrow({ where: { id: beneficiary.body.id } });
    expect(scrubbed).toMatchObject({
      name: 'Bénéficiaire supprimé',
      phone: null,
      email: null,
      status: 'REMOVED',
      accountIdentifierMasked: '••••',
    });
    expect(scrubbed.removedAt).not.toBeNull();
    expect(decryptString(process.env.DOCUMENT_ENCRYPTION_KEY!, scrubbed.accountIdentifierEnc)).toBe('');
    const kept = await ctx.prisma.beneficiary.findUniqueOrThrow({ where: { id: vendorBeneficiary.body.id } });
    expect(kept.name).toBe('Mamadou Ba');
    expect(kept.status).toBe('ACTIVE');
    const counterparty = await ctx.prisma.counterparty.findUniqueOrThrow({ where: { id: contact.body.id } });
    expect(counterparty).toMatchObject({
      name: 'Contact supprimé',
      email: null,
      phone: null,
      organizationId: vendorOrgId,
      linkStatus: 'REVOKED',
      linkedOrganizationId: null,
    });
    expect(
      (await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).customerEmail,
    ).toBeNull();
    expect((await ctx.prisma.quote.findUniqueOrThrow({ where: { id: quote.id } })).customerEmail).toBeNull();
    const sessions = await ctx.prisma.session.findMany({ where: { userId: user.id } });
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.ip === null && s.userAgent === null && s.revokedAt !== null)).toBe(true);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'user.anonymized', entityId: user.id },
    });
    expect(audit.metadata).toMatchObject({
      beneficiariesAnonymized: 1,
      counterpartiesAnonymized: 1,
      customerEmailsCleared: 2,
      passkeysDeleted: 1,
      recoveryCodesDeleted: 2,
      linkRequestsRevoked: 1,
    });
    // Audit rows keep their network identifiers (audit retention policy); the job stays idempotent.
    const requested = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'user.deletion_requested', entityId: user.id },
    });
    expect(requested.ip).not.toBeNull();
    const again = await ctx.app.get(MaintenanceService).run('ANONYMIZE_DELETED', 'test');
    expect((again.summary as any).anonymized).toBe(0);
    expect(
      (await ctx.prisma.beneficiary.findUniqueOrThrow({ where: { id: beneficiary.body.id } })).removedAt,
    ).toEqual(scrubbed.removedAt);
  });

  it('deactivates a clean account, lets an admin cancel, then anonymises it after the delay', async () => {
    const { client, user } = await registerUser(ctx, 'clean@example.com', {
      firstName: 'Fatou',
      lastName: 'Sow',
    });
    const personalOrgId = user.organizations[0].id as string;
    const verification = await client.post('/v1/verifications/identity', {
      documentType: 'PASSPORT',
      issuingCountry: 'CA',
    });
    expect(verification.status).toBe(201);
    const document = await client.upload(
      '/v1/documents',
      { kind: 'OTHER', title: 'Note personnelle' },
      { name: 'note.pdf', buffer: PDF_BYTES, type: 'application/pdf' },
    );
    expect(document.status, JSON.stringify(document.body)).toBe(201);
    const originalHash = (await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash;

    const requested = await client.post('/v1/users/me/deletion-request', { ...DELETE_BODY, reason: 'Test' });
    expect(requested.status, JSON.stringify(requested.body)).toBe(200);
    expect(requested.body.status).toBe('DEACTIVATED');
    expect(typeof requested.body.deletionRequestedAt).toBe('string');
    expect(typeof requested.body.anonymizeAfter).toBe('string');
    expect(requested.body.anonymizeAfterDays).toBe(0);

    // Sessions are revoked and the account can no longer log in.
    expect((await client.get('/v1/auth/me')).status).toBe(401);
    const login = await new Client(ctx).post('/v1/auth/login', {
      email: 'clean@example.com',
      password: PASSWORD,
    });
    expect(login.status).toBe(403);
    const deactivated = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(deactivated.status).toBe('DEACTIVATED');
    expect(deactivated.deletionRequestedAt).not.toBeNull();
    expect(await ctx.prisma.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'user.deletion_requested', entityId: user.id } }),
    ).toBe(1);
    expect(
      await ctx.prisma.notification.count({ where: { userId: user.id, type: 'account.deletion_requested' } }),
    ).toBe(1);

    // Staff can cancel during the grace period (ADMIN_USERS only).
    const { client: compliance } = await registerUser(ctx, 'compliance@example.com');
    await promote(ctx, 'compliance@example.com', 'COMPLIANCE');
    expect((await compliance.post(`/v1/admin/users/${user.id}/deletion-cancel`)).status).toBe(403);
    const { client: admin } = await registerUser(ctx, 'admin@example.com');
    await promote(ctx, 'admin@example.com', 'ADMIN');
    expect(
      (await admin.post('/v1/admin/users/00000000-0000-4000-8000-000000000000/deletion-cancel')).status,
    ).toBe(404);
    const cancelled = await admin.post(`/v1/admin/users/${user.id}/deletion-cancel`);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.status).toBe('ACTIVE');
    expect((await admin.post(`/v1/admin/users/${user.id}/deletion-cancel`)).body.code).toBe(
      'NO_DELETION_REQUEST',
    );
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'admin.user_deletion_cancelled', entityId: user.id },
      }),
    ).toBe(1);

    // The user logs in again and renews the request; the job anonymises the row (delay = 0 days).
    const back = new Client(ctx);
    expect(
      (await back.post('/v1/auth/login', { email: 'clean@example.com', password: PASSWORD })).status,
    ).toBe(200);
    expect((await back.post('/v1/users/me/deletion-request', DELETE_BODY)).status).toBe(200);

    const run = await ctx.app.get(MaintenanceService).run('ANONYMIZE_DELETED', 'test');
    expect(run.status).toBe('COMPLETED');
    expect((run.summary as any).due).toBe(1);
    expect((run.summary as any).anonymized).toBe(1);

    const anonymized = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(anonymized.email).toBe(`deleted-${user.id.slice(0, 8)}@anonymized.invalid`);
    expect(anonymized.firstName).toBe('Utilisateur');
    expect(anonymized.lastName).toBe('Supprimé');
    expect(anonymized.phone).toBeNull();
    expect(anonymized.country).toBe('CA');
    expect(anonymized.mfaEnabled).toBe(false);
    expect(anonymized.mfaSecretEnc).toBeNull();
    expect(anonymized.securityPreferences).toBeNull();
    expect(anonymized.passwordHash).not.toBe(originalHash);
    expect(anonymized.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(anonymized.status).toBe('DEACTIVATED');
    expect(anonymized.anonymizedAt).not.toBeNull();
    expect(anonymized.deletedAt).not.toBeNull();
    expect(await ctx.prisma.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    const iv = await ctx.prisma.identityVerification.findFirstOrThrow({ where: { userId: user.id } });
    expect(iv.declaredData).toEqual({ anonymized: true });
    expect(iv.providerResponse).toBeNull();
    const doc = await ctx.prisma.document.findUniqueOrThrow({ where: { id: document.body.id } });
    expect(doc.deletedAt).not.toBeNull();
    const org = await ctx.prisma.organization.findUniqueOrThrow({ where: { id: personalOrgId } });
    expect(org.name).toBe('Compte supprimé');
    const audit = await ctx.prisma.auditLog.findFirst({
      where: { action: 'user.anonymized', entityId: user.id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorUserId).toBeNull();

    // Nobody can log in with the old or the new identity.
    const anon = new Client(ctx);
    expect(
      (await anon.post('/v1/auth/login', { email: 'clean@example.com', password: PASSWORD })).status,
    ).toBe(401);
    expect((await anon.post('/v1/auth/login', { email: anonymized.email, password: PASSWORD })).status).toBe(
      401,
    );
    // Anonymised accounts cannot be restored, and the job is idempotent.
    expect((await admin.post(`/v1/admin/users/${user.id}/deletion-cancel`)).body.code).toBe(
      'ACCOUNT_ALREADY_ANONYMIZED',
    );
    const again = await ctx.app.get(MaintenanceService).run('ANONYMIZE_DELETED', 'test');
    expect((again.summary as any).anonymized).toBe(0);
  });
});

describe('in-process scheduler driver (leases)', () => {
  it('ticks every registered job and skips the ones leased by another instance', async () => {
    const registry = ctx.app.get(JobRegistry);
    registry.register('INVOICE_OVERDUE', async () => ({ summary: { overdue: 0 } }));
    registry.register('WEBHOOK_RETRY', async () => ({ summary: { due: 0 } }));
    const elsewhere = new JobLeaseStore(ctx.prisma, 'replica-elsewhere', 60);
    await elsewhere.acquire('RECONCILIATION', randomUUID());

    const scheduler = ctx.app.get(JobsSchedulerService);
    expect(scheduler.driver).toBe('inprocess');
    expect(await scheduler.status()).toMatchObject({ driver: 'inprocess', started: false, nextRuns: {} });
    const outcome = await scheduler.tick('scheduler');
    expect(outcome.skipped).toEqual(['RECONCILIATION']);
    expect(outcome.ran).toEqual(expect.arrayContaining(['BALANCE_SNAPSHOTS', 'EXPIRE_STALE']));
    expect(await ctx.prisma.maintenanceRun.count({ where: { jobName: 'RECONCILIATION' } })).toBe(0);
    const runs = await ctx.prisma.maintenanceRun.findMany({ where: { jobName: 'BALANCE_SNAPSHOTS' } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      triggeredBy: 'scheduler',
      instanceId: ctx.app.get(MaintenanceService).instanceId,
    });
    // Only the foreign lease remains: every lease taken by the tick was released.
    const leases = await ctx.prisma.jobLease.findMany();
    expect(leases.map((l) => l.ownerId)).toEqual(['replica-elsewhere']);
  });
});
