import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { securityPreferencesSchema, type SecurityPreferencesInput } from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { SecurityPreferencesService } from './security-preferences.service';

/** Per-user security preferences for simulated transfers (MFA step-up, alerts, daily limit). */
@ApiTags('users')
@Controller('v1/users/me/security-preferences')
export class SecurityPreferencesController {
  constructor(private readonly preferences: SecurityPreferencesService) {}

  @Get()
  get(@CurrentUser() auth: AuthContext) {
    return this.preferences.get(auth);
  }

  @Put()
  update(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(securityPreferencesSchema)) body: SecurityPreferencesInput,
    @Req() req: Request,
  ) {
    return this.preferences.update(auth, body, req);
  }
}
