import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const path = '/horizon-chat/api/profile-media/';
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = /^[a-f0-9]{64}$/;
const maxAsset = 4 * 1024 * 1024;
const maxBytes = 1536 * 1024 * 1024;
const maxAssets = 4096;
const ttl = 60 * 60 * 1000;
const fields = { name: 100, prefix: 100, suffix: 100, group_name: 100, description: 4000, designation: 4, status_text: 120 };
const variantFields = { ...fields, name: 60, display_name: 100 };
const imageFields = ['avatar_url', 'banner_url', 'body_url'];
const external = /^https:\/\/cdn\.tupperbox\.app\/(?:pfp|banner)\/[A-Za-z0-9._~%/-]+$/;
const imageTypes = new Set(['image/png', 'image/webp', 'image/jpeg', 'image/gif']);

function imageMime(bytes) {
  const head = bytes.toString('ascii', 0, 12);
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (head.startsWith('RIFF') && head.slice(8) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) return 'image/webp';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  return null;
}

export function createRecoveryArchives(db, { json, readJson, readBody, sync }) {
  const exports = new Map();
  const restores = new Map();
  let imageUploads = 0;
  const load = db.prepare('SELECT body,mime FROM profile_media WHERE id=?');
  const loadInfo = db.prepare('SELECT length(body) AS size,mime FROM profile_media WHERE id=?');
  const put = db.prepare(`INSERT INTO profile_media(id,body,mime) VALUES(?,?,?)
    ON CONFLICT(id) DO UPDATE SET body=excluded.body,mime=excluded.mime
    WHERE profile_media.body<>excluded.body OR profile_media.mime<>excluded.mime`);
  const roster = db.prepare(`SELECT p.id,${Object.keys(fields).map(key => 'p.' + key)},p.created_at,p.avatar_url,p.banner AS banner_url,
    coalesce(c.body_url,'') AS body_url,coalesce(c.active_variant,0) AS active_variant
    FROM proxies p LEFT JOIN character_profiles c ON c.proxy_id=p.id WHERE p.account_id=? AND p.archived=0 ORDER BY p.id`);
  const variants = db.prepare(`SELECT id,${Object.keys(variantFields)},avatar_url,banner_url,body_url FROM character_variants WHERE proxy_id=? ORDER BY id`);
  const getTheme = db.prepare('SELECT theme FROM account_themes WHERE account_id=?');
  const setTheme = db.prepare('INSERT INTO account_themes VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET theme=excluded.theme');
  const insert = db.prepare(`INSERT INTO proxies(account_id,${Object.keys(fields)},avatar_url,banner,created_at)
    VALUES(${Array(11).fill('?')}) ON CONFLICT(account_id,name,prefix,suffix) DO NOTHING`);
  const insertVariant = db.prepare(`INSERT INTO character_variants(proxy_id,${Object.keys(variantFields)},${imageFields})
    VALUES(${Array(12).fill('?')})`);
  const insertProfile = db.prepare('INSERT INTO character_profiles(proxy_id,body_url,active_variant) VALUES(?,?,?)');
  const exists = db.prepare('SELECT 1 FROM proxies WHERE account_id=? AND name=? AND prefix=? AND suffix=?');

  function releaseFiles(session) {
    if (session.dir) {
      try { rmSync(session.dir, { recursive: true, force: true }); }
      catch (error) { console.error('Could not clear recovery staging:', error.code); }
      session.dir = null;
    }
  }

  function forget(map, session) {
    map.delete(session.id);
    clearTimeout(session.timer);
    releaseFiles(session);
  }

  function retain(map, owner, token, details) {
    for (const item of map.values()) if (item.owner === owner) forget(map, item);
    const active = [...map.values()].filter(item => !item.result).length;
    if (active >= 8) throw new Error('Account recovery is busy. Try again shortly.');
    if (map.size >= 32) forget(map, [...map.values()].find(item => item.result));
    const item = { id: randomUUID(), owner, token, ...details };
    item.timer = setTimeout(() => forget(map, item), ttl);
    item.timer.unref();
    map.set(item.id, item);
    return item;
  }

  function snapshot(owner) {
    const assets = new Map();
    const inline = new Map();
    function refs(row) {
      for (const key of imageFields) {
        const value = row[key];
        if (!value || external.test(value)) continue;
        const embedded = /^data:(image\/(?:png|webp|jpeg|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
        if (embedded) {
          const body = Buffer.from(embedded[2], 'base64');
          if (imageMime(body) !== embedded[1] || body.length > maxAsset) throw new Error('An embedded character image is invalid.');
          const id = hash(body);
          row[key] = id;
          assets.set(id, { size: body.length, mime: embedded[1] });
          inline.set(id, value);
          continue;
        }
        const id = value.startsWith(path) ? value.slice(path.length) : '';
        if (!digest.test(id)) throw new Error('A character image is hosted at an unsupported URL.');
        const media = loadInfo.get(id);
        if (!media || media.size < 1 || media.size > maxAsset || !imageTypes.has(media.mime)) {
          throw new Error('A character image is missing or exceeds the recovery limit.');
        }
        assets.set(id, media);
        row[key] = id;
      }
      return row;
    }
    const characters = roster.all(owner).map(row => {
      const list = variants.all(row.id);
      const active = list.findIndex(v => v.id === row.active_variant) + 1;
      delete row.id;
      delete row.active_variant;
      return { ...refs(row), active, variants: list.map(v => { delete v.id; return refs(v); }) };
    });
    return { characters, theme: getTheme.get(owner)?.theme ?? null, assets, inline };
  }

  function validate(input) {
    if (!input || !Array.isArray(input.characters) || input.characters.length > 500 ||
        !Array.isArray(input.assets) || input.assets.length > maxAssets) throw new Error('Invalid recovery manifest.');
    const assets = new Map();
    let bytes = 0;
    for (const asset of input.assets) {
      if (!asset || typeof asset.id !== 'string' || !digest.test(asset.id) || assets.has(asset.id) ||
          !Number.isInteger(asset.size) || asset.size < 1 || asset.size > maxAsset || !imageTypes.has(asset.mime)) {
        throw new Error('Invalid recovery image descriptor.');
      }
      bytes += asset.size;
      assets.set(asset.id, asset);
    }
    if (bytes > maxBytes) throw new Error('This recovery set exceeds the 1.5 GiB limit.');
    const referenced = new Set();
    function record(row, limits) {
      if (!row || Object.entries(limits).some(([key, limit]) =>
        typeof row[key] !== 'string' || row[key].length > limit || row[key].includes('\0')) ||
        !row.name.trim() || (row.designation && !/^[A-Za-z0-9]{4}$/.test(row.designation))) {
        throw new Error('Invalid character metadata.');
      }
      for (const key of imageFields) {
        const id = row[key];
        if (typeof id !== 'string' || (id && !assets.has(id) && !external.test(id))) throw new Error('Invalid character image reference.');
        if (assets.has(id)) referenced.add(id);
      }
    }
    const identities = new Set();
    for (const row of input.characters) {
      record(row, fields);
      if (typeof row.created_at !== 'string' || row.created_at.length > 100 || row.created_at.includes('\0')) {
        throw new Error('Invalid character creation metadata.');
      }
      if (!Array.isArray(row.variants) || row.variants.length > 32 ||
          !Number.isInteger(row.active) || row.active < 0 || row.active > row.variants.length) throw new Error('Invalid character variants.');
      const identity = JSON.stringify([row.name, row.prefix, row.suffix]);
      if (identities.has(identity)) throw new Error('Duplicate characters in recovery manifest.');
      identities.add(identity);
      for (const variant of row.variants) record(variant, variantFields);
    }
    if (referenced.size !== assets.size) throw new Error('The recovery archive contains unreferenced images.');
    if (input.theme !== null && (typeof input.theme !== 'string' || !/^[a-z0-9-]{1,64}$/.test(input.theme))) {
      throw new Error('Invalid theme preference.');
    }
    return { ...input, assets, bytes };
  }

  function preview(owner, plan) {
    return plan.characters.map(row => ({ name: row.name, variants: row.variants.length,
      conflict: Boolean(exists.get(owner, row.name, row.prefix, row.suffix)) }));
  }

  function commit(item) {
    const { owner, plan } = item;
    if (item.received.size !== plan.assets.size) throw new Error('Upload every verified image before restoring.');
    const url = value => plan.assets.has(value) ? path + value : value;
    let restored = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      const pending = plan.characters.filter(row => !exists.get(owner, row.name, row.prefix, row.suffix));
      const needed = new Set();
      for (const row of pending) {
        for (const profile of [row, ...row.variants]) {
          for (const field of imageFields) if (plan.assets.has(profile[field])) needed.add(profile[field]);
        }
      }
      for (const id of needed) {
        const asset = plan.assets.get(id);
        const bytes = readFileSync(join(item.dir, id));
        if (hash(bytes) !== id || imageMime(bytes) !== asset.mime) throw new Error('A staged image is corrupted.');
        put.run(id, bytes, asset.mime);
      }
      for (const row of pending) {
        const created = insert.run(owner, ...Object.keys(fields).map(key => row[key]), url(row.avatar_url),
          url(row.banner_url), row.created_at);
        if (!created.changes) continue;
        const proxy = Number(created.lastInsertRowid);
        const ids = [0];
        for (const v of row.variants) {
          ids.push(Number(insertVariant.run(proxy, ...Object.keys(variantFields).map(key => v[key]),
            ...imageFields.map(key => url(v[key]))).lastInsertRowid));
        }
        insertProfile.run(proxy, url(row.body_url), ids[row.active]);
        sync(proxy);
        restored++;
      }
      if (plan.restoreTheme && plan.theme) setTheme.run(owner, plan.theme);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { restored, skipped: plan.characters.length - restored };
  }

  return async function routeRecovery(request, response, route, owner, token) {
    try {
      const method = request.method;
      if (route === 'recovery-archive/export' && method === 'GET') {
        const { characters, theme, assets, inline } = snapshot(owner);
        const data = { characters, theme, assets: [...assets].map(([id, asset]) => ({ id, ...asset })) };
        validate(data);
        const item = retain(exports, owner, token, { assets, inline });
        return json(response, 200, { ...data, ticket: item.id });
      }
      const assetRoute = /^recovery-archive\/(export|restore)\/([a-f0-9-]{36})\/([a-f0-9]{64})$/.exec(route);
      if (assetRoute) {
        const [, mode, ticket, id] = assetRoute;
        const item = (mode === 'export' ? exports : restores).get(ticket);
        if (item?.owner !== owner || item.token !== token) return json(response, 404, { error: 'Recovery operation expired.' });
        if (mode === 'export' && method === 'GET' && item.assets.has(id)) {
          const inline = item.inline.get(id);
          const asset = inline ? { body: Buffer.from(inline.slice(inline.indexOf(',') + 1), 'base64') } : load.get(id);
          if (!asset || hash(asset.body) !== id) throw new Error('A stored character image failed verification.');
          return response.writeHead(200, {
            'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          }).end(asset.body);
        }
        if (mode === 'restore' && method === 'POST' && !item.result) {
          const descriptor = item.plan.assets.get(id);
          if (!descriptor) throw new Error('Unexpected recovery image.');
          if (imageUploads >= 4) return json(response, 429, { error: 'Recovery uploads are busy. Try again shortly.' });
          imageUploads++;
          let bytes;
          try { bytes = await readBody(request, descriptor.size); }
          finally { imageUploads--; }
          if (!restores.has(ticket)) return json(response, 404, { error: 'Restore expired.' });
          if (!bytes || bytes.length !== descriptor.size || hash(bytes) !== id || imageMime(bytes) !== descriptor.mime) {
            throw new Error('The recovery image failed SHA-256 or format verification.');
          }
          writeFileSync(join(item.dir, id), bytes, { mode: 0o600 });
          item.received.add(id);
          return json(response, 200, { verified: true });
        }
      }
      if (method === 'POST' && ['recovery-archive/preview', 'recovery-archive/restore'].includes(route)) {
        const plan = validate(await readJson(request, 6 * 1024 * 1024));
        if (route.endsWith('/preview')) return json(response, 200, { characters: preview(owner, plan) });
        const existingBytes = [...restores.values()].filter(item => item.owner !== owner && !item.result)
          .reduce((total, item) => total + item.plan.bytes, 0);
        if (existingBytes + plan.bytes > 2 * 1024 * 1024 * 1024) {
          return json(response, 429, { error: 'Recovery staging is full. Try again shortly.' });
        }
        const item = retain(restores, owner, token, { plan, received: new Set() });
        try {
          item.dir = mkdtempSync(join(process.env.HORIZON_RECOVERY_STAGING || tmpdir(), 'horizon-restore-'));
        } catch (error) {
          forget(restores, item);
          throw error;
        }
        return json(response, 201, { ticket: item.id });
      }
      const action = /^recovery-archive\/restore\/([a-f0-9-]{36})\/(commit|cancel)$/.exec(route);
      if (action && method === 'POST') {
        const item = restores.get(action[1]);
        if (item?.owner !== owner || item.token !== token) return json(response, 404, { error: 'Restore expired.' });
        if (item.result) return json(response, 200, item.result);
        if (action[2] === 'commit') {
          item.result = commit(item);
          releaseFiles(item);
          return json(response, 200, item.result);
        }
        forget(restores, item);
        return json(response, 200, { cancelled: true });
      }
      return json(response, 404, { error: 'Recovery route not found.' });
    } catch (error) {
      return json(response, 400, { error: error.code ? 'Recovery storage is unavailable.' : error.message });
    }
  };
}
