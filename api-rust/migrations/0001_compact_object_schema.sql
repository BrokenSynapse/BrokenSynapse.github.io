PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS dict (
  group_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY(group_id, id)
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_dict_group_value ON dict(group_id, value);

CREATE TABLE IF NOT EXISTS entity (
  id INTEGER PRIMARY KEY,
  kind INTEGER NOT NULL,
  owner_id INTEGER,
  slug TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_entity_kind ON entity(kind);
CREATE INDEX IF NOT EXISTS idx_entity_owner ON entity(owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_slug ON entity(slug) WHERE slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS entity_state (
  entity_id INTEGER PRIMARY KEY,
  schema_id INTEGER NOT NULL,
  codec INTEGER NOT NULL,
  payload BLOB NOT NULL,
  FOREIGN KEY(entity_id) REFERENCES entity(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS entity_prop (
  entity_id INTEGER NOT NULL,
  key_id INTEGER NOT NULL,
  type_id INTEGER NOT NULL,
  int_v INTEGER,
  real_v REAL,
  text_v TEXT,
  blob_v BLOB,
  PRIMARY KEY(entity_id, key_id),
  FOREIGN KEY(entity_id) REFERENCES entity(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS blob_asset (
  hash BLOB PRIMARY KEY,
  mime_id INTEGER NOT NULL,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  created INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS edge (
  src_id INTEGER NOT NULL,
  edge_kind INTEGER NOT NULL,
  dst_id INTEGER NOT NULL,
  payload BLOB,
  PRIMARY KEY(src_id, edge_kind, dst_id),
  FOREIGN KEY(src_id) REFERENCES entity(id) ON DELETE CASCADE,
  FOREIGN KEY(dst_id) REFERENCES entity(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor_id INTEGER,
  op INTEGER NOT NULL,
  entity_id INTEGER,
  payload BLOB,
  FOREIGN KEY(actor_id) REFERENCES entity(id) ON DELETE SET NULL,
  FOREIGN KEY(entity_id) REFERENCES entity(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_event_log_ts ON event_log(ts);
CREATE INDEX IF NOT EXISTS idx_event_log_entity ON event_log(entity_id);

INSERT OR IGNORE INTO dict(group_id, id, value) VALUES
  (1, 1, 'system'),
  (1, 2, 'user'),
  (1, 10, 'vehicle'),
  (1, 11, 'module'),
  (2, 1, 'json'),
  (2, 2, 'messagepack-reserved'),
  (2, 3, 'cbor-reserved'),
  (3, 1, 'text'),
  (3, 2, 'integer'),
  (3, 3, 'real'),
  (3, 4, 'blob'),
  (4, 1, 'created'),
  (4, 2, 'updated'),
  (5, 1, 'application/json'),
  (5, 2, 'application/octet-stream');
