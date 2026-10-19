// Subset of the Betfair Exchange API (SportsAPING / AccountAPING v1.0) used by the connector.

export type Side = "BACK" | "LAY";
export type PersistenceType = "LAPSE" | "PERSIST" | "MARKET_ON_CLOSE";
export type MarketStatus = "INACTIVE" | "OPEN" | "SUSPENDED" | "CLOSED";
export type RunnerStatus = "ACTIVE" | "WINNER" | "LOSER" | "PLACED" | "REMOVED_VACANT" | "REMOVED" | "HIDDEN";
export type PriceData = "SP_AVAILABLE" | "SP_TRADED" | "EX_BEST_OFFERS" | "EX_ALL_OFFERS" | "EX_TRADED";

export interface TimeRange {
  from?: string;
  to?: string;
}

export interface MarketFilter {
  textQuery?: string;
  eventTypeIds?: string[];
  eventIds?: string[];
  competitionIds?: string[];
  marketIds?: string[];
  venues?: string[];
  marketCountries?: string[];
  marketTypeCodes?: string[];
  marketStartTime?: TimeRange;
  inPlayOnly?: boolean;
  turnInPlayEnabled?: boolean;
}

export interface EventType {
  id: string;
  name: string;
}

export interface EventTypeResult {
  eventType: EventType;
  marketCount: number;
}

export interface Event {
  id: string;
  name: string;
  countryCode?: string;
  timezone?: string;
  venue?: string;
  openDate?: string;
}

export interface RunnerCatalog {
  selectionId: number;
  runnerName: string;
  handicap: number;
  sortPriority: number;
  metadata?: Record<string, string | null>;
}

export interface MarketCatalogue {
  marketId: string;
  marketName: string;
  marketStartTime?: string;
  description?: {
    persistenceEnabled?: boolean;
    bspMarket?: boolean;
    marketTime?: string;
    suspendTime?: string;
    bettingType?: string;
    turnInPlayEnabled?: boolean;
    marketType?: string;
    regulator?: string;
    marketBaseRate?: number;
    discountAllowed?: boolean;
    raceType?: string;
    eachWayDivisor?: number;
    priceLadderDescription?: { type: "CLASSIC" | "FINEST" | "LINE_RANGE" };
    lineRangeInfo?: { maxUnitValue: number; minUnitValue: number; interval: number; marketUnit: string };
  };
  totalMatched?: number;
  runners?: RunnerCatalog[];
  eventType?: EventType;
  competition?: { id: string; name: string };
  event?: Event;
}

export interface PriceSize {
  price: number;
  size: number;
}

export interface StartingPrices {
  nearPrice?: number;
  farPrice?: number;
  backStakeTaken?: PriceSize[];
  layLiabilityTaken?: PriceSize[];
  actualSP?: number;
}

export interface ExchangePrices {
  availableToBack?: PriceSize[];
  availableToLay?: PriceSize[];
  tradedVolume?: PriceSize[];
}

export interface Order {
  betId: string;
  orderType: string;
  status: "PENDING" | "EXECUTION_COMPLETE" | "EXECUTABLE" | "EXPIRED";
  persistenceType: PersistenceType;
  side: Side;
  price: number;
  size: number;
  bspLiability?: number;
  placedDate: string;
  avgPriceMatched?: number;
  sizeMatched?: number;
  sizeRemaining?: number;
  sizeLapsed?: number;
  sizeCancelled?: number;
  sizeVoided?: number;
}

export interface Runner {
  selectionId: number;
  handicap: number;
  status: RunnerStatus;
  adjustmentFactor?: number;
  lastPriceTraded?: number;
  totalMatched?: number;
  removalDate?: string;
  sp?: StartingPrices;
  ex?: ExchangePrices;
  orders?: Order[];
}

export interface MarketBook {
  marketId: string;
  isMarketDataDelayed: boolean;
  status: MarketStatus;
  betDelay?: number;
  bspReconciled?: boolean;
  complete?: boolean;
  inplay?: boolean;
  numberOfWinners?: number;
  numberOfRunners?: number;
  numberOfActiveRunners?: number;
  lastMatchTime?: string;
  totalMatched?: number;
  totalAvailable?: number;
  crossMatching?: boolean;
  runnersVoidable?: boolean;
  version?: number;
  keyLineDescription?: { keyLine: Array<{ selectionId: number; handicap: number }> };
  runners: Runner[];
}

