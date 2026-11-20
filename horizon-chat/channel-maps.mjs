import { decodeServerBackground } from './server-background.mjs';

const kinds = new Set(['pin', 'label', 'region']);
const pinIcons = new Set(['point', 'settlement', 'landmark', 'water']);
const clean = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const error = (status, message) => ({ status, error: message });
const validPoint = point => Array.isArray(point) && point.length === 2 &&
  point.every(value => Number.isFinite(value) && value >= 0 && value <= 1);

function validGeometry(kind, points) {
  if (!Array.isArray(points) || !points.every(validPoint)) return false;
  if (kind !== 'region') return points.length === 1;
  if (points.length < 3 || points.length > 64) return false;
  const area = points.reduce((sum, [x, y], i) => {
    const [nextX, nextY] = points[(i + 1) % points.length];
    return sum + x * nextY - nextX * y;
  }, 0);
  return Math.abs(area) > 0.000001;
}

export function createChannelMaps(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_map_background (
      channel_id INTEGER PRIMARY KEY REFERENCES server_channels(id) ON DELETE CASCADE,
      image BLOB,
      mime TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS channel_map_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES server_channels(id) ON DELETE CASCADE,
      creator_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
      kind TEXT NOT NULL CHECK(kind IN ('pin', 'label', 'region')),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      color TEXT NOT NULL,
      symbol TEXT NOT NULL,
      geometry TEXT NOT NULL,
      links TEXT NOT NULL,
      image BLOB,
      mime TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS channel_map_items_channel ON channel_map_items(channel_id, id);
  `);
  const background = db.prepare('SELECT revision FROM channel_map_background WHERE channel_id = ? AND image IS NOT NULL');
  const saveBackground = db.prepare(`
    INSERT INTO channel_map_background(channel_id, image, mime) VALUES (?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET image = excluded.image, mime = excluded.mime,
      revision = channel_map_background.revision + 1
  `);
  const fields = 'id, creator_id AS creator, kind, title, description, color, symbol, geometry, links, image IS NOT NULL AS hasImage, revision';
  const items = db.prepare('SELECT ' + fields + ' FROM channel_map_items WHERE channel_id = ? ORDER BY id');
  const item = db.prepare('SELECT ' + fields + ' FROM channel_map_items WHERE channel_id = ? AND id = ?');
  const count = db.prepare('SELECT count(*) AS n FROM channel_map_items WHERE channel_id = ?');
  const add = db.prepare(`
    INSERT INTO channel_map_items(channel_id, creator_id, kind, title, description, color, symbol, geometry, links, image, mime)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
  `);
  const update = db.prepare(`
    UPDATE channel_map_items SET title = ?, description = ?, color = ?, symbol = ?, geometry = ?, links = ?
    WHERE channel_id = ? AND id = ?
  `);
  const move = db.prepare('UPDATE channel_map_items SET geometry = ? WHERE channel_id = ? AND id = ?');
  const saveItemImage = db.prepare(`
    UPDATE channel_map_items SET image = ?, mime = ?, revision = revision + 1 WHERE channel_id = ? AND id = ?
  `);
  const remove = db.prepare('DELETE FROM channel_map_items WHERE channel_id = ? AND id = ?');
  const backgroundImage = db.prepare('SELECT image, mime FROM channel_map_background WHERE channel_id = ?');
  const itemImage = db.prepare('SELECT image, mime FROM channel_map_items WHERE channel_id = ? AND id = ?');
  const mayEdit = (policy, row) => policy.manage || (policy.create && row.creator === policy.viewer);

  function view(policy) {
    const path = '/horizon-chat/api/conversations/' + policy.channel.conversationId + '/map/image/';
    const art = background.get(policy.channel.id);
    return {
      background: art ? path + 'background?v=' + art.revision : '',
      canCreate: policy.create, canManage: policy.manage,
      items: items.all(policy.channel.id).map(row => ({
        id: row.id, kind: row.kind, title: row.title, description: row.description,
        color: row.color, symbol: row.symbol, points: JSON.parse(row.geometry),
        links: JSON.parse(row.links).filter(policy.canLink), editable: mayEdit(policy, row),
        image: row.hasImage ? path + row.id + '?v=' + row.revision : '',
      })),
    };
  }

  function change(policy, data) {
    const channelId = policy.channel.id;
    if (data.action === 'background') {
      if (!policy.manage) return error(403, 'You cannot change the map background.');
      const image = decodeServerBackground(data.image);
      saveBackground.run(channelId, image?.body ?? null, image?.mime ?? null);
      return {};
    }
    const editing = ['update', 'delete', 'move'].includes(data.action);
    if (!editing && data.action !== 'create') return error(400, 'Invalid map action.');
    if (editing && (!Number.isSafeInteger(data.id) || data.id < 1)) return error(400, 'Invalid map location.');
    const previous = editing ? item.get(channelId, data.id) : null;
    if (editing && !previous) return error(404, 'Map location not found.');
    if (editing ? !mayEdit(policy, previous) : !policy.create) return error(403, 'You cannot edit this map location.');
    if (data.action === 'delete') {
      remove.run(channelId, previous.id);
      return {};
    }
    if (data.action === 'move') {
      if (!validGeometry(previous.kind, data.points)) return error(400, 'Choose valid map geometry.');
      move.run(JSON.stringify(data.points), channelId, previous.id);
      return { itemId: previous.id };
    }
    const kind = previous?.kind ?? data.kind;
    const title = clean(data.title, 80);
    const description = clean(data.description, 2500);
    const color = typeof data.color === 'string' && /^#[a-f\d]{6}$/i.test(data.color) ? data.color : '#d774bf';
    const symbol = pinIcons.has(data.symbol) ? data.symbol : 'point';
    const points = (data.points ?? (previous && JSON.parse(previous.geometry)));
    if (!kinds.has(kind) || !title || !validGeometry(kind, points)) return error(400, 'Enter a name and valid map geometry.');
    const links = data.links ?? [];
    if (!Array.isArray(links) || links.length > 24 || !links.every(id => Number.isSafeInteger(id) && policy.canLink(id))) {
      return error(400, 'Choose linked chats you can access on this server.');
    }
    const preserved = previous ? JSON.parse(previous.links).filter(id => !policy.canLink(id) && policy.linkExists(id)) : [];
    const linked = [...new Set([...links, ...preserved])];
    if (kind === 'pin' && !linked.length) return error(400, 'Choose a chat for this pin.');
    if (linked.length > 24) return error(400, 'Choose up to 24 linked chats.');
    const geometry = JSON.stringify(points);
    const linkData = JSON.stringify(linked);
    const image = data.image === undefined ? undefined : decodeServerBackground(data.image);
    if (!previous && count.get(channelId).n >= 250) return error(409, 'This map already has 250 locations.');
    if (previous) {
      update.run(title, description, color, symbol, geometry, linkData, channelId, previous.id);
      if (image !== undefined) saveItemImage.run(image?.body ?? null, image?.mime ?? null, channelId, previous.id);
      return { itemId: previous.id };
    }
    const row = add.get(channelId, policy.viewer, kind, title, description, color, symbol, geometry, linkData, image?.body ?? null, image?.mime ?? null);
    return { itemId: row.id };
  }

  return {
    view,
    update(policy, data) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = change(policy, data);
        db.exec('COMMIT');
        return result;
      } catch (cause) {
        db.exec('ROLLBACK');
        if (cause.code) throw cause;
        return error(400, cause.message);
      }
    },
    serve(channel, asset, response) {
      const file = asset === 'background' ? backgroundImage.get(channel) : itemImage.get(channel, Number(asset));
      if (!file?.image) return false;
      response.writeHead(200, { 'Content-Type': file.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }).end(file.image);
      return true;
    },
  };
}
