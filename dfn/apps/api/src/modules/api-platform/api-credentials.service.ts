import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import {
  API_KEY_PREFIX,
  Permission,
  type ApiRequestLogsQuery,
  type CreateApiCredentialRequest,
  type ListApiCredentialsQuery,
} from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { randomToken, sha256Hex } from '../../common/crypto';
import { DomainError } from '../../common/domain-error';
import { paginate } from '../../common/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { ApiAuthService } from './api-auth.service';
import { toApiCredentialDto, toApiRequestLogDto, type ApiCredentialWithCreator } from './api-platform.dto';

const PREFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const CREATOR_SELECT = { select: { id: true, email: true, firstName: true, lastName: true } } as const;

/** 8 lowercase alphanumeric characters: enough to tell keys apart in the console, useless to an attacker. */
export function randomKeyPrefix(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += PREFIX_ALPHABET[bytes[i]! % PREFIX_ALPHABET.length];
  return out;
}

/** `dfn_sk_<8-char prefix>_<32 random bytes, base64url>` — the clear key is shown once and never stored. */
export function generateApiKey(): { key: string; keyPrefix: string; keyHash: string } {
  const keyPrefix = randomKeyPrefix();
  const key = `${API_KEY_PREFIX}${keyPrefix}_${randomToken(32)}`;
  return { key, keyPrefix, keyHash: sha256Hex(key) };
}

/**
 * Sandbox API keys ("clés sandbox") of an organisation. Managing keys requires the API_MANAGE
 * organisation permission; keys themselves (role MEMBER) can never create or rotate keys.
 */
