import { NestFactory } from '@nestjs/core';
import { authenticator } from 'otplib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GATES_TRACKING_DISCLAIMER, REGULATORY_GATES } from '@dfn/shared';
import { buildAppModule } from '../src/app.module';
import { DomainError } from '../src/common/domain-error';
import { ENV, loadEnv, type Env } from '../src/config/env';
import { GatesModule } from '../src/modules/gates/gates.module';
import { ProviderActivationService } from '../src/modules/gates/provider-activation.service';
import { RegulatoryGatesService } from '../src/modules/gates/regulatory-gates.service';
import { ReferenceDataService } from '../src/modules/reference/reference-data.service';
import {
  bootTestApp,
  promote,
  registerUser,
  resetDatabase,
  type Client,
  type TestContext,
} from './helpers/app';

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

interface Actors {
  admin1: Client;
  admin2: Client;
  compliance: Client;
  user: Client;
  ids: { admin1: string; admin2: string; compliance: string; user: string };
}

async function actors(): Promise<Actors> {
  const a1 = await registerUser(ctx, 'gate-admin1@example.com', { firstName: 'Aminata', lastName: 'Sow' });
  const a2 = await registerUser(ctx, 'gate-admin2@example.com', { firstName: 'Bruno', lastName: 'Tremblay' });
  const c = await registerUser(ctx, 'gate-compliance@example.com');
  const u = await registerUser(ctx, 'gate-user@example.com');
  await promote(ctx, 'gate-admin1@example.com', 'ADMIN');
  await promote(ctx, 'gate-admin2@example.com', 'ADMIN');
  await promote(ctx, 'gate-compliance@example.com', 'COMPLIANCE');
  return {
    admin1: a1.client,
    admin2: a2.client,
    compliance: c.client,
    user: u.client,
    ids: { admin1: a1.user.id, admin2: a2.user.id, compliance: c.user.id, user: u.user.id },
  };
}

const PROGRESS = {
  status: 'IN_PROGRESS',
  note: 'Mandat signé avec le cabinet externe',
  evidenceRef: 'VAULT-2026-001',
};
const APPROVE_1 = { note: 'Avis juridique reçu et archivé', evidenceRef: 'VAULT-2026-014' };
const APPROVE_2 = { note: 'Avis relu, conforme au périmètre', evidenceRef: 'VAULT-2026-014#review' };

function testEnv(overrides: Partial<Env> = {}): Env {
  return { ...ctx.app.get<Env>(ENV), ...overrides };
}

