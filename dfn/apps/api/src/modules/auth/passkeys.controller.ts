import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  passkeyAuthenticationOptionsSchema,
  passkeyAuthenticationVerifySchema,
  passkeyRegistrationOptionsSchema,
  passkeyRegistrationVerifySchema,
  passkeyRenameSchema,
  passkeyRevokeSchema,
  passkeyStepUpOptionsSchema,
  type PasskeyAuthenticationOptionsInput,
  type PasskeyAuthenticationVerifyInput,
  type PasskeyRegistrationOptionsInput,
  type PasskeyRegistrationVerifyInput,
  type PasskeyRenameInput,
  type PasskeyRevokeInput,
  type PasskeyStepUpOptionsInput,
} from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AllowPreMfa, Public } from '../../common/decorators/public.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { UsersService } from '../users/users.service';
import { PasskeysService } from './passkeys.service';
import { SessionService } from './session.service';

/**
 * Passkeys (WebAuthn). Registration, listing, renaming and revocation need a fully verified
 * session; passwordless login is public and rate limited; the STEP_UP challenge, issued for one
 * operation (and resource), is also available before the login MFA step so a passkey can complete it.
 */
@ApiTags('auth')
@Controller('v1/auth/passkeys')
export class PasskeysController {
  constructor(
    private readonly passkeys: PasskeysService,
    private readonly sessions: SessionService,
    private readonly users: UsersService,
  ) {}

  @Get()
  list(@CurrentUser() auth: AuthContext) {
    return this.passkeys.list(auth);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('registration/options')
  registrationOptions(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(passkeyRegistrationOptionsSchema)) body: PasskeyRegistrationOptionsInput,
    @Req() req: Request,
  ) {
    return this.passkeys.registrationOptions(auth, body, req);
  }

  @Post('registration/verify')
  registrationVerify(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(passkeyRegistrationVerifySchema)) body: PasskeyRegistrationVerifyInput,
    @Req() req: Request,
  ) {
    return this.passkeys.registrationVerify(auth, body, req);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('authentication/options')
  authenticationOptions(
    // Validated then deliberately ignored: the answer must not depend on the account.
    @Body(zodBody(passkeyAuthenticationOptionsSchema)) _body: PasskeyAuthenticationOptionsInput,
  ) {
    return this.passkeys.authenticationOptions();
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('authentication/verify')
  async authenticationVerify(
    @Body(zodBody(passkeyAuthenticationVerifySchema)) body: PasskeyAuthenticationVerifyInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, token } = await this.passkeys.authenticationVerify(body.response, req);
    this.sessions.setCookie(res, token);
    return { user: await this.users.me(user.id), mfaRequired: false };
  }

  @AllowPreMfa()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Post('step-up/options')
  stepUpOptions(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(passkeyStepUpOptionsSchema)) body: PasskeyStepUpOptionsInput,
  ) {
    return this.passkeys.stepUpOptions(auth, body);
  }

  @Patch(':id')
  rename(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(passkeyRenameSchema)) body: PasskeyRenameInput,
    @Req() req: Request,
  ) {
    return this.passkeys.rename(auth, id, body.name, req);
  }

  @HttpCode(200)
  @Delete(':id')
  revoke(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(passkeyRevokeSchema)) body: PasskeyRevokeInput,
    @Req() req: Request,
  ) {
    return this.passkeys.revoke(auth, id, body ?? {}, req);
  }
}
