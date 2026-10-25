import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import type { Prisma } from '@dfn/database';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ENV, type Env } from '../../config/env';

export interface NotifyInput {
  userId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface EmailJob {
  notificationId: string;
  to: string;
  subject: string;
  text: string;
}

/**
 * In-app notifications are persisted synchronously (they are part of the business transaction).
 * Email delivery is queued through BullMQ when Redis is configured; otherwise it is dispatched
 * in-process. The only email transport in this build is the log transport.
 */
@Injectable()
export class NotificationsService implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private queue?: Queue<EmailJob>;
  private worker?: Worker<EmailJob>;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {
    if (env.REDIS_URL && env.NODE_ENV !== 'test') {
      const connection = { url: env.REDIS_URL } as any;
      this.queue = new Queue<EmailJob>('notifications', { connection: parseRedis(env.REDIS_URL) });
      this.worker = new Worker<EmailJob>(
        'notifications',
        async (job) => {
          // Not committed yet → throw so BullMQ retries with back-off (see deliverEmail).
          if ((await this.deliverEmail(job.data)) === 'pending') {
            throw new Error('notification not committed yet');
          }
        },
        { connection: parseRedis(env.REDIS_URL) },
      );
      this.worker.on('failed', (job, err) =>
        this.logger.error(`email job ${job?.id} failed: ${err.message}`),
      );
      void connection;
    } else {
      this.logger.warn('REDIS_URL not set — notifications are dispatched in-process (development only)');
    }
  }

  async notify(input: NotifyInput, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    const notification = await db.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        data: (input.data ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    const user = await db.user.findUnique({ where: { id: input.userId }, select: { email: true } });
    if (user) {
      const job: EmailJob = {
        notificationId: notification.id,
        to: user.email,
        subject: input.title,
        text: input.body,
      };
      if (this.queue) {
        await this.queue.add('email', job, {
          removeOnComplete: 100,
          removeOnFail: 100,
          attempts: EMAIL_DELIVERY_ATTEMPTS,
          backoff: { type: 'exponential', delay: 250 },
        });
      } else {
        this.deliverInProcess(job, 0);
      }
    }
    return notification;
  }

  async notifyMany(userIds: string[], input: Omit<NotifyInput, 'userId'>, db?: Prisma.TransactionClient) {
    const unique = [...new Set(userIds)];
    for (const userId of unique) await this.notify({ ...input, userId }, db);
  }

  /**
   * The notification row is the outbox. When notify() runs inside a business transaction, the row
   * only becomes visible once that transaction commits: until then delivery reports 'pending' and
   * is retried with back-off; a row that never appears belongs to a rolled-back operation and no
   * e-mail is ever sent for it. Delivery is idempotent (sentAt is set once).
   */
  private async deliverEmail(job: EmailJob): Promise<'sent' | 'pending' | 'skipped'> {
    const row = await this.prisma.notification.findUnique({
      where: { id: job.notificationId },
      select: { sentAt: true },
    });
    if (!row) return 'pending';
    if (row.sentAt) return 'skipped';
    // EMAIL_PROVIDER=log is the only transport in the sandbox build.
    this.logger.log(`[email:log] to=${maskEmail(job.to)} subject="${job.subject}"`);
    await this.prisma.notification.updateMany({
      where: { id: job.notificationId, sentAt: null },
      data: { sentAt: new Date() },
    });
    return 'sent';
  }

  /** In-process fallback (no Redis): same outbox semantics, bounded exponential retries. */
  private deliverInProcess(job: EmailJob, attempt: number) {
    const timer = setTimeout(
      () => {
        this.deliverEmail(job)
          .then((outcome) => {
            if (outcome !== 'pending') return;
            if (attempt + 1 < EMAIL_DELIVERY_ATTEMPTS) this.deliverInProcess(job, attempt + 1);
            else this.logger.debug(`notification ${job.notificationId} never committed — no e-mail sent`);
          })
          .catch((err) => this.logger.warn(`e-mail delivery failed: ${String(err)}`));
      },
      attempt === 0 ? 0 : 250 * 2 ** (attempt - 1),
    );
    timer.unref?.();
  }

  async listForUser(userId: string, page: number, pageSize: number, unreadOnly = false) {
    const where = { userId, ...(unreadOnly ? { readAt: null } : {}) };
    const [items, total, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    return { items, total, page, pageSize, unread };
  }

  async markRead(userId: string, id: string) {
    const r = await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: r.count };
  }

  async markAllRead(userId: string) {
    const r = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: r.count };
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
  }
}

/** Delivery attempts while waiting for the enclosing transaction to commit (~8 s in total). */
const EMAIL_DELIVERY_ATTEMPTS = 6;

function parseRedis(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password || undefined,
    username: u.username || undefined,
    db: u.pathname && u.pathname !== '/' ? Number(u.pathname.slice(1)) : undefined,
    maxRetriesPerRequest: null as unknown as number | null,
  } as any;
}

function maskEmail(email: string) {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}
