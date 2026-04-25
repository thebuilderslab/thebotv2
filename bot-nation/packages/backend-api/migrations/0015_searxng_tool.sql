-- Phase 8C: Switch web_search tool from Brave to SearXNG.
-- SearXNG is self-hosted, no API key required.
-- The endpoint stored here is the fallback base URL used when SEARXNG_BASE_URL
-- env var is not set. Update this value after deploying your SearXNG instance.
--
-- Kind changes: web_search → searxng
-- tool-executor.ts will call GET {endpoint}/search?q=...&format=json

UPDATE tools
SET
  kind        = 'searxng',
  description = 'Search the web using SearXNG (self-hosted metasearch: Google + Bing + DuckDuckGo). Input: { query: string, count?: number }.',
  endpoint    = 'https://searxng-placeholder.up.railway.app',
  updated_at  = datetime('now')
WHERE name = 'web_search';
