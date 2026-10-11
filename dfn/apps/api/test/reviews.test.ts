import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@dfn/database';
import { LedgerService } from '@dfn/financial-ledger';
import { JobRegistry } from '../src/modules/jobs/job-registry';
import { LEDGER } from '../src/modules/ledger/ledger.provider';
import { WalletsService } from '../src/modules/ledger/wallets.service';
import { ReferenceDataService } from '../src/modules/reference/reference-data.service';
import { RiskService } from '../src/modules/risk/risk.service';
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
import { createWalletActors, selfDeposit } from './helpers/wallet';

const HOUR = 3_600_000;

let ctx: TestContext;
beforeAll(async () => {
  ctx = await bootTestApp();
});
beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  await ctx.app.get(ReferenceDataService).ensure();
});
afterAll(async () => {
  await ctx.close();
});

async function staff(email: string, role: 'ADMIN' | 'COMPLIANCE', firstName = 'Rama', lastName = 'Seck') {
  const { user } = await registerUser(ctx, email, { firstName, lastName });
  await promote(ctx, email, role);
  const client = new Client(ctx);
  const login = await client.post('/v1/auth/login', { email, password: PASSWORD });
  expect(login.status, JSON.stringify(login.body)).toBeLessThan(300);
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

describe('review SLA', () => {
  it('sets dueAt = createdAt + SLA(severity) on every new alert', async () => {
    const { user } = await registerUser(ctx, 'subject@example.com');
    const risk = ctx.app.get(RiskService);
    expect(risk.slaHours).toEqual({ HIGH: 24, MEDIUM: 72, LOW: 168 });

    await risk.evaluateAndRecord({ event: 'auth.login_failed', userId: user.id, failedLoginsLast15m: 10 });
    await risk.evaluateAndRecord({ event: 'auth.login_failed', userId: user.id, failedLoginsLast15m: 6 });
    await risk.evaluateAndRecord({
      event: 'transaction.created',
      userId: user.id,
      userCountry: 'FR',
      originCountry: 'CA',
      corridorSupported: true,
    });
    const alerts = await ctx.prisma.riskAlert.findMany({ where: { userId: user.id } });
    expect(alerts.map((a) => a.severity).sort()).toEqual(['HIGH', 'LOW', 'MEDIUM']);
    const expected = { HIGH: 24, MEDIUM: 72, LOW: 168 } as const;
    for (const a of alerts) {
      expect(a.dueAt, a.ruleCode).not.toBeNull();
      expect(a.dueAt!.getTime() - a.createdAt.getTime()).toBe(expected[a.severity] * HOUR);
      expect(a.firstActionAt).toBeNull();
      expect(a.slaBreachedAt).toBeNull();
    }
  });

  it('REVIEW_SLA marks each breach once and notifies the assignee or every active staff member', async () => {
    const admin = await staff('admin@example.com', 'ADMIN', 'Awa', 'Admin');
    const analyst = await staff('analyst@example.com', 'COMPLIANCE', 'Binta', 'Analyste');
    const other = await staff('other@example.com', 'COMPLIANCE', 'Cheikh', 'Autre');
    const suspended = await staff('suspended@example.com', 'COMPLIANCE', 'Daba', 'Suspendue');
    await ctx.prisma.user.update({ where: { id: suspended.user.id }, data: { status: 'SUSPENDED' } });
    const now = Date.now();

    const unassigned = await alert({
      severity: 'HIGH',
      createdAt: new Date(now - 30 * HOUR),
      dueAt: new Date(now - 6 * HOUR),
    });
    const assigned = await alert({
      status: 'REVIEWING',
      createdAt: new Date(now - 80 * HOUR),
      dueAt: new Date(now - HOUR),
      assignedToUserId: analyst.user.id,
      assignedAt: new Date(now - 70 * HOUR),
    });
    // Assigned to someone who is no longer active staff: falls back to every staff member.
    const orphan = await alert({
      status: 'CONTESTED',
      createdAt: new Date(now - 100 * HOUR),
      dueAt: new Date(now - 2 * HOUR),
      assignedToUserId: suspended.user.id,
    });
    // Created without a deadline (legacy path): backfilled from createdAt, then breached.
    const legacy = await alert({ severity: 'HIGH', createdAt: new Date(now - 48 * HOUR), dueAt: null });
    const notYet = await alert({ severity: 'LOW', dueAt: new Date(now + 10 * HOUR) });
    const closed = await alert({ status: 'DISMISSED', dueAt: new Date(now - 10 * HOUR) });

    const registry = ctx.app.get(JobRegistry);
    expect(registry.has('REVIEW_SLA')).toBe(true);
    const first = await registry.get('REVIEW_SLA')!({ triggeredBy: 'test' });
    expect(first.summary).toMatchObject({
      dueAtBackfilled: 1,
      breached: 4,
      notifiedAssignee: 1,
      notifiedStaff: 3,
      truncated: false,
    });

    const byId = async (id: string) => ctx.prisma.riskAlert.findUniqueOrThrow({ where: { id } });
    for (const a of [unassigned, assigned, orphan, legacy])
      expect((await byId(a.id)).slaBreachedAt).not.toBeNull();
    expect((await byId(legacy.id)).dueAt!.getTime()).toBe(legacy.createdAt.getTime() + 24 * HOUR);
    expect((await byId(notYet.id)).slaBreachedAt).toBeNull();
    expect((await byId(closed.id)).slaBreachedAt).toBeNull();

    const count = (userId: string) =>
      ctx.prisma.notification.count({ where: { userId, type: 'risk.review_sla_breached' } });
    // analyst: own assigned alert + the 3 unassigned / orphaned ones (as staff).
    expect(await count(analyst.user.id)).toBe(4);
    expect(await count(admin.user.id)).toBe(3);
    expect(await count(other.user.id)).toBe(3);
    expect(await count(suspended.user.id)).toBe(0);
    const assignedNotif = await ctx.prisma.notification.findFirst({
      where: {
        userId: analyst.user.id,
        type: 'risk.review_sla_breached',
        data: { path: ['alertId'], equals: assigned.id },
      },
    });
    expect(assignedNotif?.body).toContain('vous est assignée');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'risk.review_sla_breached' } })).toBe(4);

    // Idempotent: a second run notifies nobody.
    const second = await registry.get('REVIEW_SLA')!({ triggeredBy: 'test' });
    expect(second.summary).toMatchObject({ dueAtBackfilled: 0, breached: 0, notifications: 0 });
    expect(await count(analyst.user.id)).toBe(4);
  });
});

