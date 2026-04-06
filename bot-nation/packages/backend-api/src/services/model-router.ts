/**
 * Model Router — Phase 7
 *
 * Maps task kind + agent domain → OpenRouter model ID.
 * All models served via OpenRouter's OpenAI-compatible endpoint.
 *
 * Model assignments:
 *   research          → Kimi K2.5       (256K context, agentic tool-calling, deep research)
 *   content_generation → Gemini Flash   (fast, cheap, long context)
 *   code_change        → GLM-5          (agentic planning, backend engineering)
 *   config_change      → Qwen3.5 397B   (reasoning, low cost MoE)
 *   improvement_proposal → GLM-5        (complex orchestration)
 *   wallet_simulation  → Qwen3.5 397B   (finance reasoning)
 *   deep_research      → Kimi K2.5      (best-in-class deep research)
 *   vision             → GLM-5V-Turbo   (image + video input)
 *   default            → Kimi K2.5      (fallback)
 *
 * Fallback chain per model:
 *   primary → openrouter/auto (NotDiamond picks best available)
 */

export interface ModelConfig {
  model: string;
  fallback: string;
  maxTokens: number;
  temperature: number;
}

// ── Model ID constants ────────────────────────────────────────────────────────

export const MODELS = {
  KIMI_K2_5:        "moonshotai/kimi-k2.5",
  GLM_5:            "z-ai/glm-5",
  GLM_5V_TURBO:     "z-ai/glm-5v-turbo",
  QWEN_397B:        "qwen/qwen3.5-397b-a17b",
  GEMINI_FLASH:     "google/gemini-2.5-flash-lite",
  GEMINI_PRO:       "google/gemini-2.5-flash",
  AUTO:             "openrouter/auto",
} as const;

// ── Task kind → model ─────────────────────────────────────────────────────────

const KIND_MODEL_MAP: Record<string, ModelConfig> = {
  research: {
    model: MODELS.KIMI_K2_5,
    fallback: MODELS.AUTO,
    maxTokens: 4096,
    temperature: 0.7,
  },
  deep_research: {
    model: MODELS.KIMI_K2_5,
    fallback: MODELS.GEMINI_PRO,
    maxTokens: 8192,
    temperature: 0.5,
  },
  content_generation: {
    model: MODELS.GEMINI_FLASH,
    fallback: MODELS.KIMI_K2_5,
    maxTokens: 2048,
    temperature: 0.9,
  },
  code_change: {
    model: MODELS.GLM_5,
    fallback: MODELS.QWEN_397B,
    maxTokens: 4096,
    temperature: 0.2,
  },
  config_change: {
    model: MODELS.QWEN_397B,
    fallback: MODELS.GLM_5,
    maxTokens: 2048,
    temperature: 0.1,
  },
  improvement_proposal: {
    model: MODELS.GLM_5,
    fallback: MODELS.KIMI_K2_5,
    maxTokens: 4096,
    temperature: 0.4,
  },
  wallet_simulation: {
    model: MODELS.QWEN_397B,
    fallback: MODELS.AUTO,
    maxTokens: 2048,
    temperature: 0.1,
  },
  // ── projecT87 DeFi task kinds ────────────────────────────────────────────────
  defi_plan: {
    model: MODELS.QWEN_397B,       // strong reasoning for DAG planning
    fallback: MODELS.GLM_5,
    maxTokens: 4096,
    temperature: 0.2,
  },
  defi_risk_check: {
    model: MODELS.QWEN_397B,       // deterministic policy evaluation
    fallback: MODELS.AUTO,
    maxTokens: 1024,
    temperature: 0.0,
  },
  defi_health_monitor: {
    model: MODELS.GEMINI_FLASH,    // fast, cheap, frequent polling
    fallback: MODELS.QWEN_397B,
    maxTokens: 1024,
    temperature: 0.1,
  },
  defi_report: {
    model: MODELS.KIMI_K2_5,       // long-context PnL + performance reports
    fallback: MODELS.GEMINI_FLASH,
    maxTokens: 4096,
    temperature: 0.3,
  },
  // ── Agency sales task kinds ──────────────────────────────────────────────────
  market_research: {
    model: MODELS.KIMI_K2_5,       // deep ICP / market analysis
    fallback: MODELS.AUTO,
    maxTokens: 4096,
    temperature: 0.6,
  },
  campaign_generation: {
    model: MODELS.GEMINI_FLASH,    // fast multilingual content
    fallback: MODELS.KIMI_K2_5,
    maxTokens: 2048,
    temperature: 0.9,
  },
  lead_qualification: {
    model: MODELS.GLM_5,           // structured scoring + reasoning
    fallback: MODELS.QWEN_397B,
    maxTokens: 1024,
    temperature: 0.2,
  },
  crm_hygiene: {
    model: MODELS.GEMINI_FLASH,    // fast, cheap, high-volume CRM tasks
    fallback: MODELS.AUTO,
    maxTokens: 1024,
    temperature: 0.1,
  },
  vision: {
    model: MODELS.GLM_5V_TURBO,
    fallback: MODELS.KIMI_K2_5,
    maxTokens: 2048,
    temperature: 0.5,
  },
};

// ── Domain → model override ───────────────────────────────────────────────────

const DOMAIN_MODEL_OVERRIDE: Record<string, Partial<ModelConfig>> = {
  knowledge:          { model: MODELS.KIMI_K2_5 },
  execution_product:  { model: MODELS.GLM_5 },
  execution_infra:    { model: MODELS.QWEN_397B },
  execution_finance:  { model: MODELS.QWEN_397B },
  execution_growth:   { model: MODELS.GEMINI_FLASH },
  governance:         { model: MODELS.GLM_5 },
};

// ── Default ───────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ModelConfig = {
  model: MODELS.KIMI_K2_5,
  fallback: MODELS.AUTO,
  maxTokens: 2048,
  temperature: 0.7,
};

// ── Main resolver ─────────────────────────────────────────────────────────────

export function resolveModel(taskKind: string, agentDomain?: string | null): ModelConfig {
  const kindConfig = KIND_MODEL_MAP[taskKind] ?? { ...DEFAULT_CONFIG };

  // Domain can override the model but keeps kind-level maxTokens + temperature
  if (agentDomain && DOMAIN_MODEL_OVERRIDE[agentDomain]) {
    return {
      ...kindConfig,
      ...DOMAIN_MODEL_OVERRIDE[agentDomain],
    };
  }

  return kindConfig;
}

// ── OpenRouter base URL ───────────────────────────────────────────────────────

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_APP_NAME = "PBOT Nation";
export const OPENROUTER_APP_URL  = "https://bot-nation-api.thejamalshackleford.workers.dev";
