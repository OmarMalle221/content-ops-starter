import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@dfn/database';
import { JobRegistry } from '../src/modules/jobs/job-registry';
import { ReferenceDataService } from '../src/modules/reference/reference-data.service';
import {
  Client,
  PASSWORD,
  bootTestApp,
  promote,
  registerUser,
  resetDatabase,
  type TestContext,
} from './helpers/app';
import { createBeneficiary, createTransferActors, fundWallet, quoteAndCreate } from './helpers/transfers';
import { enableMfa } from './helpers/webauthn';

const HOUR = 3_600_000;

// REQUIRE_STAFF_MFA: staff picked by their stored role (notifications, assignees, SLA escalation)
// must have two-factor authentication, like staff acting through a session.
let ctx: TestContext;
beforeAll(async () => {
  ctx = await bootTestApp({ REQUIRE_STAFF_MFA: 'true' });
});
beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  await ctx.app.get(ReferenceDataService).ensure();
});
afterAll(async () => {
  await ctx.close();
});

async function staff(email: string, role: 'ADMIN' | 'COMPLIANCE', withMfa: boolean) {
  const { user } = await registerUser(ctx, email, { firstName: 'Rama', lastName: email.split('@')[0] });
  await promote(ctx, email, role);
  const client = new Client(ctx);
  const login = await client.post('/v1/auth/login', { email, password: PASSWORD });
  expect(login.status, JSON.stringify(login.body)).toBeLessThan(300);
  if (withMfa) await enableMfa(client);
  return { client, user: user as { id: string; email: string } };
}

function alert(data: Partial<Prisma.RiskAlertUncheckedCreateInput> = {}) {
  return ctx.prisma.riskAlert.create({
    data: {
      ruleCode: 'VELOCITY_24H',
      severity: 'MEDIUM',
      score: 15,
      explanation: { summary: 'Test alert', factors: {}, recommendation: 'Review' },
      ...data,
    },
  });
}

describe('REQUIRE_STAFF_MFA — staff recipients and assignees', () => {
  it('sends the review notification of a flagged transfer only to staff with two-factor authentication', async () => {
    const a = await createTransferActors(ctx); // a.compliance: COMPLIANCE without MFA
    const secured = await staff('secured-admin@example.com', 'ADMIN', true);
    await fundWallet(ctx, a.orgId, 'CAD', '40000.00');
    const beneficiary = await createBeneficiary(ctx, {
      organizationId: a.orgId,
      createdByUserId: a.ownerUser.id,
    });
    const reviewNotifications = (userId: string) =>
      ctx.prisma.notification.count({ where: { userId, type: 'transfer.review_required' } });

    // 15 000 CAD by an unverified user: held for review, staff are told (risk score, rule codes).
    const { transfer } = await quoteAndCreate(a.owner, beneficiary.id, { amount: '15000.00' });
    const held = await a.owner.post(`/v1/transfers/${transfer.id}/authorize`, {});
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    expect(held.body.status).toBe('REVIEW_REQUIRED');
    expect(await reviewNotifications(secured.user.id)).toBe(1);
    expect(await reviewNotifications(a.complianceUser.id)).toBe(0);

    // Once the compliance officer enables MFA, the next flagged transfer reaches them too.
    await enableMfa(a.compliance);
    const { transfer: second } = await quoteAndCreate(a.owner, beneficiary.id, { amount: '15000.00' });
    expect((await a.owner.post(`/v1/transfers/${second.id}/authorize`, {})).body.status).toBe(
      'REVIEW_REQUIRED',
    );
    expect(await reviewNotifications(secured.user.id)).toBe(2);
    expect(await reviewNotifications(a.complianceUser.id)).toBe(1);
  });

  it('refuses to assign a review to staff without two-factor authentication until they enable it', async () => {
    const lead = await staff('lead@example.com', 'COMPLIANCE', true);
    const analyst = await staff('analyst@example.com', 'COMPLIANCE', false);
    const { user: subject } = await registerUser(ctx, 'subject@example.com');
    const a = await alert({ userId: subject.id, dueAt: new Date(Date.now() + 72 * HOUR) });

    const listed = await lead.client.get('/v1/admin/risk-alerts/assignees');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const ids = (listed.body.items as Array<{ id: string }>).map((u) => u.id);
    expect(ids).toContain(lead.user.id);
    expect(ids).not.toContain(analyst.user.id);

    const refused = await lead.client.post(`/v1/admin/risk-alerts/${a.id}/assign`, {
      assigneeUserId: analyst.user.id,
    });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('ALERT_NOT_ASSIGNABLE');
    expect(
      (await ctx.prisma.riskAlert.findUniqueOrThrow({ where: { id: a.id } })).assignedToUserId,
    ).toBeNull();
    expect(
      await ctx.prisma.notification.count({
        where: { userId: analyst.user.id, type: 'risk.alert_assigned' },
      }),
    ).toBe(0);

    await enableMfa(analyst.client);
    const relisted = await lead.client.get('/v1/admin/risk-alerts/assignees');
    expect((relisted.body.items as Array<{ id: string }>).map((u) => u.id)).toContain(analyst.user.id);
    const assigned = await lead.client.post(`/v1/admin/risk-alerts/${a.id}/assign`, {
      assigneeUserId: analyst.user.id,
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect(assigned.body.assignedTo.id).toBe(analyst.user.id);
    expect(
      await ctx.prisma.notification.count({
        where: { userId: analyst.user.id, type: 'risk.alert_assigned' },
      }),
    ).toBe(1);
  });

  it('REVIEW_SLA escalates a breach assigned to staff without two-factor authentication to eligible staff', async () => {
    const lead = await staff('lead@example.com', 'COMPLIANCE', true);
    const analyst = await staff('analyst@example.com', 'COMPLIANCE', false);
    const now = Date.now();
    // Assigned before REQUIRE_STAFF_MFA was switched on (straight in the database).
    await alert({
      status: 'REVIEWING',
      createdAt: new Date(now - 80 * HOUR),
      dueAt: new Date(now - HOUR),
      assignedToUserId: analyst.user.id,
      assignedAt: new Date(now - 70 * HOUR),
    });

    const run = await ctx.app.get(JobRegistry).get('REVIEW_SLA')!({ triggeredBy: 'test' });
    expect(run.summary).toMatchObject({
      breached: 1,
      notifiedAssignee: 0,
      notifiedStaff: 1,
      notifications: 1,
    });
    const breaches = (userId: string) =>
      ctx.prisma.notification.count({ where: { userId, type: 'risk.review_sla_breached' } });
    expect(await breaches(lead.user.id)).toBe(1);
    expect(await breaches(analyst.user.id)).toBe(0);
  });
});
