import { createHash } from 'node:crypto';
import { validateEmojiImage } from './emoji-images.mjs';

export const emojiIdentity = '[1-9a-f][0-9a-f]{0,12}(?:\\.[1-9a-f][0-9a-f]{0,12})?';
export const emojiReference = new RegExp('^<e:(' + emojiIdentity + ')>$');
const assetPath = '/horizon-chat/api/emoji-art/';
const reference = (slot, generation) => '<e:' + slot.toString(16) + (generation ? '.' + generation.toString(16) : '') + '>';
const namePattern = /^[a-z0-9_]{2,32}$/;
const fail = (status, error) => ({ status, error });

export function emojiCounts(format) {
  const counts = new Map();
  function visit(nodes) {
    for (const node of nodes) {
      if (node?.tag === 'emoji') counts.set(node.ref, (counts.get(node.ref) || 0) + 1);
      else if (node?.children) visit(node.children);
    }
  }
  const rich = format?.kind === 'document' ? format.caption : format;
  if (rich?.kind === 'rich') visit(rich.nodes);
  return counts;
}

export function createEmojis(db, transaction) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS emoji_slots (
      id INTEGER PRIMARY KEY,
      generation INTEGER NOT NULL,
      vacant INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS emoji_vacancies ON emoji_slots(vacant, id);
    CREATE TABLE IF NOT EXISTS emoji_assets (
      hash TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      body BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS emoji_generations (
      slot INTEGER NOT NULL REFERENCES emoji_slots(id),
      generation INTEGER NOT NULL,
      server_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      asset TEXT REFERENCES emoji_assets(hash),
      active INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(slot, generation)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS emoji_active_names
      ON emoji_generations(server_id, name) WHERE active = 1;
    CREATE TABLE IF NOT EXISTS emoji_legacy_refs (
      server_id INTEGER NOT NULL REFERENCES chat_servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slot INTEGER NOT NULL,
      generation INTEGER NOT NULL,
      PRIMARY KEY(server_id, name),
      FOREIGN KEY(slot, generation) REFERENCES emoji_generations(slot, generation)
    );
  `);
  const insertAsset = db.prepare('INSERT OR IGNORE INTO emoji_assets VALUES (?, ?, ?)');
  const vacant = db.prepare('SELECT id, generation FROM emoji_slots WHERE vacant = 1 ORDER BY id LIMIT 1');
  const claim = db.prepare('UPDATE emoji_slots SET generation = ?, vacant = 0 WHERE id = ?');
  const newSlot = db.prepare('INSERT INTO emoji_slots (generation) VALUES (0)');
  const insert = db.prepare('INSERT INTO emoji_generations VALUES (?, ?, ?, ?, ?, 1)');
  const active = db.prepare('SELECT slot, generation, name FROM emoji_generations WHERE server_id = ? AND active = 1 ORDER BY name');
  const archived = db.prepare('SELECT slot, generation, name FROM emoji_generations WHERE server_id = ? AND active = 0 AND asset IS NOT NULL ORDER BY name, slot, generation');
  const activeCount = db.prepare('SELECT count(*) AS count FROM emoji_generations WHERE server_id = ? AND active = 1');
  const legacy = db.prepare('SELECT name, slot, generation FROM emoji_legacy_refs WHERE server_id = ? ORDER BY name');
  const find = db.prepare('SELECT * FROM emoji_generations WHERE slot = ? AND generation = ?');
  const byName = db.prepare('SELECT * FROM emoji_generations WHERE server_id = ? AND name = ? AND active = 1');
  const rename = db.prepare('UPDATE emoji_generations SET name = ? WHERE slot = ? AND generation = ?');
  const detach = db.prepare('UPDATE emoji_generations SET server_id = -server_id WHERE server_id = ?');
  const retire = db.prepare('UPDATE emoji_generations SET active = 0 WHERE slot = ? AND generation = ?');
  const release = db.prepare('UPDATE emoji_slots SET vacant = 1 WHERE id = ?');
  const purge = db.prepare('UPDATE emoji_generations SET asset = NULL WHERE slot = ? AND generation = ?');
  const collect = db.prepare('DELETE FROM emoji_assets WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM emoji_generations WHERE asset = ?)');
  const image = db.prepare(`
    SELECT a.mime, a.body FROM emoji_generations g JOIN emoji_assets a ON a.hash = g.asset
    WHERE g.slot = ? AND g.generation = ?
  `);
  const access = db.prepare(`
    SELECT 1 FROM emoji_generations g JOIN chat_server_members m ON m.server_id = g.server_id
    WHERE g.slot = ? AND g.generation = ? AND g.active = 1 AND m.account_id = ?
  `);

  function store(server, name, mime, body) {
    const hash = createHash('sha256').update(body).digest('hex');
    insertAsset.run(hash, mime, body);
    const next = vacant.get();
    const generation = next ? next.generation + 1 : 0;
    const slot = next ? next.id : Number(newSlot.run().lastInsertRowid);
    if (next) claim.run(generation, slot);
    insert.run(slot, generation, server, name, hash);
    return [slot, generation];
  }

  function remove(emoji) {
    retire.run(emoji.slot, emoji.generation);
    release.run(emoji.slot);
  }

  // Migrate the previous WebP catalog once, preserving the mapping used by older messages.
  transaction(() => {
    const previous = db.prepare(`
      SELECT e.server_id, e.name, p.body FROM server_emojis e
      JOIN profile_media p ON e.url = '/horizon-chat/api/profile-media/' || p.id
      ORDER BY e.server_id, e.name
    `).all();
    if (!previous.length) return;
    const preserve = db.prepare('INSERT INTO emoji_legacy_refs VALUES (?, ?, ?, ?)');
    for (const row of previous) {
      preserve.run(row.server_id, row.name, ...store(row.server_id, row.name, 'image/webp', row.body));
    }
    db.exec(`
      DELETE FROM server_emojis;
      DELETE FROM profile_media
        WHERE EXISTS (SELECT 1 FROM emoji_assets WHERE hash = profile_media.id)
          AND NOT EXISTS (SELECT 1 FROM accounts WHERE avatar_url = '/horizon-chat/api/profile-media/' || profile_media.id OR banner_url = '/horizon-chat/api/profile-media/' || profile_media.id)
          AND NOT EXISTS (SELECT 1 FROM proxies WHERE avatar_url = '/horizon-chat/api/profile-media/' || profile_media.id OR banner = '/horizon-chat/api/profile-media/' || profile_media.id)
          AND NOT EXISTS (SELECT 1 FROM chat_servers WHERE icon_url = '/horizon-chat/api/profile-media/' || profile_media.id OR background_url = '/horizon-chat/api/profile-media/' || profile_media.id);
    `);
  });

  function metadata(row) {
    const ref = reference(row.slot, row.generation);
    return { ref, name: row.name, url: assetPath + ref.slice(3, -1) };
  }

  return {
    catalog(server, canPurge = false) {
      return {
        emojis: active.all(server).map(metadata),
        retiredEmojis: canPurge ? archived.all(server).map(metadata) : [],
        legacyEmojis: legacy.all(server).map(metadata),
      };
    },
    removeServer(server) {
      for (const row of active.all(server)) remove(row);
      detach.run(server);
    },
    edit(server, data, { canPurge, audit }) {
      const name = typeof data.name === 'string' ? data.name.trim().toLowerCase() : '';
      const id = typeof data.ref === 'string' && emojiReference.exec(data.ref)?.[1];
      const action = data.purge ? 'purge' : data.remove ? 'remove' : data.ref ? 'rename' : 'upload';
      if (action === 'purge' && !canPurge) return fail(403, 'Only the server owner can purge emoji artwork.');
      if (['rename', 'upload'].includes(action) && !namePattern.test(name)) {
        return fail(400, 'Use 2–32 letters, numbers, or underscores for the emoji name.');
      }
      if (action !== 'upload' && !id) return fail(400, 'Invalid emoji reference.');
      const uploaded = action === 'upload' && validateEmojiImage(data.image);
      if (action === 'upload' && !uploaded) return fail(400, 'Choose a valid PNG, WebP, or GIF up to 220 KB and 128 × 128 pixels.');
      return transaction(() => {
        const target = id && find.get(...withGeneration(id));
        if (action !== 'upload' && (!target || target.server_id !== server || !target.asset ||
            (action === 'purge' ? target.active : !target.active))) return fail(404, 'Emoji not found.');
        const duplicate = name && byName.get(server, name);
        if (['rename', 'upload'].includes(action) && duplicate && duplicate.slot !== target?.slot) {
          return fail(409, 'This server already has an emoji with that name.');
        }
        if (action === 'upload') {
          if (activeCount.get(server).count >= 50) return fail(409, 'This server already has 50 emojis.');
          store(server, name, uploaded.mime, uploaded.body);
        } else if (action === 'rename') {
          rename.run(name, target.slot, target.generation);
        } else if (action === 'remove') {
          remove(target);
        } else {
          purge.run(target.slot, target.generation);
          collect.run(target.asset, target.asset);
        }
        audit({ upload: 'Uploaded emoji', rename: 'Renamed emoji', remove: 'Removed emoji', purge: 'Purged emoji artwork' }[action],
          ':' + (name || target.name) + ':');
        return {};
      });
    },
    mayUse(account, format, previous) {
      const existing = emojiCounts(previous);
      for (const [ref, count] of emojiCounts(format)) {
        if (count > (existing.get(ref) || 0) && !access.get(...withGeneration(ref.slice(3, -1)), account)) return false;
      }
      return true;
    },
    serve(id, request, response) {
      if (!emojiReference.test('<e:' + id + '>')) return false;
      const asset = image.get(...withGeneration(id));
      if (!asset) return false;
      const etag = '"' + id + '"';
      const headers = { 'Cache-Control': 'private, no-cache', 'ETag': etag, 'X-Content-Type-Options': 'nosniff' };
      if (request.headers['if-none-match'] === etag) response.writeHead(304, headers).end();
      else response.writeHead(200, { ...headers, 'Content-Type': asset.mime }).end(asset.body);
      return true;
    },
  };

  function withGeneration(id) {
    const [slot, generation = 0] = id.split('.').map(part => Number.parseInt(part, 16));
    return [slot, generation];
  }
}