describe('regulatory gates register', () => {
  it('re-creates the ten default gates lazily after truncation, in R1..R10 order', async () => {
    const { admin1 } = await actors();
    expect(await ctx.prisma.regulatoryGate.count()).toBe(0);
    const res = await admin1.get('/v1/admin/gates');
    expect(res.status).toBe(200);
    expect(res.body.items.map((g: any) => g.code)).toEqual(REGULATORY_GATES.map((g) => g.code));
    expect(res.body.items.map((g: any) => g.code)).toEqual([
      'R1',
      'R2',
      'R3',
      'R4',
      'R5',
      'R6',
      'R7',
      'R8',
      'R9',
      'R10',
    ]);
    expect(res.body).toMatchObject({
      mode: 'sandbox',
      trackingOnly: true,
      disclaimer: GATES_TRACKING_DISCLAIMER,
      canManage: true,
      summary: { total: 10, byStatus: { NOT_STARTED: 10, SATISFIED: 0 } },
    });
    const r10 = res.body.items[9];
    expect(r10).toMatchObject({
      code: 'R10',
      level: 'ABSOLUTE',
      status: 'NOT_STARTED',
      trackingOnly: true,
      approvals: 0,
      approvalsRequired: 2,
      nextActions: ['PROGRESS'],
    });
    expect(r10.disclaimer.fr).toMatch(/Suivi uniquement/);
    expect(r10.disclaimer.en).toMatch(/Tracking only/);
    expect(res.body.items[1].requiredFor).toEqual(['KYC', 'SANCTIONS']);
    expect(await ctx.prisma.regulatoryGate.count()).toBe(10);
  });

  it('never overwrites status, notes, evidence or approvals when ensuring defaults', async () => {
    const { ids } = await actors();
    const svc = ctx.app.get(RegulatoryGatesService);
    await svc.ensureDefaults();
    await ctx.prisma.regulatoryGate.update({
      where: { code: 'R1' },
      data: {
        status: 'PENDING_SECOND_APPROVAL',
        notes: 'kept',
        evidenceRef: 'EV-1',
        firstApproverId: ids.admin1,
        firstApprovedAt: new Date(),
        title: 'stale title',
      },
    });
    await svc.ensureDefaults();
    await svc.ensureDefaults({ syncDefinitions: true });
    const r1 = await ctx.prisma.regulatoryGate.findUniqueOrThrow({ where: { code: 'R1' } });
    expect(r1).toMatchObject({
      status: 'PENDING_SECOND_APPROVAL',
      notes: 'kept',
      evidenceRef: 'EV-1',
      firstApproverId: ids.admin1,
      title: REGULATORY_GATES[0].title,
    });
    expect(await ctx.prisma.regulatoryGate.count()).toBe(10);
  });

  it('enforces permissions: USER 403, COMPLIANCE read-only, ADMIN manages', async () => {
    const { user, compliance, admin1 } = await actors();
    for (const url of ['/v1/admin/gates', '/v1/admin/gates/R1', '/v1/admin/gates/providers']) {
      const r = await user.get(url);
      expect(r.status, url).toBe(403);
    }
    expect((await user.post('/v1/admin/gates/R1/progress', PROGRESS)).status).toBe(403);

    const list = await compliance.get('/v1/admin/gates');
    expect(list.status).toBe(200);
    expect(list.body.canManage).toBe(false);
    expect(list.body.items.every((g: any) => g.nextActions.length === 0)).toBe(true);
    expect((await compliance.get('/v1/admin/gates/R3')).status).toBe(200);
    expect((await compliance.get('/v1/admin/gates/providers')).status).toBe(200);
    for (const [path, body] of [
      ['progress', PROGRESS],
      ['approve', APPROVE_1],
      ['revoke', { note: 'tentative de révocation' }],
    ] as const) {
      const r = await compliance.post(`/v1/admin/gates/R3/${path}`, body);
      expect(r.status, path).toBe(403);
      expect(r.body.code).toBe('FORBIDDEN');
    }
    expect(await ctx.prisma.regulatoryGateEvent.count()).toBe(0);

    const progressed = await admin1.post('/v1/admin/gates/r3/progress', PROGRESS);
    expect(progressed.status).toBe(200);
    expect(progressed.body).toMatchObject({
      code: 'R3',
      status: 'IN_PROGRESS',
      evidenceRef: 'VAULT-2026-001',
    });
    expect(progressed.body.nextActions).toEqual(['PROGRESS', 'APPROVE', 'REVOKE']);
  });

  it('validates input and returns 404 for unknown gates', async () => {
    const { admin1 } = await actors();
    expect((await admin1.get('/v1/admin/gates/R11')).status).toBe(404);
    expect((await admin1.get('/v1/admin/gates/X1')).status).toBe(404);
    expect((await admin1.post('/v1/admin/gates/R42/progress', PROGRESS)).status).toBe(404);
    const noNote = await admin1.post('/v1/admin/gates/R1/progress', { status: 'IN_PROGRESS' });
    expect(noNote.status).toBe(400);
    expect(noNote.body.code).toBe('VALIDATION_FAILED');
    const badStatus = await admin1.post('/v1/admin/gates/R1/progress', { ...PROGRESS, status: 'SATISFIED' });
    expect(badStatus.status).toBe(400);
    const noEvidence = await admin1.post('/v1/admin/gates/R1/approve', { note: 'pas de preuve' });
    expect(noEvidence.status).toBe(400);
    const extra = await admin1.post('/v1/admin/gates/R1/revoke', { note: 'ok note', status: 'NOT_STARTED' });
    expect(extra.status).toBe(400);
    // Approving a gate that never started is an invalid transition.
    const early = await admin1.post('/v1/admin/gates/R1/approve', APPROVE_1);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('INVALID_TRANSITION');
    const revokeNew = await admin1.post('/v1/admin/gates/R1/revoke', { note: 'rien à révoquer' });
    expect(revokeNew.status).toBe(409);
  });

  it('requires two different ADMIN approvers (four-eyes) and records events, audit and notifications', async () => {
    const { admin1, admin2, compliance, ids } = await actors();
    expect((await admin1.post('/v1/admin/gates/R2/progress', PROGRESS)).status).toBe(200);

    const first = await admin1.post('/v1/admin/gates/R2/approve', APPROVE_1);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      status: 'PENDING_SECOND_APPROVAL',
      approvals: 1,
      evidenceRef: APPROVE_1.evidenceRef,
      firstApprover: { id: ids.admin1, name: 'Aminata Sow' },
      secondApprover: null,
      trackingOnly: true,
    });
    // The first approver is not offered (nor allowed) the second approval.
    expect(first.body.nextActions).toEqual(['REVOKE']);
    expect((await admin2.get('/v1/admin/gates/R2')).body.nextActions).toEqual(['APPROVE', 'REVOKE']);
    expect((await compliance.get('/v1/admin/gates/R2')).body.nextActions).toEqual([]);

    const same = await admin1.post('/v1/admin/gates/R2/approve', APPROVE_2);
    expect(same.status).toBe(409);
    expect(same.body.code).toBe('GATE_SAME_APPROVER');
    expect((await ctx.prisma.regulatoryGate.findUniqueOrThrow({ where: { code: 'R2' } })).status).toBe(
      'PENDING_SECOND_APPROVAL',
    );

    const second = await admin2.post('/v1/admin/gates/R2/approve', APPROVE_2);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      status: 'SATISFIED',
      approvals: 2,
      firstApprover: { id: ids.admin1 },
      secondApprover: { id: ids.admin2, name: 'Bruno Tremblay' },
      nextActions: ['REVOKE'],
      trackingOnly: true,
    });
    expect(second.body.firstApprovedAt).toBeTruthy();
    expect(second.body.secondApprovedAt).toBeTruthy();
    const again = await admin2.post('/v1/admin/gates/R2/approve', APPROVE_2);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');

    // Event history (newest first) with actors and the evidence reference of each step.
    const detail = await compliance.get('/v1/admin/gates/R2');
    expect(detail.status).toBe(200);
    expect(detail.body.events.map((e: any) => [e.action, e.fromStatus, e.toStatus])).toEqual([
      ['SECOND_APPROVAL', 'PENDING_SECOND_APPROVAL', 'SATISFIED'],
      ['FIRST_APPROVAL', 'IN_PROGRESS', 'PENDING_SECOND_APPROVAL'],
      ['PROGRESS', 'NOT_STARTED', 'IN_PROGRESS'],
    ]);
    expect(detail.body.events.map((e: any) => e.actor.id)).toEqual([ids.admin2, ids.admin1, ids.admin1]);
    expect(detail.body.events.map((e: any) => e.evidenceRef)).toEqual([
      APPROVE_2.evidenceRef,
      APPROVE_1.evidenceRef,
      PROGRESS.evidenceRef,
    ]);
    expect(detail.body.events[0].note).toBe(APPROVE_2.note);

    const audits = await ctx.prisma.auditLog.findMany({
      where: { entityType: 'RegulatoryGate', entityId: 'R2' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((a) => [a.action, a.actorUserId])).toEqual([
      ['gate.progress', ids.admin1],
      ['gate.first_approval', ids.admin1],
      ['gate.second_approval', ids.admin2],
    ]);
    expect(audits[2].metadata).toMatchObject({
      fromStatus: 'PENDING_SECOND_APPROVAL',
      toStatus: 'SATISFIED',
      evidenceRef: APPROVE_2.evidenceRef,
      trackingOnly: true,
    });
    // Refused attempts leave no trace in the register.
    expect(await ctx.prisma.regulatoryGateEvent.count()).toBe(3);

    // Every active ADMIN is notified of every transition; nobody else is.
    for (const id of [ids.admin1, ids.admin2]) {
      const notes = await ctx.prisma.notification.findMany({
        where: { userId: id, type: 'gate.status_changed' },
        orderBy: { createdAt: 'asc' },
      });
      expect(notes).toHaveLength(3);
      expect(notes[2].title).toMatch(/R2/);
      expect(notes[2].body).toMatch(/DFN_MODE reste sandbox/);
      expect(notes[2].data).toMatchObject({ code: 'R2', toStatus: 'SATISFIED', action: 'SECOND_APPROVAL' });
    }
    expect(
      await ctx.prisma.notification.count({
        where: { userId: { in: [ids.compliance, ids.user] }, type: 'gate.status_changed' },
      }),
    ).toBe(0);
  });

  it('revoke clears approvals and evidence; the gate can then be restarted', async () => {
    const { admin1, admin2 } = await actors();
    await admin1.post('/v1/admin/gates/R7/progress', PROGRESS);
    await admin1.post('/v1/admin/gates/R7/approve', APPROVE_1);
    await admin2.post('/v1/admin/gates/R7/approve', APPROVE_2);

    const revoked = await admin2.post('/v1/admin/gates/R7/revoke', {
      note: 'EFVP à refaire après changement',
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({
      status: 'REVOKED',
      firstApprover: null,
      firstApprovedAt: null,
      secondApprover: null,
      secondApprovedAt: null,
      evidenceRef: null,
      approvals: 0,
      notes: 'EFVP à refaire après changement',
      nextActions: ['PROGRESS'],
    });
    const row = await ctx.prisma.regulatoryGate.findUniqueOrThrow({ where: { code: 'R7' } });
    expect(row.firstApproverId).toBeNull();
    expect(row.secondApproverId).toBeNull();
    expect(revoked.body.events[0]).toMatchObject({
      action: 'REVOKE',
      fromStatus: 'SATISFIED',
      toStatus: 'REVOKED',
      evidenceRef: null,
    });
    expect((await admin1.post('/v1/admin/gates/R7/revoke', { note: 'encore' })).status).toBe(409);
    expect((await admin1.post('/v1/admin/gates/R7/approve', APPROVE_1)).status).toBe(409);

    const restarted = await admin1.post('/v1/admin/gates/R7/progress', {
      status: 'IN_PROGRESS',
      note: 'Reprise',
    });
    expect(restarted.status).toBe(200);
    expect(restarted.body).toMatchObject({ status: 'IN_PROGRESS', evidenceRef: null, approvals: 0 });

    // The same admin may first-approve again after a revoke (approvals were cleared).
    const reapproved = await admin2.post('/v1/admin/gates/R7/approve', APPROVE_1);
    expect(reapproved.body.firstApprover.name).toBe('Bruno Tremblay');
    expect(await ctx.prisma.regulatoryGateEvent.count({ where: { gateCode: 'R7' } })).toBe(6);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'gate.revoke', entityId: 'R7' } })).toBe(1);
  });

  it('requires a fresh second factor from an ADMIN who has one (approve and revoke)', async () => {
    const { admin1, admin2 } = await actors();
    const setup = await admin1.post('/v1/auth/mfa/setup');
    expect(setup.status, JSON.stringify(setup.body)).toBe(201);
    const enabled = await admin1.post('/v1/auth/mfa/enable', {
      code: authenticator.generate(setup.body.secret),
    });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(201);
    expect((await admin1.post('/v1/admin/gates/R7/progress', PROGRESS)).status).toBe(200);

    const bare = await admin1.post('/v1/admin/gates/R7/approve', APPROVE_1);
    expect(bare.status).toBe(401);
    expect(bare.body.code).toBe('STEP_UP_REQUIRED');
    expect((await ctx.prisma.regulatoryGate.findUniqueOrThrow({ where: { code: 'R7' } })).status).toBe(
      'IN_PROGRESS',
    );
    const recovery = enabled.body.recoveryCodes[0] as string;
    const approved = await admin1.post('/v1/admin/gates/R7/approve', { ...APPROVE_1, mfaCode: recovery });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('PENDING_SECOND_APPROVAL');
    // An ADMIN without any second factor keeps the four-eyes rule as the control.
    expect((await admin2.post('/v1/admin/gates/R7/approve', APPROVE_2)).status).toBe(200);

    const revokeBare = await admin1.post('/v1/admin/gates/R7/revoke', { note: 'Révision du périmètre' });
    expect(revokeBare.status).toBe(401);
    const reused = await admin1.post('/v1/admin/gates/R7/revoke', {
      note: 'Révision du périmètre',
      mfaCode: recovery,
    });
    expect(reused.status).toBe(401);
    expect(reused.body.code).toBe('RECOVERY_CODE_INVALID');
    const revoked = await admin1.post('/v1/admin/gates/R7/revoke', {
      note: 'Révision du périmètre',
      mfaCode: enabled.body.recoveryCodes[1],
    });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body.status).toBe('REVOKED');
  });

  it('can revoke a gate that is pending its second approval', async () => {
    const { admin1 } = await actors();
    await admin1.post('/v1/admin/gates/R9/progress', PROGRESS);
    await admin1.post('/v1/admin/gates/R9/approve', APPROVE_1);
    const r = await admin1.post('/v1/admin/gates/R9/revoke', { note: 'Assureur retiré' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'REVOKED', firstApprover: null });
  });
});

