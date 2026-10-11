import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  Permission,
  listAdminTransfersQuerySchema,
  reviewTransferSchema,
  type ListAdminTransfersQuery,
  type ReviewTransferInput,
} from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { TransfersService } from './transfers.service';

/** Compliance back-office for transfers: review queue and decisions. */
@ApiTags('admin')
@Controller('v1/admin/transfers')
export class TransfersAdminController {
  constructor(private readonly transfers: TransfersService) {}

  @RequirePermission(Permission.ADMIN_TRANSFERS)
  @Get()
  list(@Query(zodBody(listAdminTransfersQuerySchema)) query: ListAdminTransfersQuery) {
    return this.transfers.adminList(query);
  }

  @RequirePermission(Permission.ADMIN_TRANSFERS)
  @Get(':id')
  get(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.transfers.get(auth, id);
  }

  @RequirePermission(Permission.ADMIN_TRANSFERS)
  @HttpCode(200)
  @Post(':id/review')
  review(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(reviewTransferSchema)) body: ReviewTransferInput,
    @Req() req: Request,
  ) {
    return this.transfers.adminReview(auth, id, body, req);
  }
}
