/**
 * PR-α: Verifies canonical TASK_ROUTING in @bot-nation/core-domain.
 *
 * Lives in backend-api/src/services (vitest is already wired there) but
 * imports from core-domain. Closes the duplicated-routing-table gap
 * between routes/telegram.ts and services/task-router.ts.
 */

import { describe, expect, it } from "vitest";
import { TASK_ROUTING, KIND_TO_DOMAIN, TASK_KIND_ROUTING } from "@bot-nation/core-domain";

const VALID_DOMAINS = new Set([
  "governance",
  "orchestration",
  "knowledge",
  "execution_finance",
  "execution_product",
  "execution_growth",
  "execution_infra",
]);

describe("TASK_ROUTING canonical table", () => {
  it("every entry has a domain that exists in the TeamDomain union", () => {
    for (const [kind, r] of Object.entries(TASK_ROUTING)) {
      expect(VALID_DOMAINS.has(r.domain), `kind=${kind} domain=${r.domain}`).toBe(true);
    }
  });

  it("every entry has non-empty teamId and agentId", () => {
    for (const [kind, r] of Object.entries(TASK_ROUTING)) {
      expect(r.teamId.length, `kind=${kind} teamId empty`).toBeGreaterThan(0);
      expect(r.agentId.length, `kind=${kind} agentId empty`).toBeGreaterThan(0);
    }
  });

  it("no duplicate keys", () => {
    const keys = Object.keys(TASK_ROUTING);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("Derived views match canonical", () => {
  it("KIND_TO_DOMAIN has same keys as TASK_ROUTING", () => {
    expect(Object.keys(KIND_TO_DOMAIN).sort()).toEqual(Object.keys(TASK_ROUTING).sort());
  });

  it("TASK_KIND_ROUTING has same keys as TASK_ROUTING", () => {
    expect(Object.keys(TASK_KIND_ROUTING).sort()).toEqual(Object.keys(TASK_ROUTING).sort());
  });

  it("KIND_TO_DOMAIN values match TASK_ROUTING domain", () => {
    for (const [kind, r] of Object.entries(TASK_ROUTING)) {
      expect(KIND_TO_DOMAIN[kind]).toBe(r.domain);
    }
  });

  it("TASK_KIND_ROUTING values match TASK_ROUTING teamId + agentId", () => {
    for (const [kind, r] of Object.entries(TASK_ROUTING)) {
      expect(TASK_KIND_ROUTING[kind]).toEqual({ teamId: r.teamId, agentId: r.agentId });
    }
  });
});

describe("PR-α: 10 previously-unmapped kinds now have a domain", () => {
  const previouslyMissing = [
    "defi_plan",
    "defi_risk_check",
    "defi_health_monitor",
    "defi_report",
    "market_research",
    "campaign_generation",
    "lead_qualification",
    "crm_hygiene",
    "intel_review",
    "deep_research",
  ];

  for (const kind of previouslyMissing) {
    it(`'${kind}' has a domain entry`, () => {
      expect(KIND_TO_DOMAIN[kind], `${kind} missing from KIND_TO_DOMAIN`).toBeDefined();
      expect(VALID_DOMAINS.has(KIND_TO_DOMAIN[kind])).toBe(true);
    });
  }
});

describe("PR-α: no regression — original 6 kinds still map correctly", () => {
  const originalMappings: Array<[string, string]> = [
    ["research",             "knowledge"],
    ["code_change",          "execution_product"],
    ["config_change",        "execution_infra"],
    ["improvement_proposal", "governance"],
    ["wallet_simulation",    "execution_finance"],
    ["content_generation",   "execution_growth"],
  ];

  for (const [kind, expectedDomain] of originalMappings) {
    it(`'${kind}' → '${expectedDomain}' preserved`, () => {
      expect(KIND_TO_DOMAIN[kind]).toBe(expectedDomain);
    });
  }
});

describe("PR-α: team-mapped kinds resolve to correct team + agent", () => {
  it("defi_plan → team-p87 / agent-p87-planner", () => {
    expect(TASK_KIND_ROUTING.defi_plan).toEqual({ teamId: "team-p87", agentId: "agent-p87-planner" });
  });

  it("crm_hygiene → team-agency / agent-agency-revops", () => {
    expect(TASK_KIND_ROUTING.crm_hygiene).toEqual({ teamId: "team-agency", agentId: "agent-agency-revops" });
  });

  it("intel_review → team-intel / agent-intel-lead", () => {
    expect(TASK_KIND_ROUTING.intel_review).toEqual({ teamId: "team-intel", agentId: "agent-intel-lead" });
  });
});
