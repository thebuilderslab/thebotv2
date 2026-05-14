/**
 * Unit tests for `matchChainRow` (Phase A.6, Layer 2).
 *
 * Runner: vitest (or compatible). When a test runner is added to backend-api,
 * these tests run unmodified. Until then, the file documents expected behaviour
 * and is type-checked by `tsc --noEmit`.
 */

import { describe, expect, it } from "vitest";
import { ChainRowNotFound, matchChainRow } from "./chain-match";
import type { OptionsChainResult } from "./schwab-positions";

function makeChain(): OptionsChainResult {
  return {
    symbol: "GOOGL",
    underlying_price: 335.70,
    as_of: "2026-05-15T20:30:00.000Z",
    calls: [
      {
        symbol: "GOOGL  260424C00340000",
        strike: 340,
        expiration: "2026-04-24",
        contract_type: "CALL",
        bid: 4.30, ask: 4.40, mark: 4.35, last: 4.32,
        delta: 0.42, gamma: 0.05, theta: -0.08, vega: 0.12, iv: 0.28,
        volume: 1200, open_interest: 8500, dte: 8, in_the_money: false,
      },
      {
        symbol: "GOOGL  260424C00345000",
        strike: 345,
        expiration: "2026-04-24",
        contract_type: "CALL",
        bid: 2.10, ask: 2.20, mark: 2.15, last: 2.18,
        delta: 0.27, gamma: 0.045, theta: -0.07, vega: 0.11, iv: 0.27,
        volume: 600, open_interest: 3200, dte: 8, in_the_money: false,
      },
      {
        symbol: "GOOGL  260508C00365000",
        strike: 365,
        expiration: "2026-05-08",
        contract_type: "CALL",
        bid: 1.20, ask: 1.30, mark: 1.25, last: 1.27,
        delta: 0.15, gamma: 0.030, theta: -0.05, vega: 0.09, iv: 0.26,
        volume: 200, open_interest: 1500, dte: 22, in_the_money: false,
      },
    ],
    puts: [
      {
        symbol: "GOOGL  260424P00320000",
        strike: 320,
        expiration: "2026-04-24",
        contract_type: "PUT",
        bid: 1.50, ask: 1.60, mark: 1.55, last: 1.58,
        delta: -0.22, gamma: 0.040, theta: -0.06, vega: 0.10, iv: 0.30,
        volume: 400, open_interest: 2200, dte: 8, in_the_money: false,
      },
    ],
  };
}

describe("matchChainRow", () => {
  it("returns the exact call contract when (strike, expiry, type) match", () => {
    const chain = makeChain();
    const matched = matchChainRow(chain, {
      strike: 340,
      expiry: "2026-04-24",
      contract_type: "CALL",
    });
    expect(matched.strike).toBe(340);
    expect(matched.expiration).toBe("2026-04-24");
    expect(matched.contract_type).toBe("CALL");
    expect(matched.delta).toBe(0.42);
    expect(matched.iv).toBe(0.28);
  });

  it("returns the exact put contract when (strike, expiry, type) match", () => {
    const chain = makeChain();
    const matched = matchChainRow(chain, {
      strike: 320,
      expiry: "2026-04-24",
      contract_type: "PUT",
    });
    expect(matched.contract_type).toBe("PUT");
    expect(matched.delta).toBe(-0.22);
  });

  it("accepts lowercased contract_type and matches the same row", () => {
    const chain = makeChain();
    const matched = matchChainRow(chain, {
      strike: 340,
      expiry: "2026-04-24",
      contract_type: "call",
    });
    expect(matched.strike).toBe(340);
  });

  it("throws ChainRowNotFound when strike does not exist in chain", () => {
    const chain = makeChain();
    expect(() =>
      matchChainRow(chain, {
        strike: 999,
        expiry: "2026-04-24",
        contract_type: "CALL",
      }),
    ).toThrow(ChainRowNotFound);
  });

  it("throws ChainRowNotFound when expiry does not exist in chain", () => {
    const chain = makeChain();
    expect(() =>
      matchChainRow(chain, {
        strike: 340,
        expiry: "2099-01-01",
        contract_type: "CALL",
      }),
    ).toThrow(ChainRowNotFound);
  });

  it("throws ChainRowNotFound when contract_type does not match (CALL strike requested as PUT)", () => {
    const chain = makeChain();
    expect(() =>
      matchChainRow(chain, {
        strike: 340,
        expiry: "2026-04-24",
        contract_type: "PUT",
      }),
    ).toThrow(ChainRowNotFound);
  });

  it("throws ChainRowNotFound for an invalid contract_type string (no fuzzy fallback)", () => {
    const chain = makeChain();
    expect(() =>
      matchChainRow(chain, {
        strike: 340,
        expiry: "2026-04-24",
        contract_type: "SOMETHING",
      }),
    ).toThrow(ChainRowNotFound);
  });

  it("never performs nearest-strike substitution (335 is not 340)", () => {
    const chain = makeChain();
    expect(() =>
      matchChainRow(chain, {
        strike: 335,
        expiry: "2026-04-24",
        contract_type: "CALL",
      }),
    ).toThrow(ChainRowNotFound);
  });

  it("never returns a different expiry even if strike matches in another expiry", () => {
    const chain = makeChain();
    // 365 exists for 2026-05-08, not 2026-04-24. Must throw.
    expect(() =>
      matchChainRow(chain, {
        strike: 365,
        expiry: "2026-04-24",
        contract_type: "CALL",
      }),
    ).toThrow(ChainRowNotFound);
  });
});
