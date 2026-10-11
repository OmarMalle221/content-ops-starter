import { Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { MaintenanceJobName } from '@dfn/database';
import { Permission, paginationSchema } from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { requestMeta } from '../../common/request-meta';
import { AuditService } from '../audit/audit.service';
import { JobsSchedulerService } from './jobs-scheduler.service';
import { MaintenanceService, toRunDto } from './maintenance.service';

const jobNameSchema = z.nativeEnum(MaintenanceJobName);
const listRunsQuerySchema = paginationSchema.extend({ jobName: jobNameSchema.optional() });

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
  async list() {
    const [jobs, scheduler] = await Promise.all([this.maintenance.listJobs(), this.scheduler.status()]);
    return {
      ...jobs,
      scheduler,
      jobs: jobs.jobs.map((job) => ({ ...job, nextRunAt: scheduler.nextRuns[job.name] ?? null })),
    };
  }

  @RequirePermission(Permission.ADMIN_JOBS)
  @Get('runs')
  runs(
    @Query(zodBody(listRunsQuerySchema))
    q: {
      jobName?: MaintenanceJobName;
      page: number;
      pageSize: number;
    },
  ) {
    return this.maintenance.listRuns(q.jobName, q.page, q.pageSize);
  }

  @RequirePermission(Permission.ADMIN_JOBS)
  @HttpCode(200)
  @Post(':name/run')
  async run(
    @CurrentUser() auth: AuthContext,
    @Param('name', zodBody(jobNameSchema)) name: MaintenanceJobName,
    @Req() req: Request,
  ) {
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
