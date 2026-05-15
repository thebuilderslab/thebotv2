/**
 * Chain Match — Phase A.6 (Layer 2).
 *
 * Pure helper that selects exactly one OptionContract from an OptionsChainResult
 * by matching on (strike, expiry, option_type). Exact match only. No fuzzy,
 * nearest-neighbor, or interpolated matching is permitted in any layer.
 *
 * Reads: nothing.
 * Writes: nothing.
 * Forbidden: anything outside pure data operations on the inputs.
 */

import type { OptionContract, OptionsChainResult } from "./schwab-positions";

export interface ChainMatchInput {
  strike: number;
  expiry: string;          // ISO date "YYYY-MM-DD"
  contract_type: string;   // "CALL" | "PUT"
}

export class ChainRowNotFound extends Error {
  constructor(input: ChainMatchInput, public chainSymbol: string) {
    super(
      `Chain row not found for ${chainSymbol} strike=${input.strike} expiry=${input.expiry} type=${input.contract_type}`,
    );
    this.name = "ChainRowNotFound";
  }
}

/**
 * Return the chain contract that exactly matches (strike, expiry, contract_type).
 * Throws ChainRowNotFound on any mismatch — caller is responsible for handling.
 */
export function matchChainRow(
  chain: OptionsChainResult,
  input: ChainMatchInput,
): OptionContract {
  const wantType = String(input.contract_type ?? "").toUpperCase();
  if (wantType !== "CALL" && wantType !== "PUT") {
    throw new ChainRowNotFound(input, chain.symbol);
  }
  const pool = wantType === "CALL" ? chain.calls : chain.puts;
  for (const c of pool) {
    if (
      c.strike === input.strike &&
      c.expiration === input.expiry &&
      c.contract_type === wantType
    ) {
      return c;
    }
  }
  throw new ChainRowNotFound(input, chain.symbol);
}
