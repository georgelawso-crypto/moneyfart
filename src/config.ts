/** A tradable symbol and where its price comes from. */
export interface MarketSpec {
  symbol: string;
  name: string;
  source: 'pyth' | 'simulated';
  /** Pyth price feed id (hex, no 0x prefix). Required when source is 'pyth'. */
  pythFeedId?: string;
  /**
   * Rough annualised volatility (0.5 = 50%). Sizes the price bands and acts as
   * the fallback / floor for the live volatility estimate.
   */
  annualVolatility: number;
  /** Starting price for simulated markets. */
  startPrice?: number;
}

export const MARKETS: MarketSpec[] = [
  {
    symbol: 'XAUUSD',
    name: 'Gold / US Dollar',
    source: 'pyth',
    pythFeedId: '765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2',
    annualVolatility: 0.18,
  },
  {
    symbol: 'BTCUSD',
    name: 'Bitcoin / US Dollar',
    source: 'pyth',
    pythFeedId: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
    annualVolatility: 0.5,
  },
  {
    symbol: 'ETHUSD',
    name: 'Ether / US Dollar',
    source: 'pyth',
    pythFeedId: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
    annualVolatility: 0.65,
  },
  {
    symbol: 'SOLUSD',
    name: 'Solana / US Dollar',
    source: 'pyth',
    pythFeedId: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    annualVolatility: 0.8,
  },
  {
    symbol: 'SIM',
    name: 'Simulated random walk, always open',
    source: 'simulated',
    annualVolatility: 0.6,
    startPrice: 100,
  },
];

export interface GameSettings {
  /** Length of each time window (one grid column), in seconds. Windows are back to back. */
  windowSeconds: number;
  /** How many upcoming windows are open for betting. */
  columns: number;
  /** How many price bands the grid shows per window, centred on the current price. */
  layers: number;
  /** Betting on a window closes this many seconds before the window opens. */
  betCloseSeconds: number;
  minBet: number;
  startingBalance: number;
  /** Fraction of fair odds the house keeps. Negative = player edge (simulation only). */
  houseEdge: number;
  minOdds: number;
  maxOdds: number;
  /** A price older than this is stale: betting pauses and bets settling on it are refunded. */
  staleAfterSeconds: number;
}

export const DEFAULT_SETTINGS: GameSettings = {
  windowSeconds: 30,
  columns: 8,
  layers: 9,
  betCloseSeconds: 10,
  minBet: 10,
  startingBalance: 10_000,
  houseEdge: -0.15, // player has +15% edge by construction (simulation only)
  minOdds: 1.01,
  maxOdds: 99,
  staleAfterSeconds: 15,
};

const SETTING_ENV: Record<keyof GameSettings, string> = {
  windowSeconds: 'WINDOW_SECONDS',
  columns: 'COLUMNS',
  layers: 'LAYERS',
  betCloseSeconds: 'BET_CLOSE_SECONDS',
  minBet: 'MIN_BET',
  startingBalance: 'STARTING_BALANCE',
  houseEdge: 'HOUSE_EDGE',
  minOdds: 'MIN_ODDS',
  maxOdds: 'MAX_ODDS',
  staleAfterSeconds: 'STALE_AFTER_SECONDS',
};

/** Default settings, overridden by any matching environment variables (e.g. WINDOW_SECONDS=60). */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): GameSettings {
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(SETTING_ENV) as (keyof GameSettings)[]) {
    const raw = env[SETTING_ENV[key]];
    if (raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new Error(`${SETTING_ENV[key]} must be a number, got "${raw}"`);
    }
    // A negative house edge is a player edge. Everything else stays non-negative.
    if (key === 'houseEdge') {
      if (value <= -1 || value >= 1) {
        throw new Error(`${SETTING_ENV[key]} must be between -1 and 1 (exclusive), got "${raw}"`);
      }
    } else if (value < 0) {
      throw new Error(`${SETTING_ENV[key]} must be a non-negative number, got "${raw}"`);
    }
    settings[key] = value;
  }
  return settings;
}

/** The markets to run: all of them, or the comma-separated symbols in `list` (e.g. "BTCUSD,SIM"). */
export function selectMarkets(list: string | undefined): MarketSpec[] {
  if (!list?.trim()) return MARKETS;
  const wanted = list.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const unknown = wanted.filter((s) => !MARKETS.some((m) => m.symbol === s));
  if (unknown.length > 0) {
    throw new Error(`Unknown market(s) in MARKETS: ${unknown.join(', ')}. Known: ${MARKETS.map((m) => m.symbol).join(', ')}`);
  }
  return MARKETS.filter((m) => wanted.includes(m.symbol));
}