describe('partner activation guard', () => {
  it('refuses every non-sandbox provider code with the required gates and their status', async () => {
    const { admin1 } = await actors();
    await admin1.post('/v1/admin/gates/R2/progress', PROGRESS);
    const guard = ctx.app.get(ProviderActivationService);

    const cases = [
      ['KYC', 'reference', ['R1', 'R2', 'R7', 'R8']],
      ['SANCTIONS', 'reference', ['R1', 'R2', 'R7', 'R8']],
      ['PAYMENT', 'live-bank', ['R1', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9']],
      ['PAYOUT', 'reference', ['R1', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9']],
      ['FX', 'reference', ['R1', 'R3', 'R4', 'R6', 'R8']],
    ] as const;
    for (const [kind, code, gates] of cases) {
      const err = await guard.assertProviderActivatable(kind, code).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, kind).toBeInstanceOf(DomainError);
      const e = err as DomainError;
      expect(e.code).toBe('PROVIDER_NOT_ACTIVATABLE');
      expect(e.message).toMatch(/sandbox-only/);
      const details = e.details as any;
      expect(details).toMatchObject({
        kind,
        providerCode: code,
        mode: 'sandbox',
        reason: 'SANDBOX_ONLY_BUILD',
      });
      expect(details.requiredGates.map((g: any) => g.code)).toEqual(gates);
      if (kind === 'KYC') {
        expect(details.requiredGates.map((g: any) => g.status)).toEqual([
          'NOT_STARTED',
          'IN_PROGRESS',
          'NOT_STARTED',
          'NOT_STARTED',
        ]);
      }
    }
    for (const kind of ['KYC', 'SANCTIONS', 'PAYMENT', 'FX', 'PAYOUT'] as const) {
      await expect(guard.assertProviderActivatable(kind, 'sandbox')).resolves.toBeUndefined();
      await expect(guard.assertProviderActivatable(kind, undefined)).resolves.toBeUndefined();
    }
    await expect(guard.assertProviderActivatable('PAYMENT', 'SANDBOX_PARTNER')).resolves.toBeUndefined();
  });

  it('still refuses when every required gate is SATISFIED (tracking only, never a switch)', async () => {
    const svc = ctx.app.get(RegulatoryGatesService);
    await svc.ensureDefaults();
    await ctx.prisma.regulatoryGate.updateMany({ data: { status: 'SATISFIED' } });
    const err = (await ctx.app
      .get(ProviderActivationService)
      .assertProviderActivatable('KYC', 'reference')
      .catch((e: unknown) => e)) as DomainError;
    expect(err.code).toBe('PROVIDER_NOT_ACTIVATABLE');
    expect((err.details as any).allRequiredGatesSatisfied).toBe(true);
    const { admin1 } = await actors();
    const providers = await admin1.get('/v1/admin/gates/providers');
    expect(providers.body.providers.every((p: any) => p.sandbox && p.requiredGatesSatisfied > 0)).toBe(true);
  });

  it('fails the module init for a misconfigured provider (env override) and passes for sandbox', async () => {
    const gates = ctx.app.get(RegulatoryGatesService);
    for (const key of [
      'KYC_PROVIDER',
      'SANCTIONS_PROVIDER',
      'PAYMENT_PROVIDER',
      'FX_PROVIDER',
      'PAYOUT_PROVIDER',
    ] as const) {
      const guard = new ProviderActivationService(ctx.prisma, testEnv({ [key]: 'reference' }));
      const module = new GatesModule(gates, guard);
      await expect(module.onModuleInit(), key).rejects.toMatchObject({ code: 'PROVIDER_NOT_ACTIVATABLE' });
    }
    const ok = new GatesModule(gates, new ProviderActivationService(ctx.prisma, testEnv()));
    await expect(ok.onModuleInit()).resolves.toBeUndefined();
    expect(await ctx.prisma.regulatoryGate.count()).toBe(10);
  });

  it('refuses to boot the API with KYC_PROVIDER=reference or PAYOUT_PROVIDER=reference', async () => {
    try {
      // KYC: the sandbox-only factory refuses while the providers are instantiated.
      await expect(
        NestFactory.create(buildAppModule({ KYC_PROVIDER: 'reference' }), {
          abortOnError: false,
          logger: false,
        }),
      ).rejects.toThrow(/PROVIDER_NOT_ACTIVATABLE.*KYC provider "reference"/s);

      // PAYOUT: nothing else reads it — the GatesModule startup guard refuses it.
      const app = await NestFactory.create(buildAppModule({ PAYOUT_PROVIDER: 'reference' }), {
        abortOnError: false,
        logger: false,
      });
      try {
        await expect(app.init()).rejects.toMatchObject({
          code: 'PROVIDER_NOT_ACTIVATABLE',
          message: expect.stringMatching(/PAYOUT provider "reference".*R1, R3, R4, R5, R6, R7, R8, R9/s),
        });
      } finally {
        await app.close().catch(() => undefined);
      }
    } finally {
      // buildAppModule caches the parsed env: restore the default one for the rest of the run.
      loadEnv();
    }
  });

  it('lists the configured providers, their kind, sandbox status and required gates', async () => {
    const { admin1, compliance } = await actors();
    const res = await compliance.get('/v1/admin/gates/providers');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: 'sandbox',
      trackingOnly: true,
      disclaimer: GATES_TRACKING_DISCLAIMER,
    });
    expect(res.body.providers.map((p: any) => [p.kind, p.envVar, p.configuredCode, p.sandbox])).toEqual([
      ['KYC', 'KYC_PROVIDER', 'sandbox', true],
      ['SANCTIONS', 'SANCTIONS_PROVIDER', 'sandbox', true],
      ['PAYMENT', 'PAYMENT_PROVIDER', 'sandbox', true],
      ['FX', 'FX_PROVIDER', 'sandbox', true],
      ['PAYOUT', 'PAYOUT_PROVIDER', 'sandbox', true],
    ]);
    const fx = res.body.providers.find((p: any) => p.kind === 'FX');
    expect(fx.requiredGates.map((g: any) => g.code)).toEqual(['R1', 'R3', 'R4', 'R6', 'R8']);
    expect(fx.requiredGatesSatisfied).toBe(0);
    expect(fx.referenceAdapter).toEqual({
      name: 'HttpReferenceFxRateProvider',
      package: '@dfn/payment-adapters',
      reachableFromEnv: false,
    });
    expect(res.body.providers.find((p: any) => p.kind === 'PAYMENT').referenceAdapter).toBeNull();
    expect((await admin1.get('/v1/admin/gates/providers')).status).toBe(200);
  });
});
