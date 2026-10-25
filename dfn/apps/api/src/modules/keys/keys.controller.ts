import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  Permission,
  generateManagedKeySchema,
  keyPurposeSchema,
  managedKeyIdSchema,
  rotateKeysSchema,
  retireManagedKeySchema,
  type GenerateManagedKeyInput,
  type KeyPurpose,
  type RetireManagedKeyInput,
  type RotateKeysInput,
} from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { KeyLifecycleService } from './key-lifecycle.service';
import { KeysService } from './keys.service';

/** Key ring console — platform ADMIN only (Permission.ADMIN_KEYS). */
@ApiTags('admin')
@RequirePermission(Permission.ADMIN_KEYS)
@Controller('v1/admin/keys')
export class KeysController {
  constructor(
    private readonly keys: KeysService,
    private readonly lifecycle: KeyLifecycleService,
  ) {}

  /**
   * Active key id, configured key ids and value counts per key id, KMS-managed keys and their
   * lifecycle, legacy-key usage, for every purpose. Never any key material.
   */
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

  /** Stages a new KMS-managed data key (activated by KEY_LIFECYCLE after the activation delay). */
  @HttpCode(201)
  @Post(':purpose/generate')
  generate(
    @CurrentUser() auth: AuthContext,
    @Param('purpose', zodBody(keyPurposeSchema)) purpose: KeyPurpose,
    @Body(zodBody(generateManagedKeySchema)) body: GenerateManagedKeyInput,
    @Req() req: Request,
  ) {
    return this.lifecycle.generate(auth, purpose, body, req);
  }

  /** DECRYPT_ONLY → RETIRED, once nothing references the key any more. */
  @HttpCode(200)
  @Post(':purpose/:keyId/retire')
  retire(
    @CurrentUser() auth: AuthContext,
    @Param('purpose', zodBody(keyPurposeSchema)) purpose: KeyPurpose,
    @Param('keyId', zodBody(managedKeyIdSchema)) keyId: string,
    @Body(zodBody(retireManagedKeySchema)) body: RetireManagedKeyInput,
    @Req() req: Request,
  ) {
    return this.lifecycle.retire(auth, purpose, keyId, body, req);
  }
}
