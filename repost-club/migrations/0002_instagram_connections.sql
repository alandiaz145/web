PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS instagram_connections (
  user_id INTEGER PRIMARY KEY,
  ig_user_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  account_type TEXT,
  access_token_encrypted TEXT NOT NULL,
  token_expires_at TEXT,
  scopes TEXT NOT NULL,
  connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS instagram_oauth_states (
  state TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS instagram_webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_instagram_state_expiry
ON instagram_oauth_states(expires_at);

CREATE INDEX IF NOT EXISTS idx_instagram_webhook_type
ON instagram_webhook_events(event_type, received_at);
