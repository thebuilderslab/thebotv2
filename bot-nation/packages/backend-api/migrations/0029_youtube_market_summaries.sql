-- =============================================================================
-- Migration 0029: YouTube market summary storage
-- =============================================================================

CREATE TABLE IF NOT EXISTS youtube_market_summaries (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  video_id         TEXT NOT NULL,
  video_title      TEXT,
  video_url        TEXT,
  playlist_url     TEXT,
  published_at     TEXT,
  analyzed_at      TEXT NOT NULL,
  tldr             TEXT,
  sentiment        TEXT CHECK(sentiment IN ('bullish','bearish','neutral','mixed')),
  key_tickers      TEXT,           -- JSON array of ticker strings
  highlights       TEXT NOT NULL,  -- JSON array of MarketHighlight objects
  transcript_chars INTEGER,        -- length of raw transcript used
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_yt_summaries_analyzed  ON youtube_market_summaries(analyzed_at DESC);
CREATE INDEX IF NOT EXISTS idx_yt_summaries_video     ON youtube_market_summaries(video_id);
CREATE INDEX IF NOT EXISTS idx_yt_summaries_sentiment ON youtube_market_summaries(sentiment);
