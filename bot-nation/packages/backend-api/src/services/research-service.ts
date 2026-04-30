/**
 * Research Service
 *
 * Calls the last30days microservice for multi-platform research.
 * Searches Reddit, X, YouTube, HN, Polymarket, GitHub, etc.
 * and returns synthesized findings.
 */

export interface ResearchRequest {
  topic: string;
  mode?: 'quick' | 'default' | 'deep';
  sources?: string[];
}

export interface ResearchResult {
  topic: string;
  sources_used: string[];
  clusters: number;
  report: string;
  timestamp: string;
}

const DEFAULT_TIMEOUT = 120_000; // 2 minutes for quick mode

/**
 * Run multi-platform research via last30days microservice.
 * Falls back to LLM-only research if service unavailable.
 */
export async function runResearch(
  request: ResearchRequest,
  env: { LAST30DAYS_URL?: string; LAST30DAYS_API_KEY?: string; ANTHROPIC_API_KEY?: string },
): Promise<ResearchResult | null> {
  const baseUrl = env.LAST30DAYS_URL;
  if (!baseUrl) {
    console.log('[ResearchService] LAST30DAYS_URL not set, skipping');
    return null;
  }

  try {
    console.log(`[ResearchService] Requesting research: "${request.topic}" mode=${request.mode || 'quick'}`);

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (env.LAST30DAYS_API_KEY) {
      headers['Authorization'] = `Bearer ${env.LAST30DAYS_API_KEY}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

    const response = await fetch(`${baseUrl}/research`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        topic: request.topic,
        mode: request.mode || 'quick',
        sources: request.sources,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[ResearchService] Error: ${response.status}`);
      return null;
    }

    const result = (await response.json()) as ResearchResult;
    console.log(`[ResearchService] Got ${result.clusters} clusters from ${result.sources_used.length} sources`);
    return result;
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      console.error('[ResearchService] Request timed out');
    } else {
      console.error('[ResearchService] Error:', error);
    }
    return null;
  }
}

/**
 * Format research results for Telegram display
 */
export function formatResearchForTelegram(result: ResearchResult): string {
  const sourceList = result.sources_used.join(', ');
  const header = `Research: ${result.topic}\nSources: ${sourceList}\nClusters: ${result.clusters}\n\n`;

  // Truncate report if too long for Telegram (4096 char limit)
  const maxReport = 4096 - header.length - 50;
  const report = result.report.length > maxReport
    ? result.report.substring(0, maxReport) + '\n\n[truncated]'
    : result.report;

  return header + report;
}
