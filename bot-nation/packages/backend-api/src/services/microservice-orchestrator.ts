/**
 * Microservice Orchestrator
 *
 * Coordinates calls to external research microservices in parallel:
 * - last30days-api: multi-platform research (real-time social + web)
 * - hermes-api: self-improvement + skill synthesis
 * - autoresearchclaw-api: deep academic research (23-stage pipeline)
 */

export interface OrchestratedResearch {
  source: "last30days" | "hermes" | "autoresearchclaw" | "trading";
  query: string;
  result: any;
  metadata: {
    duration_ms: number;
    confidence: number;
    timestamp: string;
  };
}

/**
 * Run research queries across all microservices in parallel
 */
export async function orchestrateResearch(
  query: string,
  env: {
    LAST30DAYS_URL?: string;
    LAST30DAYS_API_KEY?: string;
    HERMES_API_URL?: string;
    HERMES_API_KEY?: string;
    AUTORESEARCHCLAW_URL?: string;
    RESEARCH_API_KEY?: string;
    TRADING_URL?: string;
  },
): Promise<OrchestratedResearch[]> {
  const results: OrchestratedResearch[] = [];
  const promises: Promise<OrchestratedResearch | null>[] = [];

  // Last30days: current events + social trends
  if (env.LAST30DAYS_URL) {
    promises.push(callLast30Days(query, env));
  }

  // Hermes: self-improving synthesis + skill creation
  if (env.HERMES_API_URL) {
    promises.push(callHermes(query, env));
  }

  // AutoResearchClaw: deep academic research
  if (env.AUTORESEARCHCLAW_URL) {
    promises.push(callAutoResearchClaw(query, env));
  }

  // TradingAgents: multi-agent trading analysis for DeFi/stocks
  if (env.TRADING_URL) {
    promises.push(callTrading(query, env));
  }

  const responses = await Promise.allSettled(promises);

  for (const response of responses) {
    if (response.status === "fulfilled" && response.value) {
      results.push(response.value);
    }
  }

  return results;
}

async function callLast30Days(
  query: string,
  env: any,
): Promise<OrchestratedResearch | null> {
  const start = Date.now();
  try {
    const response = await fetch(`${env.LAST30DAYS_URL}/research`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.LAST30DAYS_API_KEY && { Authorization: `Bearer ${env.LAST30DAYS_API_KEY}` }),
      },
      body: JSON.stringify({ topic: query, mode: "quick" }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    return {
      source: "last30days",
      query,
      result: data,
      metadata: {
        duration_ms: Date.now() - start,
        confidence: data.sources_used?.length > 0 ? 0.75 : 0.5,
        timestamp: new Date().toISOString(),
      },
    };
  } catch (error) {
    console.error("[Orchestrator] last30days error:", error);
    return null;
  }
}

async function callHermes(
  query: string,
  env: any,
): Promise<OrchestratedResearch | null> {
  const start = Date.now();
  try {
    const response = await fetch(`${env.HERMES_API_URL}/reason`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.HERMES_API_KEY && { Authorization: `Bearer ${env.HERMES_API_KEY}` }),
      },
      body: JSON.stringify({ query, context: { create_skill: true } }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    return {
      source: "hermes",
      query,
      result: data,
      metadata: {
        duration_ms: Date.now() - start,
        confidence: data.skill_created ? 0.8 : 0.7,
        timestamp: new Date().toISOString(),
      },
    };
  } catch (error) {
    console.error("[Orchestrator] hermes error:", error);
    return null;
  }
}

async function callAutoResearchClaw(
  query: string,
  env: any,
): Promise<OrchestratedResearch | null> {
  const start = Date.now();
  try {
    const response = await fetch(`${env.AUTORESEARCHCLAW_URL}/research`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.RESEARCH_API_KEY && { Authorization: `Bearer ${env.RESEARCH_API_KEY}` }),
      },
      body: JSON.stringify({ topic: query, depth: "medium" }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    return {
      source: "autoresearchclaw",
      query,
      result: data,
      metadata: {
        duration_ms: Date.now() - start,
        confidence: data.confidence || 0.75,
        timestamp: new Date().toISOString(),
      },
    };
  } catch (error) {
    console.error("[Orchestrator] autoresearchclaw error:", error);
    return null;
  }
}

async function callTrading(
  query: string,
  env: any,
): Promise<OrchestratedResearch | null> {
  const start = Date.now();
  try {
    const response = await fetch(`${env.TRADING_URL}/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    return {
      source: "trading",
      query,
      result: data,
      metadata: {
        duration_ms: Date.now() - start,
        confidence: data.confidence || 0.75,
        timestamp: new Date().toISOString(),
      },
    };
  } catch (error) {
    console.error("[Orchestrator] trading error:", error);
    return null;
  }
}

/**
 * Synthesize results from multiple sources into one response
 */
export function synthesizeResults(sources: OrchestratedResearch[]): string {
  if (sources.length === 0) return "No research results available.";

  const sections: string[] = [];

  const last30 = sources.find((s) => s.source === "last30days");
  if (last30) {
    sections.push(`CURRENT EVENTS (${last30.metadata.confidence * 100 | 0}% confidence):\n${last30.result.report}`);
  }

  const hermes = sources.find((s) => s.source === "hermes");
  if (hermes) {
    sections.push(`SYNTHESIZED INSIGHT (skill: ${hermes.result.skill_created || "N/A"}):\n${hermes.result.reasoning}`);
  }

  const research = sources.find((s) => s.source === "autoresearchclaw");
  if (research) {
    sections.push(`ACADEMIC RESEARCH (${research.result.stages_executed} stages):\n${research.result.paper}`);
  }

  const trading = sources.find((s) => s.source === "trading");
  if (trading) {
    const agents = trading.result.agents_involved?.join(", ") || "N/A";
    sections.push(`TRADING ANALYSIS (${trading.result.confidence * 100 | 0}% confidence, ${agents}):\nRecommendation: ${trading.result.recommendation}\nAgents consensus: ${trading.result.agents_consensus}/4`);
  }

  return sections.join("\n\n---\n\n");
}
