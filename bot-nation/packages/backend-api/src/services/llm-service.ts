/**
 * LLM Service
 *
 * Integrates with Claude API to generate answers for simple queries
 * and research for complex tasks.
 */

// ============================================================================
// Claude API Integration
// ============================================================================

/**
 * Generate an answer for a simple query using Claude
 */
export async function generateAnswer(
  query: string,
  env: { ANTHROPIC_API_KEY?: string },
): Promise<string> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[LLMService] ANTHROPIC_API_KEY not set');
    return `I don't have access to an LLM to answer that right now. Please try again later.`;
  }

  try {
    console.log(`[LLMService] Generating answer for: "${query}"`);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-1',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: `Answer concisely. No filler, no articles, no pleasantries. Short fragments OK. Technical substance exact.\n\n${query}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error(`[LLMService] API error: ${response.status}`);
      return `I encountered an error while processing your question. Please try again.`;
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text: string }>;
    };
    const answer = data.content?.[0]?.text || 'No response generated';

    console.log(`[LLMService] Generated answer: "${answer.substring(0, 100)}..."`);
    return answer;
  } catch (error) {
    console.error('[LLMService] Error generating answer:', error);
    return `I encountered an error while processing your question. Please try again.`;
  }
}

/**
 * Generate research findings for a query
 * Used when tasks need to be executed
 */
export async function generateResearch(
  query: string,
  env: { ANTHROPIC_API_KEY?: string },
): Promise<string> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[LLMService] ANTHROPIC_API_KEY not set');
    return `Research unavailable - API key not configured.`;
  }

  try {
    console.log(`[LLMService] Generating research for: "${query}"`);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-1',
        max_tokens: 2048,
        messages: [
          {
            role: 'user',
            content: `Research this topic. Be thorough but terse — no filler words, no articles, no pleasantries. Facts and analysis only. No markdown bold (**).\n\n${query}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error(`[LLMService] API error: ${response.status}`);
      return `Research could not be completed.`;
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text: string }>;
    };
    const findings = data.content?.[0]?.text || 'No findings generated';

    console.log(`[LLMService] Generated research: "${findings.substring(0, 100)}..."`);
    return findings;
  } catch (error) {
    console.error('[LLMService] Error generating research:', error);
    return `Research could not be completed due to an error.`;
  }
}

/**
 * Format an answer for Telegram display
 */
export function formatAnswer(answer: string, question: string): string {
  return `✅ **Answer**\n\n**Question:** ${question}\n\n${answer}`;
}

/**
 * Format research findings for Telegram display
 */
export function formatResearchResults(findings: string, query: string): string {
  return `📚 **Research Complete**\n\n**Query:** ${query}\n\n${findings}`;
}
