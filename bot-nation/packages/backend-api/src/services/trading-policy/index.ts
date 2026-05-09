// R-WEEKLY-DIRECTOR.1 — public API barrel for the trading-policy module.
//
// Consumers (the orchestrator in `services/trading/` and the test fixture
// harness `verify-weekly-director-fixture.mjs`) should import from this
// barrel rather than reaching into individual files. Keeps the module
// surface small and refactor-safe.

export * from "./types";
export { WEEKLY_OPTIONS_POLICY_V1 } from "./policy.v1";
export {
  classifyTrendRegime,
  classifyVolatilityRegime,
  buildMarketContext,
} from "./classify";
export type { TrendInput, RawMarketInputs } from "./classify";
export { buildNextWeekCandidates, buildSameWeekCandidates } from "./candidates";
export type { CandidateBuildInput, RawChainRow } from "./candidates";
export { scoreCandidate, compareCandidateScoreDesc } from "./score";
export {
  evaluateCandidate,
  evaluatePosition,
  evaluateAccount,
} from "./evaluate";
