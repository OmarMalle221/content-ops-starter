import { HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { Prisma, RegulatoryGate, RegulatoryGateStatus } from '@dfn/database';
import {
  ErrorCode,
  GATES_TRACKING_DISCLAIMER,
  GateAction,
  GateEventAction,
  PROVIDER_REQUIRED_GATES,
  Permission,
  REGULATORY_GATES,
  globalRoleHas,
  regulatoryGateMachine,
  type GateApproveInput,
  type GateProgressInput,
  type GateRevokeInput,
  type ProviderKind,
} from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { AuditService } from '../audit/audit.service';
import { MfaVerifierService } from '../auth/mfa-verifier.service';
import { NotificationsService } from '../notifications/notifications.service';

const ACTOR_SELECT = { id: true, firstName: true, lastName: true, email: true } as const;
type Actor = { id: string; firstName: string; lastName: string; email: string };
type GateWithApprovers = RegulatoryGate & { firstApprover: Actor | null; secondApprover: Actor | null };

const GATE_CODES = REGULATORY_GATES.map((g) => g.code);
const gateOrder = (code: string) => Number(code.slice(1));

/** FR labels used in notifications (in-app titles are French, like the rest of the platform). */
const STATUS_FR: Record<RegulatoryGateStatus, string> = {
  NOT_STARTED: 'non commencée',
  IN_PROGRESS: 'en cours',
  PENDING_SECOND_APPROVAL: 'en attente de seconde approbation',
  SATISFIED: 'satisfaite (suivi uniquement)',
  REVOKED: 'révoquée',
};

const AUDIT_ACTION: Record<GateEventAction, string> = {
  PROGRESS: 'gate.progress',
  FIRST_APPROVAL: 'gate.first_approval',
  SECOND_APPROVAL: 'gate.second_approval',
  REVOKE: 'gate.revoke',
};

function actorDto(a: Actor | null) {
  return a ? { id: a.id, name: `${a.firstName} ${a.lastName}`.trim(), email: a.email } : null;
}

/** Provider kinds whose activation would require this gate. */
function requiredFor(code: string): ProviderKind[] {
  return (Object.keys(PROVIDER_REQUIRED_GATES) as ProviderKind[]).filter((kind) =>
    PROVIDER_REQUIRED_GATES[kind].includes(code),
  );
}

/** Server-driven actions for the viewer (empty for read-only staff). */
export function gateNextActions(
  gate: Pick<RegulatoryGate, 'status' | 'firstApproverId'>,
  auth: Pick<AuthContext, 'userId' | 'globalRole'>,
): GateAction[] {
  if (!globalRoleHas(auth.globalRole, Permission.ADMIN_GATES_MANAGE)) return [];
  const actions: GateAction[] = [];
  if (regulatoryGateMachine.canTransition(gate.status, 'IN_PROGRESS')) actions.push(GateAction.PROGRESS);
  if (
    gate.status === 'IN_PROGRESS' ||
    (gate.status === 'PENDING_SECOND_APPROVAL' &&
      gate.firstApproverId !== null &&
      gate.firstApproverId !== auth.userId)
  ) {
    actions.push(GateAction.APPROVE);
  }
  if (regulatoryGateMachine.canTransition(gate.status, 'REVOKED')) actions.push(GateAction.REVOKE);
  return actions;
}

export function toGateDto(gate: GateWithApprovers, auth: Pick<AuthContext, 'userId' | 'globalRole'>) {
  return {
    code: gate.code,
    title: gate.title,
    jurisdiction: gate.jurisdiction,
    referenceDoc: gate.referenceDoc,
    level: gate.level,
    status: gate.status,
    notes: gate.notes,
    evidenceRef: gate.evidenceRef,
    firstApprover: actorDto(gate.firstApprover),
    firstApprovedAt: gate.firstApprovedAt,
    secondApprover: actorDto(gate.secondApprover),
    secondApprovedAt: gate.secondApprovedAt,
    approvals: (gate.firstApproverId ? 1 : 0) + (gate.secondApproverId ? 1 : 0),
    approvalsRequired: 2,
    requiredFor: requiredFor(gate.code),
    createdAt: gate.createdAt,
    updatedAt: gate.updatedAt,
    trackingOnly: true as const,
    disclaimer: GATES_TRACKING_DISCLAIMER,
    nextActions: gateNextActions(gate, auth),
  };
}

/**
 * Regulatory gates register (ROADMAP §10, R1–R10). Tracking only: a SATISFIED gate never
 * switches the platform out of sandbox (see ProviderActivationService). Every transition writes a
 * RegulatoryGateEvent and an AuditLog row in one transaction, then notifies every active ADMIN.
 * SATISFIED requires two approvals by two different ADMIN users (four-eyes rule).
 */
@Injectable()
export class RegulatoryGatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly mfa: MfaVerifierService,
  ) {}

  /**
   * Approving or revoking a gate is a high-impact governance act: when the acting ADMIN has a
   * second factor (TOTP or a passkey), a fresh proof is required — a stolen session alone is not
   * enough. Accounts without any second factor keep the four-eyes rule as their only control.
   */
  private async requireStepUp(
    auth: AuthContext,
    proof: { mfaCode?: string; passkeyAssertion?: GateApproveInput['passkeyAssertion'] },
    purpose: string,
    req: Request,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: auth.userId },
      select: {
        mfaEnabled: true,
        _count: { select: { webAuthnCredentials: { where: { revokedAt: null } } } },
      },
    });
    if (!user?.mfaEnabled && !user?._count.webAuthnCredentials) return;
    await this.mfa.assertFreshProof(
      auth,
      proof,
      purpose,
      {
        code: ErrorCode.STEP_UP_REQUIRED,
        message: 'A fresh second factor (TOTP, recovery code or passkey) is required for this gate action',
      },
      req,
    );
  }

  /**
   * Creates the gates missing from the register (status, notes, evidence and approvals of
   * existing gates are never touched). With `syncDefinitions`, the code-owned definition fields
   * (title, jurisdiction, reference document, level) are also refreshed — at module init only.
   */
  async ensureDefaults(options: { syncDefinitions?: boolean } = {}): Promise<void> {
    await this.prisma.regulatoryGate.createMany({
      data: REGULATORY_GATES.map((g) => ({
        code: g.code,
        title: g.title,
        jurisdiction: g.jurisdiction,
        referenceDoc: g.referenceDoc,
        level: g.level,
      })),
      skipDuplicates: true,
    });
    if (!options.syncDefinitions) return;
    for (const g of REGULATORY_GATES) {
      await this.prisma.regulatoryGate.updateMany({
        where: {
          code: g.code,
          OR: [
            { title: { not: g.title } },
            { jurisdiction: { not: g.jurisdiction } },
            { referenceDoc: { not: g.referenceDoc } },
            { level: { not: g.level } },
          ],
        },
        data: { title: g.title, jurisdiction: g.jurisdiction, referenceDoc: g.referenceDoc, level: g.level },
      });
    }
  }

  async list(auth: AuthContext) {
    await this.ensureDefaults();
    const gates = await this.prisma.regulatoryGate.findMany({
      where: { code: { in: GATE_CODES } },
      include: { firstApprover: { select: ACTOR_SELECT }, secondApprover: { select: ACTOR_SELECT } },
    });
    gates.sort((a, b) => gateOrder(a.code) - gateOrder(b.code));
    const byStatus: Record<RegulatoryGateStatus, number> = {
      NOT_STARTED: 0,
      IN_PROGRESS: 0,
      PENDING_SECOND_APPROVAL: 0,
      SATISFIED: 0,
      REVOKED: 0,
    };
    for (const g of gates) byStatus[g.status] += 1;
    return {
      mode: 'sandbox' as const,
      trackingOnly: true as const,
      disclaimer: GATES_TRACKING_DISCLAIMER,
      canManage: globalRoleHas(auth.globalRole, Permission.ADMIN_GATES_MANAGE),
      summary: { total: gates.length, byStatus },
      items: gates.map((g) => toGateDto(g, auth)),
    };
  }

  /** Gate with its full event history (newest first). Unknown codes → 404. */
  async get(auth: AuthContext, rawCode: string) {
    const code = this.normalizeCode(rawCode);
    await this.ensureDefaults();
    const gate = await this.findGate(code);
    const [events, audits] = await Promise.all([
      this.prisma.regulatoryGateEvent.findMany({
        where: { gateCode: code },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { actor: { select: ACTOR_SELECT } },
      }),
      // Evidence references live in the audit metadata of each transition.
      this.prisma.auditLog.findMany({
        where: { entityType: 'RegulatoryGate', entityId: code },
        select: { metadata: true },
      }),
    ]);
    const evidenceByEvent = new Map<string, string>();
    for (const a of audits) {
      const m = a.metadata as { eventId?: unknown; evidenceRef?: unknown } | null;
      if (m && typeof m.eventId === 'string' && typeof m.evidenceRef === 'string') {
        evidenceByEvent.set(m.eventId, m.evidenceRef);
      }
    }
    return {
      ...toGateDto(gate, auth),
      events: events.map((e) => ({
        id: e.id,
        action: e.action,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        note: e.note,
        evidenceRef: evidenceByEvent.get(e.id) ?? null,
        actor: actorDto(e.actor),
        createdAt: e.createdAt,
      })),
    };
  }

  /** NOT_STARTED / IN_PROGRESS / REVOKED → IN_PROGRESS with a note (and optional evidence). */
  async progress(auth: AuthContext, rawCode: string, input: GateProgressInput, req: Request) {
    const code = this.normalizeCode(rawCode);
    await this.ensureDefaults();
    const gate = await this.findGate(code);
    regulatoryGateMachine.assertTransition(gate.status, 'IN_PROGRESS');
    const evidenceRef = input.evidenceRef ?? gate.evidenceRef ?? null;
    return this.transition(auth, req, gate, {
      action: GateEventAction.PROGRESS,
      to: 'IN_PROGRESS',
      note: input.note,
      evidenceRef: input.evidenceRef ?? null,
      data: { status: 'IN_PROGRESS', notes: input.note, evidenceRef },
    });
  }

  /**
   * IN_PROGRESS → PENDING_SECOND_APPROVAL (first approver), then PENDING_SECOND_APPROVAL →
   * SATISFIED by a DIFFERENT administrator (GATE_SAME_APPROVER otherwise).
   */
  async approve(auth: AuthContext, rawCode: string, input: GateApproveInput, req: Request) {
    const code = this.normalizeCode(rawCode);
    await this.requireStepUp(auth, input, 'gate.approve', req);
    await this.ensureDefaults();
    const gate = await this.findGate(code);
    const now = new Date();
    if (gate.status === 'IN_PROGRESS') {
      return this.transition(auth, req, gate, {
        action: GateEventAction.FIRST_APPROVAL,
        to: 'PENDING_SECOND_APPROVAL',
        note: input.note,
        evidenceRef: input.evidenceRef,
        data: {
          status: 'PENDING_SECOND_APPROVAL',
          notes: input.note,
          evidenceRef: input.evidenceRef,
          firstApproverId: auth.userId,
          firstApprovedAt: now,
        },
      });
    }
    if (gate.status === 'PENDING_SECOND_APPROVAL') {
      if (!gate.firstApproverId) {
        // Only possible if the first approver's account row disappeared (FK set null).
        throw DomainError.conflict('The first approval is missing: revoke the gate and restart it', { code });
      }
      if (gate.firstApproverId === auth.userId) {
        throw new DomainError(
          ErrorCode.GATE_SAME_APPROVER,
          'The second approval must come from a different administrator (four-eyes rule)',
          HttpStatus.CONFLICT,
          { code, firstApproverId: gate.firstApproverId },
        );
      }
      return this.transition(auth, req, gate, {
        action: GateEventAction.SECOND_APPROVAL,
        to: 'SATISFIED',
        note: input.note,
        evidenceRef: input.evidenceRef,
        data: {
          status: 'SATISFIED',
          notes: input.note,
          evidenceRef: input.evidenceRef,
          secondApproverId: auth.userId,
          secondApprovedAt: now,
        },
        expectFirstApproverId: gate.firstApproverId,
      });
    }
    throw DomainError.invalidTransition(
      `Regulatory gate ${code} cannot be approved while ${gate.status} (it must be IN_PROGRESS first)`,
      { entity: 'RegulatoryGate', from: gate.status, to: 'PENDING_SECOND_APPROVAL' },
    );
  }

  /** IN_PROGRESS / PENDING_SECOND_APPROVAL / SATISFIED → REVOKED; approvals and evidence cleared. */
  async revoke(auth: AuthContext, rawCode: string, input: GateRevokeInput, req: Request) {
    const code = this.normalizeCode(rawCode);
    await this.requireStepUp(auth, input, 'gate.revoke', req);
    await this.ensureDefaults();
    const gate = await this.findGate(code);
    regulatoryGateMachine.assertTransition(gate.status, 'REVOKED');
    return this.transition(auth, req, gate, {
      action: GateEventAction.REVOKE,
      to: 'REVOKED',
      note: input.note,
      evidenceRef: null,
      data: {
        status: 'REVOKED',
        notes: input.note,
        evidenceRef: null,
        firstApproverId: null,
        firstApprovedAt: null,
        secondApproverId: null,
        secondApprovedAt: null,
      },
    });
  }

  private normalizeCode(rawCode: string): string {
    const code = String(rawCode ?? '')
      .trim()
      .toUpperCase();
    if (!GATE_CODES.includes(code)) throw DomainError.notFound('Regulatory gate');
    return code;
  }

  private async findGate(code: string): Promise<GateWithApprovers> {
    const gate = await this.prisma.regulatoryGate.findUnique({
      where: { code },
      include: { firstApprover: { select: ACTOR_SELECT }, secondApprover: { select: ACTOR_SELECT } },
    });
    if (!gate) throw DomainError.notFound('Regulatory gate');
    return gate;
  }

  /**
   * Applies a transition atomically: compare-and-set on the current status (and first approver),
   * event row, audit row; then notifies every active ADMIN. A concurrent change → 409 CONFLICT.
   */
  private async transition(
    auth: AuthContext,
    req: Request,
    gate: GateWithApprovers,
    t: {
      action: GateEventAction;
      to: RegulatoryGateStatus;
      note: string;
      evidenceRef: string | null;
      data: Prisma.RegulatoryGateUncheckedUpdateManyInput & { status: RegulatoryGateStatus };
      expectFirstApproverId?: string;
    },
  ) {
    const from = gate.status;
    const eventId = await this.prisma.$transaction(async (tx) => {
      const guard = await tx.regulatoryGate.updateMany({
        where: {
          code: gate.code,
          status: from,
          updatedAt: gate.updatedAt,
          ...(t.expectFirstApproverId ? { firstApproverId: t.expectFirstApproverId } : {}),
        },
        data: t.data,
      });
      if (guard.count !== 1) {
        throw DomainError.conflict('The regulatory gate changed concurrently; reload and retry', {
          code: gate.code,
        });
      }
      const event = await tx.regulatoryGateEvent.create({
        data: {
          gateCode: gate.code,
          actorUserId: auth.userId,
          action: t.action,
          fromStatus: from,
          toStatus: t.to,
          note: t.note,
        },
      });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          action: AUDIT_ACTION[t.action],
          entityType: 'RegulatoryGate',
          entityId: gate.code,
          metadata: {
            eventId: event.id,
            fromStatus: from,
            toStatus: t.to,
            ...(t.evidenceRef ? { evidenceRef: t.evidenceRef } : {}),
            trackingOnly: true,
          },
          ...requestMeta(req),
        },
        tx,
      );
      return event.id;
    });

    const admins = await this.prisma.user.findMany({
      where: { globalRole: 'ADMIN', status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
    const actorName = `${auth.firstName} ${auth.lastName}`.trim() || auth.email;
    await this.notifications.notifyMany(
      admins.map((a) => a.id),
      {
        type: 'gate.status_changed',
        title: `Porte réglementaire ${gate.code} : ${STATUS_FR[t.to]}`,
        body:
          `${actorName} — ${STATUS_FR[from]} → ${STATUS_FR[t.to]}. ` +
          'Suivi uniquement : aucun statut ne permet d’activer des fonds réels ; DFN_MODE reste sandbox.',
        data: { code: gate.code, action: t.action, fromStatus: from, toStatus: t.to, eventId },
      },
    );
    return this.get(auth, gate.code);
  }
}
