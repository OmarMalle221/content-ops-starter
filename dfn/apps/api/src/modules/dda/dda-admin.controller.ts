import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  Permission,
  ddaMintSchema,
  ddaRedeemSchema,
  ddaReserveAdjustmentSchema,
  ddaStressTestSchema,
  ddaTransferSchema,
  paginationSchema,
  type DdaMintInput,
  type DdaRedeemInput,
  type DdaReserveAdjustmentInput,
  type DdaStressTestInput,
  type DdaTransferInput,
  type PaginationInput,
} from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { DdaService } from './dda.service';

/**
 * Diaspora Digital Asset research sandbox — platform administrators only (Permission.ADMIN_DDA).
 * Every response is a simulation: { simulated: true, disclaimer, hypothesis }. No route converts
 * fictitious units into anything.
 */
@ApiTags('admin')
@Controller('v1/admin/dda')
export class DdaAdminController {
  constructor(private readonly dda: DdaService) {}

  @RequirePermission(Permission.ADMIN_DDA)
  @Get('overview')
  overview() {
    return this.dda.overview();
  }

  @RequirePermission(Permission.ADMIN_DDA)
  @Get('operations')
  operations(@Query(zodBody(paginationSchema)) q: PaginationInput) {
    return this.dda.operations(q.page, q.pageSize);
  }

  @RequirePermission(Permission.ADMIN_DDA)
  @Get('holdings')
  holdings() {
    return this.dda.holdings();
  }

  @RequirePermission(Permission.ADMIN_DDA)
  @Get('organizations')
  organizations() {
    return this.dda.organizations();
  }

  @RequirePermission(Permission.ADMIN_DDA)
  @Get('trace/:reference')
  trace(@Param('reference') reference: string) {
    return this.dda.trace(reference);
  }

  @RequirePermission(Permission.ADMIN_DDA)
  @Post('mint')
  mint(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(ddaMintSchema)) body: DdaMintInput,
    @Req() req: Request,
  ) {
    return this.dda.mint(auth, body, req);
  }

  @RequirePermission(Permission.ADMIN_DDA)
  @Post('transfer')
  transfer(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(ddaTransferSchema)) body: DdaTransferInput,
    @Req() req: Request,
  ) {
    return this.dda.transfer(auth, body, req);
  }

  @RequirePermission(Permission.ADMIN_DDA)
  @Post('redeem')
  redeem(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(ddaRedeemSchema)) body: DdaRedeemInput,
    @Req() req: Request,
  ) {
    return this.dda.redeem(auth, body, req);
  }

  @RequirePermission(Permission.ADMIN_DDA)
  @Post('reserve-adjustments')
  reserveAdjustment(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(ddaReserveAdjustmentSchema)) body: DdaReserveAdjustmentInput,
    @Req() req: Request,
  ) {
    return this.dda.adjustReserve(auth, body, req);
  }

  @RequirePermission(Permission.ADMIN_DDA)
  @HttpCode(200)
  @Post('stress-test')
  stressTest(@Body(zodBody(ddaStressTestSchema)) body: DdaStressTestInput) {
    return this.dda.stressTest(body);
  }
}
