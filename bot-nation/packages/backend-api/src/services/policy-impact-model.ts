/**
 * Policy Decision Impact Model
 *
 * Evaluates credit/debit cascade impacts on hold/roll decisions.
 * Thresholds are parameterized at runtime (stored in agent memory).
 * On each position evaluation:
 *   - IF credit received → extend DTE hold, raise price target
 *   - IF debit paid → compress DTE roll, lower price target
 *   - Compare Greeks (delta, theta, vega) for re-hedge signals
 */

import { run, query, queryOne } from "../db/schema";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PolicyThresholds {
  min_credit_roll: number;        // $ net credit threshold to roll (e.g., $6.00)
  debit_roll_tiers: [number, number];  // [$floor, $ceiling] debit bounds
  max_dte_days: number;           // days to expiry before roll alert
  delta_threshold: number;        // delta level for re-hedge (e.g., 0.30)
}

export interface Position {
  symbol: string;
  position_type: string;  // 'long_call', 'short_put', etc.
  quantity: number;
  entry_price: number;
  current_price: number;
  days_to_expiry: number;
  delta?: number;
  theta?: number;
  vega?: number;
  underlying_price: number;
  pnl_pct: number;
}

export interface PolicyDecision {
  action: 'HOLD' | 'ROLL' | 'CLOSE' | 'ESCALATE';
  pnl_impact: number;
  new_targets?: {
    price_target: number;
    dte_threshold: number;
    hold_bias: string;
  };
  confidence: number;
  affected_positions: string[];
  rationale: string;
  audit_trail?: {
    prior_decision?: string;
    delta_since_prior?: number;
    greeks_impact: string;
  };
}

export interface DecisionContext {
  new_trade_today: boolean;
  credit_amount?: number;
  debit_amount?: number;
  contract_multiplier: number;
  prior_snapshot?: {
    price_target: number;
    dte_threshold: number;
  };
}

// ── Storage (agent memory integration) ────────────────────────────────────────

/**
 * Retrieve thresholds from agent memory (agent_notes-like storage).
 * Returns null if thresholds not yet initialized by Finance Lead.
 */
export async function getStoredThresholds(
  db: D1Database,
  agentId: string,
): Promise<PolicyThresholds | null> {
  try {
    // Query agent memory for threshold JSON
    const result = await queryOne<{ value: string }>(
      db,
      `SELECT value FROM agent_notes
       WHERE agent_id = ? AND key = 'policy_thresholds_json'
       LIMIT 1`,
      [agentId],
    );

    if (!result) {
      return null;  // Not yet initialized
    }

    return JSON.parse(result.value) as PolicyThresholds;
  } catch (err) {
    console.error(`[policy-impact-model] Failed to retrieve thresholds for ${agentId}:`, err);
    return null;
  }
}

/**
 * Store/update thresholds in agent memory. Called after Finance Lead approval.
 */
export async function updateStoredThresholds(
  db: D1Database,
  agentId: string,
  thresholds: PolicyThresholds,
): Promise<void> {
  const now = new Date().toISOString();
  const json = JSON.stringify(thresholds);
  const id = crypto.randomUUID();

  await run(
    db,
    `INSERT INTO agent_notes (id, agent_id, key, value, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id, key) DO UPDATE SET value = ?, updated_at = ?`,
    [id, agentId, 'policy_thresholds_json', json, now, now, json, now],
  );
}

// ── Decision Engine ───────────────────────────────────────────────────────────

/**
 * Evaluate policy decision for a single position.
 * Returns action (HOLD/ROLL/CLOSE/ESCALATE) with rationale and impact.
 */
