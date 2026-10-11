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
      this.worker = new Worker<EmailJob>('notifications', async (job) => this.deliverEmail(job.data), {
        connection: parseRedis(env.REDIS_URL),
      });
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
        await this.queue.add('email', job, { removeOnComplete: 100, removeOnFail: 100, attempts: 3 });
      } else {
        setImmediate(() => void this.deliverEmail(job));
      }
    }
    return notification;
  }

  async notifyMany(userIds: string[], input: Omit<NotifyInput, 'userId'>, db?: Prisma.TransactionClient) {
    const unique = [...new Set(userIds)];
    for (const userId of unique) await this.notify({ ...input, userId }, db);
  }

  private async deliverEmail(job: EmailJob) {
    // EMAIL_PROVIDER=log is the only transport in the sandbox build.
    this.logger.log(`[email:log] to=${maskEmail(job.to)} subject="${job.subject}"`);
    await this.prisma.notification
      .update({ where: { id: job.notificationId }, data: { sentAt: new Date() } })
      .catch(() => undefined);
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
