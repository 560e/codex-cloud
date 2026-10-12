export function moneyUnit(unit?: string) {
  return unit?.trim().toUpperCase() === 'USD' ? '$' : unit || '';
}
export function formatMoney(value?: number, digits?: number) {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString(
    'en-US',
    digits === undefined
      ? { maximumFractionDigits: 20 }
      : { minimumFractionDigits: digits, maximumFractionDigits: digits },
  );
}
// Subtract the reported decimal values without binary floating-point tails.
export function balanceDifference(before?: number, after?: number) {
  if (
    before === undefined ||
    after === undefined ||
    !Number.isFinite(before) ||
    !Number.isFinite(after)
  )
    return undefined;
  function decimal(value: number) {
    const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
    const [whole, fraction = ''] = mantissa.split('.');
    return { integer: BigInt(whole + fraction), scale: fraction.length - Number(exponent) };
  }
  const a = decimal(before),
    b = decimal(after),
    scale = Math.max(a.scale, b.scale, 0);
  const delta =
    a.integer * 10n ** BigInt(scale - a.scale) - b.integer * 10n ** BigInt(scale - b.scale);
  if (delta < 0n) return undefined;
  const digits = delta.toString().padStart(scale + 1, '0');
  const result = Number(scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits);
  return Number.isFinite(result) ? result : undefined;
}
