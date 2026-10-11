import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Permission, rotateKeysSchema, type RotateKeysInput } from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { KeysService } from './keys.service';

/** Key ring console — platform ADMIN only (Permission.ADMIN_KEYS). */
@ApiTags('admin')
@RequirePermission(Permission.ADMIN_KEYS)
@Controller('v1/admin/keys')
export class KeysController {
  constructor(private readonly keys: KeysService) {}

  /** Active key id, configured key ids and value counts per key id, for every purpose. */
  @Get()
  status() {
    return this.keys.status();
  }

  /** Runs the ENCRYPTION_KEY_ROTATION job now (optionally for one purpose). */
  @HttpCode(200)
  @Post('rotate')
  rotate(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(rotateKeysSchema)) body: RotateKeysInput,
    @Req() req: Request,
  ) {
    return this.keys.rotateNow(auth, body.purpose, req);
  }
}
