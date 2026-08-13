/**
 * Money rules (`architecture.md` §4.4). All money is INTEGER paise; tax is
 * INTEGER percent. Tax truncates — never banker's rounding, never round-up.
 */
export function computeTaxAmountPaise(unitPricePaise: number, quantity: number, taxRatePct: number): number {
  return Math.floor((unitPricePaise * quantity * taxRatePct) / 100);
}

export function computeLineTotalPaise(unitPricePaise: number, quantity: number, taxRatePct: number): number {
  const subtotalPaise = unitPricePaise * quantity;
  return subtotalPaise + computeTaxAmountPaise(unitPricePaise, quantity, taxRatePct);
}
