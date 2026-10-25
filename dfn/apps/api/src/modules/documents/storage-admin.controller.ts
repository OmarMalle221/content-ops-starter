import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Permission, storageMigrationRunSchema, type StorageMigrationRunInput } from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { StorageAdminService } from './storage-admin.service';

/** Document storage console — platform ADMIN only (Permission.ADMIN_KEYS), like the key ring. */
@ApiTags('admin')
@RequirePermission(Permission.ADMIN_KEYS)
@Controller('v1/admin/storage')
export class StorageAdminController {
  constructor(private readonly storage: StorageAdminService) {}

  /** Blobs per driver, scan verdicts, retained / purgeable / purged blobs, pending migration. */
  @Get()
  status() {
    return this.storage.status();
  }

  /** Runs STORAGE_MIGRATION now; `dryRun: true` only verifies the pending local blobs. */
  @HttpCode(200)
  @Post('migration')
  migrate(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(storageMigrationRunSchema)) body: StorageMigrationRunInput,
    @Req() req: Request,
  ) {
    return this.storage.migrate(auth, body.dryRun, req);
  }
}
