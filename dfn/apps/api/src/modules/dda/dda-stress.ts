/**
 * Pure arithmetic of the DDA research sandbox (BigInt minor units, no floating point on money).
 * DDA and USD both have exponent 2, so 1 unit minor of DDA maps to 1 cent of simulated USD under
 * the parity hypothesis (1 DDA = 1 USD — never guaranteed).
 */

export const BPS_SCALE = 10_000n;

/** Coverage ratio in basis points: simulated reserve ÷ supply. `null` when nothing is in circulation. */
export function coverageRatioBps(supplyMinor: bigint, reserveUsdMinor: bigint): number | null {
  if (supplyMinor <= 0n) return null;
  const reserve = reserveUsdMinor < 0n ? 0n : reserveUsdMinor;
  return Number((reserve * BPS_SCALE) / supplyMinor);
}

/** 12.5 % → 1250 bps (two decimals of precision, clamped to 0–100 %). */
export function percentToBps(percent: number): bigint {
  if (!Number.isFinite(percent)) return 0n;
  const clamped = Math.min(100, Math.max(0, percent));
  // Decimal (not binary) rounding: 33.335 % must give 3 334 bps, not 3 333 (33.335 * 100 is
  // 3333.4999… in IEEE-754). Render as a fixed decimal string, then round half-up in integers.
  const [intPart, fracPart = ''] = clamped.toFixed(6).split('.');
  const frac = (fracPart + '000').slice(0, 3);
  const bps = BigInt(intPart!) * 100n + BigInt(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1n : 0n);
  return bps > 10_000n ? 10_000n : bps;
}

export interface StressTestInput {
  supplyMinor: bigint;
  reserveUsdMinor: bigint;
  redemptionPercent: number;
  reserveHaircutPercent: number;
}

export type StressVerdict = 'COVERED' | 'SHORTFALL';

export interface StressTestResult {
  redemptionBps: number;
  reserveHaircutBps: number;
  redeemedUnitsMinor: bigint;
  remainingSupplyMinor: bigint;
  reserveAfterHaircutMinor: bigint;
  reserveAfterRedemptionsMinor: bigint;
  shortfallUsdMinor: bigint;
  coverageBeforeBps: number | null;
  coverageAfterBps: number | null;
  verdict: StressVerdict;
  notes: string[];
}

/**
 * De-peg / liquidity stress scenario:
 *  1. a share of the supply is redeemed at par (hypothesis 1 DDA = 1 USD);
 *  2. the simulated reserve first suffers a haircut (loss of value / illiquidity of reserve assets);
 *  3. redemptions are served from the reserve after haircut;
 *  4. the shortfall is the part of the redemptions the reserve cannot honour.
 * Pure function: never touches the database, never moves anything.
 */
export function runStressTest(input: StressTestInput): StressTestResult {
  const redemptionBps = percentToBps(input.redemptionPercent);
  const haircutBps = percentToBps(input.reserveHaircutPercent);
  const supply = input.supplyMinor < 0n ? 0n : input.supplyMinor;
  const reserve = input.reserveUsdMinor < 0n ? 0n : input.reserveUsdMinor;

  const redeemed = (supply * redemptionBps) / BPS_SCALE;
  const remaining = supply - redeemed;
  const reserveAfterHaircut = (reserve * (BPS_SCALE - haircutBps)) / BPS_SCALE;
  const reserveAfterRedemptions = reserveAfterHaircut - redeemed;
  const shortfall = reserveAfterRedemptions < 0n ? -reserveAfterRedemptions : 0n;
  const verdict: StressVerdict = shortfall > 0n ? 'SHORTFALL' : 'COVERED';

  const notes: string[] = [
    'Hypothèse de parité 1 DDA = 1 USD — non garantie ; aucun marché secondaire n’existe (aucun jeton public).',
    'Réserve et unités sont fictives : le résultat est une analyse de recherche, pas une attestation de couverture.',
  ];
  if (supply === 0n) notes.push('Aucune unité fictive en circulation : le scénario est vide.');
  if (haircutBps > 0n)
    notes.push(
      `Décote de ${formatBps(haircutBps)} % appliquée à la réserve simulée avant de servir les rachats.`,
    );
  if (redemptionBps > 0n)
    notes.push(
      `Rachat de ${formatBps(redemptionBps)} % de l’encours servi au pair depuis la réserve simulée.`,
    );
  if (verdict === 'SHORTFALL')
    notes.push(
      'Déficit : la réserve simulée ne couvre pas les rachats du scénario — un tel scénario imposerait des délais de rachat contractuels, une réserve plus liquide ou une couverture supérieure à 100 %.',
    );
  else if (supply > 0n)
    notes.push('Couvert : la réserve simulée après décote absorbe les rachats du scénario.');

  return {
    redemptionBps: Number(redemptionBps),
    reserveHaircutBps: Number(haircutBps),
    redeemedUnitsMinor: redeemed,
    remainingSupplyMinor: remaining,
    reserveAfterHaircutMinor: reserveAfterHaircut,
    reserveAfterRedemptionsMinor: reserveAfterRedemptions,
    shortfallUsdMinor: shortfall,
    coverageBeforeBps: coverageRatioBps(supply, reserve),
    coverageAfterBps: coverageRatioBps(remaining, reserveAfterRedemptions),
    verdict,
    notes,
  };
}

function formatBps(bps: bigint): string {
  const whole = bps / 100n;
  const frac = bps % 100n;
  return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(2, '0').replace(/0$/, '')}`;
}
