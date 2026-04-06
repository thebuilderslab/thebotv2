-- Phase 7B: Research Lead classify-first graph + Nation Supervisor graph

-- ── Research Lead: classify-before-execute graph ────────────────────────────
--
-- Flow:
--   classify → (contains:NEEDS_SEARCH) → search → analyze → report → end
--   classify → (contains:DIRECT)       → direct_answer → end
--   classify → (always fallback)        → direct_answer → end
--
-- The classify node asks the model to output exactly one of:
--   NEEDS_SEARCH  — topic needs live web data
--   DIRECT        — can be answered from training knowledge
--   SPAWN         — complex enough to split into sub-researchers

UPDATE agent_graphs
SET definition = '{
  "startNode": "classify",
  "nodes": [
    {
      "id": "classify",
      "kind": "llm_call",
      "label": "Classify Task",
      "prompt": "You are a research classifier. Analyze this research task and output EXACTLY ONE of these labels on the first line, then a brief reason:\n\nNEEDS_SEARCH — requires current/live information from the web\nDIRECT — can be answered from your training knowledge alone\nSPAWN — too broad, needs to be split into multiple parallel sub-research tasks\n\nTask: {{prev}}"
    },
    {
      "id": "search",
      "kind": "tool_call",
      "toolName": "web_search",
      "label": "Web Search"
    },
    {
      "id": "analyze",
      "kind": "llm_call",
      "label": "Analyze Results",
      "prompt": "Analyze these search results and identify key themes, facts, and gaps:\n\n{{prev}}"
    },
    {
      "id": "report",
      "kind": "llm_call",
      "label": "Write Report",
      "prompt": "Write a structured research report with sections: Summary, Key Findings, Details, Conclusion. Base it on:\n\n{{prev}}"
    },
    {
      "id": "direct_answer",
      "kind": "llm_call",
      "label": "Direct Answer",
      "prompt": "Answer this research question thoroughly and accurately. Include key concepts, comparisons where relevant, and a clear conclusion:\n\n{{prev}}"
    },
    {
      "id": "end",
      "kind": "end",
      "label": "Done"
    }
  ],
  "edges": [
    { "from": "classify", "to": "search",        "condition": "contains:NEEDS_SEARCH" },
    { "from": "classify", "to": "direct_answer", "condition": "contains:DIRECT" },
    { "from": "classify", "to": "direct_answer", "condition": "always" },
    { "from": "search",   "to": "analyze",       "condition": "on_success" },
    { "from": "search",   "to": "direct_answer", "condition": "on_failure" },
    { "from": "analyze",  "to": "report",        "condition": "always" },
    { "from": "report",   "to": "end",           "condition": "always" },
    { "from": "direct_answer", "to": "end",      "condition": "always" }
  ]
}',
updated_at = datetime('now')
WHERE id = 'graph-research-default';

-- ── Nation Supervisor: intent-routing graph ───────────────────────────────────
--
-- Supervisor receives all Telegram tasks, classifies intent,
-- emits a structured routing decision as its output.

INSERT OR IGNORE INTO agent_graphs (id, agent_id, name, definition, is_default, created_at, updated_at)
VALUES (
  'graph-supervisor-default',
  'agent-nation-supervisor',
  'Nation Supervisor Routing Graph',
  '{
    "startNode": "assess",
    "nodes": [
      {
        "id": "assess",
        "kind": "llm_call",
        "label": "Assess Request",
        "prompt": "You are the Nation Supervisor. Assess this incoming request and produce a structured briefing:\n\n1. INTENT: (one of: research / code_change / content_generation / config_change / wallet_simulation / improvement_proposal / status_check / governance)\n2. PRIORITY: (low / medium / high)\n3. TEAM: (team-research / team-build / team-infra / team-finance / team-growth)\n4. SUMMARY: one sentence describing what needs to happen\n5. RISKS: any flags or concerns\n\nRequest: {{prev}}"
      },
      {
        "id": "synthesize",
        "kind": "llm_call",
        "label": "Synthesize Response",
        "prompt": "Based on this assessment, write a concise executive summary suitable for reporting back to the operator. Include the routing decision, priority, and any risks:\n\n{{prev}}"
      },
      {
        "id": "end",
        "kind": "end",
        "label": "Done"
      }
    ],
    "edges": [
      { "from": "assess",     "to": "synthesize", "condition": "always" },
      { "from": "synthesize", "to": "end",        "condition": "always" }
    ]
  }',
  1,
  datetime('now'),
  datetime('now')
);
