-- Phase 7B fix: update Research Lead graph
-- - direct_answer node uses {{task}} so it always has the original question
-- - report node also anchors to {{task}} for context
-- - No tools passed to LLM nodes (tool_call nodes handle tool invocation)

UPDATE agent_graphs
SET definition = '{
  "startNode": "classify",
  "nodes": [
    {
      "id": "classify",
      "kind": "llm_call",
      "label": "Classify Task",
      "prompt": "You are a research classifier. Analyze this research task and output EXACTLY ONE of these labels on the first line, then a brief reason:\n\nNEEDS_SEARCH — requires current or live information from the web\nDIRECT — can be answered from training knowledge alone\n\nTask: {{task}}"
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
      "prompt": "Analyze these search results and identify key themes, facts, and gaps relevant to this question: {{task}}\n\nSearch results:\n{{prev}}"
    },
    {
      "id": "report",
      "kind": "llm_call",
      "label": "Write Report",
      "prompt": "Write a structured research report with sections: Summary, Key Findings, Details, Conclusion.\n\nOriginal question: {{task}}\n\nAnalysis: {{prev}}"
    },
    {
      "id": "direct_answer",
      "kind": "llm_call",
      "label": "Direct Answer",
      "prompt": "Answer this research question thoroughly and accurately. Include key concepts, comparisons where relevant, and a clear conclusion.\n\nQuestion: {{task}}"
    },
    {
      "id": "end",
      "kind": "end",
      "label": "Done"
    }
  ],
  "edges": [
    { "from": "classify",      "to": "search",        "condition": "contains:NEEDS_SEARCH" },
    { "from": "classify",      "to": "direct_answer", "condition": "contains:DIRECT" },
    { "from": "classify",      "to": "direct_answer", "condition": "always" },
    { "from": "search",        "to": "analyze",       "condition": "on_success" },
    { "from": "search",        "to": "direct_answer", "condition": "on_failure" },
    { "from": "analyze",       "to": "report",        "condition": "always" },
    { "from": "report",        "to": "end",           "condition": "always" },
    { "from": "direct_answer", "to": "end",           "condition": "always" }
  ]
}',
updated_at = datetime('now')
WHERE id = 'graph-research-default';
