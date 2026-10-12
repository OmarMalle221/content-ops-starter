import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CounterpartiesService } from '../src/modules/organizations/counterparties.service';
import { ReferenceDataService } from '../src/modules/reference/reference-data.service';
import { bootTestApp, resetDatabase, type TestContext } from './helpers/app';
import { createWalletActors, type WalletActors } from './helpers/wallet';

/**
 * Phase 7 — e-mail link requests are resolved after the response: the request itself does the same
 * work whether or not the address belongs to an account, and the resolution is idempotent,
 * cancellable by a revocation and resumed by the sweep after a crash.
 */
let ctx: TestContext;
let service: CounterpartiesService;
let a: WalletActors;

beforeAll(async () => {
  ctx = await bootTestApp();
  service = ctx.app.get(CounterpartiesService);
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDatabase(ctx.prisma);
  await ctx.app.get(ReferenceDataService).ensure();
  a = await createWalletActors(ctx, '-async');
});
afterAll(async () => {
  await ctx.close();
});

const MATCHING = 'wallet-outsider-async@example.com';
const later = () => new Date(Date.now() + 120_000);

/** Requests whose post-response resolution is held back (as if the process stopped right after). */
async function createHeld(email: string, name = 'Client') {
  const hold = vi.spyOn(service, 'resolveLinkRequest').mockResolvedValue(undefined);
  const res = await a.owner.post(`/v1/organizations/${a.businessOrgId}/counterparties`, { name, email });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await service.whenIdle();
  hold.mockRestore();
  return res.body as { id: string };
}

describe('Link requests — resolution after the response', () => {
  it('records matched and unknown e-mails identically, then resolves only the match', async () => {
    const lookup = vi.spyOn(
      service as unknown as { eligibleTargetForEmail: () => unknown },
      'eligibleTargetForEmail',
    );
    const matched = await createHeld(MATCHING, 'Jean Tremblay');
    const unknown = await createHeld('nobody-async@example.com', 'Inconnu');
    // No account lookup inside the request: both rows are the same unresolved request.
    expect(lookup).not.toHaveBeenCalled();
    const rows = await ctx.prisma.counterparty.findMany({
      where: { id: { in: [matched.id, unknown.id] } },
      select: { linkStatus: true, linkRequestedOrganizationId: true, linkResolvedAt: true },
    });
    expect(rows).toEqual([
      { linkStatus: 'NONE', linkRequestedOrganizationId: null, linkResolvedAt: null },
      { linkStatus: 'NONE', linkRequestedOrganizationId: null, linkResolvedAt: null },
    ]);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'counterparty.link_requested' } })).toBe(0);

    await service.resolveLinkRequest(matched.id, { actorUserId: a.ownerUser.id });
    await service.resolveLinkRequest(unknown.id, { actorUserId: a.ownerUser.id });
    const after = await ctx.prisma.counterparty.findMany({
      where: { id: { in: [matched.id, unknown.id] } },
      orderBy: { name: 'asc' },
    });
    expect(after.map((c) => [c.name, c.linkStatus, c.linkRequestedOrganizationId])).toEqual([
      ['Inconnu', 'NONE', null],
      ['Jean Tremblay', 'PENDING', a.outsiderOrgId],
    ]);
    expect(after.every((c) => c.linkResolvedAt)).toBe(true);
    const audit = await ctx.prisma.auditLog.findMany({ where: { action: 'counterparty.link_requested' } });
    expect(audit.map((e) => [e.organizationId, e.actorUserId])).toEqual([[a.outsiderOrgId, a.ownerUser.id]]);
    const notifs = await ctx.prisma.notification.findMany({ where: { type: 'counterparty.link_requested' } });
    expect(notifs.map((n) => n.userId)).toEqual([a.outsiderUser.id]);
  });

  it('is idempotent under concurrent resolutions and never resolves a revoked request', async () => {
    const cp = await createHeld(MATCHING);
    await Promise.all([service.resolveLinkRequest(cp.id), service.resolveLinkRequest(cp.id)]);
    expect(await ctx.prisma.notification.count({ where: { type: 'counterparty.link_requested' } })).toBe(1);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'counterparty.link_requested' } })).toBe(1);

    const withdrawn = await createHeld(MATCHING, 'Retiré');
    const revoke = await a.owner.post(
      `/v1/organizations/${a.businessOrgId}/counterparties/${withdrawn.id}/link/revoke`,
      {},
    );
    expect(revoke.status, JSON.stringify(revoke.body)).toBe(200);
    await service.resolveLinkRequest(withdrawn.id);
    const row = await ctx.prisma.counterparty.findUniqueOrThrow({ where: { id: withdrawn.id } });
    expect(row.linkStatus).toBe('REVOKED');
    expect(row.linkRequestedOrganizationId).toBeNull();
    expect(await ctx.prisma.notification.count({ where: { type: 'counterparty.link_requested' } })).toBe(1);
  });

  it('resumes requests left unresolved by a stopped process, and only once they are a minute old', async () => {
    const cp = await createHeld(MATCHING);
    expect(await service.resolveStaleLinkRequests()).toBe(0);
    expect(await service.resolveStaleLinkRequests(later())).toBe(1);
    const row = await ctx.prisma.counterparty.findUniqueOrThrow({ where: { id: cp.id } });
    expect(row.linkStatus).toBe('PENDING');
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'counterparty.link_requested' },
    });
    expect(audit.actorUserId).toBeNull();
    expect((audit.metadata as Record<string, unknown>).resolvedBy).toBe('sweep');
    // Nothing left to resume.
    expect(await service.resolveStaleLinkRequests(later())).toBe(0);
  });
});
