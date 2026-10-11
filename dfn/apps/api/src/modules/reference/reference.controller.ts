import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CORRIDORS,
  COUNTRIES,
  CURRENCIES,
  DocumentKind,
  SANDBOX_DISCLAIMER,
  TransactionCategory,
} from '@dfn/shared';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('reference')
@Controller('v1/reference')
export class ReferenceController {
  @Public()
  @Get()
  reference() {
    return {
      mode: 'sandbox',
      disclaimer: SANDBOX_DISCLAIMER,
      currencies: Object.values(CURRENCIES),
      countries: Object.values(COUNTRIES),
      corridors: CORRIDORS,
      categories: Object.values(TransactionCategory),
      documentKinds: Object.values(DocumentKind),
    };
  }
}
