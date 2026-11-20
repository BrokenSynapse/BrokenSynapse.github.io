import { randomInt } from 'node:crypto';

export const defaultDisplayName = 'Horizon member';
const tagCount = 36 ** 4;
const identityKey = value => value.normalize('NFC').toLowerCase();
const publicTag = /^[A-Z0-9]{4}$/;

export function sharesLoginName(displayName, username) {
  const displayKey = identityKey(displayName);
  const login = identityKey(username).split(':')[0];
  return displayKey === login || (/[#:][a-z0-9]{4}$/.test(displayKey) && displayKey.slice(0, -5) === login);
}

export function createPublicHandles(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('accounts')").all().map(row => row.name));
    if (!columns.has('display_key')) db.exec("ALTER TABLE accounts ADD COLUMN display_key TEXT NOT NULL DEFAULT ''");
    if (!columns.has('public_tag')) db.exec("ALTER TABLE accounts ADD COLUMN public_tag TEXT NOT NULL DEFAULT ''");
    const pending = db.prepare("SELECT id, username, display_name FROM accounts WHERE public_tag = '' ORDER BY id").all();
    const update = db.prepare('UPDATE accounts SET display_name = ?, display_key = ?, public_tag = ? WHERE id = ?');
    const usedTag = db.prepare('SELECT 1 FROM accounts WHERE display_key = ? AND public_tag = ?');
    for (const row of pending) {
      const storedName = row.display_name.trim();
      const name = storedName && !sharesLoginName(storedName, row.username) ? storedName : defaultDisplayName;
      const tag = allocateTag((key, tag) => usedTag.get(key, tag), identityKey(name), row.username.slice(-4).toUpperCase());
      update.run(name, identityKey(name), tag, row.id);
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS account_public_handle ON accounts(display_key, public_tag)');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const lookup = db.prepare('SELECT id FROM accounts WHERE display_key = ? AND public_tag = ?');
  const tagInUse = db.prepare('SELECT 1 FROM accounts WHERE display_key = ? AND public_tag = ? AND id <> ?');
  return {
    find(value) {
      const match = typeof value === 'string' && /^(.+)[#:](\w{4})$/su.exec(value.trim());
      const name = match && match[1].trim();
      const tag = match && match[2].toUpperCase();
      if (name && name.length <= 40 && publicTag.test(tag)) return lookup.get(identityKey(name), tag);
    },
    allocate(name, tag, accountId = 0) {
      const key = identityKey(name);
      return [key, allocateTag((key, value) => tagInUse.get(key, value, accountId), key, tag)];
    },
  };
}

function allocateTag(used, key, preferred) {
  if (publicTag.test(preferred) && !used(key, preferred)) return preferred;
  const start = randomInt(tagCount);
  for (let i = 0; i < tagCount; i++) {
    const tag = ((start + i) % tagCount).toString(36).toUpperCase().padStart(4, '0');
    if (!used(key, tag)) return tag;
  }
  throw new Error('No public tags are available for this display name.');
}
