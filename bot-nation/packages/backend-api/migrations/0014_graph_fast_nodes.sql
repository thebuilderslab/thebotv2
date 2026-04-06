-- Phase 8B fix: all graph LLM nodes now use Gemini Flash.
-- Kimi K2.5 first-token latency (60-120s) was causing AbortErrors on analyze/report nodes.
-- Graph = fast structured pipeline (Flash). Flat loop = deep research (Kimi).
--
-- Model strategy:
--   classify      → gemini-2.5-flash-lite  (already set — tiny classification task)
--   analyze       → gemini-2.5-flash       (summarise search results, ~10s)
--   report        → gemini-2.5-flash       (structured write-up, ~15s)
--   direct_answer → gemini-2.5-flash       (knowledge answer, ~10s)
--   flat-loop     → Kimi K2.5 (unchanged)  (deep research agentic loop)

UPDATE agent_graphs
SET definition = '{
  "startNode": "classify",
  "nodes": [
    {
      "id": "classify",
      "kind": "llm_call",
      "label": "Classify Task",
      "model": "google/gemini-2.5-flash-lite",
      "prompt": "You are a research classifier. Read the task and output EXACTLY ONE label on the first line, then a brief reason.\n\nNEEDS_SEARCH — requires current or live information from the web\nDIRECT — can be answered from training knowledge alone\n\nTask: {{task}}"
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
      "model": "google/gemini-2.5-flash",
      "prompt": "Analyze these search results and identify key themes, facts, and gaps relevant to this question: {{task}}\n\nSearch results:\n{{prev}}"
    },
    {
      "id": "report",
      "kind": "llm_call",
      "label": "Write Report",
      "model": "google/gemini-2.5-flash",
      "prompt": "Write a structured research report with sections: Summary, Key Findings, Details, Conclusion.\n\nOriginal question: {{task}}\n\nAnalysis: {{prev}}"
    },
    {
      "id": "direct_answer",
      "kind": "llm_call",
      "label": "Direct Answer",
      "model": "google/gemini-2.5-flash",
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
