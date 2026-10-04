/**
 * Unit tests for formatBalanceReport — the OpenRouter weekly balance message.
 */

import { describe, expect, it } from "vitest";
import { formatBalanceReport } from "./openrouter-balance";

describe("formatBalanceReport", () => {
  it("computes remaining = credits − usage and states it", () => {
    const msg = formatBalanceReport(5.0, 0.8);
    expect(msg).toContain("$4.20 remaining");
    expect(msg).toContain("used $0.80 of $5.00");
  });

  it("does NOT warn when remaining is at or above $1", () => {
    expect(formatBalanceReport(5.0, 4.0)).not.toContain("⚠️"); // $1.00 exactly
    expect(formatBalanceReport(5.0, 0.0)).not.toContain("⚠️"); // $5.00
  });

  it("warns when remaining is below $1", () => {
    const msg = formatBalanceReport(5.0, 4.5); // $0.50 left
    expect(msg).toContain("⚠️ Low");
    expect(msg).toContain("$0.50 remaining");
  });

  it("handles a fully-drained balance", () => {
    const msg = formatBalanceReport(5.0, 5.0); // $0.00
    expect(msg).toContain("$0.00 remaining");
    expect(msg).toContain("⚠️ Low");
  });

  it("respects a custom threshold", () => {
    // $4 remaining with threshold $5 → warns
    expect(formatBalanceReport(10, 6, 5)).toContain("⚠️");
    // $6 remaining with threshold $5 → no warn
    expect(formatBalanceReport(10, 4, 5)).not.toContain("⚠️");
  });
});
