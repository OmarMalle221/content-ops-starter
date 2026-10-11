import { DDA_CODE, SIMULATED_ASSETS } from '@dfn/shared';

/**
 * Diaspora Digital Asset (DDA) — strictly internal research sandbox.
 *
 * Red lines enforced by this module (see docs/architecture/DDA_SIMULATION.md and
 * docs/compliance/STABLECOIN_RISKS.md):
 *  - no public blockchain, no token, no real money;
 *  - no conversion of DDA into fiat or any other asset (the fiat ledger is never touched);
 *  - no exposure to non-admin users (Permission.ADMIN_DDA only);
 *  - the parity 1 DDA = 1 USD is a HYPOTHESIS UNDER STUDY, never a guarantee.
 */
export const DDA = DDA_CODE;
export const DDA_DEFINITION = SIMULATED_ASSETS[DDA_CODE];
export const DDA_RESERVE_CURRENCY = 'USD';

export const DDA_HYPOTHESIS = '1 DDA = 1 USD (hypothèse — non garantie)';

export const DDA_DISCLAIMER_FR =
  'Simulation de recherche — unités fictives — parité 1 DDA = 1 USD non garantie — aucune émission réelle — aucun fonds réel';
export const DDA_DISCLAIMER_EN =
  'Research simulation — fictitious units — 1 DDA = 1 USD parity not guaranteed — no real issuance — no real funds';

/** Metadata attached to every ledger posting, simulation row and audit entry of the module. */
export const DDA_METADATA = { simulated: true, hypothesis: '1 DDA = 1 USD (non garantie)' } as const;

export interface DdaEnvelope {
  simulated: true;
  disclaimer: string;
  disclaimerEn: string;
  hypothesis: string;
}

/** Every DDA response carries the simulation envelope. */
export function ddaEnvelope<T extends object>(payload: T): T & DdaEnvelope {
  return {
    ...payload,
    simulated: true,
    disclaimer: DDA_DISCLAIMER_FR,
    disclaimerEn: DDA_DISCLAIMER_EN,
    hypothesis: DDA_HYPOTHESIS,
  };
}