export interface PriceProjection {
  priceData?: PriceData[];
  exBestOffersOverrides?: { bestPricesDepth?: number };
  virtualise?: boolean;
}

export interface PlaceInstruction {
  orderType: "LIMIT";
  selectionId: number;
  handicap?: number;
  side: Side;
  limitOrder: {
    size: number;
    price: number;
    persistenceType: PersistenceType;
  };
  customerOrderRef?: string;
}

export interface PlaceInstructionReport {
  status: "SUCCESS" | "FAILURE" | "TIMEOUT";
  errorCode?: string;
  orderStatus?: "PENDING" | "EXECUTION_COMPLETE" | "EXECUTABLE" | "EXPIRED";
  instruction: PlaceInstruction;
  betId?: string;
  placedDate?: string;
  averagePriceMatched?: number;
  sizeMatched?: number;
}

export interface PlaceExecutionReport {
  customerRef?: string;
  status: "SUCCESS" | "FAILURE" | "PROCESSED_WITH_ERRORS" | "TIMEOUT";
  errorCode?: string;
  marketId: string;
  instructionReports?: PlaceInstructionReport[];
}

export interface CancelInstruction {
  betId: string;
  sizeReduction?: number;
}

export interface CancelExecutionReport {
  status: "SUCCESS" | "FAILURE" | "PROCESSED_WITH_ERRORS" | "TIMEOUT";
  errorCode?: string;
  marketId: string;
  instructionReports?: Array<{
    status: "SUCCESS" | "FAILURE" | "TIMEOUT";
    errorCode?: string;
    instruction: CancelInstruction;
    sizeCancelled?: number;
    cancelledDate?: string;
  }>;
}

export interface CurrentOrderSummary {
  betId: string;
  marketId: string;
  selectionId: number;
  handicap: number;
  priceSize: PriceSize;
  bspLiability?: number;
  side: Side;
  status: "PENDING" | "EXECUTION_COMPLETE" | "EXECUTABLE" | "EXPIRED";
  persistenceType: PersistenceType;
  orderType: string;
  placedDate: string;
  matchedDate?: string;
  averagePriceMatched?: number;
  sizeMatched?: number;
  sizeRemaining?: number;
  sizeLapsed?: number;
  sizeCancelled?: number;
  sizeVoided?: number;
  customerStrategyRef?: string;
  customerOrderRef?: string;
}

export interface CurrentOrderSummaryReport {
  currentOrders: CurrentOrderSummary[];
  moreAvailable: boolean;
}

export interface ClearedOrderSummary {
  eventTypeId?: string;
  eventId?: string;
  marketId?: string;
  selectionId?: number;
  handicap?: number;
  betId?: string;
  placedDate?: string;
  persistenceType?: PersistenceType;
  orderType?: string;
  side?: Side;
  itemDescription?: {
    eventTypeDesc?: string;
    eventDesc?: string;
    marketDesc?: string;
    marketType?: string;
    marketStartTime?: string;
    runnerDesc?: string;
    numberOfWinners?: number;
  };
  betOutcome?: string;
  priceRequested?: number;
  settledDate?: string;
  lastMatchedDate?: string;
  betCount?: number;
  commission?: number;
  priceMatched?: number;
  priceReduced?: boolean;
  sizeSettled?: number;
  profit?: number;
  sizeCancelled?: number;
  customerOrderRef?: string;
  customerStrategyRef?: string;
}

export interface ClearedOrderSummaryReport {
  clearedOrders: ClearedOrderSummary[];
  moreAvailable: boolean;
}

export interface AccountFunds {
  availableToBetBalance: number;
  exposure: number;
  retainedCommission: number;
  exposureLimit: number;
  discountRate?: number;
  pointsBalance?: number;
  wallet?: string;
}

export interface AccountDetails {
  currencyCode: string;
  firstName?: string;
  lastName?: string;
  localeCode?: string;
  region?: string;
  timezone?: string;
  discountRate?: number;
  pointsBalance?: number;
  countryCode?: string;
}
