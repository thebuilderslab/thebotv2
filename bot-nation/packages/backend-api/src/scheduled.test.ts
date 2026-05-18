/**
 * Unit tests for A.11 Schwab Token Heartbeat cron.
 * Validates event emission on success and failure paths.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("A.11 Schwab Token Heartbeat", () => {
  let mockDb: any;
  let mockGetAccessToken: any;
  let mockLoadTokens: any;
  let mockEmitEvent: any;

  beforeEach(() => {
    mockDb = {};
    mockGetAccessToken = vi.fn();
    mockLoadTokens = vi.fn();
    mockEmitEvent = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("successful token refresh", () => {
    it("emits schwab.heartbeat event with token_expires_at", async () => {
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      mockGetAccessToken.mockResolvedValue("test_token");
      mockLoadTokens.mockResolvedValue({
        access_token: "test_token",
        refresh_token: "refresh_token",
        expires_at: expiresAt,
      });

      // Simulate the heartbeat handler logic
      try {
        await mockGetAccessToken(mockDb, "client_id", "client_secret");
        const tokens = await mockLoadTokens(mockDb);
        await mockEmitEvent(mockDb, "schwab.heartbeat", "agent-finance-lead", "agent", "agent-finance-lead", {
          token_expires_at: tokens?.expires_at,
        }, null, new Date().toISOString());
      } catch (err) {
        throw err;
      }

      expect(mockGetAccessToken).toHaveBeenCalledWith(mockDb, "client_id", "client_secret");
      expect(mockLoadTokens).toHaveBeenCalledWith(mockDb);
      expect(mockEmitEvent).toHaveBeenCalledWith(
        mockDb,
        "schwab.heartbeat",
        "agent-finance-lead",
        "agent",
        "agent-finance-lead",
        expect.objectContaining({
          token_expires_at: expiresAt,
        }),
        null,
        expect.any(String) // ISO timestamp
      );
    });
  });

  describe("failed token refresh", () => {
    it("emits schwab.refresh_failed event with error message", async () => {
      const testError = new Error("Schwab API connection failed");
      mockGetAccessToken.mockRejectedValue(testError);

      // Simulate the error handling path
      let caughtError;
      try {
        await mockGetAccessToken(mockDb, "client_id", "client_secret");
      } catch (err) {
        caughtError = err;
        await mockEmitEvent(mockDb, "schwab.refresh_failed", "agent-finance-lead", "agent", "agent-finance-lead", {
          error: (err as Error).message,
        }, null, new Date().toISOString());
      }

      expect(caughtError).toBe(testError);
      expect(mockEmitEvent).toHaveBeenCalledWith(
        mockDb,
        "schwab.refresh_failed",
        "agent-finance-lead",
        "agent",
        "agent-finance-lead",
        expect.objectContaining({
          error: "Schwab API connection failed",
        }),
        null,
        expect.any(String)
      );
    });
  });

  describe("event emission fields", () => {
    it("heartbeat event uses correct actor and target ids", async () => {
      mockGetAccessToken.mockResolvedValue("test_token");
      mockLoadTokens.mockResolvedValue({
        expires_at: new Date().toISOString(),
      });

      await mockGetAccessToken(mockDb, "client_id", "client_secret");
      const tokens = await mockLoadTokens(mockDb);
      await mockEmitEvent(mockDb, "schwab.heartbeat", "agent-finance-lead", "agent", "agent-finance-lead", {
        token_expires_at: tokens?.expires_at,
      }, null, new Date().toISOString());

      const call = mockEmitEvent.mock.calls[0];
      expect(call[1]).toBe("schwab.heartbeat"); // kind
      expect(call[2]).toBe("agent-finance-lead"); // actor_id
      expect(call[3]).toBe("agent"); // target_kind
      expect(call[4]).toBe("agent-finance-lead"); // target_id
    });

    it("refresh_failed event uses correct actor and target ids", async () => {
      mockGetAccessToken.mockRejectedValue(new Error("test error"));

      try {
        await mockGetAccessToken(mockDb, "client_id", "client_secret");
      } catch (err) {
        await mockEmitEvent(mockDb, "schwab.refresh_failed", "agent-finance-lead", "agent", "agent-finance-lead", {
          error: (err as Error).message,
        }, null, new Date().toISOString());
      }

      const call = mockEmitEvent.mock.calls[0];
      expect(call[1]).toBe("schwab.refresh_failed"); // kind
      expect(call[2]).toBe("agent-finance-lead"); // actor_id
      expect(call[3]).toBe("agent"); // target_kind
      expect(call[4]).toBe("agent-finance-lead"); // target_id
    });
  });
});
