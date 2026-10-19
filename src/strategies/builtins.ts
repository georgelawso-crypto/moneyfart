// Built-in strategy settings: the names the BetfairAiTrading prompt library calls.
// Stakes are in the account currency ("Euro" is part of BFExplorer's names only).

import { CLOSE, OPEN, TEMPLATE, findTemplate, normaliseParameters, parseParameters } from "./templates.js";
import type { StrategySetting } from "./types.js";

type Raw = Omit<StrategySetting, "builtIn">;

const tradeEntry = (betType: "Back" | "Lay", stake: number, stakeType: "Stake" | "Liability") => ({
  [`${OPEN}BetType`]: betType,
  [`${OPEN}Stake`]: stake,
  [`${OPEN}StakeType`]: stakeType,
  [`${OPEN}AtInPlayKeepBet`]: true,
  [`${OPEN}AllowPlacingBetInPlay`]: true,
});

const tradeExit = (type: "Percentage" | "Ticks", profit: number, loss: number, closeTime: string | null, extra: Record<string, unknown> = {}) => ({
  [`${CLOSE}ProfitLossType`]: type,
  [`${CLOSE}Profit`]: profit,
  [`${CLOSE}Loss`]: loss,
  [`${CLOSE}HedgingEnabled`]: true,
  [`${CLOSE}ClosePositionTimeSpan`]: closeTime,
  ...extra,
});

/** "Place Bet and Close Selection Bet Position" settings of the candlestick prompts: 10 at risk, 3 ticks profit, 30 ticks loss, flat 2 minutes before the off. */
function candlestickTrades(): Raw[] {
  const trades: Array<[string, "Back" | "Lay", string]> = [
    ["Back scalping strategy", "Back", "Breakout (steam) signal"],
    ["Back hedge strategy", "Back", "Value signal"],
    ["Conservative back strategy", "Back", "Moderate steam signal"],
    ["Technical back strategy", "Back", "Technical steam signal"],
    ["Lay fade strategy", "Lay", "False favourite signal"],
    ["Lay resistance trading", "Lay", "Resistance test signal"],
    ["Conservative lay strategy", "Lay", "Moderate drift signal"],
  ];
  return trades.map(([name, betType, signal]) => ({
    name,
    template: TEMPLATE.trade,
    parameters: { ...tradeEntry(betType, 10, betType === "Lay" ? "Liability" : "Stake"), ...tradeExit("Ticks", 3, 30, "-0:02:00") },
    description:
      `${signal}: ${betType === "Lay" ? "lay for a liability of 10" : "back 10"}, then green up at CloseBetPosition.Profit ticks profit (3) or CloseBetPosition.Loss ticks loss (30), ` +
      `or 2 minutes before the off. Prompts pass {"OpenBetPosition.Stake":N,"CloseBetPosition.Profit":N,"CloseBetPosition.Loss":N}${betType === "Lay" ? " (the stake is the liability)" : ""}.`,
  }));
}

