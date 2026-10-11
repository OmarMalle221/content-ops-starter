import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Permission, deleteAccountSchema, type DeleteAccountInput } from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { AccountDeletionService } from './account-deletion.service';

@ApiTags('users')
@Controller('v1/users/me/deletion-request')
export class AccountDeletionController {
  constructor(private readonly deletion: AccountDeletionService) {}

  /** Deactivates the account now; anonymisation follows after ANONYMIZE_AFTER_DAYS. */
  @HttpCode(200)
  @Post()
  request(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(deleteAccountSchema)) body: DeleteAccountInput,
    @Req() req: Request,
  ) {
    return this.deletion.request(auth, body, req);
  }

  @Get('status')
  status(@CurrentUser() auth: AuthContext) {
    return this.deletion.status(auth.userId);
  }
}

@ApiTags('admin')
@Controller('v1/admin/users')
export class AccountDeletionAdminController {
  constructor(private readonly deletion: AccountDeletionService) {}

  /** Restores an account whose deletion was requested but not yet anonymised. */
  @RequirePermission(Permission.ADMIN_USERS)
  @HttpCode(200)
  @Post(':id/deletion-cancel')
  cancel(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.deletion.adminCancel(auth, id, req);
  }
}
