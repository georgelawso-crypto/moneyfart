// Betfair minimum bet rules per account currency. A LIMIT bet below the minimum stake is
// still accepted when stake x price reaches the minimum payout (not on .it/.es exchanges).
// Values follow betfairlightweight's currency_parameters (GBP minimum stake is 1 since Feb 2022).

export interface CurrencyRules {
  currency: string;
  minBetSize: number;
  minBetPayout?: number;
}

const RULES: Record<string, Omit<CurrencyRules, "currency">> = {
  GBP: { minBetSize: 1, minBetPayout: 10 },
  EUR: { minBetSize: 1, minBetPayout: 20 },
  USD: { minBetSize: 3, minBetPayout: 20 },
  AUD: { minBetSize: 5, minBetPayout: 30 },
  CAD: { minBetSize: 6, minBetPayout: 30 },
  HKD: { minBetSize: 10, minBetPayout: 125 },
  DKK: { minBetSize: 30, minBetPayout: 150 },
  NOK: { minBetSize: 30, minBetPayout: 150 },
  SEK: { minBetSize: 30, minBetPayout: 150 },
  SGD: { minBetSize: 6, minBetPayout: 30 },
};

export function currencyRules(currency: string, overrides: { minBetSize?: number; minBetPayout?: number } = {}): CurrencyRules {
  const code = currency.toUpperCase();
  const base = RULES[code] ?? { minBetSize: 1, minBetPayout: undefined };
  return {
    currency: code,
    minBetSize: overrides.minBetSize ?? base.minBetSize,
    minBetPayout: overrides.minBetPayout ?? base.minBetPayout,
  };
}

/** Undefined when the bet size is acceptable, otherwise a human-readable reason. */
export function betSizeProblem(size: number, price: number, rules: CurrencyRules): string | undefined {
  if (!(size >= 0.01)) return "Stake rounds to zero.";
  if (size + 1e-9 >= rules.minBetSize) return undefined;
  if (rules.minBetPayout !== undefined && size * price + 1e-9 >= rules.minBetPayout) return undefined;
  const payout = rules.minBetPayout !== undefined ? ` and payout ${(size * price).toFixed(2)} is below ${rules.minBetPayout}` : "";
  return `Stake ${size} is below Betfair's minimum ${rules.minBetSize} ${rules.currency}${payout} (INVALID_BET_SIZE).`;
}
