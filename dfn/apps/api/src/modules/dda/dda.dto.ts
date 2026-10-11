import type { DigitalAssetSimulation } from '@dfn/database';
import { moneyDto } from '../../common/serialize';
import { DDA, DDA_RESERVE_CURRENCY } from './dda.constants';

export interface OrganizationRef {
  id: string;
  name: string;
  type: 'PERSONAL' | 'BUSINESS';
}

export interface UserRef {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

export type DdaOperationRow = DigitalAssetSimulation & {
  organization: OrganizationRef | null;
  counterparty: OrganizationRef | null;
  createdBy: UserRef | null;
};

export const DDA_OPERATION_INCLUDE = {
  organization: { select: { id: true, name: true, type: true } },
  counterparty: { select: { id: true, name: true, type: true } },
  createdBy: { select: { id: true, email: true, firstName: true, lastName: true } },
} as const;

/**
 * Wire format of a simulated operation. Reserve adjustments are platform-level: the organisation
 * stored on the row is only the booking workspace of the acting admin (schema requires one), so it
 * is not exposed as the operation's organisation.
 */
export function ddaOperationDto(row: DdaOperationRow) {
  const platformScoped = row.operation === 'RESERVE_ADJUSTMENT';
  return {
    id: row.id,
    reference: row.reference,
    operation: row.operation,
    status: row.status,
    scope: platformScoped ? ('PLATFORM' as const) : ('ORGANIZATION' as const),
    units: moneyDto(row.unitsMinor, DDA),
    reserveDeltaUsd: moneyDto(row.reserveDeltaUsdMinor, DDA_RESERVE_CURRENCY),
    organization: platformScoped ? null : row.organization,
    counterparty: row.counterparty,
    createdBy: row.createdBy,
    ledgerTransactionId: row.ledgerTransactionId,
    note: row.note,
    metadata: row.metadata,
    createdAt: row.createdAt,
    simulated: true as const,
  };
}
export type DdaOperationDto = ReturnType<typeof ddaOperationDto>;
