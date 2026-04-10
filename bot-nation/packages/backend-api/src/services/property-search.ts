/**
 * Property Search Service
 * Calls Perplexity Vision to find properties matching Bailey Group criteria
 * Returns structured CSV for ingest
 */

interface SearchResult {
  address: string;
  owner_name: string;
  phone: string;
  rented_units: number;
  total_units: number;
  equity_percent: number;
  estimated_value: number;
  property_status: string;
  timeline: string;
  owner_email?: string;
}

export async function searchPropertiesPerplexity(apiKey: string): Promise<SearchResult[]> {
  const prompt = `You are a real estate research assistant for Bailey Group Acquisitions.

Find 4 off-market commercial multifamily properties matching this profile:
- Geography: Connecticut, Massachusetts, Rhode Island
- Price range: $350k - $750k estimated value
- Property types: Duplexes, triplexes, small multifamily (2-6 units)
- Distress indicators: Pre-foreclosure, tax-delinquent, absentee owners, tired landlords
- Key metrics: 65%+ equity, challenged cashflow, motivated sellers

Search public records, tax databases, and real estate listings.

RETURN ONLY VALID CSV (no markdown, no extra text):
address,owner_name,phone,rented_units,total_units,equity_percent,estimated_value,property_status,timeline,owner_email
"123 Main St, Hartford, CT","John Doe","(860) 555-0123",2,3,72,450000,"pre_foreclosure","30 days","john@example.com"

Rules:
- Address must be complete with city, state
- Equity %= estimated_value_with_liens
- Rented units = currently occupied rental units
- Status must be one of: pre_foreclosure, absentee_distressed, tired_landlord, tax_delinquent
- Timeline = seller urgency (ASAP, 2 weeks, 30 days, 60 days, Flexible)
- Return exactly 4 properties
- Each property on a new line`;

  const response = await fetch("https://api.perplexity.ai/openai/deployments/mistral-7b/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "mistral-7b-instruct",
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.7,
      max_tokens: 2000,
    }),
  });

  if (!response.ok) {
    throw new Error(`Perplexity API error: ${response.status}`);
  }

  const data = (await response.json()) as any;
  const csvContent = data.choices[0].message.content;

  // Parse CSV
  const lines = csvContent.trim().split("\n");
  const results: SearchResult[] = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split('","').map((p) => p.replace(/^"|"$/g, ""));
    if (parts.length < 10) continue;

    results.push({
      address: parts[0],
      owner_name: parts[1],
      phone: parts[2],
      rented_units: parseInt(parts[3]) || 0,
      total_units: parseInt(parts[4]) || 0,
      equity_percent: parseFloat(parts[5]) || 0,
      estimated_value: parseInt(parts[6]) || 0,
      property_status: parts[7],
      timeline: parts[8],
      owner_email: parts[9],
    });
  }

  return results;
}

/**
 * Format results as CSV string for ingest
 */
export function formatAsCSV(results: SearchResult[]): string {
  const header = "address,owner_name,phone,rented_units,total_units,equity_percent,estimated_value,property_status,timeline,owner_email";
  const rows = results.map(
    (r) =>
      `"${r.address}","${r.owner_name}","${r.phone}",${r.rented_units},${r.total_units},${r.equity_percent},${r.estimated_value},"${r.property_status}","${r.timeline}","${r.owner_email || ""}"`,
  );
  return [header, ...rows].join("\n");
}
