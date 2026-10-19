/** HH:MM:SS in UTC. */
export function clock(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(11, 19);
}

/** "in 45s" / "12s ago". */
export function relative(unixSeconds: number, now: number): string {
  const d = unixSeconds - now;
  return d >= 0 ? `in ${d}s` : `${-d}s ago`;
}

export function money(x: number): string {
  return x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function signedMoney(x: number): string {
  return `${x >= 0 ? '+' : '-'}${money(Math.abs(x))}`;
}

/** Decimal places needed to write multiples of `step` exactly (50 → 0, 2.5 → 1, 0.05 → 2). */
export function decimalsFor(step: number): number {
  for (let d = 0; d < 10; d++) {
    const scaled = step * 10 ** d;
    if (Math.abs(Math.round(scaled) - scaled) < 1e-6) return d;
  }
  return 10;
}

export function num(x: number, decimals: number): string {
  return x.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Two significant figures, for volatility readouts. */
export function approx(x: number): string {
  return Number(x.toPrecision(2)).toLocaleString('en-US', { maximumFractionDigits: 10 });
}

export function percent(p: number): string {
  if (p > 0 && p < 0.001) return '<0.1%';
  return `${(p * 100).toFixed(1)}%`;
}
