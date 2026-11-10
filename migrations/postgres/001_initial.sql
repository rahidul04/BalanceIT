CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (LOWER(username));

CREATE TABLE IF NOT EXISTS expenses (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  amount_paise BIGINT NOT NULL CHECK(amount_paise > 0),
  category TEXT NOT NULL,
  expense_date TEXT NOT NULL,
  expense_type TEXT NOT NULL CHECK(expense_type IN ('shared','personal')),
  paid_by BIGINT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')) DEFAULT 'pending',
  rejection_reason TEXT,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS expense_participants (
  id BIGSERIAL PRIMARY KEY,
  expense_id BIGINT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id),
  share_paise BIGINT NOT NULL CHECK(share_paise >= 0),
  UNIQUE(expense_id, user_id)
);
CREATE TABLE IF NOT EXISTS expense_votes (
  id BIGSERIAL PRIMARY KEY,
  expense_id BIGINT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id),
  vote TEXT NOT NULL CHECK(vote IN ('approved','rejected')),
  rejection_reason TEXT,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(expense_id, user_id)
);
CREATE TABLE IF NOT EXISTS settlements (
  id BIGSERIAL PRIMARY KEY,
  payer_id BIGINT NOT NULL REFERENCES users(id),
  receiver_id BIGINT NOT NULL REFERENCES users(id),
  amount_paise BIGINT NOT NULL CHECK(amount_paise > 0),
  payment_date TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending_confirmation','confirmed')) DEFAULT 'pending_confirmation',
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_at TIMESTAMP WITHOUT TIME ZONE,
  CHECK(payer_id != receiver_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  related_type TEXT,
  related_id BIGINT,
  is_read INTEGER NOT NULL DEFAULT 0 CHECK(is_read IN (0,1)),
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expired BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_expenses_status_date ON expenses(status, expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_payer ON expenses(paid_by, status);
CREATE INDEX IF NOT EXISTS idx_votes_expense ON expense_votes(expense_id);
CREATE INDEX IF NOT EXISTS idx_settlements_status ON settlements(status, payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
