import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  Permission,
  gateApproveSchema,
  gateProgressSchema,
  gateRevokeSchema,
  type GateApproveInput,
  type GateProgressInput,
  type GateRevokeInput,
} from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { ProviderActivationService } from './provider-activation.service';
import { RegulatoryGatesService } from './regulatory-gates.service';

/**
 * Regulatory gates register — read: COMPLIANCE + ADMIN (ADMIN_GATES_VIEW); write: ADMIN only
 * (ADMIN_GATES_MANAGE). Tracking only: no response or transition ever activates live mode.
 */
@ApiTags('admin')
@Controller('v1/admin/gates')
export class GatesController {
  constructor(
    private readonly gates: RegulatoryGatesService,
    private readonly activation: ProviderActivationService,
  ) {}

  @RequirePermission(Permission.ADMIN_GATES_VIEW)
  @Get()
  list(@CurrentUser() auth: AuthContext) {
    return this.gates.list(auth);
  }

  /** Configured providers (env), sandbox status and the gates a licensed partner would need. */
  @RequirePermission(Permission.ADMIN_GATES_VIEW)
  @Get('providers')
  providers() {
    return this.activation.listProviders();
  }

  @RequirePermission(Permission.ADMIN_GATES_VIEW)
  @Get(':code')
  get(@CurrentUser() auth: AuthContext, @Param('code') code: string) {
    return this.gates.get(auth, code);
  }

  @RequirePermission(Permission.ADMIN_GATES_MANAGE)
  @HttpCode(200)
  @Post(':code/progress')
  progress(
    @CurrentUser() auth: AuthContext,
    @Param('code') code: string,
    @Body(zodBody(gateProgressSchema)) body: GateProgressInput,
    @Req() req: Request,
  ) {
    return this.gates.progress(auth, code, body, req);
  }

  @RequirePermission(Permission.ADMIN_GATES_MANAGE)
  @HttpCode(200)
  @Post(':code/approve')
  approve(
    @CurrentUser() auth: AuthContext,
    @Param('code') code: string,
    @Body(zodBody(gateApproveSchema)) body: GateApproveInput,
    @Req() req: Request,
  ) {
    return this.gates.approve(auth, code, body, req);
  }

  @RequirePermission(Permission.ADMIN_GATES_MANAGE)
  @HttpCode(200)
  @Post(':code/revoke')
  revoke(
    @CurrentUser() auth: AuthContext,
    @Param('code') code: string,
    @Body(zodBody(gateRevokeSchema)) body: GateRevokeInput,
    @Req() req: Request,
  ) {
    return this.gates.revoke(auth, code, body, req);
  }
}
