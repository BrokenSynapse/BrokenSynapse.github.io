CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  action TEXT,
  actor TEXT,
  payload_json TEXT
);

CREATE TABLE sheets (
  name TEXT PRIMARY KEY,
  headers_json TEXT NOT NULL DEFAULT '[]',
  rows_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sqlite_sequence(name,seq);
