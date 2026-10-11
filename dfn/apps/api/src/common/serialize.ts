import { minorToDecimalString } from '@dfn/shared';

/** Convert a BigInt minor amount into the wire format { minor, decimal, currency }. */
export function moneyDto(amountMinor: bigint | null | undefined, currencyCode: string) {
  if (amountMinor === null || amountMinor === undefined) return null;
  return {
    minor: amountMinor.toString(),
    decimal: minorToDecimalString(amountMinor, currencyCode),
    currency: currencyCode,
  };
}

/** Install BigInt JSON serialisation once per process (minor units as strings). */
export function installBigIntJson() {
  const proto = BigInt.prototype as unknown as { toJSON?: () => string };
  if (!proto.toJSON) {
    Object.defineProperty(BigInt.prototype, 'toJSON', {
      value: function toJSON(this: bigint) {
        return this.toString();
      },
      configurable: true,
    });
  }
}
