/** Persisted state of a running strategy bot (owned by the bot runner; stored by State). */
export interface BotState {
  id: string;
  strategyName: string;
  template: string;
  marketId: string;
  selectionId: number;
  handicap: number;
  createdAt: string;
  updatedAt: string;
  status: "running" | "finished" | "stopped" | "failed";
  /** Normalised template parameters the bot runs with. */
  parameters: Record<string, unknown>;
  /** Bets placed by this bot (entry, close, hedge...). */
  betIds: string[];
  log: Array<{ at: string; message: string }>;
  /** Runner-specific bookkeeping (phase, best price seen, entry details...). */
  meta?: Record<string, unknown>;
}
