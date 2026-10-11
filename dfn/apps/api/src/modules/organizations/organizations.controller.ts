import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import {
  createCounterpartySchema,
  createOrganizationSchema,
  inviteMemberSchema,
  submitBusinessVerificationSchema,
  updateMemberRoleSchema,
  type CreateOrganizationInput,
  type InviteMemberInput,
  type SubmitBusinessVerificationInput,
} from '@dfn/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthContext } from '../../common/auth-context';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { OrganizationsService } from './organizations.service';

const acceptSchema = z.object({ token: z.string().min(16).max(256) });

@ApiTags('organizations')
@Controller('v1/organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  list(@CurrentUser() auth: AuthContext) {
    return this.organizations.listMine(auth);
  }

  @Post()
  create(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(createOrganizationSchema)) body: CreateOrganizationInput,
    @Req() req: Request,
  ) {
    return this.organizations.createBusiness(auth, body, req);
  }

  @Post('invitations/accept')
  acceptInvitation(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(acceptSchema)) body: { token: string },
    @Req() req: Request,
  ) {
    return this.organizations.acceptMemberInvitation(auth, body.token, req);
  }

  @Get(':id')
  get(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.organizations.get(auth, id);
  }

  @Post(':id/members/invite')
  invite(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(inviteMemberSchema)) body: InviteMemberInput,
    @Req() req: Request,
  ) {
    return this.organizations.inviteMember(auth, id, body, req);
  }

  @Patch(':id/members/:memberId')
  updateRole(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body(zodBody(updateMemberRoleSchema)) body: { role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' },
    @Req() req: Request,
  ) {
    return this.organizations.updateMemberRole(auth, id, memberId, body.role, req);
  }

  @Delete(':id/members/:memberId')
  remove(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Req() req: Request,
  ) {
    return this.organizations.removeMember(auth, id, memberId, req);
  }

  @Post(':id/verification')
  verify(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(submitBusinessVerificationSchema)) body: SubmitBusinessVerificationInput,
    @Req() req: Request,
  ) {
    return this.organizations.submitBusinessVerification(auth, id, body, req);
  }

  @Get(':id/counterparties')
  counterparties(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.organizations.listCounterparties(auth, id);
  }

  @Post(':id/counterparties')
  createCounterparty(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(createCounterpartySchema)) body: z.infer<typeof createCounterpartySchema>,
    @Req() req: Request,
  ) {
    return this.organizations.createCounterparty(auth, id, body, req);
  }
}
