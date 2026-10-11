import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  createBeneficiarySchema,
  listBeneficiariesQuerySchema,
  type CreateBeneficiaryInput,
  type ListBeneficiariesQuery,
} from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { BeneficiariesService } from './beneficiaries.service';

/**
 * Beneficiaries of simulated transfers. Account identifiers are encrypted at rest and only a
 * masked form ever leaves the API. Access is scoped to the organisation (other tenants → 404).
 */
@ApiTags('beneficiaries')
@Controller('v1/beneficiaries')
export class BeneficiariesController {
  constructor(private readonly beneficiaries: BeneficiariesService) {}

  @Get()
  list(
    @CurrentUser() auth: AuthContext,
    @Query(zodBody(listBeneficiariesQuerySchema)) q: ListBeneficiariesQuery,
  ) {
    return this.beneficiaries.list(auth, q);
  }

  @Post()
  @HttpCode(201)
  create(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(createBeneficiarySchema)) body: CreateBeneficiaryInput,
    @Req() req: Request,
  ) {
    return this.beneficiaries.create(auth, body, req);
  }

  @Delete(':id')
  @HttpCode(200)
  remove(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.beneficiaries.remove(auth, id, req);
  }
}