describe('assignment and decisions', () => {
  it('lets compliance assign, reassign and unassign; refuses users, non-staff assignees and decided alerts', async () => {
    const { client: user, user: plain } = await registerUser(ctx, 'plain@example.com');
    const analyst = await staff('analyst@example.com', 'COMPLIANCE', 'Binta', 'Analyste');
    const admin = await staff('admin@example.com', 'ADMIN', 'Awa', 'Admin');
    const suspended = await staff('suspended@example.com', 'COMPLIANCE');
    await ctx.prisma.user.update({ where: { id: suspended.user.id }, data: { status: 'SUSPENDED' } });
    const a = await alert({ userId: plain.id, dueAt: new Date(Date.now() + 72 * HOUR) });

    // RBAC: a plain user has no access to the queue.
    expect((await user.post(`/v1/admin/risk-alerts/${a.id}/assign`, { assigneeUserId: 'me' })).status).toBe(
      403,
    );
    expect((await user.get('/v1/admin/risk-alerts')).status).toBe(403);
    expect((await user.get('/v1/admin/risk-alerts/stats')).status).toBe(403);
    expect((await user.get('/v1/admin/risk-alerts.csv')).status).toBe(403);

    // "Assign to me": no notification to oneself.
    const mine = await analyst.client.post(`/v1/admin/risk-alerts/${a.id}/assign`, { assigneeUserId: 'me' });
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.assignedTo).toMatchObject({ id: analyst.user.id, name: 'Binta Analyste' });
    expect(mine.body.assignedAt).toBeTruthy();
    expect(mine.body.firstActionAt).toBeNull(); // assignment is not a review action
    expect(mine.body.nextActions).toEqual(['START_REVIEW', 'CONFIRM', 'DISMISS', 'ASSIGN', 'UNASSIGN']);
    expect(
      await ctx.prisma.notification.count({
        where: { userId: analyst.user.id, type: 'risk.alert_assigned' },
      }),
    ).toBe(0);

    // Reassign to an admin: audited and notified.
    const re = await analyst.client.post(`/v1/admin/risk-alerts/${a.id}/assign`, {
      assigneeUserId: admin.user.id,
    });
    expect(re.status).toBe(200);
    expect(re.body.assignedTo.id).toBe(admin.user.id);
    expect(
      await ctx.prisma.notification.count({ where: { userId: admin.user.id, type: 'risk.alert_assigned' } }),
    ).toBe(1);
    const audits = await ctx.prisma.auditLog.findMany({
      where: { entityId: a.id, action: 'admin.risk_alert_assigned' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits).toHaveLength(2);
    expect(audits[1].actorUserId).toBe(analyst.user.id);
    expect(audits[1].metadata).toMatchObject({ from: analyst.user.id, to: admin.user.id });

    // Assignee must be ACTIVE COMPLIANCE / ADMIN staff.
    for (const assigneeUserId of [plain.id, suspended.user.id, randomUUID()]) {
      const bad = await analyst.client.post(`/v1/admin/risk-alerts/${a.id}/assign`, { assigneeUserId });
      expect(bad.status).toBe(422);
      expect(bad.body.code).toBe('ALERT_NOT_ASSIGNABLE');
    }
    expect((await analyst.client.post(`/v1/admin/risk-alerts/${a.id}/assign`, {})).status).toBe(400);
    expect(
      (await analyst.client.post(`/v1/admin/risk-alerts/${randomUUID()}/assign`, { assigneeUserId: 'me' }))
        .status,
    ).toBe(404);

    // Unassign.
    const un = await admin.client.post(`/v1/admin/risk-alerts/${a.id}/assign`, { assigneeUserId: null });
    expect(un.status).toBe(200);
    expect(un.body.assignedTo).toBeNull();
    expect(
      (
        await ctx.prisma.riskAlertAction.findMany({ where: { alertId: a.id }, orderBy: { createdAt: 'asc' } })
      ).map((x) => x.action),
    ).toEqual(['ASSIGN', 'ASSIGN', 'UNASSIGN']);

    // Decided alerts cannot be (re)assigned.
    const dismissed = await analyst.client.post(`/v1/admin/risk-alerts/${a.id}/actions`, {
      action: 'DISMISS',
      note: 'Opérations documentées, client connu.',
    });
    expect(dismissed.status).toBe(201);
    const late = await analyst.client.post(`/v1/admin/risk-alerts/${a.id}/assign`, { assigneeUserId: 'me' });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('ALERT_NOT_ASSIGNABLE');
  });

  it('records the actor, the first action and a mandatory note; CONTEST reopens with a new SLA cycle', async () => {
    const { user: plain } = await registerUser(ctx, 'plain@example.com');
    const analyst = await staff('analyst@example.com', 'COMPLIANCE');
    const created = new Date(Date.now() - 100 * HOUR);
    const a = await alert({
      userId: plain.id,
      createdAt: created,
      dueAt: new Date(created.getTime() + 72 * HOUR),
      slaBreachedAt: new Date(Date.now() - 20 * HOUR),
    });
    const s = await alert({ ruleCode: 'STRUCTURING', severity: 'HIGH', userId: plain.id });

    // Empty or too short notes are refused (decisions must be explained).
    for (const note of ['', '  ', 'ok']) {
      const r = await analyst.client.post(`/v1/admin/risk-alerts/${a.id}/actions`, {
        action: 'CONFIRM',
        note,
      });
      expect(r.status).toBe(400);
    }

    // START_REVIEW on an unassigned alert assigns it to the reviewer and stamps firstActionAt.
    const started = await analyst.client.post(`/v1/admin/risk-alerts/${a.id}/actions`, {
      action: 'START_REVIEW',
      note: 'Analyse en cours.',
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body.status).toBe('REVIEWING');
    expect(started.body.assignedTo.id).toBe(analyst.user.id);
    const firstActionAt = started.body.firstActionAt;
    expect(firstActionAt).toBeTruthy();

    const confirmed = await analyst.client.post(`/v1/admin/risk-alerts/${a.id}/actions`, {
      action: 'CONFIRM',
      note: 'Anomalie confirmée après analyse des justificatifs.',
    });
    expect(confirmed.body.status).toBe('CONFIRMED');
    expect(confirmed.body.resolvedBy.id).toBe(analyst.user.id);
    expect(confirmed.body.resolutionNote).toBe('Anomalie confirmée après analyse des justificatifs.');
    expect(confirmed.body.firstActionAt).toBe(firstActionAt);
    expect(confirmed.body.overdue).toBe(false);
    expect(confirmed.body.slaRemainingMinutes).toBeNull();
    expect(confirmed.body.nextActions).toEqual(['CONTEST']);
    expect(confirmed.body.actions.map((x: any) => [x.action, x.actor.id])).toEqual([
      ['START_REVIEW', analyst.user.id],
      ['CONFIRM', analyst.user.id],
    ]);
    // The person concerned is informed of the decision.
    expect(
      await ctx.prisma.notification.count({ where: { userId: plain.id, type: 'risk.alert_resolved' } }),
    ).toBe(1);

    // Invalid transition.
    const again = await analyst.client.post(`/v1/admin/risk-alerts/${a.id}/actions`, {
      action: 'DISMISS',
      note: 'Changement d’avis.',
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');

    // CONTEST reopens the alert with a new deadline and clears the breach marker.
    const before = Date.now();
    const contested = await analyst.client.post(`/v1/admin/risk-alerts/${a.id}/actions`, {
      action: 'CONTEST',
      note: 'Contestation reçue via le support.',
    });
    expect(contested.body.status).toBe('CONTESTED');
    expect(contested.body.slaBreachedAt).toBeNull();
    expect(new Date(contested.body.dueAt).getTime()).toBeGreaterThanOrEqual(before + 72 * HOUR - 1000);
    expect(contested.body.overdue).toBe(false);

    // No tipping-off: decisions on a STRUCTURING alert are not notified to the person concerned.
    const n0 = await ctx.prisma.notification.count({
      where: { userId: plain.id, type: 'risk.alert_resolved' },
    });
    const d = await analyst.client.post(`/v1/admin/risk-alerts/${s.id}/actions`, {
      action: 'CONFIRM',
      note: 'Fractionnement confirmé, escalade à l’agent de conformité.',
    });
    expect(d.status).toBe(201);
    expect(
      await ctx.prisma.notification.count({ where: { userId: plain.id, type: 'risk.alert_resolved' } }),
    ).toBe(n0);
  });
});

describe('queue filters, CSV export and statistics', () => {
  async function seedQueue() {
    const analyst = await staff('analyst@example.com', 'COMPLIANCE', 'Binta', 'Analyste');
    const admin = await staff('admin@example.com', 'ADMIN', 'Awa', 'Admin');
    const w = await createWalletActors(ctx);
    const now = Date.now();
    const at = (h: number) => new Date(now + h * HOUR);
    const a = {
      // open, overdue, unassigned, HIGH
      overdueHigh: await alert({
        ruleCode: 'STRUCTURING',
        severity: 'HIGH',
        organizationId: w.businessOrgId,
        createdAt: at(-30),
        dueAt: at(-6),
        explanation: {
          summary: '=HYPERLINK("http://evil.example","clic")',
          factors: {},
          recommendation: 'Review',
        },
      }),
      // open, due soon, assigned to analyst, MEDIUM
      soonMine: await alert({
        status: 'REVIEWING',
        createdAt: at(-60),
        dueAt: at(12),
        assignedToUserId: analyst.user.id,
        firstActionAt: at(-59),
      }),
      // open, legacy without dueAt, overdue (LOW: 168 h), assigned to admin
      legacyOverdue: await alert({
        severity: 'LOW',
        createdAt: at(-200),
        dueAt: null,
        assignedToUserId: admin.user.id,
        organizationId: w.personalOrgId,
      }),
      // open, far deadline, unassigned
      later: await alert({ status: 'CONTESTED', severity: 'HIGH', createdAt: at(-2), dueAt: at(22) }),
      // closed
      dismissed: await alert({
        status: 'DISMISSED',
        createdAt: at(-24 * 40),
        dueAt: at(-24 * 37),
        firstActionAt: at(-24 * 40 + 1),
        resolvedAt: at(-24 * 39),
      }),
      confirmed: await alert({
        status: 'CONFIRMED',
        severity: 'HIGH',
        organizationId: w.businessOrgId,
        createdAt: at(-5),
        dueAt: at(19),
        firstActionAt: at(-4),
      }),
    };
    return { analyst, admin, w, a };
  }

  it('filters by status, severity, rule, assignee, overdue, organisation and dates, with SLA fields', async () => {
    const { analyst, admin, w, a } = await seedQueue();
    const ids = (body: any) => body.items.map((x: any) => x.id);
    const q = (qs: string) => analyst.client.get(`/v1/admin/risk-alerts${qs}`);

    // Open alerts: dueAt ascending by default (legacy rows are ordered last until backfilled).
    const open = await q('?status=OPEN,REVIEWING,CONTESTED');
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    expect(open.body.sort).toBe('dueAt');
    expect(ids(open.body)).toEqual([a.overdueHigh.id, a.soonMine.id, a.later.id, a.legacyOverdue.id]);
    // Repeated and bracket parameters are accepted.
    expect(ids((await q('?status=OPEN&status=REVIEWING&status=CONTESTED')).body)).toEqual(ids(open.body));
    expect(ids((await q('?status[]=CONTESTED')).body)).toEqual([a.later.id]);

    // Otherwise newest first.
    const all = await q('');
    expect(all.body.sort).toBe('-createdAt');
    expect(all.body.total).toBe(6);
    expect(ids(all.body)[0]).toBe(a.later.id);
    expect(ids(all.body).at(-1)).toBe(a.dismissed.id);
    expect(all.body.rules.map((r: any) => r.code)).toContain('STRUCTURING');

    const item = all.body.items.find((x: any) => x.id === a.overdueHigh.id);
    expect(item).toMatchObject({ overdue: true, assignedTo: null, ruleCode: 'STRUCTURING', ageHours: 30 });
    expect(item.slaRemainingMinutes).toBeLessThan(-5 * 60);
    expect(item.nextActions).toEqual(['START_REVIEW', 'CONFIRM', 'DISMISS', 'ASSIGN', 'ASSIGN_TO_ME']);
    const legacy = all.body.items.find((x: any) => x.id === a.legacyOverdue.id);
    expect(new Date(legacy.dueAt).getTime()).toBe(a.legacyOverdue.createdAt.getTime() + 168 * HOUR);
    expect(legacy.overdue).toBe(true);
    expect(legacy.assignedTo).toMatchObject({ id: admin.user.id, name: 'Awa Admin' });
    const mine = all.body.items.find((x: any) => x.id === a.soonMine.id);
    expect(mine.firstActionAt).toBeTruthy();
    expect(mine.overdue).toBe(false);

    expect(ids((await q('?severity=HIGH')).body).sort()).toEqual(
      [a.overdueHigh.id, a.later.id, a.confirmed.id].sort(),
    );
    expect(ids((await q('?ruleCode=STRUCTURING')).body)).toEqual([a.overdueHigh.id]);
    expect(ids((await q('?assignee=me')).body)).toEqual([a.soonMine.id]);
    expect(ids((await admin.client.get('/v1/admin/risk-alerts?assignee=me')).body)).toEqual([
      a.legacyOverdue.id,
    ]);
    expect(ids((await q(`?assignee=${admin.user.id}`)).body)).toEqual([a.legacyOverdue.id]);
    expect(ids((await q('?assignee=unassigned&status=OPEN,CONTESTED')).body)).toEqual([
      a.overdueHigh.id,
      a.later.id,
    ]);
    const overdue = await q('?overdue=true');
    expect(overdue.body.sort).toBe('dueAt');
    expect(ids(overdue.body)).toEqual([a.overdueHigh.id, a.legacyOverdue.id]);
    expect(ids((await q(`?organizationId=${w.businessOrgId}`)).body).sort()).toEqual(
      [a.overdueHigh.id, a.confirmed.id].sort(),
    );
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const fromTo = await q(`?from=${day(a.dismissed.createdAt)}&to=${day(a.dismissed.createdAt)}`);
    expect(ids(fromTo.body)).toEqual([a.dismissed.id]);
    expect(ids((await q(`?from=${new Date(Date.now() - 6 * HOUR).toISOString()}`)).body).sort()).toEqual(
      [a.later.id, a.confirmed.id].sort(),
    );
    expect(ids((await q('?sort=severity&status=CONFIRMED,DISMISSED')).body)).toEqual([
      a.confirmed.id,
      a.dismissed.id,
    ]);

    // Page pagination, capped at 100.
    const p2 = await q('?pageSize=2&page=2');
    expect(p2.body).toMatchObject({ page: 2, pageSize: 2, total: 6 });
    expect(ids(p2.body)).toEqual(ids(all.body).slice(2, 4));
    for (const bad of [
      '?pageSize=101',
      '?assignee=nobody',
      '?status=CLOSED',
      '?overdue=maybe',
      '?from=yesterday',
    ]) {
      expect((await q(bad)).status, bad).toBe(400);
    }

    // Single alert.
    const one = await q(`/${a.overdueHigh.id}`);
    expect(one.status).toBe(200);
    expect(one.body.id).toBe(a.overdueHigh.id);
    expect((await q(`/${randomUUID()}`)).status).toBe(404);

    // Assignable staff.
    const assignees = await q('/assignees');
    expect(assignees.body.items.map((u: any) => u.id).sort()).toEqual(
      [analyst.user.id, admin.user.id].sort(),
    );
  });

  it('exports the filtered queue as an injection-safe CSV with the sandbox disclaimer', async () => {
    const { analyst, a } = await seedQueue();
    const res = await analyst.client.get('/v1/admin/risk-alerts.csv?severity=HIGH&status=OPEN,CONTESTED');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('risk-alerts-sandbox.csv');
    const lines = res.text.split('\n');
    expect(lines[0]).toBe(
      '# Diaspora Trust — SANDBOX compliance review queue (risk alerts). Données fictives — Aucun fonds réel',
    );
    expect(lines[1].startsWith('id,created_at,rule_code,severity')).toBe(true);
    expect(lines).toHaveLength(4);
    // dueAt ascending: the overdue alert first.
    expect(lines[2].startsWith(a.overdueHigh.id)).toBe(true);
    expect(lines[3].startsWith(a.later.id)).toBe(true);
    // The formula is neutralised (apostrophe) and quoted.
    expect(lines[2]).toContain(`"'=HYPERLINK(""http://evil.example"",""clic"")"`);
    expect(lines[2]).toContain(',true,');
    expect(res.text).not.toMatch(/,=HYPERLINK/);
    const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'admin.risk_alerts_exported' } });
    expect(audit?.actorUserId).toBe(analyst.user.id);
    expect(audit?.metadata).toMatchObject({ rows: 2, total: 2 });
  });

  it('computes queue statistics and the median time to first action', async () => {
    const { analyst, admin } = await seedQueue();
    const now = Date.now();
    // Median over the last 30 days of (firstActionAt − createdAt): soonMine 60 min, confirmed 60 min,
    // plus 10 and 240 min → median of [10, 60, 60, 240] = 60 min. The 40-day-old alert is excluded.
    await alert({
      status: 'DISMISSED',
      createdAt: new Date(now - 10 * HOUR),
      firstActionAt: new Date(now - 10 * HOUR + 10 * 60_000),
    });
    await alert({
      status: 'DISMISSED',
      createdAt: new Date(now - 9 * HOUR),
      firstActionAt: new Date(now - 5 * HOUR),
    });
    const stats = await analyst.client.get('/v1/admin/risk-alerts/stats');
    expect(stats.status, JSON.stringify(stats.body)).toBe(200);
    expect(stats.body.byStatus).toEqual({ OPEN: 2, REVIEWING: 1, CONFIRMED: 1, DISMISSED: 3, CONTESTED: 1 });
    expect(stats.body.openBySeverity).toEqual({ HIGH: 2, MEDIUM: 1, LOW: 1 });
    expect(stats.body.open).toBe(4);
    expect(stats.body.overdue).toBe(2);
    expect(stats.body.unassigned).toBe(2);
    expect(stats.body.assignedToMe).toBe(1);
    expect(stats.body.medianTimeToFirstAction).toEqual({ windowDays: 30, sampleSize: 4, minutes: 60 });
    expect(stats.body.slaHours).toEqual({ HIGH: 24, MEDIUM: 72, LOW: 168 });
    expect((await admin.client.get('/v1/admin/risk-alerts/stats')).body.assignedToMe).toBe(1);
  });
});

describe('structuring detection', () => {
  it('opens one STRUCTURING alert when several transfers below the threshold add up to it', async () => {
    const t = await createTransferActors(ctx);
    await fundWallet(ctx, t.orgId, 'CAD', '50000.00');
    const beneficiary = await createBeneficiary(ctx, {
      organizationId: t.orgId,
      createdByUserId: t.ownerUser.id,
      createdAt: new Date(Date.now() - 72 * HOUR),
    });
    const send = async (amount: string) => {
      const { transfer } = await quoteAndCreate(t.owner, beneficiary.id, { amount });
      const res = await t.owner.post(`/v1/transfers/${transfer.id}/authorize`, {});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return { reference: transfer.reference as string, status: res.body.status as string };
    };
    const structuring = () => ctx.prisma.riskAlert.findMany({ where: { ruleCode: 'STRUCTURING' } });

    const first = await send('4000.00');
    const second = await send('4000.00');
    expect([first.status, second.status]).toEqual(['PROCESSING', 'PROCESSING']);
    expect(await structuring()).toHaveLength(0);

    // 3 × 4 000 CAD = 12 000 CAD ≥ 10 000 CAD within 24 h → HIGH → manual review (advisory hold).
    const third = await send('4000.00');
    expect(third.status).toBe('REVIEW_REQUIRED');
    const [alertRow] = await structuring();
    expect(alertRow.severity).toBe('HIGH');
    expect(alertRow.organizationId).toBe(t.orgId);
    expect(alertRow.dueAt!.getTime() - alertRow.createdAt.getTime()).toBe(24 * HOUR);
    const explanation = alertRow.explanation as any;
    expect(explanation.factors).toMatchObject({
      subjectType: 'ORGANIZATION',
      subjectId: t.orgId,
      flow: 'OUTBOUND',
      currencyCode: 'CAD',
      operationsCount: 3,
      sum: '12000.00',
      threshold: '10000.00',
      windowHours: 24,
      kinds: 'TRANSFER',
    });
    expect(explanation.factors.references).toContain(first.reference);
    expect(explanation.factors.references).toContain(second.reference);
    expect(explanation.evidence).toHaveLength(3);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'risk.structuring_detected' } })).toBe(1);

    // A fourth operation in the window does not open a second alert: it is appended to the open one.
    const fourth = await send('1500.00');
    expect(fourth.status).toBe('REVIEW_REQUIRED');
    const after = await structuring();
    expect(after).toHaveLength(1);
    expect((after[0].explanation as any).updates).toHaveLength(1);
    // The held third transfer counts as an authorisation attempt: 4 operations now.
    expect((after[0].explanation as any).updates[0]).toMatchObject({ operationsCount: 4, severity: 'HIGH' });
    expect((after[0].explanation as any).factors.operationsCount).toBe(3); // original facts unchanged

    // The queue shows it first among open alerts.
    const analyst = await staff('analyst@example.com', 'COMPLIANCE');
    const queue = await analyst.client.get('/v1/admin/risk-alerts?ruleCode=STRUCTURING&status=OPEN');
    expect(queue.body.items.map((x: any) => x.id)).toEqual([alertRow.id]);
  });

  it('aggregates sandbox self-deposits (inbound) per subject and escalates MEDIUM → HIGH without duplicating', async () => {
    const w = await createWalletActors(ctx);
    const risk = ctx.app.get(RiskService);
    // The wallet module evaluates structuring itself after every self-deposit (post-commit hook).
    const deposit = async (amount: string) => {
      const res = await selfDeposit(w.owner, w.businessOrgId, 'CAD', amount);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body.ledgerTransactionId as string;
    };
    const structuring = () => ctx.prisma.riskAlert.findMany({ where: { ruleCode: 'STRUCTURING' } });

    // A transfer-side (outbound) operation is never mixed with inbound deposits.
    const d1 = await deposit('6000.00');
    expect(await structuring()).toHaveLength(0);
    const d2 = await deposit('5000.00');
    const [medium] = await structuring();
    expect(medium.severity).toBe('MEDIUM');
    expect(medium.dueAt!.getTime() - medium.createdAt.getTime()).toBe(72 * HOUR);
    const factors = (medium.explanation as any).factors;
    expect(factors).toMatchObject({
      flow: 'INBOUND',
      kinds: 'SELF_DEPOSIT',
      operationsCount: 2,
      sum: '11000.00',
    });
    expect(factors.references).toBe(`${d1}, ${d2}`);
    expect((medium.explanation as any).evidence[1]).toMatchObject({ reference: d2, current: true });

    // Third deposit: same alert, escalated to HIGH with the shorter HIGH deadline.
    await deposit('1000.00');
    const [high] = await structuring();
    expect(high.id).toBe(medium.id);
    expect(high.severity).toBe('HIGH');
    expect(high.dueAt!.getTime() - high.createdAt.getTime()).toBe(24 * HOUR);
    expect((high.explanation as any).updates[0]).toMatchObject({ severity: 'HIGH', operationsCount: 3 });
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'risk.alert_escalated', entityId: high.id } }),
    ).toBe(1);

    // A deposit at or above the threshold is not part of a structuring pattern.
    const big = await selfDeposit(w.owner, w.personalOrgId, 'CAD', '10000.00');
    const ev = await risk.evaluateAndRecord({
      event: 'wallet.self_deposit',
      organizationId: w.personalOrgId,
      amountMinor: 1_000_000n,
      currencyCode: 'CAD',
      operationReference: big.body.ledgerTransactionId,
    });
    expect(ev.signals.map((s) => s.ruleCode)).not.toContain('STRUCTURING');
    expect(await structuring()).toHaveLength(1);

    // Once the open alert is decided, a new pattern in the window opens a new alert.
    await ctx.prisma.riskAlert.update({ where: { id: high.id }, data: { status: 'DISMISSED' } });
    await deposit('500.00');
    expect((await structuring()).filter((x) => x.status === 'OPEN')).toHaveLength(1);
  });

  it('reads invoice wallet payments from their ledger tagging (outbound)', async () => {
    const payer = await createWalletActors(ctx);
    const issuer = await createWalletActors(ctx, '-issuer');
    await fundWallet(ctx, payer.businessOrgId, 'XOF', '9000000');
    const ledger = ctx.app.get<LedgerService>(LEDGER);
    const wallets = ctx.app.get(WalletsService);
    const payerWallet = await wallets.ensureWallet(payer.businessOrgId, 'XOF');
    const issuerWallet = await wallets.ensureWallet(issuer.businessOrgId, 'XOF');
    const risk = ctx.app.get(RiskService);
    // Three partial wallet payments of 1 600 000 XOF, each below the XOF threshold (4 400 000 XOF,
    // ≈ 10 000 CAD — STRUCTURING_THRESHOLD has a per-currency entry for XOF), together above it.
    let last;
    for (let i = 0; i < 3; i++) {
      const paymentId = randomUUID();
      const posted = await ledger.post({
        idempotencyKey: `invoice-payment:${paymentId}`,
        kind: 'ADJUSTMENT',
        description: 'Invoice paid from wallet (test, simulated)',
        reference: randomUUID(),
        metadata: {
          purpose: 'INVOICE_PAYMENT',
          paymentId,
          payerOrganizationId: payer.businessOrgId,
          issuerOrganizationId: issuer.businessOrgId,
          by: payer.ownerUser.id,
          simulated: true,
        },
        entries: [
          {
            accountId: payerWallet.ledgerAccountId,
            direction: 'DEBIT',
            amountMinor: 1_600_000n,
            currencyCode: 'XOF',
          },
          {
            accountId: issuerWallet.ledgerAccountId,
            direction: 'CREDIT',
            amountMinor: 1_600_000n,
            currencyCode: 'XOF',
          },
        ],
      });
      last = await risk.evaluateAndRecord({
        event: 'invoice.wallet_payment',
        userId: payer.ownerUser.id,
        organizationId: payer.businessOrgId,
        amountMinor: 1_600_000n,
        currencyCode: 'XOF',
        operationReference: posted.id,
      });
    }
    expect(last!.signals.map((s) => s.ruleCode)).toEqual(['STRUCTURING']);
    const alerts = await ctx.prisma.riskAlert.findMany({ where: { ruleCode: 'STRUCTURING' } });
    expect(alerts).toHaveLength(1);
    expect((alerts[0].explanation as any).factors).toMatchObject({
      flow: 'OUTBOUND',
      kinds: 'INVOICE_PAYMENT',
      currencyCode: 'XOF',
      operationsCount: 3,
      sum: '4800000',
      threshold: '4400000',
    });
  });
});
