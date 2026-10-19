/**
 * BFExplorer data-context providers built on third-party feeds this connector does not have.
 * Values: [what it needs, BFExplorer's per-selection data key(s) where known].
 */
export const BFEXPLORER_ONLY_CONTEXTS: Record<string, { source: string; dataKeys?: string[]; marketDataKeys?: string[] }> = {
  RacingpostDataForHorses: { source: "Racing Post form and ratings", dataKeys: ["racingpostHorseData"] },
  TimeformDataForHorses: { source: "Timeform indicators", dataKeys: ["timeformHorseData"] },
  TimeformFullDataForHorses: { source: "Timeform full data", dataKeys: ["expertView", "timeformHorseData"] },
  AtTheRacesDataForHorses: { source: "At The Races form and expert views", dataKeys: ["atTheRacesHorseData"] },
  AtTheRacesBookmakersOdds: { source: "At The Races bookmaker odds", dataKeys: ["bookmakersOdds"] },
  RacingTvDataForHorses: { source: "Racing TV form", dataKeys: ["racingTvHorseData"], marketDataKeys: ["racingTvRaceData"] },
  RacingTvBookmakersOdds: { source: "Racing TV bookmaker odds" },
  OddscheckerBookmakersOdds: { source: "Oddschecker bookmaker odds" },
  OlbgRaceTipsData: { source: "OLBG tipster data", dataKeys: ["olbgRaceTipData"] },
  RacingStattoData: { source: "RacingStatto statistics", dataKeys: ["racingStatto"] },
  RacesResultsForRacingStattoData: { source: "RacingStatto results" },
  RacesWinnersForRacingStattoData: { source: "RacingStatto winners" },
  PedigreeDataForHorses: { source: "pedigree data", dataKeys: ["horsePedigreeData"] },
  DbHorsesResults: { source: "BFExplorer's horse results database", dataKeys: ["horseResults"] },
  DbJockeysResults: { source: "BFExplorer's jockey results database", dataKeys: ["jockeyResults"] },
  DbTrainersResults: { source: "BFExplorer's trainer results database", dataKeys: ["trainerResults"] },
  DbJockeysStatisticsData: { source: "BFExplorer's jockey statistics database" },
  HorsesNigelsRaceCard: { source: "Nigel's race card", dataKeys: ["nigelHorseDetail"] },
  HorsesNigelsRaceTissue: { source: "Nigel's tissue prices", dataKeys: ["nigelTissuePricer"] },
  HorsesNigelsRaceRadar: { source: "Nigel's race radar", dataKeys: ["nigelRaceRadar"] },
  HorsesNigelsRaceTrainerHeatmap: { source: "Nigel's trainer heatmap", dataKeys: ["nigelRaceTrainerHeatmap"] },
  HorsesNigelsRaceJockeyHeatmap: { source: "Nigel's jockey heatmap", dataKeys: ["nigelRaceJockeyHeatmap"] },
  TestRaceData: { source: "BFExplorer test race data", dataKeys: ["horseData"] },
  FootballMatchScoreData: { source: "live football scores" },
  PlayingFootballMatchScoresData: { source: "live football scores" },
  PlayingTennisMatchScoresData: { source: "live tennis scores" },
};
