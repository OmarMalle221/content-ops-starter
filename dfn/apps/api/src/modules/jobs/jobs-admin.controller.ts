import { Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { MaintenanceJobName } from '@dfn/database';
import { Permission, globalRoleHas, paginationSchema } from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { requestMeta } from '../../common/request-meta';
import { DomainError } from '../../common/domain-error';
import { AuditService } from '../audit/audit.service';
import { JobsSchedulerService } from './jobs-scheduler.service';
import { MaintenanceService, toRunDto } from './maintenance.service';

const jobNameSchema = z.nativeEnum(MaintenanceJobName);
const listRunsQuerySchema = paginationSchema.extend({ jobName: jobNameSchema.optional() });

/**
 * Key rotation re-encrypts every secret and its runs expose key ids and failure counts: on this
 * generic console it stays reserved to ADMIN_KEYS holders (COMPLIANCE has ADMIN_JOBS only).
 */
const KEY_ROTATION_JOB = MaintenanceJobName.ENCRYPTION_KEY_ROTATION;
const canSeeKeyJobs = (auth: AuthContext) => globalRoleHas(auth.globalRole, Permission.ADMIN_KEYS);

@ApiTags('admin')
@Controller('v1/admin/jobs')
export class JobsAdminController {
  constructor(
    private readonly maintenance: MaintenanceService,
    private readonly scheduler: JobsSchedulerService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Jobs, their latest run and current lease, plus the scheduler driver, this replica's instance
   * id and the next planned executions (BullMQ schedules or the in-process timer).
   */
  @RequirePermission(Permission.ADMIN_JOBS)
  @Get()
  async list(@CurrentUser() auth: AuthContext) {
    const [jobs, scheduler] = await Promise.all([this.maintenance.listJobs(), this.scheduler.status()]);
    const visible = (name: string) => name !== KEY_ROTATION_JOB || canSeeKeyJobs(auth);
    return {
      ...jobs,
      leases: jobs.leases.filter((lease) => visible(lease.jobName)),
      scheduler,
      jobs: jobs.jobs
        .filter((job) => visible(job.name))
        .map((job) => ({ ...job, nextRunAt: scheduler.nextRuns[job.name] ?? null })),
    };
  }

  @RequirePermission(Permission.ADMIN_JOBS)
  @Get('runs')
  runs(
    @CurrentUser() auth: AuthContext,
    @Query(zodBody(listRunsQuerySchema))
    q: {
      jobName?: MaintenanceJobName;
      page: number;
      pageSize: number;
    },
  ) {
    if (canSeeKeyJobs(auth)) return this.maintenance.listRuns(q.jobName, q.page, q.pageSize);
    if (q.jobName === KEY_ROTATION_JOB) throw DomainError.forbidden();
    return this.maintenance.listRuns(q.jobName, q.page, q.pageSize, [KEY_ROTATION_JOB]);
  }

  @RequirePermission(Permission.ADMIN_JOBS)
  @HttpCode(200)
  @Post(':name/run')
  async run(
    @CurrentUser() auth: AuthContext,
    @Param('name', zodBody(jobNameSchema)) name: MaintenanceJobName,
    @Req() req: Request,
  ) {
    if (name === KEY_ROTATION_JOB && !canSeeKeyJobs(auth)) throw DomainError.forbidden();
    const run = await this.maintenance.run(name, `manual:${auth.userId}`);
    await this.audit.log({
      actorUserId: auth.userId,
      action: 'admin.job_run',
      entityType: 'MaintenanceRun',
      entityId: run.id,
      metadata: { jobName: name, status: run.status, error: run.error ?? undefined },
      ...requestMeta(req),
    });
    return toRunDto(run);
  }
}
