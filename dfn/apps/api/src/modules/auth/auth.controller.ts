import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  changePasswordSchema,
  loginSchema,
  mfaEnableSchema,
  mfaVerifySchema,
  registerSchema,
  type LoginInput,
  type RegisterInput,
} from '@dfn/shared';
import { AllowPreMfa, Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthContext } from '../../common/auth-context';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { UsersService } from '../users/users.service';
import { TransactionsService } from '../transactions/transactions.service';

@ApiTags('auth')
@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly users: UsersService,
    private readonly transactions: TransactionsService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  async register(
    @Body(zodBody(registerSchema)) body: RegisterInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, token } = await this.auth.register(body, req);
    this.sessions.setCookie(res, token);
    if (body.invitationToken) {
      // Best effort: link the invitation to the freshly created account.
      await this.transactions
        .acceptInvitation(body.invitationToken, await this.users.authContextFor(user.id, req), req)
        .catch(() => undefined);
    }
    return { user: await this.users.me(user.id), mfaRequired: false };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login')
  async login(
    @Body(zodBody(loginSchema)) body: LoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, token, mfaRequired } = await this.auth.login(body, req);
    this.sessions.setCookie(res, token);
    return {
      user: mfaRequired ? { id: user.id, email: user.email } : await this.users.me(user.id),
      mfaRequired,
    };
  }

  @AllowPreMfa()
  @HttpCode(200)
  @Post('logout')
  async logout(
    @CurrentUser() auth: AuthContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(auth, req);
    this.sessions.clearCookie(res);
    return { loggedOut: true };
  }

  @AllowPreMfa()
  @Get('me')
  async me(@CurrentUser() auth: AuthContext) {
    if (auth.mfaEnabled && !auth.mfaVerified)
      return { mfaRequired: true, user: { id: auth.userId, email: auth.email } };
    return { mfaRequired: false, user: await this.users.me(auth.userId) };
  }

  @Post('mfa/setup')
  mfaSetup(@CurrentUser() auth: AuthContext) {
    return this.auth.mfaSetup(auth);
  }

  @Post('mfa/enable')
  mfaEnable(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(mfaEnableSchema)) body: { code: string },
    @Req() req: Request,
  ) {
    return this.auth.mfaEnable(auth, body.code, req);
  }

  @AllowPreMfa()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('mfa/verify')
  mfaVerify(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(mfaVerifySchema)) body: { code: string },
    @Req() req: Request,
  ) {
    return this.auth.mfaVerify(auth, body.code, req);
  }

  @Post('mfa/disable')
  mfaDisable(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(mfaEnableSchema)) body: { code: string },
    @Req() req: Request,
  ) {
    return this.auth.mfaDisable(auth, body.code, req);
  }

  @Post('password')
  changePassword(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(changePasswordSchema)) body: { currentPassword: string; newPassword: string },
    @Req() req: Request,
  ) {
    return this.auth.changePassword(auth, body.currentPassword, body.newPassword, req);
  }

  @Get('sessions')
  listSessions(@CurrentUser() auth: AuthContext) {
    return this.sessions.listForUser(auth.userId);
  }

  @HttpCode(200)
  @Post('sessions/revoke-others')
  async revokeOthers(@CurrentUser() auth: AuthContext) {
    await this.sessions.revokeAllForUser(auth.userId, auth.sessionId);
    return { revoked: true };
  }
}
