import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { updateProfileSchema, type UpdateProfileInput } from '@dfn/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthContext } from '../../common/auth-context';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { UsersService } from './users.service';

@ApiTags('users')
@Controller('v1/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  me(@CurrentUser() auth: AuthContext) {
    return this.users.me(auth.userId);
  }

  @Patch('me')
  update(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(updateProfileSchema)) body: UpdateProfileInput,
    @Req() req: Request,
  ) {
    return this.users.updateProfile(auth, body, req);
  }
}
