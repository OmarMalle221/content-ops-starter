import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  Permission,
  listAuditLogsQuerySchema,
  listRiskAlertsQuerySchema,
  paginationSchema,
  reviewVerificationSchema,
  riskAlertActionSchema,
  updateUserRoleSchema,
  updateUserStatusSchema,
  type ReviewVerificationInput,
} from '@dfn/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { AuthContext } from '../../common/auth-context';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { AuditService } from '../audit/audit.service';
import { VerificationsService } from '../verifications/verifications.service';
import { AdminService } from './admin.service';

@ApiTags('admin')
@Controller('v1/admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly audit: AuditService,
    private readonly verifications: VerificationsService,
  ) {}

  @RequirePermission(Permission.ADMIN_AUDIT)
  @Get('stats')
  stats() {
    return this.admin.stats();
  }

  @RequirePermission(Permission.ADMIN_USERS)
  @Get('users')
  users(
    @Query(zodBody(paginationSchema)) q: { page: number; pageSize: number },
    @Query('search') search?: string,
  ) {
    return this.admin.listUsers(q.page, q.pageSize, search || undefined);
  }

  @RequirePermission(Permission.ADMIN_USERS)
  @Post('users/:id/status')
  userStatus(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateUserStatusSchema))
    body: { status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED'; reason: string },
    @Req() req: Request,
  ) {
    return this.admin.updateUserStatus(auth, id, body.status, body.reason, req);
  }

  @RequirePermission(Permission.ADMIN_USERS)
  @Post('users/:id/role')
  userRole(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateUserRoleSchema)) body: { globalRole: 'USER' | 'COMPLIANCE' | 'ADMIN' },
    @Req() req: Request,
  ) {
    return this.admin.updateUserRole(auth, id, body.globalRole, req);
  }

  @RequirePermission(Permission.ADMIN_VERIFICATIONS)
  @Get('verifications')
  verificationsQueue(
    @Query('status') status: string | undefined,
    @Query(zodBody(paginationSchema)) q: { page: number; pageSize: number },
  ) {
    return this.verifications.adminQueue(status || undefined, q.page, q.pageSize);
  }

  @RequirePermission(Permission.ADMIN_VERIFICATIONS)
  @Post('verifications/:id/review')
  reviewVerification(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(reviewVerificationSchema)) body: ReviewVerificationInput,
    @Req() req: Request,
  ) {
    return this.verifications.adminReview(auth, id, body, req);
  }

  @RequirePermission(Permission.ADMIN_RISK)
  @Get('risk-alerts')
  riskAlerts(
    @Query(zodBody(listRiskAlertsQuerySchema)) q: { status?: string; page: number; pageSize: number },
  ) {
    return this.admin.listRiskAlerts(q.status, q.page, q.pageSize);
  }

  @RequirePermission(Permission.ADMIN_RISK)
  @Post('risk-alerts/:id/actions')
  riskAction(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(riskAlertActionSchema))
    body: { action: 'START_REVIEW' | 'CONFIRM' | 'DISMISS' | 'CONTEST'; note: string },
    @Req() req: Request,
  ) {
    return this.admin.actOnRiskAlert(auth, id, body.action, body.note, req);
  }

  @RequirePermission(Permission.ADMIN_AUDIT)
  @Get('audit-logs')
  auditLogs(
    @Query(zodBody(listAuditLogsQuerySchema))
    q: {
      entityType?: string;
      entityId?: string;
      actorUserId?: string;
      page: number;
      pageSize: number;
    },
  ) {
    return this.audit.list(q);
  }

  @RequirePermission(Permission.ADMIN_LEDGER)
  @Get('ledger')
  ledger(@Query(zodBody(paginationSchema)) q: { page: number; pageSize: number }) {
    return this.admin.ledgerOverview(q.page, q.pageSize);
  }

  @RequirePermission(Permission.ADMIN_LEDGER)
  @HttpCode(200)
  @Post('ledger/reconcile')
  reconcile(@CurrentUser() auth: AuthContext, @Req() req: Request) {
    return this.admin.reconcile(auth, req);
  }

  @RequirePermission(Permission.ADMIN_AUDIT)
  @Get('transactions')
  transactions(
    @Query(zodBody(paginationSchema)) q: { page: number; pageSize: number },
    @Query('status') status?: string,
  ) {
    return this.admin.listTransactions(q.page, q.pageSize, status || undefined);
  }

  @RequirePermission(Permission.ADMIN_USERS)
  @HttpCode(200)
  @Post('maintenance/expire')
  maintenance(@CurrentUser() auth: AuthContext, @Req() req: Request) {
    return this.admin.runMaintenance(auth, req);
  }
}
