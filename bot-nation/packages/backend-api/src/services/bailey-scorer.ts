/**
 * Bailey Group Lead Scorer
 * Analyzes property data and generates HOT/WARM/COLD scores
 * Suggests Retell voice script angle based on property profile
 */

import { Anthropic } from "@anthropic-ai/sdk";

interface PropertyInput {
  property_address: string;
  owner_name: string;
  phone: string;
  rented_units: number;
  total_units: number;
  equity_percent: number;
  estimated_value: number;
  property_status: string;
  timeline?: string;
  owner_email?: string;
}

interface ScoringResult {
  property_address: string;
  owner_name: string;
  score: number; // 0-12 scale
  disposition: "hot" | "warm" | "cold";
  reasoning: string;
  call_angle: string;
  script_variables: Record<string, string>;
  confidence: number; // 0-100
}

export async function scoreLead(input: PropertyInput, apiKey: string): Promise<ScoringResult> {
  const client = new Anthropic();

  const prompt = `You are Bailey Group's lead scoring agent. Analyze this property and return a JSON score.

Property Data:
- Address: ${input.property_address}
- Owner: ${input.owner_name}
- Rented Units: ${input.rented_units}/${input.total_units}
- Equity: ${input.equity_percent}%
- Estimated Value: $${input.estimated_value.toLocaleString()}
- Status: ${input.property_status}
- Timeline: ${input.timeline || "Unknown"}
- Phone: ${input.phone}

Scoring Rules (max 12 points):
- Distress (0-4): pre_foreclosure=4, absentee_distressed=3, tired_landlord=2, other=0
- Equity (0-3): 70%+=3, 50-70%=2, 30-50%=1, <30%=0
- Ownership (0-3): individual=3, LLC=2, corporate=1
- Market (0-2): <$400k=2, $400-600k=1, >$600k=0

Return ONLY valid JSON (no markdown, no backticks):
{
  "distress_score": <0-4>,
  "equity_score": <0-3>,
  "ownership_score": <0-3>,
  "market_score": <0-2>,
  "total_score": <0-12>,
  "disposition": "<hot|warm|cold>",
  "reasoning": "<2-sentence explanation>",
  "call_angle": "<specific pitch angle e.g. 'High equity, tired landlord - position as off-market buyer'>",
  "confidence": <0-100>,
  "script_variables": {
    "units_rented": "${input.rented_units}",
    "units_total": "${input.total_units}",
    "equity_pct": "${input.equity_percent}",
    "property_status": "${input.property_status}",
    "estimated_value": "$${input.estimated_value.toLocaleString()}"
  }
}`;

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  let jsonText = response.content[0].type === "text" ? response.content[0].text : "";

  // Remove markdown code blocks if present
  jsonText = jsonText
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  const parsed = JSON.parse(jsonText);

  return {
    property_address: input.property_address,
    owner_name: input.owner_name,
    score: parsed.total_score,
    disposition: parsed.disposition,
    reasoning: parsed.reasoning,
    call_angle: parsed.call_angle,
    script_variables: parsed.script_variables,
    confidence: parsed.confidence,
  };
}

/**
 * Disposition mapping for task routing
 */
export function getNextTaskKind(disposition: "hot" | "warm" | "cold"): string | null {
  return {
    hot: "seller_outbound_call",      // Queue for Retell voice
    warm: "call_transcript_processor", // Review manually first
    cold: null,                         // Archive
  }[disposition] || null;
}
