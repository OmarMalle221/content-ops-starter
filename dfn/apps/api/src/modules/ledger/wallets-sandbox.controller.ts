import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { sandboxSelfDepositSchema, type SandboxSelfDepositInput } from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { WalletsService } from './wallets.service';

/**
 * Self-service sandbox funding of an organisation wallet. Sandbox only: the credited units are
 * fictitious and come from the simulated partner settlement account, under a daily cap.
 */
@ApiTags('sandbox')
@Controller('v1/sandbox/wallets')
export class WalletsSandboxController {
  constructor(private readonly wallets: WalletsService) {}

  @Post('self-deposit')
  @HttpCode(200)
  selfDeposit(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(sandboxSelfDepositSchema)) body: SandboxSelfDepositInput,
    @Req() req: Request,
  ) {
    return this.wallets.selfDeposit(auth, body, req);
  }
}
