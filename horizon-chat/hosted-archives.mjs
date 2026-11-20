import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const blockBytes = 1024 * 1024;
const mib = 1024 * 1024;
const sha = /^[a-f0-9]{64}$/;
const archiveId = /^[a-f0-9]{32}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const partialLifetime = 48 * 60 * 60 * 1000;

export function createHostedArchives(db, { json, readJson, readBody, directory = process.env.HORIZON_ARCHIVE_STORE }) {
  if (!directory) return (_request, response) => json(response, 404, { error: 'Hosted recovery storage is disabled.' });
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  db.exec(`
    CREATE TABLE IF NOT EXISTS hosted_archive_settings(owner INTEGER PRIMARY KEY REFERENCES accounts(id),limit_mib INTEGER NOT NULL,days INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS hosted_archives(
      id TEXT PRIMARY KEY, owner INTEGER NOT NULL REFERENCES accounts(id), archive_id TEXT NOT NULL,
      parent TEXT REFERENCES hosted_archives(id), version INTEGER NOT NULL, label TEXT NOT NULL, size INTEGER NOT NULL,
      tags TEXT NOT NULL, uploaded INTEGER NOT NULL DEFAULT 0, digest TEXT, created INTEGER NOT NULL, touched INTEGER NOT NULL,
      UNIQUE(owner, archive_id)
    );
    CREATE INDEX IF NOT EXISTS hosted_archive_parent ON hosted_archives(parent);
  `);
  const select = db.prepare('SELECT * FROM hosted_archives WHERE id=? AND owner=?');
  const byArchive = db.prepare('SELECT * FROM hosted_archives WHERE owner=? AND archive_id=?');
  const children = db.prepare('SELECT 1 FROM hosted_archives WHERE parent=? LIMIT 1');
  const owned = db.prepare(`SELECT id,archive_id,parent,version,label,size,uploaded,digest,created
    FROM hosted_archives WHERE owner=? ORDER BY created DESC`);
  const accountCount = db.prepare('SELECT count(*) AS count FROM hosted_archives WHERE owner=?');
  const purge = db.prepare('DELETE FROM hosted_archives WHERE id=?');
  const policy = db.prepare('SELECT limit_mib AS limitMiB, days FROM hosted_archive_settings WHERE owner=?');
  const savePolicy = db.prepare('INSERT INTO hosted_archive_settings VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET limit_mib=excluded.limit_mib,days=excluded.days');
  const accountUsage = db.prepare('SELECT coalesce(sum(size),0) AS bytes FROM hosted_archives WHERE owner=?');
  const serverUsage = db.prepare('SELECT coalesce(sum(size),0) AS bytes FROM hosted_archives');
  const add = db.prepare('INSERT INTO hosted_archives(id,owner,archive_id,parent,version,label,size,tags,created,touched) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const active = new Set();
  const pathFor = id => join(root, id + '.hca');
  const settings = owner => policy.get(owner) ?? { limitMiB: 2048, days: 0 };
  const summary = row => ({ id: row.id, archive: row.archive_id, parent: row.parent, version: row.version,
    label: row.label, size: row.size, uploaded: row.uploaded, hash: row.digest, created: row.created });
  let lastSweep = 0;
  async function remove(row) {
    if (active.has(row.id) || children.get(row.id)) return false;
    active.add(row.id);
    try {
      await unlink(pathFor(row.id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      purge.run(row.id);
      return true;
    } finally { active.delete(row.id); }
  }

  async function sweep() {
    const now = Date.now();
    if (now - lastSweep < 60_000) return;
    lastSweep = now;
    const expired = db.prepare(`SELECT a.id FROM hosted_archives a
      LEFT JOIN hosted_archive_settings s ON s.owner=a.owner
      WHERE (a.digest IS NULL AND a.touched<?) OR (a.digest IS NOT NULL AND s.days>0 AND a.created + s.days*86400000 < ?)
      ORDER BY a.created DESC LIMIT 100`).all(now - partialLifetime, now);
    for (const row of expired) await remove(row);
  }

  return async function hosted(request, response, route, owner) {
    const error = (status, message) => json(response, status, { error: message });
    try {
      await sweep();
      const method = request.method;
      if (route === '' && method === 'GET') {
        return json(response, 200, { archives: owned.all(owner).map(summary), ...settings(owner), blockBytes });
      }
      if (route === '/settings' && method === 'POST') {
        const input = await readJson(request, 512);
        if (!input || !Number.isInteger(input.limitMiB) || input.limitMiB < 0 || input.limitMiB > 8192 ||
            !Number.isInteger(input.days) || input.days < 0 || input.days > 3650) return error(400, 'Invalid storage or retention limit.');
        savePolicy.run(owner, input.limitMiB, input.days);
        return json(response, 200, settings(owner));
      }
      if (route === '/begin' && method === 'POST') {
        const input = await readJson(request, 128 * 1024);
        if (!input || typeof input.archive !== 'string' || !archiveId.test(input.archive) || input.version !== 1 ||
            !(input.parent === null || typeof input.parent === 'string' && archiveId.test(input.parent)) ||
            !Number.isInteger(input.size) || input.size < 58 || input.size > 1537 * mib ||
            typeof input.label !== 'string' || !/^[a-zA-Z0-9 ._()-]{1,140}\.hca$/i.test(input.label) ||
            !Array.isArray(input.tags) || input.tags.length !== Math.ceil(input.size / blockBytes) ||
            input.tags.some(tag => typeof tag !== 'string' || !sha.test(tag))) return error(400, 'Invalid archive upload manifest.');
        const tags = JSON.stringify(input.tags);
        const previous = byArchive.get(owner, input.archive);
        const parent = input.parent === null ? null : byArchive.get(owner, input.parent);
        if (input.parent && (!parent?.digest || active.has(parent.id))) return error(409, 'Upload the parent archive first.');
        if (previous) {
          if (previous.size !== input.size || previous.tags !== tags || previous.parent !== (parent?.id ?? null)) {
            return error(409, 'This archive ID already belongs to different bytes.');
          }
          return json(response, 200, summary(previous));
        }
        if (accountCount.get(owner).count >= 256 || accountUsage.get(owner).bytes + input.size > settings(owner).limitMiB * mib ||
            serverUsage.get().bytes + input.size > 64 * 1024 * mib) return error(413, 'Hosted archive storage limit reached.');
        const id = randomUUID();
        add.run(id, owner, input.archive, parent?.id ?? null, 1, input.label, input.size, tags, Date.now(), Date.now());
        return json(response, 201, summary(select.get(id, owner)));
      }
      const match = /^\/([a-f0-9-]{36})\/(manifest|block\/([0-9]{1,5})|finish|delete)$/.exec(route);
      const row = match && select.get(match[1], owner);
      if (!row) return error(404, 'Hosted archive not found.');
      const [, id, action, indexText] = match;
      if (action === 'delete' && method === 'POST') {
        return await remove(row) ? json(response, 200, { deleted: true })
          : error(409, 'This backup is in use or has a dependent incremental.');
      }
      const tags = JSON.parse(row.tags);
      if (action === 'manifest' && method === 'GET' && row.digest) return json(response, 200, { ...summary(row), tags, blockBytes });
      if (indexText !== undefined) {
        const index = Number(indexText);
        if (index >= tags.length) return error(404, 'Archive block not found.');
        const offset = index * blockBytes;
        const size = Math.min(blockBytes, row.size - offset);
        if (method === 'GET' && row.digest && !active.has(id)) {
          const file = await open(pathFor(id), 'r');
          try {
            const bytes = Buffer.alloc(size);
            if ((await file.read(bytes, 0, size, offset)).bytesRead !== size || hash(bytes) !== tags[index]) {
              return error(409, 'Hosted archive failed integrity verification.');
            }
            return response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff' }).end(bytes);
          } finally { await file.close(); }
        }
        if (method === 'POST' && !row.digest) {
          if (offset !== row.uploaded || active.has(id) || active.size >= 6) return error(409, 'Check the current upload offset and resume.');
          active.add(id);
          try {
            const bytes = await readBody(request, size);
            if (!bytes || bytes.length !== size || hash(bytes) !== tags[index]) return error(400, 'Archive block failed SHA-256 verification.');
            if (index === 0 && (bytes.toString('ascii', 0, 8) !== 'HORIZHCA' || bytes[8] !== row.version ||
                bytes.subarray(9, 25).toString('hex') !== row.archive_id)) return error(400, 'Archive header does not match the upload manifest.');
            const file = await open(pathFor(id), index === 0 ? 'w+' : 'r+', 0o600);
            try {
              if ((await file.write(bytes, 0, size, offset)).bytesWritten !== size) return error(503, 'Archive storage is full.');
              await file.sync();
            } finally { await file.close(); }
            db.prepare('UPDATE hosted_archives SET uploaded=?,touched=? WHERE id=?').run(offset + size, Date.now(), id);
            return json(response, 200, { uploaded: offset + size });
          } finally { active.delete(id); }
        }
      }
      if (action === 'finish' && method === 'POST') {
        if (row.digest) return json(response, 200, summary(row));
        if (row.uploaded !== row.size || active.has(id) || active.size >= 6) return error(409, 'Upload all verified blocks first.');
        active.add(id);
        try {
          const digest = createHash('sha256');
          const file = await open(pathFor(id), 'r');
          try {
            for (const [index, tag] of tags.entries()) {
              const size = Math.min(blockBytes, row.size - index * blockBytes);
              const data = Buffer.alloc(size);
              if ((await file.read(data, 0, size, index * blockBytes)).bytesRead !== size || hash(data) !== tag) {
                return error(409, 'Stored archive failed integrity verification.');
              }
              digest.update(data);
            }
          } finally { await file.close(); }
          db.prepare('UPDATE hosted_archives SET digest=?,touched=? WHERE id=?').run(digest.digest('hex'), Date.now(), id);
          return json(response, 200, summary(select.get(id, owner)));
        } finally { active.delete(id); }
      }
      return error(404, 'Hosted archive action not available.');
    } catch (failure) {
      console.error('Hosted archive operation failed:', failure.code || failure.name);
      return error(503, 'Hosted archive storage is unavailable.');
    }
  };
}