const RAW: Raw[] = [
  {
    name: "Bet 10 Euro",
    template: TEMPLATE.placeBet,
    parameters: { BetType: "Back", Stake: 10 },
    description: "Back the selection for a stake of 10 at the best available price.",
  },
  {
    name: "Lay 10 Euro",
    template: TEMPLATE.placeBet,
    parameters: { BetType: "Lay", Stake: 10 },
    description: "Lay the selection for a backer's stake of 10 at the best available price (liability 10 x (price - 1)).",
  },
  {
    name: "Back 2 Euro",
    aliases: ["Bet 2 Euro"],
    template: TEMPLATE.placeBet,
    parameters: { BetType: "Back", Stake: 2 },
    description: "Back the selection for a stake of 2 at the best available price.",
  },
  {
    name: "Lay 2 Euro",
    template: TEMPLATE.placeBet,
    parameters: { BetType: "Lay", Stake: 2 },
    description: "Lay the selection for a backer's stake of 2 at the best available price.",
  },
  {
    name: "Bet 10 Euro Fill or Kill",
    template: TEMPLATE.fillOrKill,
    parameters: { BetType: "Back", Stake: 10 },
    description: "Back for 10 at the best price; whatever is not matched within 5 seconds is cancelled.",
  },
  {
    name: "Trade x profit",
    template: TEMPLATE.trade,
    parameters: { ...tradeEntry("Back", 10, "Liability"), ...tradeExit("Percentage", 10, 1000, "-0:00:05") },
    description:
      'Open a 10 position (back stake / lay liability), then green up at CloseBetPosition.Profit % of the opening risk, or 5 seconds before the off. Prompts pass {"OpenBetPosition.BetType":"Back"|"Lay","CloseBetPosition.Profit":N}.',
  },
  {
    name: "Trade 20% profit",
    aliases: ["Trade 20%"],
    template: TEMPLATE.trade,
    parameters: { ...tradeEntry("Back", 10, "Liability"), ...tradeExit("Percentage", 20, 1000, "-0:00:05") },
    description: "Like Trade x profit with a 20% profit target.",
  },
  {
    name: "Trade 5 ticks",
    template: TEMPLATE.trade,
    parameters: { ...tradeEntry("Back", 10, "Liability"), ...tradeExit("Ticks", 5, 0, "-0:00:05") },
    description: "Open a 10 position, green up once the price has moved 5 ticks in our favour, or 5 seconds before the off.",
  },
  {
    name: "Trade 3 ticks",
    template: TEMPLATE.trade,
    parameters: { ...tradeEntry("Back", 10, "Liability"), ...tradeExit("Ticks", 3, 0, "-0:00:05") },
    description: "Open a 10 position, green up once the price has moved 3 ticks in our favour, or 5 seconds before the off.",
  },
  {
    name: "Trade 2 Ticks Profit or 10 Ticks Loss",
    template: TEMPLATE.trade,
    parameters: {
      [`${OPEN}BetType`]: "Back",
      [`${OPEN}Stake`]: 2,
      ...tradeExit("Ticks", 2, 10, null, { [`${CLOSE}ClosePositionImmediately`]: true }),
    },
    description: "Back 2, green up at 2 ticks profit or 10 ticks loss.",
  },
  {
    name: "Trading Strategy",
    template: TEMPLATE.trade,
    parameters: { [`${OPEN}BetType`]: "Back", [`${OPEN}Stake`]: 10, ...tradeExit("Percentage", 15, 20, null) },
    description: "Open a 10 stake position, green up at 15% profit or 20% loss of the opening risk.",
  },
  {
    name: "Back Trade",
    template: TEMPLATE.trade,
    parameters: { [`${OPEN}BetType`]: "Back", [`${OPEN}Stake`]: 10, ...tradeExit("Percentage", 20, 10, "-0:02:00") },
    description: "Back 10, green up at 20% profit or 10% loss, or 2 minutes before the off.",
  },
  {
    name: "Lay Trade",
    template: TEMPLATE.trade,
    parameters: { [`${OPEN}BetType`]: "Lay", [`${OPEN}Stake`]: 10, ...tradeExit("Percentage", 20, 10, "-0:02:00") },
    description: "Lay 10, green up at 20% profit or 10% loss of the liability, or 2 minutes before the off.",
  },
  {
    name: "Trailing Stop Loss 3 Ticks",
    template: TEMPLATE.trailingStopLoss,
    parameters: { Loss: 3 },
    description: "Protect the selection's position: close it when the price moves 3 ticks back from the best price reached.",
  },
  {
    name: "Back trailing stop loss trading",
    template: TEMPLATE.sequence,
    parameters: { StrategyNames: "Bet 10 Euro;Trailing Stop Loss 3 Ticks" },
    description: "Back 10, then protect the position with a 3-tick trailing stop.",
  },
  // Settings the candlestick prompts (BetfairMarketAnalysisCandleStickData*) execute. Prompts override
  // OpenBetPosition.Stake, CloseBetPosition.Profit and CloseBetPosition.Loss; the unit of Profit/Loss is not
  // recorded upstream, so it is Ticks here (the template default; pass CloseBetPosition.ProfitLossType to change it).
  ...candlestickTrades(),
  {
    name: "Steam momentum trading",
    template: TEMPLATE.sequence,
    parameters: { StrategyNames: "Bet 10 Euro;Trailing Stop Loss 3 Ticks" },
    description: "Steam (shortening price) momentum: back 10, then protect the position with a 3-tick trailing stop.",
  },
  {
    name: "Drift momentum trading",
    template: TEMPLATE.sequence,
    parameters: { StrategyNames: "Lay 10 Euro;Trailing Stop Loss 3 Ticks" },
    description: "Drift (lengthening price) momentum: lay 10, then protect the position with a 3-tick trailing stop.",
  },
  {
    name: "Close Selection Bet Position",
    template: TEMPLATE.closeSelection,
    parameters: {},
    description:
      "Cancel the selection's unmatched bets and green up its matched position now; given Profit/Loss/ClosePositionTimeSpan (and no ClosePositionImmediately true), a bot closes it on those targets instead.",
  },
  {
    name: "Close Market Bet Position",
    template: TEMPLATE.closeMarket,
    parameters: {},
    description: "Cancel unmatched bets in the market and green up every selection's matched position now.",
  },
  {
    name: "Cancel Selection Bets",
    template: TEMPLATE.cancelBets,
    parameters: { Scope: "Selection" },
    description: "Cancel unmatched bets on the selection.",
  },
  {
    name: "Cancel Market Bets",
    template: TEMPLATE.cancelBets,
    parameters: { Scope: "Market" },
    description: "Cancel every unmatched bet in the market.",
  },
  {
    name: "Dutch to profit 10 Euro",
    template: TEMPLATE.dutching,
    parameters: { DutchingType: "RequiredProfit", TargetValue: 10 },
    description: "Back the given selections so that any of them winning returns a profit of 10.",
  },
  {
    name: "Dutch for 10 Euro",
    template: TEMPLATE.dutching,
    parameters: { DutchingType: "TotalStake", TargetValue: 10 },
    description: "Split a total stake of 10 across the given selections for an equal return whichever wins.",
  },
  {
    name: "Dutch 10 Euro stake",
    template: TEMPLATE.dutching,
    parameters: { DutchingType: "TotalStake", TargetValue: 10 },
    description: "Split a total stake of 10 across the given selections for an equal return whichever wins.",
  },
];

/** Built-ins with canonical parameter names and values (validated at load). */
export const BUILT_IN_SETTINGS: readonly StrategySetting[] = RAW.map((raw) => {
  const template = findTemplate(raw.template)!;
  normaliseParameters(template, raw.parameters); // throws at startup if a built-in is invalid
  return { ...raw, template: template.name, parameters: parseParameters(template, raw.parameters), builtIn: true };
});