@Injectable()
export class ApiCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly apiAuth: ApiAuthService,
  ) {}

  private manager(auth: AuthContext, organizationId?: string) {
    // API keys never manage keys, whatever their scopes (defence in depth beyond the scope map).
    if (auth.apiCredential) throw DomainError.forbidden('API keys cannot manage API credentials');
    return this.organizations.resolveActingOrganization(auth, organizationId, Permission.API_MANAGE);
  }

  private async load(auth: AuthContext, id: string): Promise<ApiCredentialWithCreator> {
    const credential = await this.prisma.apiCredential.findUnique({
      where: { id },
      include: { createdBy: CREATOR_SELECT },
    });
    // Unknown id and foreign tenant are indistinguishable (404).
    if (!credential) throw DomainError.notFound('API credential');
    this.manager(auth, credential.organizationId);
    return credential;
  }

  async list(auth: AuthContext, query: ListApiCredentialsQuery) {
    const membership = this.manager(auth, query.organizationId);
    const items = await this.prisma.apiCredential.findMany({
      where: {
        organizationId: membership.organizationId,
        ...(query.includeRevoked ? {} : { revokedAt: null }),
      },
      include: { createdBy: CREATOR_SELECT },
      orderBy: { createdAt: 'desc' },
    });
    const now = new Date();
    return {
      organizationId: membership.organizationId,
      sandbox: true,
      items: items.map((c) => toApiCredentialDto(c, now)),
    };
  }

  async get(auth: AuthContext, id: string) {
    return toApiCredentialDto(await this.load(auth, id));
  }

  async create(auth: AuthContext, input: CreateApiCredentialRequest, req: Request) {
    const membership = this.manager(auth, input.organizationId);
    const { key, keyPrefix, keyHash } = generateApiKey();
    const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null;
    const credential = await this.prisma.$transaction(async (tx) => {
      const created = await tx.apiCredential.create({
        data: {
          organizationId: membership.organizationId,
          createdByUserId: auth.userId,
          name: input.name,
          description: input.description ?? null,
          keyPrefix,
          keyHash,
          scopes: [...new Set(input.scopes)],
          rateLimitPerMinute: input.rateLimitPerMinute,
          expiresAt,
        },
        include: { createdBy: CREATOR_SELECT },
      });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: membership.organizationId,
          action: 'api_credential.created',
          entityType: 'ApiCredential',
          entityId: created.id,
          metadata: {
            keyPrefix,
            scopes: created.scopes,
            rateLimitPerMinute: created.rateLimitPerMinute,
            expiresAt: expiresAt?.toISOString() ?? null,
          },
          ...requestMeta(req),
        },
        tx,
      );
      await this.notifications.notify(
        {
          userId: auth.userId,
          type: 'api_credential.created',
          title: 'Clé sandbox créée',
          body: `La clé sandbox « ${created.name} » (${API_KEY_PREFIX}${keyPrefix}_…) a été créée. Données fictives — Aucun fonds réel.`,
          data: { credentialId: created.id, organizationId: membership.organizationId },
        },
        tx,
      );
      return created;
    });
    return { credential: toApiCredentialDto(credential), key, sandbox: true as const };
  }

  /** Issues a replacement key with the same settings and revokes the current one atomically. */
  async rotate(auth: AuthContext, id: string, req: Request) {
    const current = await this.load(auth, id);
    if (current.revokedAt) throw DomainError.conflict('A revoked key cannot be rotated');
    const { key, keyPrefix, keyHash } = generateApiKey();
    const now = new Date();
    const replacement = await this.prisma.$transaction(async (tx) => {
      const created = await tx.apiCredential.create({
        data: {
          organizationId: current.organizationId,
          createdByUserId: auth.userId,
          name: current.name,
          description: current.description,
          keyPrefix,
          keyHash,
          scopes: current.scopes,
          rateLimitPerMinute: current.rateLimitPerMinute,
          rotatedFromId: current.id,
          expiresAt: current.expiresAt && current.expiresAt > now ? current.expiresAt : null,
        },
        include: { createdBy: CREATOR_SELECT },
      });
      await tx.apiCredential.update({ where: { id: current.id }, data: { revokedAt: now } });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: current.organizationId,
          action: 'api_credential.rotated',
          entityType: 'ApiCredential',
          entityId: created.id,
          metadata: { previousCredentialId: current.id, previousKeyPrefix: current.keyPrefix, keyPrefix },
          ...requestMeta(req),
        },
        tx,
      );
      await this.notifications.notify(
        {
          userId: auth.userId,
          type: 'api_credential.rotated',
          title: 'Clé sandbox renouvelée',
          body: `La clé « ${current.name} » a été renouvelée ; l’ancienne clé (${API_KEY_PREFIX}${current.keyPrefix}_…) est révoquée. Données fictives — Aucun fonds réel.`,
          data: { credentialId: created.id, previousCredentialId: current.id },
        },
        tx,
      );
      return created;
    });
    this.apiAuth.forget(current.id);
    return { credential: toApiCredentialDto(replacement), key, sandbox: true as const };
  }

  async revoke(auth: AuthContext, id: string, req: Request) {
    const current = await this.load(auth, id);
    if (current.revokedAt) throw DomainError.conflict('This key is already revoked');
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.apiCredential.update({
        where: { id: current.id },
        data: { revokedAt: new Date() },
        include: { createdBy: CREATOR_SELECT },
      });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: current.organizationId,
          action: 'api_credential.revoked',
          entityType: 'ApiCredential',
          entityId: current.id,
          metadata: { keyPrefix: current.keyPrefix },
          ...requestMeta(req),
        },
        tx,
      );
      await this.notifications.notify(
        {
          userId: auth.userId,
          type: 'api_credential.revoked',
          title: 'Clé sandbox révoquée',
          body: `La clé « ${current.name} » (${API_KEY_PREFIX}${current.keyPrefix}_…) a été révoquée.`,
          data: { credentialId: current.id },
        },
        tx,
      );
      return row;
    });
    this.apiAuth.forget(current.id);
    return toApiCredentialDto(updated);
  }

  async logs(auth: AuthContext, id: string, query: ApiRequestLogsQuery) {
    await this.load(auth, id);
    const where = { credentialId: id };
    const [items, total] = await Promise.all([
      this.prisma.apiRequestLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.apiRequestLog.count({ where }),
    ]);
    return paginate(items.map(toApiRequestLogDto), total, query.page, query.pageSize);
  }
}
