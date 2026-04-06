/**
 * Guardrails — Phase 7C
 *
 * Centralised safety checks applied at input, spawn, and execution boundaries.
 *
 * Active guardrails:
 *   1. Input sanitisation   — strips prompt-injection patterns, caps length
 *   2. Spawn depth limit    — blocks agent trees deeper than MAX_SPAWN_DEPTH
 *   3. Spawn count limit    — blocks a single task from spawning > MAX_CHILDREN
 *   4. Graph node cap       — stops graph traversal after MAX_GRAPH_NODES steps
 *   5. Flat loop cap        — max iterations in the tool-use loop
 */

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_INPUT_LENGTH   = 2000;   // chars — truncated before reaching LLM
export const MAX_SPAWN_DEPTH    = 3;      // root=0, child=1, grandchild=2, great=3 (blocked)
export const MAX_CHILDREN       = 5;      // max sub-tasks a single SPAWN_TASKS block may request
export const MAX_GRAPH_NODES    = 20;     // max node executions per graph traversal
export const MAX_LOOP_ITERATIONS = 5;     // max tool-use loop iterations in flatToolLoop

// ── Prompt injection patterns ─────────────────────────────────────────────────

const INJECTION_PATTERNS: RegExp[] = [
  /<SPAWN_TASKS[\s\S]*?>/gi,          // attempt to inject spawn block openers
  /<\/SPAWN_TASKS>/gi,                // close tags
  /<system[\s\S]*?>/gi,               // system prompt override attempts
  /<\/system>/gi,
  /\[INST\]/gi,                       // Llama instruction tokens
  /\[\/INST\]/gi,
  /<<SYS>>/gi,                        // Llama system tokens
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/gi,
  /disregard\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/gi,
  /you\s+are\s+now\s+(?:a\s+)?(?:an?\s+)?(?:different|new|another)\s+(?:AI|agent|assistant|model)/gi,
  /act\s+as\s+(?:a\s+)?(?:an?\s+)?(?:different|unrestricted|unfiltered)/gi,
];

// ── 1. Input sanitisation ─────────────────────────────────────────────────────

/**
 * Sanitise user-supplied text before it reaches any LLM prompt.
 * - Strips known prompt-injection patterns
 * - Truncates to MAX_INPUT_LENGTH
 * Returns { safe: string; flagged: boolean; reasons: string[] }
 */
export function sanitiseInput(raw: string): {
  safe: string;
  flagged: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  let text = raw;

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      reasons.push(`Injection pattern stripped: ${pattern.source.slice(0, 40)}`);
      text = text.replace(pattern, "[REDACTED]");
      pattern.lastIndex = 0; // reset stateful regex
    }
  }

  if (text.length > MAX_INPUT_LENGTH) {
    reasons.push(`Input truncated from ${text.length} to ${MAX_INPUT_LENGTH} chars`);
    text = text.slice(0, MAX_INPUT_LENGTH) + "… [truncated]";
  }

  return { safe: text, flagged: reasons.length > 0, reasons };
}

// ── 2 & 3. Spawn depth + count guard ─────────────────────────────────────────

export interface SpawnGuardResult {
  allowed: boolean;
  reason?: string;
  clampedList?: Array<{ kind: string; summary: string; details?: string }>;
}

export function guardSpawn(
  spawnList: Array<{ kind: string; summary: string; details?: string }>,
  currentDepth: number,
): SpawnGuardResult {
  if (currentDepth >= MAX_SPAWN_DEPTH) {
    return {
      allowed: false,
      reason: `Spawn blocked: task is already at depth ${currentDepth} (max ${MAX_SPAWN_DEPTH})`,
    };
  }

  if (spawnList.length > MAX_CHILDREN) {
    return {
      allowed: true,
      reason: `Spawn list clamped from ${spawnList.length} to ${MAX_CHILDREN}`,
      clampedList: spawnList.slice(0, MAX_CHILDREN),
    };
  }

  return { allowed: true, clampedList: spawnList };
}

// ── 4. Graph node execution cap ───────────────────────────────────────────────

export function checkGraphNodeCap(nodesExecuted: number): boolean {
  return nodesExecuted < MAX_GRAPH_NODES;
}

// ── Audit log helper ──────────────────────────────────────────────────────────

export interface GuardrailEvent extends Record<string, unknown> {
  guardrail: string;
  triggered: boolean;
  detail: string;
  taskId?: string;
}

export function makeGuardrailEvent(
  guardrail: string,
  detail: string,
  taskId?: string,
): GuardrailEvent {
  return { guardrail, triggered: true, detail, taskId };
}
