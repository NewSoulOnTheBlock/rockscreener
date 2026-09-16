-- Indexes Prisma's schema language cannot express.
--
-- Every one of these backs a query that exists in the code; none is
-- speculative. They are all IF NOT EXISTS so this file re-runs on every deploy.

-- THE SCREENER'S SEARCH. `contains` on symbol and name is a sequential scan
-- without trigrams, and the search box fires on every keystroke.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS tokens_symbol_trgm
  ON tokens USING gin (lower(symbol) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS tokens_name_trgm
  ON tokens USING gin (lower(name) gin_trgm_ops);

-- THE SCORER'S SELECTION: never-scored rows first, then stale ones. A partial
-- index over the two tiers that are actually scored keeps it a fraction of the
-- size of the table it is on.
CREATE INDEX IF NOT EXISTS tokens_scoring_queue
  ON tokens (scored_at NULLS FIRST)
  WHERE tier IN ('ACTIVE', 'GRADUATED');

-- THE SELL CHECKER'S SELECTION, same shape and the same reasoning.
CREATE INDEX IF NOT EXISTS tokens_sell_queue
  ON tokens (sell_checked_at NULLS FIRST)
  WHERE tier IN ('ACTIVE', 'GRADUATED');

-- THE MARKET SYNC'S ROUND ROBIN: least recently touched first.
CREATE INDEX IF NOT EXISTS tokens_activity_queue
  ON tokens (last_activity_at NULLS FIRST)
  WHERE tier IN ('SEEDED', 'ACTIVE', 'GRADUATED');

-- THE GRADED LANE. A partial index on the exact condition the lane filters by,
-- so the most-read query in the product never touches an unscored row.
CREATE INDEX IF NOT EXISTS tokens_graded
  ON tokens (score DESC, mint)
  WHERE score IS NOT NULL AND coverage >= 60;

-- THE CALL TRACKER reads every live call on every tick.
CREATE INDEX IF NOT EXISTS calls_live
  ON calls (called_at DESC)
  WHERE outcome = 'live';

-- THE ENGINE'S CANDIDATE QUERY: fresh live calls at a buyable tier.
CREATE INDEX IF NOT EXISTS calls_fresh_buyable
  ON calls (called_at DESC)
  WHERE outcome = 'live' AND tier IN ('strong_buy', 'buy');

-- THE EXIT LOOP reads every open position on every tick, across all users.
CREATE INDEX IF NOT EXISTS positions_open
  ON auto_positions (opened_at)
  WHERE status = 'open';

-- THE ENTRY LOOP reads every armed user on every tick.
CREATE INDEX IF NOT EXISTS settings_armed
  ON auto_settings (user_id)
  WHERE enabled = true;

-- THE CURVE PASS reads least-recently-read first. Without this index the
-- ordering is a sort of every bonding token on every tick.
CREATE INDEX IF NOT EXISTS tokens_curve_queue
  ON tokens (curve_read_at NULLS FIRST)
  WHERE status = 'BONDING';

-- THE METADATA PASS: newest unread first.
CREATE INDEX IF NOT EXISTS tokens_metadata_queue
  ON tokens (first_seen_at DESC)
  WHERE metadata_read_at IS NULL;

-- THE IMAGE PASS: tokens that published a URI and have no picture yet.
CREATE INDEX IF NOT EXISTS tokens_image_queue
  ON tokens (first_seen_at DESC)
  WHERE image_url IS NULL AND metadata_uri IS NOT NULL;
