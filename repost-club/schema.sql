PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  instagram_username TEXT,
  points INTEGER NOT NULL DEFAULT 50 CHECK(points >= 0),
  trust_score INTEGER NOT NULL DEFAULT 100 CHECK(trust_score BETWEEN 0 AND 100),
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  platform TEXT NOT NULL DEFAULT 'instagram',
  url TEXT NOT NULL UNIQUE,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','expired','cancelled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS post_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  action_type TEXT NOT NULL CHECK(action_type IN ('like','comment','repost','mention')),
  reward_points INTEGER NOT NULL CHECK(reward_points > 0),
  target_count INTEGER NOT NULL DEFAULT 1 CHECK(target_count > 0),
  completed_count INTEGER NOT NULL DEFAULT 0 CHECK(completed_count >= 0),
  verification_mode TEXT NOT NULL DEFAULT 'manual' CHECK(verification_mode IN ('manual','automatic','trust')),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  UNIQUE(post_id, action_type)
);

CREATE TABLE IF NOT EXISTS participations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_action_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed' CHECK(status IN ('claimed','verified','rejected')),
  evidence TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (post_action_id) REFERENCES post_actions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(post_action_id, user_id)
);

CREATE TABLE IF NOT EXISTS point_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('signup_bonus','campaign_hold','campaign_refund','action_reward','admin_adjustment')),
  post_id INTEGER,
  participation_id INTEGER,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE SET NULL,
  FOREIGN KEY (participation_id) REFERENCES participations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_active ON posts(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_actions_post ON post_actions(post_id);
CREATE INDEX IF NOT EXISTS idx_participations_user ON participations(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON point_transactions(user_id, created_at);
