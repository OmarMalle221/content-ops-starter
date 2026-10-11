import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { submitIdentityVerificationSchema, type SubmitIdentityVerificationInput } from '@dfn/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthContext } from '../../common/auth-context';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { VerificationsService } from './verifications.service';

@ApiTags('verifications')
@Controller('v1/verifications')
export class VerificationsController {
  constructor(private readonly verifications: VerificationsService) {}

  @Get('identity')
  list(@CurrentUser() auth: AuthContext) {
    return this.verifications.listMine(auth);
  }

  @Post('identity')
  submit(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(submitIdentityVerificationSchema)) body: SubmitIdentityVerificationInput,
    @Req() req: Request,
  ) {
    return this.verifications.submitIdentity(auth, body, req);
  }
}
