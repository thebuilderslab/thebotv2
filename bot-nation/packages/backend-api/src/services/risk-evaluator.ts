/**
 * Risk Auto-Evaluator
 *
 * Pure function — no DB access. Derives a risk assessment from a proposal's
 * changeSet and target entity kind.
 *
 * Called from POST /api/proposals when the caller omits riskLevel, so the
 * system always has a risk level rather than defaulting to "low" blindly.
 */

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface RiskEvaluation {
  level: RiskLevel;
  affectsWallets: boolean;
  affectsDeployment: boolean;
}

/**
 * Evaluate risk for a proposed changeSet.
 *
 * Rules are checked in descending severity order — the first match wins.
 */
export function evaluateRisk(
  changeSet: Record<string, unknown>,
  _targetEntityKind: string,
): RiskEvaluation {
  const keys = Object.keys(changeSet);

  // ── critical: wallet or auto-deploy permissions being enabled ────────────
  if (keys.includes("permissions")) {
    const perms = changeSet["permissions"] as Record<string, unknown> | null;
    if (perms && typeof perms === "object") {
      const touchesWallets = perms["canTouchWallets"] === true;
      const touchesDeploy = perms["canAutoDeploy"] === true;
      if (touchesWallets || touchesDeploy) {
        return {
          level: "critical",
          affectsWallets: touchesWallets,
          affectsDeployment: touchesDeploy,
        };
      }
    }
  }

  // ── high: any permissions change (even disabling) ────────────────────────
  if (keys.includes("permissions")) {
    return { level: "high", affectsWallets: false, affectsDeployment: false };
  }

  // ── high: changing team's maxRiskTier policy ──────────────────────────────
  if (keys.includes("policies")) {
    const pol = changeSet["policies"] as Record<string, unknown> | null;
    if (pol && typeof pol === "object" && "maxRiskTier" in pol) {
      return { level: "high", affectsWallets: false, affectsDeployment: false };
    }
  }

  // ── medium: retiring an agent ─────────────────────────────────────────────
  if (keys.includes("status") && changeSet["status"] === "retired") {
    return { level: "medium", affectsWallets: false, affectsDeployment: false };
  }

  // ── medium: any policies change ───────────────────────────────────────────
  if (keys.includes("policies")) {
    return { level: "medium", affectsWallets: false, affectsDeployment: false };
  }

  // ── low: everything else ──────────────────────────────────────────────────
  return { level: "low", affectsWallets: false, affectsDeployment: false };
}
