CREATE TABLE IF NOT EXISTS data_reset_requests (
  id INTEGER PRIMARY KEY,
  requested_by INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK(status IN ('pending','completed','rejected')) DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_pending_data_reset
  ON data_reset_requests(status) WHERE status='pending';

CREATE TABLE IF NOT EXISTS data_reset_votes (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES data_reset_requests(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  vote TEXT NOT NULL CHECK(vote IN ('approved','rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(request_id,user_id)
);

CREATE TABLE IF NOT EXISTS data_reset_archives (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL UNIQUE REFERENCES data_reset_requests(id),
  archived_by INTEGER NOT NULL REFERENCES users(id),
  archived_at TEXT NOT NULL DEFAULT (datetime('now')),
  expense_count INTEGER NOT NULL CHECK(expense_count >= 0),
  settlement_count INTEGER NOT NULL CHECK(settlement_count >= 0),
  archive_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_data_reset_requests_status_date
  ON data_reset_requests(status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_reset_votes_request
  ON data_reset_votes(request_id,created_at);