export function evaluatePolicyDecision(
  position: Position,
  thresholds: PolicyThresholds | null,
  context: DecisionContext = {
    new_trade_today: false,
    contract_multiplier: 100,
  },
): PolicyDecision {
  // Guard: if thresholds not initialized, escalate
  if (!thresholds) {
    return {
      action: 'ESCALATE',
      pnl_impact: 0,
      confidence: 0,
      affected_positions: [position.symbol],
      rationale: 'Policy thresholds not initialized. Awaiting Finance Lead setup.',
      audit_trail: {
        greeks_impact: 'No Greeks available; thresholds missing',
      },
    };
  }

  let basePriceTarget = position.entry_price;
  let baseDteThreshold = thresholds.max_dte_days;
  let holdBias = 'neutral';

  // ── Credit/Debit Cascade ──────────────────────────────────────────────────
  if (context.new_trade_today) {
    if (context.credit_amount && context.credit_amount > 0) {
      // Credit received → extend DTE hold, raise price target
      basePriceTarget =
        position.entry_price + (context.credit_amount / context.contract_multiplier);
      baseDteThreshold = Math.max(baseDteThreshold + 2, baseDteThreshold + 5);
      holdBias = 'increase';
    } else if (context.debit_amount && context.debit_amount > 0) {
      // Debit paid → compress DTE roll, lower price target
      basePriceTarget =
        position.entry_price - (context.debit_amount / context.contract_multiplier);
      baseDteThreshold = Math.max(2, baseDteThreshold - 2);
      holdBias = 'increase_roll';
    }
  }

  // ── Decision Logic ────────────────────────────────────────────────────────

  const rationales: string[] = [];
  let decision: 'HOLD' | 'ROLL' | 'CLOSE' | 'ESCALATE' = 'HOLD';
  let confidence = 0.8;

  // Stop-loss check (simplified: if DTE < 1 or P&L < -30%)
  if (position.pnl_pct <= -0.30) {
    decision = 'CLOSE';
    confidence = 0.95;
    rationales.push(`🔴 STOP HIT: P&L ${(position.pnl_pct * 100).toFixed(1)}% ≤ -30%`);
  }

  // Profit target check
  else if (
    position.pnl_pct >= 1.8 &&
    position.position_type.includes('call')
  ) {
    decision = 'ROLL';
    confidence = 0.90;
    rationales.push(
      `🎯 TARGET HIT: P&L ${(position.pnl_pct * 100).toFixed(1)}% ≥ +180%`,
    );
  }

  // DTE expiry alert
  else if (position.days_to_expiry <= 1) {
    decision = 'CLOSE';
    confidence = 0.95;
    rationales.push(`⏰ EXPIRY: ${position.days_to_expiry} DTE`);
  }

  // DTE roll threshold
  else if (position.days_to_expiry <= baseDteThreshold) {
    decision = 'ROLL';
    confidence = 0.85;
    rationales.push(
      `📅 DTE ALERT: ${position.days_to_expiry} ≤ threshold ${baseDteThreshold}`,
    );
  }

  // Delta re-hedge check (if delta > threshold, might be too deep ITM)
  else if (
    position.delta &&
    position.delta > thresholds.delta_threshold &&
    position.position_type.includes('call')
  ) {
    decision = 'ROLL';
    confidence = 0.70;
    rationales.push(
      `⚠️ DELTA HIGH: ${position.delta.toFixed(2)} > ${thresholds.delta_threshold}`,
    );
  }

  // Credit/debit checks
  else if (
    context.credit_amount &&
    context.credit_amount >= thresholds.min_credit_roll
  ) {
    decision = 'HOLD';
    confidence = 0.85;
    rationales.push(
      `💰 CREDIT STRONG: ${context.credit_amount.toFixed(2)} ≥ $${thresholds.min_credit_roll}`,
    );
  }

  // Otherwise: HOLD
  else {
    decision = 'HOLD';
    confidence = 0.75;
    rationales.push(
      `✅ HOLD: No escalation trigger detected; monitoring P&L & theta`,
    );
  }

  return {
    action: decision,
    pnl_impact: position.pnl_pct,
    new_targets: {
      price_target: basePriceTarget,
      dte_threshold: baseDteThreshold,
      hold_bias: holdBias,
    },
    confidence,
    affected_positions: [position.symbol],
    rationale: rationales.join(' | '),
    audit_trail: {
      prior_decision: context.prior_snapshot ? 'PRIOR_SNAPSHOT' : 'INITIAL',
      delta_since_prior: context.prior_snapshot
        ? basePriceTarget - context.prior_snapshot.price_target
        : undefined,
      greeks_impact: `delta=${position.delta?.toFixed(2) || 'N/A'}, theta=${position.theta?.toFixed(2) || 'N/A'}, vega=${position.vega?.toFixed(2) || 'N/A'}`,
    },
  };
}

// ── Validation & Formatting ───────────────────────────────────────────────────

/**
 * Validate thresholds before storage (ensure sane values).
 */
export function validateThresholds(t: PolicyThresholds): string | null {
  if (t.min_credit_roll < 0) return 'min_credit_roll must be ≥ 0';
  if (t.debit_roll_tiers[0] < 0 || t.debit_roll_tiers[1] < t.debit_roll_tiers[0]) {
    return 'debit_roll_tiers must be [floor, ceiling] with floor ≥ 0 and ceiling > floor';
  }
  if (t.max_dte_days < 1 || t.max_dte_days > 60) {
    return 'max_dte_days should be 1-60 (days)';
  }
  if (t.delta_threshold < 0 || t.delta_threshold > 1) {
    return 'delta_threshold must be 0.0-1.0';
  }
  return null;
}

/**
 * Format thresholds for Telegram preview (human-readable).
 */
export function formatThresholdsForTelegram(t: PolicyThresholds): string {
  return `
💳 **MIN_CREDIT_ROLL**: $${t.min_credit_roll.toFixed(2)}
📊 **DEBIT_ROLL_TIERS**: [$${t.debit_roll_tiers[0]}, $${t.debit_roll_tiers[1]}]
📅 **MAX_DTE_DAYS**: ${t.max_dte_days} days
📈 **DELTA_THRESHOLD**: ${(t.delta_threshold * 100).toFixed(0)}%
  `.trim();
}
