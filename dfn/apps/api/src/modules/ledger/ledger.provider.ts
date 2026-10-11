import { LedgerService } from '@dfn/financial-ledger';
import { PrismaService } from '../../common/prisma/prisma.service';

export const LEDGER = 'LEDGER';
export const ledgerProvider = {
  provide: LEDGER,
  useFactory: (prisma: PrismaService) => new LedgerService(prisma),
  inject: [PrismaService],
};
