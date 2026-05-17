import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import cors from 'cors';
import zlib from 'zlib';
import { rows as storeRows, ensureSheet as storeEnsureSheet, appendRow as storeAppendRow, updateRows as storeUpdateRows, listSheets, getSheet, putSheet, appendAudit } from './lib/store.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const memCache = new Map();

app.use(cors());
app.use(express.text({ type: ['text/*','application/json'], limit: '25mb' }));
app.use(express.json({ type: 'application/json', limit: '25mb' }));



// -----------------------------------------------------------------------------
// FileExplorer.LMX asset endpoints
// Jailed to /assets. This exposes only public site asset files.
// -----------------------------------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});


const ASSET_ROOT = process.env.ASSET_ROOT || '/site/lmi/assets';
const ASSET_URL_PREFIX = process.env.ASSET_URL_PREFIX || '/lmi/assets';

const ASSET_ALLOWED_EXT = new Set([
  '.png','.jpg','.jpeg','.webp','.gif','.svg',
  '.json','.txt','.csv','.md',
  '.mp3','.wav','.ogg',
  '.mp4','.webm',
  '.glb','.gltf','.obj','.mtl',
  '.pdf'
]);

const ICON_PACK_ROOT_REL = 'icon-packs';
const ICON_PACK_ALLOWED_ICON_EXT = new Set(['.png','.jpg','.jpeg','.webp','.gif','.svg']);

function assetCleanPart_(part) {
  return String(part || '')
    .replace(/[^a-zA-Z0-9._() -]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96);
}

function safeAssetName_(name, fallbackExt = '') {
  const givenExt = path.extname(name || '').toLowerCase();
  const fallback = String(fallbackExt || '').toLowerCase();
  const ext = ASSET_ALLOWED_EXT.has(givenExt) ? givenExt : (ASSET_ALLOWED_EXT.has(fallback) ? fallback : '.bin');
  const base = assetCleanPart_(path.basename(name || 'asset', givenExt)) || 'asset';
  return { base, ext };
}

function userFromRequest_(req) {
  let body = req.body;

  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  if (!body || typeof body !== 'object') body = {};

  const raw =
    body.user ||
    body.lmiUser ||
    req.headers['x-lmi-user'] ||
    req.query.user;

  if (!raw) return {};
  if (typeof raw === 'object') return raw;

  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

function coreIsAdmin_(c) {
  return String(c?.al || c?.access || c?.role || '').trim().toLowerCase() === 'admin';
}

function requireLmiAdmin_(req, res, label = 'Admin access required.') {
  try {
    const c = coreFromUserStrict_(userFromRequest_(req));
    if (coreIsAdmin_(c)) return c;
  } catch {}

  res.status(403).json({ ok: false, error: label });
  return null;
}

function assetRelFromInput_(input) {
  let p = String(input || '').trim();

  // Normalize slashes and remove fake drive prefix.
  p = p.replace(/\\/g, '/');
  p = p.replace(/^LMC:\s*/i, '');

  // Strip query/hash if a copied URL-like path gets passed.
  p = p.split('?')[0].split('#')[0];

  // Normalize leading slashes.
  p = p.replace(/^\/+/, '');

  // Accepted roots:
  //   /lmi/assets
  //   lmi/assets
  //   /assets
  //   assets
  // Everything after those roots becomes the relative jail path.
  if (p === '' || p === 'lmi' || p === 'lmi/assets' || p === 'assets') {
    return '';
  }

  if (p.startsWith('lmi/assets/')) {
    p = p.slice('lmi/assets/'.length);
  } else if (p.startsWith('assets/')) {
    p = p.slice('assets/'.length);
  }

  // Clean each segment but preserve normal readable filenames.
  const parts = p
    .split('/')
    .map(x => assetCleanPart_(x))
    .filter(Boolean)
    .filter(x => x !== '.' && x !== '..');

  return parts.join('/');
}

function assetFullPath_(input) {
  const rel = assetRelFromInput_(input);
  const root = path.resolve(ASSET_ROOT);
  const full = rel ? path.resolve(root, rel) : root;

  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error('Asset path escaped jail.');
  }

  return { rel, full };
}

function assetWebPath_(rel) {
  rel = assetRelFromInput_(rel);
  return rel ? `${ASSET_URL_PREFIX}/${rel}`.replace(/\/+/g, '/') : ASSET_URL_PREFIX;
}

function safeIconPackId_(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'icon-pack';
}

function readZipEntries_(buffer) {
  const sig = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65558); i--) {
    if (buffer.readUInt32LE(i) === sig) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Invalid zip: central directory not found.');

  const count = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  let off = cdOffset;

  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(off) !== 0x02014b50) throw new Error('Invalid zip central directory.');
    const method = buffer.readUInt16LE(off + 10);
    const compressedSize = buffer.readUInt32LE(off + 20);
    const uncompressedSize = buffer.readUInt32LE(off + 24);
    const nameLen = buffer.readUInt16LE(off + 28);
    const extraLen = buffer.readUInt16LE(off + 30);
    const commentLen = buffer.readUInt16LE(off + 32);
    const localOffset = buffer.readUInt32LE(off + 42);
    const name = buffer.slice(off + 46, off + 46 + nameLen).toString('utf8').replace(/\\/g, '/');

    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

function zipEntryData_(buffer, entry) {
  const off = entry.localOffset;
  if (buffer.readUInt32LE(off) !== 0x04034b50) throw new Error('Invalid zip local header.');
  const nameLen = buffer.readUInt16LE(off + 26);
  const extraLen = buffer.readUInt16LE(off + 28);
  const start = off + 30 + nameLen + extraLen;
  const raw = buffer.slice(start, start + entry.compressedSize);

  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`Unsupported zip compression method ${entry.method}: ${entry.name}`);
}

function cleanZipPath_(value) {
  const p = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!p || p.includes('\0') || p.split('/').some(part => !part || part === '.' || part === '..')) return '';
  return p;
}

function validateIconPackZip_(buffer) {
  const entries = readZipEntries_(buffer);
  if (entries.length > 80) throw new Error('Icon pack zip has too many files.');

  const byName = new Map();
  for (const entry of entries) {
    if (String(entry.name || '').endsWith('/')) continue;
    const clean = cleanZipPath_(entry.name);
    if (!clean) throw new Error(`Unsafe zip path: ${entry.name}`);
    if (entry.uncompressedSize > 8 * 1024 * 1024) throw new Error(`Zip entry too large: ${clean}`);
    byName.set(clean, entry);
  }

  const packEntry = byName.get('pack.json');
  if (!packEntry) throw new Error('Icon pack must include pack.json at the zip root.');
  const pack = JSON.parse(zipEntryData_(buffer, packEntry).toString('utf8'));
  const packId = safeIconPackId_(pack.id || pack.name);
  if (!packId || !pack.apps || typeof pack.apps !== 'object') throw new Error('pack.json must include id/name and apps.');

  const files = [];
  for (const [appId, spec] of Object.entries(pack.apps)) {
    if (!spec || typeof spec !== 'object') throw new Error(`Invalid app entry: ${appId}`);
    const icon = cleanZipPath_(spec.icon || '');
    if (!icon) continue;
    if (!icon.startsWith('icons/')) throw new Error(`Icon path must live under icons/: ${icon}`);
    if (!ICON_PACK_ALLOWED_ICON_EXT.has(path.extname(icon).toLowerCase())) throw new Error(`Icon type not allowed: ${icon}`);
    if (!byName.has(icon)) throw new Error(`Missing icon file referenced by pack.json: ${icon}`);
    files.push(icon);
  }

  return {
    pack: Object.assign({}, pack, { id: packId }),
    files: [...new Set(files)].sort(),
    entries: entries.filter(e => !String(e.name || '').endsWith('/')).map(e => ({ path: e.name, size: e.uncompressedSize, compressedSize: e.compressedSize }))
  };
}

async function writeIconPackManifest_() {
  const root = assetFullPath_(ICON_PACK_ROOT_REL);
  await fs.mkdir(root.full, { recursive: true });
  const dirs = await fs.readdir(root.full, { withFileTypes: true }).catch(() => []);
  const packs = [];

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const manifestPath = path.join(root.full, dir.name, 'pack.json');
    try {
      const pack = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      packs.push({
        id: pack.id || dir.name,
        name: pack.name || pack.id || dir.name,
        type: pack.type || 'image',
        manifest: assetWebPath_(`${ICON_PACK_ROOT_REL}/${dir.name}/pack.json`)
      });
    } catch {}
  }

  const manifest = { ok: true, packs: packs.sort((a, b) => String(a.name).localeCompare(String(b.name))) };
  await fs.writeFile(path.join(root.full, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

function normalizeLmiAssetUrl_(value) {
  let src = String(value || '').trim().replace(/\\/g, '/').replace(/^LMC:\s*/i, '');
  if (!src || /^(default|none|null|x)$/i.test(src)) return '';

  const githubAsset = src.match(/^https:\/\/github\.com\/BrokenSynapse\/BrokenSynapse\.github\.io\/blob\/main\/(?:site\/)?(?:lmi\/)?assets\/(.+?)\?raw=true$/i);
  if (githubAsset) src = `/lmi/assets/${githubAsset[1]}`;

  if (/^https?:\/\//i.test(src) || /^data:/i.test(src)) return src;

  if (src.startsWith('/assets/')) src = '/lmi' + src;
  if (src.startsWith('assets/')) src = '/lmi/' + src;
  if (src.startsWith('lmi/assets/')) src = '/' + src;

  if (src && !src.startsWith('/')) {
    src = '/lmi/assets/' + src.replace(/^\/+/, '').replace(/^assets\//, '').replace(/^lmi\/assets\//, '');
  }

  return src.replace(/\/+/g, '/');
}

async function walkAssets_(dir, rel = '') {
  const files = [];
  const dirs = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);

  for (const ent of entries) {
    const relPath = rel ? `${rel}/${ent.name}` : ent.name;
    const full = path.join(dir, ent.name);
    const stat = await fs.stat(full).catch(() => null);

    if (ent.isDirectory()) {
      dirs.push({
        kind: 'dir',
        name: ent.name,
        relPath,
        path: assetWebPath_(relPath),
        size: 0,
        updatedAt: stat ? stat.mtime.toISOString() : null
      });

      const nested = await walkAssets_(full, relPath);
      files.push(...nested.files);
      dirs.push(...nested.dirs);
      continue;
    }

    const ext = path.extname(ent.name).toLowerCase();

    if (typeof ASSET_ALLOWED_EXT !== 'undefined' && !ASSET_ALLOWED_EXT.has(ext)) {
      continue;
    }

    files.push({
      kind: 'file',
      name: ent.name,
      relPath,
      path: assetWebPath_(relPath),
      size: stat ? stat.size : 0,
      updatedAt: stat ? stat.mtime.toISOString() : null,
      type: ext.replace('.', '')
    });
  }

  return {
    files: files.sort((a, b) => a.relPath.localeCompare(b.relPath)),
    dirs: dirs.sort((a, b) => a.relPath.localeCompare(b.relPath))
  };
}


function fileOpBody_(req) {
  let body = req.body;

  if (Buffer.isBuffer(body)) {
    body = body.toString('utf8');
  }

  if (typeof body === 'string') {
    const txt = body.trim();
    if (!txt) body = {};
    else {
      try {
        body = JSON.parse(txt);
      } catch {
        body = { path: txt };
      }
    }
  }

  if (!body || typeof body !== 'object') body = {};

  return Object.assign({}, req.query || {}, body);
}

function fileOpPath_(req, keys = ['path']) {
  const body = fileOpBody_(req);

  for (const k of keys) {
    if (body[k] !== undefined && body[k] !== null && String(body[k]).trim() !== '') {
      return String(body[k]);
    }
  }

  return '';
}

function isCoreAssetRel_(rel) {
  const p = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return p === 'coreAssets' || p.startsWith('coreAssets/');
}

function requireCoreAssetAdmin_(req, res, rel) {
  if (!isCoreAssetRel_(rel)) return true;

  const c = (() => {
    try { return coreFromUserStrict_(userFromRequest_(req)); } catch { return null; }
  })();

  if (coreIsAdmin_(c)) return true;

  if (ADMIN_TOKEN) {
    const got = req.headers['x-admin-token'] || req.query.token;
    if (got === ADMIN_TOKEN) return true;
  }

  res.status(403).json({ ok: false, error: 'Admin account required for coreAssets changes.' });
  return false;
}

async function installIconPackFromZip_(buffer) {
  const parsed = validateIconPackZip_(buffer);
  const packId = safeIconPackId_(parsed.pack.id);
  const destRoot = assetFullPath_(`${ICON_PACK_ROOT_REL}/${packId}`);
  await fs.rm(destRoot.full, { recursive: true, force: true });
  await fs.mkdir(path.join(destRoot.full, 'icons'), { recursive: true });

  const entries = new Map(readZipEntries_(buffer)
    .filter(entry => !String(entry.name || '').endsWith('/'))
    .map(entry => [cleanZipPath_(entry.name), entry]));
  const cleanPack = {
    id: packId,
    name: String(parsed.pack.name || packId).slice(0, 80),
    type: parsed.pack.type || 'image',
    fallback: parsed.pack.fallback || 'default',
    apps: parsed.pack.apps || {},
    aliases: parsed.pack.aliases || {}
  };

  for (const icon of parsed.files) {
    const entry = entries.get(icon);
    const data = zipEntryData_(buffer, entry);
    const out = assetFullPath_(`${ICON_PACK_ROOT_REL}/${packId}/${icon}`);
    await fs.mkdir(path.dirname(out.full), { recursive: true });
    await fs.writeFile(out.full, data);
  }

  await fs.writeFile(path.join(destRoot.full, 'pack.json'), JSON.stringify(cleanPack, null, 2));
  const manifest = await writeIconPackManifest_();

  return {
    pack: cleanPack,
    url: assetWebPath_(`${ICON_PACK_ROOT_REL}/${packId}/pack.json`),
    icons: parsed.files,
    manifest
  };
}

app.get('/api/files/assets', async (req, res) => {
  try {
    await fs.mkdir(ASSET_ROOT, { recursive: true });
    const walked = await walkAssets_(ASSET_ROOT);

    res.json({
      ok: true,
      root: ASSET_URL_PREFIX,
      assetRoot: ASSET_ROOT,
      count: walked.files.length,
      files: walked.files,
      dirs: walked.dirs
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.post('/api/files/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });

    const target = assetFullPath_(req.body.subdir || req.body.dir || '');
    if (!requireCoreAssetAdmin_(req, res, target.rel)) return;
    await fs.mkdir(target.full, { recursive: true });

    const uploadExt = path.extname(req.file.originalname || '').toLowerCase();
    if (uploadExt === '.zip') {
      const admin = requireLmiAdmin_(req, res, 'Admin account required to upload icon pack zips.');
      if (!admin) return;

      const result = await installIconPackFromZip_(req.file.buffer);
      return res.json({
        ok: true,
        iconPack: true,
        file: {
          kind: 'icon-pack',
          name: result.pack.name || result.pack.id,
          path: result.url,
          relPath: `${ICON_PACK_ROOT_REL}/${result.pack.id}/pack.json`,
          type: 'icon-pack'
        },
        pack: result.pack,
        icons: result.icons,
        manifest: result.manifest,
        message: `Installed icon pack ${result.pack.name || result.pack.id}.`
      });
    }

    const safe = safeAssetName_(req.body.filename || req.file.originalname, uploadExt);

    let finalName = `${safe.base}${safe.ext}`;
    let fullPath = path.join(target.full, finalName);

    for (let i = 2; ; i++) {
      try {
        await fs.access(fullPath);
        finalName = `${safe.base}-${i}${safe.ext}`;
        fullPath = path.join(target.full, finalName);
      } catch {
        break;
      }
    }

    await fs.writeFile(fullPath, req.file.buffer);

    const relPath = target.rel ? `${target.rel}/${finalName}` : finalName;

    res.json({
      ok: true,
      file: {
        kind: 'file',
        name: finalName,
        path: assetWebPath_(relPath),
        relPath,
        size: req.file.size,
        type: safe.ext.replace('.', '')
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.post('/api/files/mkdir', express.text({ type: '*/*', limit: '2mb' }), async (req, res) => {
  try {
    const target = assetFullPath_(fileOpPath_(req, ['path']));
    if (!requireCoreAssetAdmin_(req, res, target.rel)) return;

    if (!target.rel) {
      return res.status(400).json({ ok: false, error: 'Cannot create /lmi/assets root.' });
    }

    await fs.mkdir(target.full, { recursive: true });

    res.json({
      ok: true,
      dir: {
        kind: 'dir',
        name: path.basename(target.rel),
        relPath: target.rel,
        path: assetWebPath_(target.rel)
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.post('/api/files/delete', express.text({ type: '*/*', limit: '2mb' }), async (req, res) => {
  try {
    const target = assetFullPath_(fileOpPath_(req, ['path']));
    if (!requireCoreAssetAdmin_(req, res, target.rel)) return;

    if (!target.rel) {
      return res.status(400).json({ ok: false, error: 'Cannot delete /lmi/assets root.' });
    }

    await fs.rm(target.full, { recursive: true, force: true });

    res.json({
      ok: true,
      deleted: assetWebPath_(target.rel),
      relPath: target.rel
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.post('/api/files/move', express.text({ type: '*/*', limit: '2mb' }), async (req, res) => {
  try {
    const body = fileOpBody_(req);
    const src = assetFullPath_(body.src || body.from || '');
    if (!requireCoreAssetAdmin_(req, res, src.rel)) return;

    if (!src.rel) {
      return res.status(400).json({ ok: false, error: 'Cannot move /lmi/assets root.' });
    }

    let destInput = body.dest || body.to || '';

    if (!destInput && (body.destDir || body.filename)) {
      const name = assetCleanPart_(body.filename || path.basename(src.rel));
      const dir = assetRelFromInput_(body.destDir || '');
      destInput = dir ? `${dir}/${name}` : name;
    }

    const dest = assetFullPath_(destInput);
    if (!requireCoreAssetAdmin_(req, res, dest.rel)) return;

    if (!dest.rel) {
      return res.status(400).json({ ok: false, error: 'Invalid destination.' });
    }

    await fs.mkdir(path.dirname(dest.full), { recursive: true });

    try {
      await fs.access(dest.full);
      return res.status(409).json({ ok: false, error: 'Destination already exists.' });
    } catch {}

    await fs.rename(src.full, dest.full);

    res.json({
      ok: true,
      from: assetWebPath_(src.rel),
      to: assetWebPath_(dest.rel),
      relPath: dest.rel
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.post('/api/files/write', express.text({ type: '*/*', limit: '2mb' }), async (req, res) => {
  try {
    const body = fileOpBody_(req);
    const target = assetFullPath_(fileOpPath_(req, ['path','dest']));
    if (!requireCoreAssetAdmin_(req, res, target.rel)) return;

    if (!target.rel) {
      return res.status(400).json({ ok: false, error: 'Cannot write /lmi/assets root.' });
    }

    const ext = path.extname(target.full).toLowerCase();
    const allowedText = new Set(['.txt', '.json', '.md', '.csv', '.css', '.html', '.js', '.xml', '.yaml', '.yml']);

    if (!allowedText.has(ext)) {
      return res.status(400).json({ ok: false, error: 'Text file extension not allowed.' });
    }

    try {
      await fs.access(target.full);
      if (!body.overwrite) {
        return res.status(409).json({ ok: false, error: 'File already exists.' });
      }
    } catch {}

    await fs.mkdir(path.dirname(target.full), { recursive: true });
    await fs.writeFile(target.full, String(body.content || ''), 'utf8');

    res.json({
      ok: true,
      file: {
        kind: 'file',
        name: path.basename(target.rel),
        path: assetWebPath_(target.rel),
        relPath: target.rel,
        type: ext.replace('.', '')
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.post('/api/icon-packs/inspect', upload.single('file'), async (req, res) => {
  try {
    const admin = requireLmiAdmin_(req, res, 'Admin account required to inspect icon pack zips.');
    if (!admin) return;
    if (!req.file) return res.status(400).json({ ok: false, error: 'No zip uploaded.' });
    if (path.extname(req.file.originalname || '').toLowerCase() !== '.zip') {
      return res.status(400).json({ ok: false, error: 'Icon pack upload must be a .zip file.' });
    }

    const parsed = validateIconPackZip_(req.file.buffer);
    res.json({
      ok: true,
      pack: {
        id: parsed.pack.id,
        name: parsed.pack.name || parsed.pack.id,
        type: parsed.pack.type || 'image',
        appCount: Object.keys(parsed.pack.apps || {}).length,
        aliases: parsed.pack.aliases || {}
      },
      icons: parsed.files,
      entries: parsed.entries
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

app.post('/api/icon-packs/upload', upload.single('file'), async (req, res) => {
  try {
    const admin = requireLmiAdmin_(req, res, 'Admin account required to upload icon pack zips.');
    if (!admin) return;
    if (!req.file) return res.status(400).json({ ok: false, error: 'No zip uploaded.' });
    if (path.extname(req.file.originalname || '').toLowerCase() !== '.zip') {
      return res.status(400).json({ ok: false, error: 'Icon pack upload must be a .zip file.' });
    }

    const result = await installIconPackFromZip_(req.file.buffer);

    res.json({
      ok: true,
      pack: result.pack,
      url: result.url,
      icons: result.icons,
      manifest: result.manifest
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  }
});

app.get('/api/icon-packs', async (req, res) => {
  try {
    const manifest = await writeIconPackManifest_();
    res.json(manifest);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err), packs: [] });
  }
});


function cache_(){
  return {
    get(k){ const x=memCache.get(k); if(!x) return null; if(x.expires && x.expires<Date.now()){ memCache.delete(k); return null; } return x.value; },
    put(k,v,seconds){ memCache.set(k,{value:String(v),expires: seconds ? Date.now()+seconds*1000 : 0}); },
    remove(k){ memCache.delete(k); }
  };
}
function rows_(name){ return storeRows(String(name)); }
function invalidate_(name){ try { cache_().remove('rows:' + name); } catch(e) {} }
function ensureSheet_(name, headers){ return storeEnsureSheet(String(name), headers || []); }
function appendSafe_(name, headers, obj){ ensureSheet_(name, headers || Object.keys(obj||{})); append_(name, obj||{}); }
function append_(name, obj){ storeAppendRow(String(name), obj || {}); invalidate_(name); }
function updateRows_(name, predicate, patcher){ const n=storeUpdateRows(String(name), predicate, patcher); if(n) invalidate_(name); return n; }

function bool_(v) { return v === true || String(v).toUpperCase() === 'TRUE' || String(v) === '1'; }
function now_() { return new Date().toISOString(); }
function centsToNumber_(c) { return Number(c || 0) / 100; }

function pick_(r, keys, fallback) {
  for (var i=0;i<keys.length;i++) {
    var k=keys[i];
    if (r[k] !== undefined && r[k] !== '') return r[k];
  }
  return fallback === undefined ? '' : fallback;
}
function moneyVal_(v) {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'number') return v > 9999 ? v / 100 : v;
  var s = String(v).replace(/[^0-9.\-]/g,'');
  var n = Number(s || 0);
  return n > 9999 ? n / 100 : n;
}


function ping() { return { status: 'online', time: now_() }; }


function getCoreByLogin_(tag, hash) {
  tag = String(tag || '').trim();
  hash = String(hash || '').trim();

  if (!tag || !hash) {
    throw new Error('Missing employee tag or hash.');
  }

  const row = rows_('core').find(r => {
    const rowTag = String(r.tag || '').trim();
    const rowHash = String(r.hash || '').trim();
    const status = String(r.st || 'Active').trim().toLowerCase();

    return rowTag.toLowerCase() === tag.toLowerCase()
      && rowHash === hash
      && status !== 'disabled'
      && status !== 'inactive'
      && status !== 'locked';
  });

  if (!row) {
    throw new Error('Invalid employee tag or hash.');
  }

  return row;
}

function login(payload) {
  payload = payload || {};

  const tag =
    payload.tag ??
    payload.employeeTag ??
    payload.login ??
    payload.username ??
    payload.user ??
    '';

  const hash =
    payload.hash ??
    payload.loginHash ??
    payload.password ??
    payload.pass ??
    payload.pw ??
    '';

  const c = getCoreByLogin_(tag, hash);

  appendSafe_('audit', ['id','t','cid','action','ok','blob'], {
    id: 'a_' + Date.now(),
    t: now_(),
    cid: c.cid,
    action: 'login',
    ok: 1,
    blob: pack_({ tag: c.tag })
  });

  return { user: userFromCore_(c), session: { mode: 'relay', at: now_() } };
}

function coreFromUser_(user) {
  const cid = user && user.cid;
  const tag = user && user.tag;
  if (cid) { const row = rows_('core').find(r => String(r.cid || '').trim() === String(cid).trim()); if (row) return row; }
  if (tag) { const row = rows_('core').find(r => String(r.tag).toLowerCase() === String(tag).toLowerCase()); if (row) return row; }
  throw new Error('No authenticated LMI user context.');
}

function sameCid_(a, b) {
  return String(a || '').trim() === String(b || '').trim();
}

function shellPrefsFromCore_(c) {
  const raw = c && (c.shellPrefs ?? c.shp ?? c.shell ?? {});
  if (!raw) return {};
  if (typeof raw === 'object') return normalizeShellPrefs_(raw);
  try {
    return normalizeShellPrefs_(JSON.parse(String(raw)));
  } catch {
    return {};
  }
}


function attachShellPrefsToUser_(u, c) {
  if (!u || !c) return u;
  u.cid = u.cid || c.cid || c.id || '';
  u.shellPrefs = shellPrefsFromCore_(c);
  return u;
}

function userFromCore_(c) {
  const out = {
    cid: c.cid,
    tag: c.tag,
    displayName: c.cn || c.tag,
    access: c.al || 'User',
    theme: c.th || 'Default',
    avatar: normalizeLmiAssetUrl_(c.av || ''),
    wallpaper: normalizeLmiAssetUrl_(c.wp || ''),
    bankAccountId: c.bid || '',
    currency: c.cur || 'LGD',
    occupation: c.occ || '',
    shellPrefs: shellPrefsFromCore_(c)
  };
  return attachShellPrefsToUser_(out, c);
}

const TERMINAL_APP_KEY = 'x';
const TERMINAL_APP_ID = 'bipac';
const TERMINAL_DESK_APPS = TERMINAL_APP_KEY;
const TERMINAL_DESK_LAYOUT = 'x:0,18,80,70,980,680,0,0;bipac:0,18,80,70,980,680,0,0';
const DEFAULT_START_APP_KEYS = new Set(['cv', 'fe', 's']);
const FIRST_PARTY_APPS = [
  {
    k: 'r',
    id: 'browser',
    nm: 'ATOMIKA Browser',
    name: 'ATOMIKA Browser',
    path: 'modules/browser.html?v=2026051605',
    ico: '◎',
    icon: '◎',
    desc: 'Low Data Rate Quantum Entangled Transit Environment',
    description: 'Low Data Rate Quantum Entangled Transit Environment',
    w: 1180,
    h: 820
  },
  { k: 'k', id: 'bank', nm: 'Bank.LMX', path: 'modules/bank.html', ico: '◇', desc: 'Wallet and account ledger', w: 860, h: 620 },
  { k: 'w', id: 'work', nm: 'Work.LMX', path: 'modules/work.html', ico: '$', desc: 'Snake payout labor terminal', w: 860, h: 620 },
  { k: 'p', id: 'pointOfSale', nm: 'POS.LMX', path: 'modules/pointOfSale.html?v=2026051501', ico: '▣', desc: 'Full point-of-sale register suite', w: 1280, h: 780 },
  { k: 'd', id: 'dealership', nm: 'Dealership.LMX', path: 'modules/dealership.html', ico: 'V', desc: 'Vehicle catalog and sales terminal', w: 1120, h: 760 },
  { k: 'm', id: 'bodyMods', nm: 'BodyMods.LMX', path: 'modules/bodyMods.html?v=2026051507', ico: '+', desc: 'Body Status tracker', w: 900, h: 650 },
  { k: 'h', id: 'chat', nm: 'Chat.LMX', path: 'modules/chat.html', ico: '#', desc: 'Board messenger process', w: 850, h: 620 },
  { k: 'ph', id: 'pharma', nm: 'Pharma.LMX', path: 'modules/pharma.html?v=2026051501', ico: 'Rx', desc: 'Public compound marketplace / clean supply registry', w: 1180, h: 800 },
  { k: 'df', id: 'dataEditor', nm: 'DataForge.LMX', path: 'modules/dataEditor.html?v=2026051502', ico: 'DF', desc: 'Sheet entry formatter', w: 980, h: 720 },
  { k: 'qv', id: 'qvault', nm: 'QVault.LMX', path: 'modules/qvault.html?v=2026051502', ico: 'QV', desc: 'Personal inventory grid', w: 980, h: 760 },
  { k: 'cv', id: 'convert', nm: 'Convert.LMX', path: 'modules/convert.html', ico: '⇄', desc: 'Currency and unit conversion suite', w: 760, h: 560, startOnly: true },
  { k: 'fe', id: 'fileExplorer', nm: 'FileExplorer.LMX', path: 'modules/fileExplorer.html?v=2026051504', ico: 'FE', desc: 'LMC jailed /assets context file manager', w: 980, h: 700, startOnly: true },
  { k: 's', id: 'settings', nm: 'Settings.LMX', path: 'modules/settings-v2.html', ico: '⚙', desc: 'Profile, appearance, wallpaper, desktop and relay settings', w: 1120, h: 760, startOnly: true },
  {
    k: TERMINAL_APP_KEY,
    id: TERMINAL_APP_ID,
    nm: 'LMI Terminal',
    name: 'LMI Terminal',
    path: 'modules/bipac.html?v=2026051611',
    ico: '>_',
    icon: '>_',
    desc: 'Command shell for module discovery, descriptions, install, and launch',
    description: 'Command shell for module discovery, descriptions, install, and launch',
    w: 980,
    h: 680
  }
];
const APP_NORMALIZERS = {
  browser: {
    k: 'r',
    key: 'r',
    id: 'browser',
    nm: 'ATOMIKA Browser',
    name: 'ATOMIKA Browser',
    path: 'modules/browser.html?v=2026051605',
    ico: '◎',
    icon: '◎',
    desc: 'Low Data Rate Quantum Entangled Transit Environment',
    description: 'Low Data Rate Quantum Entangled Transit Environment',
    w: 1180,
    h: 820
  }
};

function normalizeFirstPartyApp_(a = {}) {
  const key = String(a.k || a.key || '').trim().toLowerCase();
  const id = String(a.id || '').trim().toLowerCase();
  if (key === TERMINAL_APP_KEY || id === TERMINAL_APP_ID) return Object.assign({}, a, {
    k: TERMINAL_APP_KEY,
    id: TERMINAL_APP_ID,
    nm: 'LMI Terminal',
    name: 'LMI Terminal',
    path: 'modules/bipac.html?v=2026051611',
    ico: '>_',
    icon: '>_',
    desc: 'Command shell for module discovery, descriptions, install, and launch',
    description: 'Command shell for module discovery, descriptions, install, and launch',
    w: a.w || 980,
    h: a.h || 680
  });
  if (APP_NORMALIZERS[id]) return Object.assign({}, a, APP_NORMALIZERS[id]);
  return a;
}

function appDict_() {
  const out = {};
  FIRST_PARTY_APPS.map(normalizeFirstPartyApp_).forEach(app => {
    const key = String(app.k || app.key || app.id || '').trim();
    const id = String(app.id || '').trim();
    if (key) out[key] = app;
    if (id) out[id] = app;
  });
  rows_('dictApps').forEach(a => {
    const app = normalizeFirstPartyApp_(a);
    const key = String(app.k || app.key || app.id || '').trim();
    const id = String(app.id || '').trim();
    if (key) out[key] = app;
    if (id) out[id] = app;
  });
  return out;
}

function canonicalAppKey_(dict, value) {
  const needle = String(value || '').trim().toLowerCase();
  if (!needle) return '';
  const hit = Object.values(dict).find(app =>
    String(app.k || app.key || '').trim().toLowerCase() === needle ||
    String(app.id || '').trim().toLowerCase() === needle
  );
  return hit ? String(hit.k || hit.key || hit.id || '').trim() : '';
}

function n_(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function decodeLayout_(text) {
  if (!text) return {};

  // Support accidental JSON layout written by older repair patches.
  const raw = String(text || '').trim();
  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw);
      const out = {};
      Object.entries(obj || {}).forEach(([k, v]) => {
        v = v || {};
        out[k] = {
          iconX: Number(v.iconX ?? v.x ?? 0),
          iconY: Number(v.iconY ?? v.y ?? 0),
          x: Number(v.x ?? 120),
          y: Number(v.y ?? 90),
          w: Number(v.w ?? 800),
          h: Number(v.h ?? 600),
          minimized: !!v.minimized,
          maximized: !!v.maximized
        };
      });
      return out;
    } catch {}
  }

  const out = {};
  raw.split(';').filter(Boolean).forEach(part => {
    const bits = part.split(':');
    if (bits.length < 2) return;
    const a = bits[0];
    const v = bits[1].split(',').map(x => Number(x || 0));
    out[a] = {
      iconX: Number.isFinite(v[0]) ? v[0] : 0,
      iconY: Number.isFinite(v[1]) ? v[1] : 0,
      x: Number.isFinite(v[2]) ? v[2] : 120,
      y: Number.isFinite(v[3]) ? v[3] : 90,
      w: Number.isFinite(v[4]) ? v[4] : 800,
      h: Number.isFinite(v[5]) ? v[5] : 600,
      minimized: !!v[6],
      maximized: !!v[7]
    };
  });
  return out;
}


function encodeLayout_(layout) {
  return Object.keys(layout || {}).map(k => {
    const v = layout[k] || {};
    return [
      k,
      [
        n_(v.iconX, 0),
        n_(v.iconY, 0),
        n_(v.x, 120),
        n_(v.y, 90),
        n_(v.w, 800),
        n_(v.h, 600),
        v.minimized ? 1 : 0,
        v.maximized ? 1 : 0
      ].join(',')
    ].join(':');
  }).join(';');
}
function getDesktopState(payload, user) {
  const c = payload && payload.tag ? getCoreByLogin_(payload.tag, payload.hash) : coreFromUser_(user);
  const desk = rows_('desk').find(d => sameCid_(d.cid, c.cid)) || { apps: '', lay: '' };
  const dict = appDict_(); const layout = decodeLayout_(desk.lay);
  const seenApps = new Set();
  const explicitDesktopKeys = new Set();
  String(desk.apps || '').split(',').filter(Boolean).forEach(rawKey => {
    const k = canonicalAppKey_(dict, rawKey);
    if (k) explicitDesktopKeys.add(k);
  });
  explicitDesktopKeys.add(TERMINAL_APP_KEY);
  const apps = [...explicitDesktopKeys, ...DEFAULT_START_APP_KEYS].map(rawKey => {
    const k = canonicalAppKey_(dict, rawKey);
    if (!k || seenApps.has(k)) return null;
    seenApps.add(k);
    const a = dict[k]; if (!a) return null;
    const id = a.id || k;
    const byKey = layout[k] || {};
    const byId = layout[id] || {};
    const keyHasIcon = Number.isFinite(Number(byKey.iconX)) && Number.isFinite(Number(byKey.iconY));
    const idHasIcon = Number.isFinite(Number(byId.iconX)) && Number.isFinite(Number(byId.iconY));
    const l = keyHasIcon && !idHasIcon ? Object.assign({}, byId, byKey) : Object.assign({}, byKey, byId);
    const hasLayout = keyHasIcon || idHasIcon;
    if (hasLayout) {
      layout[k] = Object.assign({}, l);
      layout[id] = Object.assign({}, l);
    }
    const showOnDesktop = explicitDesktopKeys.has(k);
    return { key: k, id, hasLayout, showOnDesktop, startOnly: !showOnDesktop, name: a.nm || a.name || id, path: a.path, icon: a.ico || a.icon || '□', description: a.desc || a.description || '', min: a.min, w: n_(l.w, n_(a.w, 900)), h: n_(l.h, n_(a.h, 620)), x: n_(l.x, 80), y: n_(l.y, 70), iconX: hasLayout ? n_(l.iconX, 0) : undefined, iconY: hasLayout ? n_(l.iconY, 0) : undefined };
  }).filter(Boolean);
  return {
    user: userFromCore_(c),
    apps,
    layout,
    settings: {
      theme: c.th || 'Default',
      source: 'sheet',
      shellPrefs: shellPrefsFromCore_(c)
    }
  };
}

function saveUserWallpaper(payload, user) {
  const c = coreFromUser_(user);
  const wallpaper = normalizeLmiAssetUrl_((payload && (payload.wallpaper || payload.wp || payload.url)) || '');

  // Store in the legacy/core user row as wp, because userFromCore_ already maps c.wp -> user.wallpaper.
  const changed = updateRows_('core', r => sameCid_(r.cid, c.cid), r => ({ wp: wallpaper }));

  appendSafe_('audit', ['id','t','cid','action','ok','blob'], {
    id: 'a_' + Date.now(),
    t: now_(),
    cid: c.cid,
    action: 'user.wallpaper.save',
    ok: changed ? 1 : 0,
    blob: pack_({ wallpaper })
  });

  return { saved: !!changed, wallpaper, wp: wallpaper };
}


function userProfileGet(payload, user) {
  const c = coreFromUser_(user);
  return { user: userFromCore_(c), raw: c };
}

function userProfileSave(payload, user) {
  const c = coreFromUserStrict_(user);
  const pl = payload || {};

  const has = k => Object.prototype.hasOwnProperty.call(pl, k);
  const firstDefined = (...keys) => {
    for (const k of keys) {
      if (has(k)) return pl[k];
    }
    return undefined;
  };

  const patch = {};

  const displayName = firstDefined('displayName', 'cn', 'characterName', 'name');
  if (displayName !== undefined) patch.cn = String(displayName || '').trim();

  const avatar = firstDefined('avatar', 'av');
  if (avatar !== undefined) patch.av = normalizeLmiAssetUrl_(avatar);

  const wallpaper = firstDefined('wallpaper', 'wp');
  if (wallpaper !== undefined) patch.wp = normalizeLmiAssetUrl_(wallpaper);

  const currency = firstDefined('currency', 'cur');
  if (currency !== undefined) patch.cur = String(currency || '').trim();

  const occupation = firstDefined('occupation', 'occ');
  if (occupation !== undefined) patch.occ = String(occupation || '').trim();

  // Keep old behavior for display name only if nothing provided.
  if (!Object.keys(patch).length) {
    patch.cn = String(c.cn || c.tag || '').trim();
  }

  const changed = updateRows_('core', r => String(r.cid) === String(c.cid), r => Object.assign(r, patch));

  appendSafe_('audit', ['id','t','cid','action','ok','blob'], {
    id: 'a_' + Date.now(),
    t: now_(),
    cid: c.cid,
    action: 'user.profile.save',
    ok: changed ? 1 : 0,
    blob: pack_(patch)
  });

  const fresh = coreFromUserStrict_({ cid: c.cid });
  return { saved: !!changed, user: userFromCore_(fresh) };
}


function coreFromUserStrict_(user = {}) {
  const rows = rows_('core');
  const u = user || {};

  const cid = String(u.cid || u.id || '').trim();
  if (cid) {
    const byCid = rows.find(r => String(r.cid || r.id || '').trim() === cid);
    if (byCid) return byCid;
  }

  const tag = String(u.tag || u.username || '').trim().toLowerCase();
  if (tag) {
    const byTag = rows.find(r => String(r.tag || r.username || '').trim().toLowerCase() === tag);
    if (byTag) return byTag;
  }

  const name = String(u.displayName || u.cn || u.name || '').trim().toLowerCase();
  if (name) {
    const byName = rows.find(r => String(r.cn || r.displayName || r.name || '').trim().toLowerCase() === name);
    if (byName) return byName;
  }

  return coreFromUser_(user);
}



function resolveCoreForShell_(user = {}) {
  const rows = rows_('core');
  const u = user || {};

  const cid = String(u.cid || u.id || '').trim();
  if (cid) {
    const hit = rows.find(r => String(r.cid || r.id || '').trim() === cid);
    if (hit) return hit;
  }

  const tag = String(u.tag || u.username || '').trim().toLowerCase();
  if (tag) {
    const hit = rows.find(r => String(r.tag || r.username || '').trim().toLowerCase() === tag);
    if (hit) return hit;
  }

  const name = String(u.displayName || u.cn || u.name || '').trim().toLowerCase();
  if (name) {
    const hit = rows.find(r => String(r.cn || r.displayName || r.name || '').trim().toLowerCase() === name);
    if (hit) return hit;
  }

  return coreFromUser_(user);
}



function resolveCoreForShellPrefs_(user = {}) {
  const rows = rows_('core');
  const u = user || {};

  const cid = String(u.cid || u.id || '').trim();
  if (cid) {
    const hit = rows.find(r => String(r.cid || r.id || '').trim() === cid);
    if (hit) return hit;
  }

  const tag = String(u.tag || u.username || '').trim().toLowerCase();
  if (tag) {
    const hit = rows.find(r => String(r.tag || r.username || '').trim().toLowerCase() === tag);
    if (hit) return hit;
  }

  const name = String(u.displayName || u.cn || u.name || '').trim().toLowerCase();
  if (name) {
    const hit = rows.find(r => String(r.cn || r.displayName || r.name || '').trim().toLowerCase() === name);
    if (hit) return hit;
  }

  return coreFromUser_(u);
}

function parseShellPrefsDirect_(c = {}) {
  const raw = c.shellPrefs ?? c.prefs ?? null;
  if (!raw) return {};
  if (typeof raw === 'object') return normalizeShellPrefs_(raw);
  try { return normalizeShellPrefs_(JSON.parse(String(raw))); }
  catch { return {}; }
}


function userShellGet(payload, user) {
  const u = (payload && payload.user) || user || {};
  const c = resolveCoreForShellPrefs_(u);
  const prefs = parseShellPrefsDirect_(c);

  return {
    prefs,
    shellPrefs: prefs,
    cid: c.cid || c.id || '',
    tag: c.tag || '',
    user: userFromCore_(c)
  };
}


function userShellSave(payload, user) {
  const u = (payload && payload.user) || user || {};
  const c = resolveCoreForShellPrefs_(u);

  const incoming = normalizeShellPrefs_(
    (payload && (payload.prefs || payload.shellPrefs)) || {}
  );

  const oldPrefs = parseShellPrefsDirect_(c);
  const prefs = normalizeShellPrefs_(Object.assign({}, oldPrefs, incoming));

  const cid = String(c.cid || c.id || '').trim();

  const changed = updateRows_(
    'core',
    r => String(r.cid || r.id || '').trim() === cid,
    r => Object.assign(r, { shellPrefs: JSON.stringify(prefs) })
  );

  appendSafe_('audit', ['id','t','cid','action','ok','blob'], {
    id: 'a_' + Date.now(),
    t: now_(),
    cid,
    action: 'user.shell.save',
    ok: changed ? 1 : 0,
    blob: pack_({ shellPrefs: prefs })
  });

  return {
    saved: !!changed,
    prefs,
    shellPrefs: prefs,
    cid,
    tag: c.tag || ''
  };
}



function getCurrentAccount(payload, user) {
  const c = coreFromUserStrict_((payload && payload.user) || user || {});
  return { user: userFromCore_(c), raw: c };
}

function updateCurrentAccount(payload, user) {
  const c = coreFromUserStrict_((payload && payload.user) || user || {});
  const patch = (payload && payload.patch) || payload || {};
  const next = {};

  if (patch.displayName !== undefined || patch.cn !== undefined) next.cn = String(patch.displayName ?? patch.cn ?? '').trim();
  if (patch.tag !== undefined) next.tag = String(patch.tag || '').trim();
  if (patch.hash !== undefined) next.hash = String(patch.hash || '');
  if (patch.access !== undefined || patch.al !== undefined) next.al = String(patch.access ?? patch.al ?? '').trim();
  if (patch.status !== undefined || patch.st !== undefined) next.st = String(patch.status ?? patch.st ?? '').trim();
  if (patch.occupation !== undefined || patch.occ !== undefined) next.occ = String(patch.occupation ?? patch.occ ?? '').trim();
  if (patch.currency !== undefined || patch.cur !== undefined) next.cur = String(patch.currency ?? patch.cur ?? '').trim();
  if (patch.bankAccountId !== undefined || patch.bid !== undefined) next.bid = String(patch.bankAccountId ?? patch.bid ?? '').trim();
  if (patch.avatar !== undefined || patch.av !== undefined) next.av = normalizeLmiAssetUrl_(patch.avatar ?? patch.av);
  if (patch.wallpaper !== undefined || patch.wp !== undefined) next.wp = normalizeLmiAssetUrl_(patch.wallpaper ?? patch.wp);

  if (patch.shellPrefs !== undefined || patch.prefs !== undefined) {
    const incoming = normalizeShellPrefs_(patch.shellPrefs ?? patch.prefs ?? {});
    const old = shellPrefsFromCore_(c);
    next.shellPrefs = JSON.stringify(Object.assign({}, old, incoming));
  }

  const changed = updateRows_('core', r => String(r.cid) === String(c.cid), r => next);

  appendSafe_('audit', ['id','t','cid','action','ok','blob'], {
    id: 'a_' + Date.now(),
    t: now_(),
    cid: c.cid,
    action: 'updateCurrentAccount',
    ok: changed ? 1 : 0,
    blob: pack_(next)
  });

  const fresh = coreFromUserStrict_({ cid: c.cid });
  return { saved: !!changed, user: userFromCore_(fresh), raw: fresh };
}

function getModuleIndex() {
  const seen = new Set();
  const out = [];
  [...FIRST_PARTY_APPS, ...rows_('dictApps')].map(normalizeFirstPartyApp_).forEach(app => {
    const key = String(app.k || app.key || app.id || '').trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(app);
  });
  return out;
}
function saveDesktopLayout(payload, user) {
  const c = coreFromUser_(user);
  const dict = appDict_();
  const deskRows = rows_('desk');
  let row = deskRows.find(d => sameCid_(d.cid, c.cid));

  if (!row) {
    row = {
      cid: c.cid,
      apps: TERMINAL_DESK_APPS,
      lay: TERMINAL_DESK_LAYOUT
    };
    appendSafe_('desk', ['cid','apps','lay'], row);
  }

  const layout = decodeLayout_(row.lay || '');

  function applyLayoutPatch_(appId, patch) {
    appId = String(appId || '').trim();
    if (!appId) return null;

    const key = Object.keys(dict).find(k =>
      String(k).toLowerCase() === appId.toLowerCase() ||
      String(dict[k].id || '').toLowerCase() === appId.toLowerCase()
    ) || appId;

    const id = String((dict[key] && dict[key].id) || appId || key);
    const merged = Object.assign({}, layout[key] || {}, layout[id] || {}, patch || {});

    layout[key] = Object.assign({}, merged);
    layout[id] = Object.assign({}, merged);

    return { key, id, layout: merged };
  }

  if (payload && payload.positions && typeof payload.positions === 'object') {
    Object.entries(payload.positions).forEach(([rawId, pos]) => {
      pos = pos || {};
      const iconX = Number(pos.iconX ?? pos.x);
      const iconY = Number(pos.iconY ?? pos.y);
      const clean = {};

      if (Number.isFinite(iconX)) clean.iconX = Math.round(iconX);
      if (Number.isFinite(iconY)) clean.iconY = Math.round(iconY);

      applyLayoutPatch_(rawId, clean);
    });

    const lay = encodeLayout_(layout);
    const changed = updateRows_(
      'desk',
      r => sameCid_(r.cid, c.cid),
      r => Object.assign(r, { lay })
    );

    appendSafe_('audit', ['id','t','cid','action','ok','blob'], {
      id: 'a_' + Date.now(),
      t: now_(),
      cid: c.cid,
      action: 'saveDesktopLayout.batch',
      ok: changed ? 1 : 0,
      blob: pack_({ count: Object.keys(payload.positions).length, lay })
    });

    return { saved: !!changed, batch: true, count: Object.keys(payload.positions).length, lay };
  }

  const appId = String(payload.appId || payload.id || payload.key || '').trim();
  if (!appId) throw new Error('Missing appId.');

  const incoming = payload.layout && typeof payload.layout === 'object' ? payload.layout : payload;

  const clean = {};
  for (const k of ['x','y','w','h','iconX','iconY','maximized']) {
    if (incoming[k] !== undefined && incoming[k] !== null && incoming[k] !== '') {
      const n = Number(incoming[k]);
      clean[k] = Number.isFinite(n) ? Math.round(n) : incoming[k];
    }
  }

  const applied = applyLayoutPatch_(appId, clean);
  const key = applied.key;
  const id = applied.id;

  const lay = encodeLayout_(layout);

  const changed = updateRows_(
    'desk',
    r => sameCid_(r.cid, c.cid),
    r => Object.assign(r, { lay })
  );

  appendSafe_('audit', ['id','t','cid','action','ok','blob'], {
    id: 'a_' + Date.now(),
    t: now_(),
    cid: c.cid,
    action: 'saveDesktopLayout',
    ok: changed ? 1 : 0,
    blob: pack_({ appId, key, id, layout: clean, lay })
  });

  return {
    saved: !!changed,
    appId,
    key,
    id,
    layout: clean,
    lay
  };
}

function installApp(payload, user) { return toggleApp_(payload, user, true); }
function uninstallApp(payload, user) { return toggleApp_(payload, user, false); }
function toggleApp_(payload, user, install) {
  const c = coreFromUser_(user); const dict = appDict_();
  const needle = String(payload.appKey || payload.appId || payload.id || '').trim().toLowerCase();
  const key = Object.keys(dict).find(k => String(dict[k].id || '').toLowerCase() === needle || String(k).toLowerCase() === needle);
  if (!key) throw new Error('Unknown app: ' + payload.appId);
  if (!install && key === TERMINAL_APP_KEY) throw new Error('LMI Terminal cannot uninstall itself.');
  let found = false;
  const changed = updateRows_('desk', r => sameCid_(r.cid, c.cid), r => {
    found = true;
    let apps = String(r.apps || '').split(',').filter(Boolean);
    if (apps.indexOf(TERMINAL_APP_KEY) < 0) apps.unshift(TERMINAL_APP_KEY);
    if (install && apps.indexOf(key) < 0) apps.push(key);
    if (!install) apps = apps.filter(x => x !== key);
    return { apps: apps.join(',') };
  });
  if (!found) {
    const apps = [TERMINAL_APP_KEY];
    if (install && key !== TERMINAL_APP_KEY) apps.push(key);
    appendSafe_('desk', ['cid','apps','lay'], { cid: c.cid, apps: apps.join(','), lay: TERMINAL_DESK_LAYOUT });
  }
  return { appKey: key, appId: dict[key].id || key, installed: install, changed: !!changed || !found, desktop: getDesktopState({}, user) };
}

function catalogSearch(payload) {
  const q = String((payload && payload.query) || '').toLowerCase();
  const limit = Math.min(Number(payload && payload.limit || 500), 5000);
  const all = rows_('catalog').map(r => {
    const price = pick_(r, ['price','Price','retail','Retail','cost','Cost'], '') !== '' ? moneyVal_(pick_(r, ['price','Price','retail','Retail','cost','Cost'], 0)) : centsToNumber_(pick_(r, ['cents','Cents'], 0));
    return { id: pick_(r,['iid','id','ID','Item ID','itemId'],''), sku: pick_(r,['pn','sku','SKU','part','Part Number','Part'],''), upc: pick_(r,['upc','UPC'],''), name: pick_(r,['nm','name','Name','item','Item','description','Description'],''), price, manufacturer: pick_(r,['mfg','manufacturer','Manufacturer','brand','Brand'],''), description: pick_(r,['desc','description','Description','notes','Notes'],''), category: [pick_(r,['c1','Main Category','mainCategory','Department','department'],''), pick_(r,['c2','Second Category','secondCategory','Category','category'],''), pick_(r,['c3','Third Category','thirdCategory','Subcategory','subcategory'], '')].filter(Boolean).join(' / '), image: pick_(r,['img','image','Image','imageUrl','Image URL'],''), quality: pick_(r,['q','quality','Quality','qualityTier'], ''), invShape: pick_(r,['invShape','shape','gridShape','Inventory Shape'],''), invW: pick_(r,['invW','shapeW','gridW'],''), invH: pick_(r,['invH','shapeH','gridH'],''), invSlots: pick_(r,['invSlots','slots','slotCount'],''), isStackable: pick_(r,['isStackable','stackable'],''), maxStack: pick_(r,['maxStack','stackMax'],'') };
  });
  return { items: all.filter(x => !q || JSON.stringify(x).toLowerCase().indexOf(q) >= 0).slice(0, limit) };
}
function vehiclesSearch(payload) {
  const q = String((payload && payload.query) || '').toLowerCase();
  const limit = Math.min(Number(payload && payload.limit || 500), 5000);
  const all = rows_('vehicles').map(r => {
    const price = pick_(r, ['price','Price','cents','Cents','MSRP','msrp'], '') !== '' ? moneyVal_(pick_(r, ['price','Price','cents','Cents','MSRP','msrp'], 0)) : 0;
    const extraPrice = pick_(r, ['extraPrice','extrasPrice','extraCents','Extras Price','Addition Price'], '') !== '' ? moneyVal_(pick_(r, ['extraPrice','extrasPrice','extraCents','Extras Price','Addition Price'], 0)) : 0;
    return {
      id: pick_(r,['vid','id','ID','Vehicle ID'],''),
      type: pick_(r,['type','vehicleType','Vehicle Type','Class','class','Segment','segment'],''),
      manufacturer: pick_(r,['mfg','manufacturer','Manufacturer','Brand','brand','Make','make'],''),
      model: pick_(r,['model','Model','name','Name','Vehicle','vehicle'],''),
      paint: pick_(r,['paint','paintOption','Paint','Paint Option','Color','colour'],''),
      engine: pick_(r,['eng','engine','engineType','Engine','Engine Type'],''),
      fuel: pick_(r,['fuel','fuelUse','Fuel','Fuel Use','Fuel Type'],''),
      transmission: pick_(r,['trans','transmission','transType','Transmission','Transmission Type'],''),
      drivetrain: pick_(r,['drive','drivetrain','Drivetrain','Drive','Layout'],''),
      price, description: pick_(r,['desc','description','Description','Blurb','blurb','Notes'],''), image: pick_(r,['img','image','Image','imageUrl','Image URL','Photo'],''),
      extra: pick_(r,['extra','extras','Factory Extras','Extras','Addition','addition'],''), extraPrice,
      hp: pick_(r,['hp','HP','Horsepower'],''), tq: pick_(r,['tq','TQ','Torque'],''), zeroToSixty: pick_(r,['z60','zeroToSixty','0-60','0 to 60'], '')
    };
  });
  return { vehicles: all.filter(x => !q || JSON.stringify(x).toLowerCase().indexOf(q) >= 0).slice(0, limit) };
}
function bankGetAccount(payload, user) {
  const c = coreFromUser_(user);
  const ledger = rows_('bank').filter(r => r.cid === c.cid || r.bid === c.bid);
  const bal = ledger.reduce((s, r) => s + Number(r.amt || 0), 0);
  return { accountId: c.bid, owner: c.cn, balance: centsToNumber_(bal), currency: c.cur || 'LGD', ledger: ledger.map(r => ({ date: r.t, memo: r.memo, amount: centsToNumber_(r.amt), type: r.typ })) };
}
function bankLedger(payload, user) { return bankGetAccount(payload, user); }
function writeLedger_(cid, bid, type, cents, cur, memo, by, blobObj) {
  append_('bank', { lid: 'l_' + Date.now(), bid, cid, t: now_(), typ: type, amt: cents, cur, memo, by, blob: blobObj ? pack_(blobObj) : '' });
}

const QVAULT_HEADERS = ['id','cid','source','sourceId','kind','name','qty','shape','shapeW','shapeH','slots','stackable','maxStack','x','y','rot','status','action','createdAt','updatedAt','blob'];

function normalizeInvShape_(item) {
  const raw = String(pick_(item || {}, ['invShape','shape','gridShape','Inventory Shape'], '') || '').trim();
  const compact = raw.replace(/[^01]/g, '');
  const cells = (compact || '1').slice(0, 15).padEnd(15, '0');
  const w = Math.max(1, Math.min(5, Number(pick_(item || {}, ['invW','shapeW','gridW'], 5)) || 5));
  const h = Math.max(1, Math.min(3, Number(pick_(item || {}, ['invH','shapeH','gridH'], 3)) || 3));
  const area = Math.max(1, cells.split('').filter(x => x === '1').length);
  return { shape: cells, shapeW: w, shapeH: h, slots: Number(pick_(item || {}, ['invSlots','slots','slotCount'], area)) || area };
}

function qvaultItemFromSource_(c, source, item, qty) {
  const shape = normalizeInvShape_(item);
  const id = 'qv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const sourceId = String(item.id || item.iid || item.pid || item.mid || item.sku || item.pn || item.name || id);
  const name = String(item.name || item.nm || item.label || item.sku || item.mid || sourceId);
  const kind = String(item.kind || item.itemKind || item.cat || item.category || source || 'item');
  const stackable = boolish_(pick_(item, ['isStackable','stackable'], shape.slots === 1 ? 'TRUE' : 'FALSE'));
  const maxStack = Math.max(1, Number(pick_(item, ['maxStack','stackMax'], stackable ? 99 : 1)) || 1);
  return {
    id,
    cid: c.cid,
    source,
    sourceId,
    kind,
    name,
    qty: Math.max(1, Number(qty || 1)),
    shape: shape.shape,
    shapeW: shape.shapeW,
    shapeH: shape.shapeH,
    slots: shape.slots,
    stackable: stackable ? 'TRUE' : 'FALSE',
    maxStack,
    x: '',
    y: '',
    rot: 0,
    status: 'stored',
    action: '',
    createdAt: now_(),
    updatedAt: now_(),
    blob: pack_(item || {})
  };
}

function qvaultAdd_(c, source, items) {
  const rows = [];
  (Array.isArray(items) ? items : [items]).filter(Boolean).forEach(entry => {
    const item = entry.item || entry;
    const qty = entry.qty || item.qty || 1;
    rows.push(qvaultItemFromSource_(c, source, item, qty));
  });
  rows.forEach(row => appendSafe_('qvault', QVAULT_HEADERS, row));
  return rows;
}

function qvaultList(payload, user) {
  const c = coreFromUser_(user);
  ensureSheet_('qvault', QVAULT_HEADERS);
  const items = rows_('qvault').filter(r => r.cid === c.cid).map(r => Object.assign({}, r, { data: unpackSafe_(r.blob) }));
  return { width: 9, height: 21, items };
}

function qvaultAdd(payload, user) {
  const c = coreFromUser_(user);
  const added = qvaultAdd_(c, String(payload.source || 'manual'), payload.items || payload.item || payload);
  appendSafe_('audit', ['id','t','cid','action','ok','blob'], { id:'a_'+Date.now(), t:now_(), cid:c.cid, action:'qvault.add', ok:1, blob:pack_({ count:added.length }) });
  return { added };
}

function qvaultMove(payload, user) {
  const c = coreFromUser_(user);
  const id = String(payload.id || '');
  const changed = updateRows_('qvault', r => r.cid === c.cid && r.id === id, r => ({ x: payload.x, y: payload.y, rot: payload.rot || 0, updatedAt: now_() }));
  return { moved: !!changed, id };
}

function qvaultAction(payload, user) {
  const c = coreFromUser_(user);
  const id = String(payload.id || '');
  const action = String(payload.action || '').trim();
  const changed = updateRows_('qvault', r => r.cid === c.cid && r.id === id, r => ({ action, status: action || r.status || 'stored', updatedAt: now_() }));
  appendSafe_('audit', ['id','t','cid','action','ok','blob'], { id:'a_'+Date.now(), t:now_(), cid:c.cid, action:'qvault.action:'+action, ok:changed ? 1 : 0, blob:pack_(payload) });
  return { ok: !!changed, id, action };
}

function chatRooms() { return { rooms: rows_('chatRooms').map(r => ({ id: r.rid, board: r.board, title: r.title, description: r.desc, access: r.access, locked: bool_(r.locked), order: Number(r.ord || 0) })) }; }
function chatPosts(payload) {
  const rid = payload && payload.room || payload && payload.rid || 'random';
  return { posts: rows_('chatPosts').filter(p => !rid || p.rid === rid).map(p => Object.assign({ id: p.pid, room: p.rid, cid: p.cid, time: p.t, kind: p.kind }, unpackSafe_(p.blob))).slice(-100) };
}
function chatPost(payload, user) {
  const c = coreFromUser_(user); const post = { subject: payload.subject || 'Untitled', body: payload.body || '', author: c.cn || c.tag };
  append_('chatPosts', { pid: 'p_' + Date.now(), rid: payload.room || 'random', cid: c.cid, t: now_(), kind: 'msg', blob: pack_(post) });
  return { posted: true };
}
function bodyMods() { ensureSheet_('mods', ['mid','slot','nm','cat','st','mfg','desc','fx','draw','rare','compat','diff','vis','lockChild','locks','replace','cost','unCost','validSlots','supportType','lmexCertified','cardiovascularOutput','pressureTolerance','renalClearance','hepaticProcessing','thermalLoad','neuralBuffer','sleepState','glucoseElectrolyte','supportNotes','img','image','imageUrl','layer','z','opacity','invShape','invW','invH','invSlots','isStackable','maxStack']); return { mods: rows_('mods') }; }
function bodySlots() {
  ensureSheet_('bodySlots', ['slot','label','parentSlot','region','ord','note','category','isSlot','accepts','blocks','exclusiveGroup']);
  const rows = rows_('bodySlots').map(r => ({
    slot: r.slot || r.id || r.label || '',
    label: r.label || r.name || r.slot || '',
    parentSlot: r.parentSlot || r.parent || '',
    region: r.region || '',
    ord: r.ord || r.order || '',
    note: r.note || r.desc || '',
    category: r.category || '',
    isSlot: r.isSlot == null ? true : bool_(r.isSlot),
    accepts: r.accepts || '',
    blocks: r.blocks || '',
    exclusiveGroup: r.exclusiveGroup || r.slot || ''
  })).filter(r => r.slot || r.label);
  return { slots: rows };
}
function bodyCategories() {
  ensureSheet_('bodyCategories', ['id','label','parent','region','canInstall','accepts','blocks','note']);
  const rows = rows_('bodyCategories').map(r => ({
    id: r.id || r.category || '',
    label: r.label || r.name || r.id || '',
    parent: r.parent || '',
    region: r.region || '',
    canInstall: r.canInstall == null ? true : bool_(r.canInstall),
    accepts: r.accepts || '',
    blocks: r.blocks || '',
    note: r.note || r.desc || ''
  })).filter(r => r.id || r.label);
  return { categories: rows };
}
function workJobs() { return { jobs: rows_('work') }; }
function workCashOut(payload, user) {
  const c = coreFromUser_(user); const amount = Math.round(Number(payload.amount || 0) * 100);
  writeLedger_(c.cid, c.bid, 'work', amount, c.cur || 'LGD', 'Work payout: ' + (payload.job || 'job'), c.tag, payload);
  append_('audit', { id: 'a_' + Date.now(), t: now_(), cid: c.cid, action: 'work.cashOut', ok: 1, blob: pack_(payload) });
  return { paid: true, cents: amount, amount: amount / 100 };
}


function coreSearch(payload, user) {
  const q = String((payload && payload.query) || '').toLowerCase();
  const rows = rows_('core').filter(r => !q || JSON.stringify(r).toLowerCase().indexOf(q) >= 0).slice(0, 25);
  return { customers: rows.map(r => ({ cid: r.cid, tag: r.tag, name: r.cn || r.tag, cn: r.cn, pos: r.pos, phone: r.ph, type: r.pt, discountPct: Number(r.disc || 0), disc: Number(r.disc || 0), bankAccountId: r.bid, currency: r.cur, note: r.pnote || r.note })) };
}
function posTender(payload, user) {
  const c = coreFromUser_(user);
  const total = Number(payload.total || 0);
  const cents = -Math.round(total * 100);
  const txid = 'tx_' + Date.now();
  writeLedger_(c.cid, c.bid, 'pos', cents, c.cur || 'LGD', 'POS tender: ' + (payload.itemCount || 0) + ' item(s)', c.tag, payload);
  appendSafe_('posTx', ['txid','cid','t','total','subtotal','discount','items','blob'], { txid, cid: c.cid, t: now_(), total: Math.round(total * 100), subtotal: Math.round(Number(payload.subtotal || 0) * 100), discount: Math.round(Number(payload.discount || 0) * 100), items: payload.itemCount || 0, blob: pack_(payload) });
  const inventory = qvaultAdd_(c, 'pos', (payload.items || []).map(line => ({ item: Object.assign({ kind:'pos' }, line.item || {}, { name: line.name, sku: line.sku }), qty: line.qty || 1 })));
  append_('audit', { id: 'a_' + Date.now(), t: now_(), cid: c.cid, action: 'pos.tender', ok: 1, blob: pack_(payload) });
  return { tendered: true, txid, cents, inventory };
}
function vehiclesBuy(payload, user) {
  const c = coreFromUser_(user);
  const amount = Number(payload.amount || 0);
  const cents = -Math.round(amount * 100);
  const memo = 'Vehicle purchase: ' + [payload.kind || 'new', payload.manufacturer, payload.model, payload.addition && payload.addition !== 'none' ? '(' + payload.addition + ')' : ''].filter(Boolean).join(' ');
  writeLedger_(c.cid, c.bid, 'vehicle', cents, c.cur || 'LGD', memo, c.tag, payload);
  appendSafe_('vehicleSales', ['saleId','cid','t','vehicleId','kind','amount','blob'], { saleId: 'vs_' + Date.now(), cid: c.cid, t: now_(), vehicleId: payload.vehicleId || '', kind: payload.kind || 'new', amount: Math.round(amount * 100), blob: pack_(payload) });
  return { bought: true, amount };
}
function bodyInstalled(payload, user) {
  const c = coreFromUser_(user);
  ensureSheet_('bodyInstalled', ['id','cid','profileId','baseMesh','meshPath','mid','slot','name','note','t','blob']);
  return { installed: rows_('bodyInstalled').filter(r => r.cid === c.cid).map(r => ({ id: r.id, cid: r.cid, profileId:r.profileId||'default', baseMesh:r.baseMesh||'', meshPath:r.meshPath||'', mid: r.mid, slot: r.slot, name: r.name, note: r.note, t: r.t })) };
}
function bodyInstall(payload, user) {
  const c = coreFromUser_(user);
  const id = 'bi_' + Date.now();
  appendSafe_('bodyInstalled', ['id','cid','profileId','baseMesh','meshPath','mid','slot','name','note','t','blob'], { id, cid: c.cid, profileId: payload.profileId || 'default', baseMesh: payload.baseMesh || '', meshPath: payload.meshPath || '', mid: payload.mid || '', slot: payload.slot || '', name: payload.name || payload.mid || '', note: payload.note || '', t: now_(), blob: pack_(payload) });
  append_('audit', { id: 'a_' + Date.now(), t: now_(), cid: c.cid, action: 'body.install', ok: 1, blob: pack_(payload) });
  return { installed: true, id };
}



function bodyProfileSheet_() {
  return ensureSheet_('bodyProfiles', ['id','cid','profileId','displayName','employeeTag','baseMesh','meshPath','skinTint','bodyJson','updatedAt','blob']);
}
function bodyProfileDefault_(c) {
  return {
    profileId: 'default',
    displayName: c.cn || c.tag || '',
    employeeTag: c.tag || '',
    baseMesh: 'human_base_3k',
    meshPath: 'assets/body/models/HumanBodyBaseMesh3k.glb',
    skinTint: '#d8b18f',
    body: { height:1, shoulders:1, chest:1, waist:1, hips:1, arms:1, legs:1, muscle:1, bodyFat:1, head:1, hands:1, feet:1 }
  };
}
function bodyProfileGet(payload, user) {
  const c = coreFromUser_(user);
  const profileId = String(payload && payload.profileId || 'default');
  bodyProfileSheet_();
  const rows = rows_('bodyProfiles').filter(r => r.cid === c.cid && String(r.profileId || 'default') === profileId);
  const r = rows.length ? rows[rows.length - 1] : null;
  if (!r) return { profile: bodyProfileDefault_(c), source: 'default' };
  var p = {};
  try { p = r.blob ? unpackSafe_(r.blob) : {}; } catch(e) { p = {}; }
  if (!p.body) { try { p.body = JSON.parse(r.bodyJson || '{}'); } catch(e) { p.body = {}; } }
  p.profileId = r.profileId || profileId;
  p.displayName = p.displayName || r.displayName || c.cn || c.tag || '';
  p.employeeTag = p.employeeTag || r.employeeTag || c.tag || '';
  p.baseMesh = p.baseMesh || r.baseMesh || 'human_base_3k';
  p.meshPath = p.meshPath || r.meshPath || 'assets/body/models/HumanBodyBaseMesh3k.glb';
  p.skinTint = p.skinTint || r.skinTint || '#d8b18f';
  return { profile: p, source: 'bodyProfiles' };
}
function bodyProfileSave(payload, user) {
  const c = coreFromUser_(user);
  const p = payload.profile || payload || {};
  const profileId = String(p.profileId || payload.profileId || 'default');
  bodyProfileSheet_();
  appendSafe_('bodyProfiles', ['id','cid','profileId','displayName','employeeTag','baseMesh','meshPath','skinTint','bodyJson','updatedAt','blob'], {
    id: 'bp_' + Date.now(), cid: c.cid, profileId: profileId, displayName: p.displayName || c.cn || c.tag || '', employeeTag: p.employeeTag || c.tag || '', baseMesh: p.baseMesh || '', meshPath: p.meshPath || '', skinTint: p.skinTint || '', bodyJson: JSON.stringify(p.body || {}), updatedAt: now_(), blob: pack_(p)
  });
  if (payload.credentials && (payload.credentials.tag || payload.credentials.hash || p.displayName)) {
    updateRows_('core', function(r){ return r.cid === c.cid; }, function(r){
      if (p.displayName) r.cn = p.displayName;
      if (payload.credentials.tag) r.tag = String(payload.credentials.tag).trim();
      if (payload.credentials.hash) r.hash = String(payload.credentials.hash).trim();
      return r;
    });
  }
  appendSafe_('audit', ['id','t','cid','action','ok','blob'], { id:'a_'+Date.now(), t:now_(), cid:c.cid, action:'body.profile.save', ok:1, blob:pack_(p) });
  return { saved:true, profileId:profileId };
}
function bodyProfileMeshSet(payload, user) {
  const current = bodyProfileGet(payload || {}, user).profile || {};
  const p = payload.profile || payload || {};
  current.profileId = p.profileId || current.profileId || 'default';
  current.baseMesh = p.baseMesh || current.baseMesh || '';
  current.meshPath = p.meshPath || current.meshPath || '';
  current.skinTint = p.skinTint || current.skinTint || '#d8b18f';
  if (p.body) current.body = p.body;
  return bodyProfileSave({ profile: current }, user);
}

function bodyBundle(payload, user) {
  return { slots: bodySlots().slots, categories: bodyCategories().categories, mods: bodyMods().mods, installed: bodyInstalled(payload || {}, user).installed };
}

function boolish_(v) { return v === true || String(v).toLowerCase() === 'true' || String(v) === '1' || String(v).toLowerCase() === 'yes'; }
function pharmaNormalize_(r) {
  var price = pick_(r, ['priceCents','cents','Price Cents','price','Price'], '') !== '' ? moneyVal_(pick_(r, ['priceCents','cents','Price Cents','price','Price'], 0)) : 0;
  if (pick_(r, ['priceCents','cents','Price Cents'], '') !== '' && price < 100 && Number(pick_(r, ['priceCents','cents','Price Cents'], 0)) > 100) price = Number(pick_(r, ['priceCents','cents','Price Cents'], 0)) / 100;
  return {
    pid: pick_(r,['pid','id','ID','compoundId'],''), sku: pick_(r,['sku','SKU','pn'],''), name: pick_(r,['nm','name','Name'],''), company: pick_(r,['company','mfg','manufacturer','Manufacturer'],''),
    category: pick_(r,['category','cat','Category'],''), publicOutletTier: pick_(r,['publicOutletTier','tier','Public Outlet Tier'],''), form: pick_(r,['form','Form'],''), quantity: pick_(r,['quantity','qty','Quantity'],''),
    labelUse: pick_(r,['labelUse','suggestedUse','Suggested Use','use'],''), price: price, buyable: boolish_(pick_(r,['buyable','Buyable'],true)), subscription: boolish_(pick_(r,['subscription','Subscription'],false)),
    purityGrade: pick_(r,['purityGrade','Purity Grade'],''), workUtility: pick_(r,['workUtility','Work Utility'],''), shiftCompatibility: pick_(r,['shiftCompatibility','Shift Compatibility'],''),
    dependency: n_(pick_(r,['dependency','addictiveness','Addictiveness'],0)), tolerance: n_(pick_(r,['tolerance','toleranceBuildup'],0)), withdrawal: n_(pick_(r,['withdrawal','withdrawalBurden'],0)), abuseLoop: n_(pick_(r,['abuseLoop','abuseLoopRisk'],0)), supportNeed: n_(pick_(r,['supportNeed','support'],0)),
    requiredRatings: pick_(r,['requiredRatings','Required Ratings'],''), disclaimers: pick_(r,['disclaimers','Disclaimer'],''), warnings: pick_(r,['warnings','Warnings'],''), effects: pick_(r,['effects','Effects'],''), sideEffects: pick_(r,['sideEffects','Side Effects'],''), interactions: pick_(r,['interactions','Interactions'],''), tags: pick_(r,['tags','Tags'],''), structure: pick_(r,['structure','Structure'],''), image: pick_(r,['img','image','Image','imageUrl'],''), description: pick_(r,['desc','description','Description'],''), invShape: pick_(r,['invShape','shape','gridShape','Inventory Shape'],''), invW: pick_(r,['invW','shapeW','gridW'],''), invH: pick_(r,['invH','shapeH','gridH'],''), invSlots: pick_(r,['invSlots','slots','slotCount'],''), isStackable: pick_(r,['isStackable','stackable'],''), maxStack: pick_(r,['maxStack','stackMax'],'')
  };
}
function pharmaSearch(payload) {
  pharmaSheet_();
  var q = String((payload && payload.query) || '').toLowerCase();
  var limit = Math.min(Number(payload && payload.limit || 500), 5000);
  var all = rows_('pharmaItems').map(pharmaNormalize_);
  return { items: all.filter(function(x){ return !q || JSON.stringify(x).toLowerCase().indexOf(q) >= 0; }).slice(0, limit) };
}
function parseRequiredRatings_(text) {
  var out = {};
  String(text || '').split(/[;|,]+/).forEach(function(part){ var m = part.split(':'); if (m.length >= 2) out[String(m[0]).trim()] = Number(m[1] || 0); });
  return out;
}
function bodyRatingsForUser_(user) {
  var c = coreFromUser_(user);
  var installed = bodyInstalled({}, user).installed || [];
  var mods = bodyMods().mods || [];
  var byMid = {}; mods.forEach(function(m){ byMid[String(m.mid || m.id || m.nm)] = m; });
  var keys = ['cardiovascularOutput','pressureTolerance','renalClearance','hepaticProcessing','thermalLoad','neuralBuffer','sleepState','glucoseElectrolyte'];
  var ratings = {}; keys.forEach(function(k){ ratings[k] = 0; });
  var sources = [];
  installed.forEach(function(inst){ var m = byMid[String(inst.mid)] || byMid[String(inst.name)] || {}; keys.forEach(function(k){ ratings[k] = Math.max(ratings[k] || 0, n_(m[k])); }); sources.push({ mid: inst.mid, name: inst.name, slot: inst.slot, supportType: m.supportType || '', lmexCertified: m.lmexCertified || '', ratings: keys.reduce(function(o,k){ o[k]=n_(m[k]); return o; }, {}) }); });
  return { cid: c.cid, ratings: ratings, sources: sources };
}
function pharmaCompat(payload, user) {
  var pid = String(payload && payload.pid || '').toLowerCase();
  var item = (pharmaSearch({ limit: 5000 }).items || []).find(function(x){ return String(x.pid).toLowerCase() === pid || String(x.sku).toLowerCase() === pid || String(x.name).toLowerCase() === pid; });
  var body = bodyRatingsForUser_(user);
  var req = parseRequiredRatings_(item && item.requiredRatings);
  var missing = Object.keys(req).filter(function(k){ return n_(body.ratings[k]) < n_(req[k]); }).map(function(k){ return { key:k, have:n_(body.ratings[k]), need:n_(req[k]) }; });
  return { item: item, body: body, required: req, ok: missing.length === 0, missing: missing, disclaimer: missing.length ? 'Legal does not mean compatible. Checkout should be blocked or heavily warned for this profile.' : 'Compatibility ratings satisfy the listed requirement.' };
}
function pharmaBuy(payload, user) {
  var compat = pharmaCompat(payload || {}, user);
  var item = compat.item;
  if (!item) throw new Error('Unknown pharma item.');
  if (!item.buyable) throw new Error('This pharma entry is archive/display-only.');
  var c = coreFromUser_(user);
  var qty = Math.max(1, Number(payload.qty || 1));
  var amount = Number(item.price || 0) * qty;
  var cents = -Math.round(amount * 100);
  writeLedger_(c.cid, c.bid, 'pharma', cents, c.cur || 'LGD', 'PHARMA purchase: ' + item.name + ' x' + qty, c.tag, { item:item, qty:qty, compat:compat });
  appendSafe_('pharmaOrders', ['orderId','cid','t','pid','sku','qty','amount','compatOk','missing','blob'], { orderId:'rx_'+Date.now(), cid:c.cid, t:now_(), pid:item.pid, sku:item.sku, qty:qty, amount:Math.round(amount*100), compatOk: compat.ok ? 1 : 0, missing: JSON.stringify(compat.missing || []), blob:pack_({ item:item, qty:qty, compat:compat }) });
  var inventory = qvaultAdd_(c, 'pharma', { item:Object.assign({ kind:'pharma' }, item), qty:qty });
  return { bought:true, item:item, qty:qty, amount:amount, compat:compat, inventory:inventory };
}
function pharmaAdd(payload, user) {
  var record = payload.record || payload || {};
  pharmaSheet_();
  append_('pharmaItems', record);
  appendSafe_('audit', ['id','t','cid','action','ok','blob'], { id:'a_'+Date.now(), t:now_(), cid:(user&&user.cid)||'', action:'pharma.add', ok:1, blob:pack_(record) });
  return { appended:true, sheet:'pharmaItems' };
}


function currencySettingsSheet_() {
  return ensureSheet_('currencySettings', ['code','label','symbol','ratePerLGD','precision','mode','notes']);
}
function currencyPresets(payload, user) {
  try {
    var rows = rows_('currencySettings').map(function(r){
      return {
        code: String(r.code || '').trim(),
        label: String(r.label || r.code || '').trim(),
        symbol: String(r.symbol || r.code || '').trim(),
        ratePerLGD: Number(r.ratePerLGD || 1),
        precision: Number(r.precision === '' || r.precision == null ? (String(r.symbol)==='$' ? 2 : 3) : r.precision),
        mode: String(r.mode || 'fixed').trim(),
        notes: String(r.notes || '')
      };
    }).filter(function(r){ return r.code; });
    if (!rows.length) throw new Error('No presets');
    return { presets: rows };
  } catch(e) {
    return { presets: [
      { code:'LGD', label:'Leviathan Gold Dollar', symbol:'Ł', ratePerLGD:1, precision:3, mode:'fixed', notes:'Base currency. One Ł equals one grain of gold.' },
      { code:'USD_LIVE', label:'US Dollar live gold grain', symbol:'$', ratePerLGD:4.5, precision:2, mode:'liveGold', notes:'XAU/USD divided by 480 grains per troy ounce.' },
      { code:'D', label:'Legacy Dinari display', symbol:'D', ratePerLGD:1, precision:3, mode:'fixed', notes:'Compatibility display.' }
    ], fallback:true, error:String(e && e.message ? e.message : e) };
  }
}
function dataAppend(payload, user) {
  const allowed = ['core','catalog','vehicles','mods','bodySlots','bodyCategories','dictApps','themes','chatRooms','work','pharmaItems','currencySettings','bodyProfiles','bodyInstalled','qvault'];
  const sheet = String(payload && payload.sheet || '').trim();
  if (allowed.indexOf(sheet) < 0) throw new Error('DataForge refused sheet: ' + sheet);
  const record = payload.record || {};
  const s = ensureSheet_(sheet, Object.keys(record).length ? Object.keys(record) : ['id','blob']);
  const headers = (s.headers && s.headers.length ? s.headers : Object.keys(record)).map(String);
  headers.forEach(h => { if (!(h in record)) record[h] = ''; });
  append_(sheet, record);
  appendSafe_('audit', ['id','t','cid','action','ok','blob'], { id:'a_'+Date.now(), t:now_(), cid:(user&&user.cid)||'', action:'data.append:'+sheet, ok:1, blob:pack_({kind:payload.kind, record}) });
  return { appended:true, sheet, headers:headers.length };
}
function themeList() {
  try { return { themes: rows_('themes') }; } catch(e) { return { themes: [] }; }
}
function themeSave(payload, user) {
  const record = payload.record || payload || {};
  if (!record.id) record.id = 'theme_' + Date.now();
  appendSafe_('themes', ['id','name','bg','panel','panel2','text','muted','line','line2','accent','accent2','good','bad','warn','wallpaper'], record);
  return { saved:true, id:record.id };
}

function createProfile(payload, user) {
  const seed = Number(payload.seed || Math.floor(Math.random() * 999999999));
  const tag = String(payload.tag || payload.employeeTag || ('op' + seed)).trim();
  const hash = String(payload.hash || payload.loginHash || seed).trim();
  const rng = rng_(seed);
  const cid = 'c_' + tag.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
  const profile = generatedProfile_(seed, rng);
  append_('core', { cid, pos: '', ph: '', cn: payload.characterName || tag, pt: 'Generated', disc: 0, pnote: '', oid: cid.replace(/^c_/, ''), tag, hash, al: payload.access || 'User', th: payload.theme || 'Default', wp: '', av: '', occ: profile.occ, bid: 'ACC-' + tag.toUpperCase(), wd: tag + "'s Wallet", bal: profile.startingCents, cur: 'LGD', st: 'Active', pin: '', note: 'generated:' + seed });
  append_('desk', { cid, apps: TERMINAL_DESK_APPS, lay: TERMINAL_DESK_LAYOUT });
  writeLedger_(cid, 'ACC-' + tag.toUpperCase(), 'opening', profile.startingCents, 'LGD', 'Generated profile opening balance', 'system', profile);
  return { cid, profile };
}
function generatedProfile_(seed, rng) {
  function stat(base, scale, mult) { return Math.floor(base + Math.log(1 + rng() * scale) * mult); }
  const rare = Math.floor(Math.pow(rng(), 4) * 100);
  return { seed, occ: rare > 80 ? 'Abnormal Hire' : 'Standard Operator', startingCents: 10000 + Math.floor(Math.log(1 + rng() * 9999) * 8000), stats: { cognition: stat(6, 50, 6), durability: stat(6, 40, 5), willpower: stat(5, 60, 5), reaction: stat(5, 40, 4), endurance: stat(6, 70, 4) }, traits: pickTraits_(rng) };
}
function pickTraits_(rng) { const pool = ['Overtime Resistant','Receipt Goblin','Inventory Savant','Mildly Haunted','Customer Repellent','Warranty Whisperer','Forklift Adjacent','Register Gremlin']; return pool.sort(() => rng() - 0.5).slice(0, 2); }
function rng_(seed) { let x = Number(seed) || 123456789; return function() { x ^= x << 13; x ^= x >> 17; x ^= x << 5; return ((x >>> 0) / 4294967296); }; }

function packTest(payload) { const packed = pack_(payload || { hello: 'LMI' }); return { packed, unpacked: unpack_(packed) }; }

// Node replacements for Apps Script-only helpers.
function pack_(obj) {
  const json = JSON.stringify(obj || {});
  return zlib.gzipSync(Buffer.from(json, 'utf8')).toString('base64url');
}
function unpack_(text) {
  const buf = Buffer.from(String(text || ''), 'base64url');
  const json = zlib.gunzipSync(buf).toString('utf8');
  return JSON.parse(json || '{}');
}
function unpackSafe_(text) { try { return text ? unpack_(text) : {}; } catch (e) { return {}; } }
function currencyGold(payload, user) {
  const cached = cache_().get('currency:gold:usdPerLGD');
  if (cached) return JSON.parse(cached);
  const out = { xauUsd: 2160, usdPerLGD: 4.5, grainUsd:4.5, source:'local fallback; live fetch disabled in sync relay', asOf: now_(), fallback:true };
  cache_().put('currency:gold:usdPerLGD', JSON.stringify(out), 1800);
  try { appendSafe_('currencyRateCache', ['rateKey','value','source','updatedAt','notes'], { rateKey:'USD_PER_LGD', value:out.usdPerLGD, source:out.source, updatedAt:out.asOf, notes:'1 Ł = 1 grain Au = XAUUSD / 480' }); } catch(e) {}
  return out;
}


// -----------------------------------------------------------------------------
// FORCED ROUTE OVERRIDE: shell prefs must resolve by cid/tag/name, not stale row.
// This is assigned directly onto routes after routes is created.
// -----------------------------------------------------------------------------
function forcedResolveCoreForShellPrefs_(user = {}) {
  const rows = rows_('core');
  const u = user || {};

  const cid = String(u.cid || u.id || '').trim();
  if (cid) {
    const hit = rows.find(r => String(r.cid || r.id || '').trim() === cid);
    if (hit) return hit;
  }

  const tag = String(u.tag || u.username || '').trim().toLowerCase();
  if (tag) {
    const hit = rows.find(r => String(r.tag || r.username || '').trim().toLowerCase() === tag);
    if (hit) return hit;
  }

  const name = String(u.displayName || u.cn || u.name || '').trim().toLowerCase();
  if (name) {
    const hit = rows.find(r => String(r.cn || r.displayName || r.name || '').trim().toLowerCase() === name);
    if (hit) return hit;
  }

  return coreFromUser_(u);
}

function forcedParseShellPrefs_(c = {}) {
  const raw = c.shellPrefs ?? c.prefs ?? null;
  if (!raw) return {};
  if (typeof raw === 'object') return normalizeShellPrefs_(raw);
  try { return normalizeShellPrefs_(JSON.parse(String(raw))); }
  catch { return {}; }
}

function forcedUserShellGet_(payload = {}, user = {}) {
  const c = forcedResolveCoreForShellPrefs_((payload && payload.user) || user || {});
  const prefs = forcedParseShellPrefs_(c);

  return {
    prefs,
    shellPrefs: prefs,
    cid: c.cid || c.id || '',
    tag: c.tag || '',
    user: userFromCore_(c)
  };
}

function forcedUserShellSave_(payload = {}, user = {}) {
  const c = forcedResolveCoreForShellPrefs_((payload && payload.user) || user || {});
  const oldPrefs = forcedParseShellPrefs_(c);
  const incoming = normalizeShellPrefs_((payload && (payload.prefs || payload.shellPrefs)) || {});
  const prefs = normalizeShellPrefs_(Object.assign({}, oldPrefs, incoming));
  const cid = String(c.cid || c.id || '').trim();

  const changed = updateRows_(
    'core',
    r => String(r.cid || r.id || '').trim() === cid,
    r => Object.assign(r, { shellPrefs: JSON.stringify(prefs) })
  );

  appendSafe_('audit', ['id','t','cid','action','ok','blob'], {
    id: 'a_' + Date.now(),
    t: now_(),
    cid,
    action: 'user.shell.save.forced',
    ok: changed ? 1 : 0,
    blob: pack_({ shellPrefs: prefs })
  });

  return {
    saved: !!changed,
    prefs,
    shellPrefs: prefs,
    cid,
    tag: c.tag || ''
  };
}


const routes = {
  getCurrentAccount,
  updateCurrentAccount,
  'account.current.get': getCurrentAccount,
  'account.current.update': updateCurrentAccount,
  ping,
  login,
  getDesktopState,
  saveDesktopLayout,
  getModuleIndex,
  installApp,
  uninstallApp,
  'catalog.search': catalogSearch,
  'vehicles.search': vehiclesSearch,
  'vehicles.buy': vehiclesBuy,
  'bank.getAccount': bankGetAccount,
  'bank.ledger': bankLedger,
  'qvault.list': qvaultList,
  'qvault.add': qvaultAdd,
  'qvault.move': qvaultMove,
  'qvault.action': qvaultAction,
  'core.search': coreSearch,
  'pos.tender': posTender,
  'chat.rooms': chatRooms,
  'chat.posts': chatPosts,
  'chat.post': chatPost,
  'body.mods': bodyMods,
  'body.slots': bodySlots,
  'body.categories': bodyCategories,
  'body.installed': bodyInstalled,
  'body.install': bodyInstall,
  'body.bundle': bodyBundle,
  'body.profile.get': bodyProfileGet,
  'body.profile.save': bodyProfileSave,
  'body.profile.meshSet': bodyProfileMeshSet,
  'pharma.search': pharmaSearch,
  'pharma.buy': pharmaBuy,
  'pharma.compat': pharmaCompat,
  'pharma.add': pharmaAdd,
  'currency.gold': currencyGold,
  'currency.presets': currencyPresets,
  'data.append': dataAppend,
  'theme.list': themeList,
  'theme.save': themeSave,
  'user.wallpaper.save': saveUserWallpaper,
  'user.profile.get': userProfileGet,
  'user.profile.save': userProfileSave,
  'user.shell.get': userShellGet,
  'user.shell.save': userShellSave,
  getShellPrefs: userShellGet,
  saveShellPrefs: userShellSave,
  writeShellPrefs: userShellSave,
  setShellPrefs: userShellSave,
  'desktop.layout.save': saveDesktopLayout,

  'work.jobs': workJobs,
  'work.cashOut': workCashOut,
  createProfile,
  packTest
};

// Forced shell pref route overrides. These must run after const routes is created.
routes['user.shell.get'] = forcedUserShellGet_;
routes['user.shell.save'] = forcedUserShellSave_;
routes.getShellPrefs = forcedUserShellGet_;
routes.saveShellPrefs = forcedUserShellSave_;
routes.writeShellPrefs = forcedUserShellSave_;
routes.setShellPrefs = forcedUserShellSave_;



function parseBody(req){
  if(typeof req.body === 'object' && req.body) return req.body;
  const text = typeof req.body === 'string' ? req.body : '';
  if(!text) return {};
  return JSON.parse(text);
}
async function handleRelay(req, res){
  try{
    const body=parseBody(req);
    const action=String(body.action||'').trim();
    const payload=body.payload||{};
    const user=body.user||{};

    if (action === 'saveShellPrefs' || action === 'writeShellPrefs' || action === 'setShellPrefs') {
      return saveShellPrefsForRelay_(req, res);
    }


    if (action === 'getShellPrefs' || action === 'loadShellPrefs' || action === 'readShellPrefs') {
      return getShellPrefsForRelay_(req, res);
    }


    if (action === 'createAccount' || action === 'createUser' || action === 'provisionAccount') {
      return createAccountForRelay_(req, res);
    }


    if (action === 'listAccountOptions' || action === 'getAccountOptions') {
      return listAccountOptionsForRelay_(req, res);
    }


    if (action === 'getCurrentAccount' || action === 'account.current.get') {
      const data = await getCurrentAccount(payload, user, body);
      return res.json({ ok: true, data });
    }

    if (action === 'updateCurrentAccount' || action === 'account.current.update') {
      const data = await updateCurrentAccount(payload, user, body);
      return res.json({ ok: true, data });
    }

    if(!routes[action]) throw new Error('Unknown action: '+action);
    const data=await routes[action](payload, user, body);
    res.json({ok:true,data});
  }catch(err){
    res.status(200).json({ok:false,error:String(err && err.message ? err.message : err)});
  }
}
function requireAdmin(req,res,next){
  if(!ADMIN_TOKEN) return res.status(503).json({ok:false,error:'ADMIN_TOKEN is not configured'});
  const got=req.headers['x-admin-token'] || req.query.token;
  if(got !== ADMIN_TOKEN) return res.status(401).json({ok:false,error:'admin token required'});
  next();
}

app.get('/api/status', (req,res)=>res.json({ok:true,name:'BrokenSynapse VM Relay',status:'online',version:'1.0.0',sheets:listSheets()}));
app.get('/api/relay', (req,res)=>res.json({ok:true,data:{name:'BrokenSynapse VM Relay',status:'online',version:'1.0.0'}}));

const ATOMIKA_BYTES_PER_SECOND = 12000; // 96 kilobits/s.

function atomikaUrl_(raw) {
  const url = new URL(String(raw || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported quantum address protocol.');
  return url;
}

function htmlEscape_(value) {
  return String(value || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function atomikaErrorPage_(title, detail) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${htmlEscape_(title)}</title><style>body{margin:0;background:#e9e9e9;color:#333;font:18px system-ui,sans-serif;display:grid;place-items:center;height:100vh}.box{max-width:560px}.icon{font-size:54px;color:#999}h1{font-size:24px;font-weight:600}</style></head><body><div class="box"><div class="icon">?</div><h1>${htmlEscape_(title)}</h1><p>${htmlEscape_(detail)}</p></div></body></html>`;
}

function atomikaProxyPath_(url) {
  return `/api/atomika/fetch?url=${encodeURIComponent(url)}`;
}

function atomikaRewriteUrl_(raw, baseUrl) {
  const value = String(raw || '').trim();
  if (!value || value.startsWith('#') || /^(data|blob|mailto|tel|javascript|about):/i.test(value)) return raw;
  try {
    const resolved = new URL(value, baseUrl);
    if (!['http:', 'https:'].includes(resolved.protocol)) return raw;
    return atomikaProxyPath_(resolved.toString());
  } catch {
    return raw;
  }
}

function atomikaRewriteSrcset_(raw, baseUrl) {
  return String(raw || '').split(',').map(part => {
    const bits = part.trim().split(/\s+/);
    if (!bits[0]) return part;
    bits[0] = atomikaRewriteUrl_(bits[0], baseUrl);
    return bits.join(' ');
  }).join(', ');
}

function atomikaRewriteCssUrls_(text, baseUrl) {
  return String(text || '').replace(/url\((['"]?)([^'")]+)\1\)/gi, (all, quote, url) => {
    return `url(${quote || ''}${atomikaRewriteUrl_(url, baseUrl)}${quote || ''})`;
  });
}

function atomikaRewriteHtml_(html, baseUrl) {
  let out = String(html || '');
  out = out.replace(/<base\b[^>]*>/gi, '');
  out = out.replace(/\s(src|href|poster|action|data-src|data-original|data-lazy-src)=("([^"]*)"|'([^']*)'|([^\s>]+))/gi, (all, attr, raw, dq, sq, bare) => {
    const value = dq ?? sq ?? bare ?? '';
    return ` ${attr}="${htmlEscape_(atomikaRewriteUrl_(value, baseUrl))}"`;
  });
  out = out.replace(/\s(srcset|data-srcset)=("([^"]*)"|'([^']*)'|([^\s>]+))/gi, (all, attr, raw, dq, sq, bare) => {
    const value = dq ?? sq ?? bare ?? '';
    return ` ${attr}="${htmlEscape_(atomikaRewriteSrcset_(value, baseUrl))}"`;
  });
  out = out.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (all, attrs, css) => {
    return `<style${attrs}>${atomikaRewriteCssUrls_(css, baseUrl)}</style>`;
  });
  out = out.replace(/\sstyle=("([^"]*)"|'([^']*)')/gi, (all, raw, dq, sq) => {
    return ` style="${htmlEscape_(atomikaRewriteCssUrls_(dq ?? sq ?? '', baseUrl))}"`;
  });
  return out;
}

async function atomikaStreamBuffer_(res, buffer, bytesPerSecond = ATOMIKA_BYTES_PER_SECOND) {
  const chunkSize = 1024;
  for (let i = 0; i < buffer.length; i += chunkSize) {
    const chunk = buffer.subarray(i, Math.min(buffer.length, i + chunkSize));
    const jitter = 0.86 + Math.random() * 0.28;
    await new Promise(resolve => setTimeout(resolve, Math.max(8, (chunk.length / (bytesPerSecond * jitter)) * 1000)));
    res.write(chunk);
  }
  res.end();
}

async function atomikaStreamReader_(res, reader, bytesPerSecond = ATOMIKA_BYTES_PER_SECOND) {
  const chunkSize = 1024;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const buffer = Buffer.from(value);
    for (let i = 0; i < buffer.length; i += chunkSize) {
      const chunk = buffer.subarray(i, Math.min(buffer.length, i + chunkSize));
      const jitter = 0.86 + Math.random() * 0.28;
      await new Promise(resolve => setTimeout(resolve, Math.max(8, (chunk.length / (bytesPerSecond * jitter)) * 1000)));
      res.write(chunk);
    }
  }
  res.end();
}

app.get('/api/atomika/probe', async (req, res) => {
  try {
    const url = atomikaUrl_(req.query.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const upstream = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'ATOMIKA Browser/1.0 (96K QE Transit)' }
    });
    clearTimeout(timer);
    try { await upstream.body?.cancel(); } catch {}
    res.json({
      ok: upstream.ok,
      status: upstream.status,
      statusText: upstream.statusText,
      url: upstream.url,
      bytesPerSecond: ATOMIKA_BYTES_PER_SECOND
    });
  } catch (err) {
    res.status(200).json({
      ok: false,
      status: 0,
      statusText: String(err && err.message ? err.message : err),
      bytesPerSecond: ATOMIKA_BYTES_PER_SECOND
    });
  }
});

app.get('/api/atomika/fetch', async (req, res) => {
  try {
    const url = atomikaUrl_(req.query.url);
    const upstream = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'ATOMIKA Browser/1.0 (96K QE Transit)' }
    });

    const type = upstream.headers.get('content-type') || 'text/html; charset=utf-8';
    const lowerType = type.toLowerCase();
    res.status(upstream.status);
    res.setHeader('content-type', type);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-atomika-bandwidth', '96 kilobits/s');
    res.setHeader('x-atomika-origin', upstream.url);

    if (!upstream.ok || !upstream.body) {
      res.send(atomikaErrorPage_('ATOMIKA route lost', `${upstream.status} ${upstream.statusText || 'Destination refused connection.'}`));
      return;
    }

    if (lowerType.includes('text/html') || lowerType.includes('application/xhtml')) {
      const body = Buffer.from(await upstream.arrayBuffer()).toString('utf8');
      await atomikaStreamBuffer_(res, Buffer.from(atomikaRewriteHtml_(body, upstream.url), 'utf8'));
      return;
    }

    if (lowerType.includes('text/css')) {
      const body = Buffer.from(await upstream.arrayBuffer()).toString('utf8');
      await atomikaStreamBuffer_(res, Buffer.from(atomikaRewriteCssUrls_(body, upstream.url), 'utf8'));
      return;
    }

    await atomikaStreamReader_(res, upstream.body.getReader());
  } catch (err) {
    res.status(502).send(atomikaErrorPage_('ATOMIKA route lost', String(err && err.message ? err.message : err)));
  }
});

// -----------------------------------------------------------------------------
// Settings.LMX shell preference relay action
// Saves account-tied desktop/settings prefs such as icon size, grid snap,
// ambienceSrc, ambienceVolume, ambienceEnabled, etc.
// -----------------------------------------------------------------------------
function normalizeShellPrefs_(prefs) {
  if (!prefs || typeof prefs !== 'object') return {};

  const out = { ...prefs };

  if (out.iconSize !== undefined) {
    out.iconSize = Math.max(40, Math.min(120, Number(out.iconSize) || 60));
  }

  if (out.gridSnap !== undefined) {
    out.gridSnap = !!out.gridSnap;
  }

  if (out.ambienceVolume !== undefined) {
    const n = Number(out.ambienceVolume);
    out.ambienceVolume = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.35;
  }

  if (out.ambienceEnabled !== undefined) {
    out.ambienceEnabled = !!out.ambienceEnabled;
  }

  if (out.ambienceSrc !== undefined) {
    out.ambienceSrc = normalizeLmiAssetUrl_(out.ambienceSrc);
  }

  return out;
}




async function listAccountOptionsForRelay_(req, res) {
  try {
    const { execFile } = await import('node:child_process');

    const py = `
import sys, json, sqlite3, os

db_candidates = [
    os.environ.get("SQLITE_DB", ""),
    os.environ.get("DB_PATH", ""),
    "/data/brokensynapse.sqlite",
    "/app/data/brokensynapse.sqlite",
    "data/brokensynapse.sqlite",
]

db = None
for cand in db_candidates:
    if cand and os.path.exists(cand):
        db = cand
        break

if not db:
    print(json.dumps({"ok": False, "error": "SQLite database not found.", "checked": db_candidates}))
    sys.exit(0)

con = sqlite3.connect(db)
cur = con.cursor()
row = cur.execute("select rows_json from sheets where name='core'").fetchone()
rows = json.loads(row[0]) if row and row[0] else []

occupations = []
access_levels = []
statuses = []
currencies = []

for r in rows:
    occ = str(r.get("occ") or r.get("occupation") or "").strip()
    al = str(r.get("al") or r.get("access") or "").strip()
    st = str(r.get("st") or r.get("status") or "").strip()
    cur = str(r.get("cur") or r.get("currency") or "").strip()

    if occ: occupations.append(occ)
    if al: access_levels.append(al)
    if st: statuses.append(st)
    if cur: currencies.append(cur)

def uniq(xs):
    seen = set()
    out = []
    for x in xs:
        key = x.lower()
        if key not in seen:
            seen.add(key)
            out.append(x)
    return sorted(out, key=lambda x: x.lower())

print(json.dumps({
    "ok": True,
    "data": {
        "occupations": uniq(occupations),
        "accessLevels": uniq(access_levels),
        "statuses": uniq(statuses),
        "currencies": uniq(currencies),
        "db": db
    }
}))
`;

    const result = await new Promise((resolve) => {
      execFile('python3', ['-c', py], { timeout: 8000 }, (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: err.message || String(err), stderr });
          return;
        }

        try {
          resolve(JSON.parse(String(stdout || '{}')));
        } catch {
          resolve({ ok: false, error: 'Bad Python JSON response.', stdout, stderr });
        }
      });
    });

    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}


async function createAccountForRelay_(req, res) {
  try {
    let body = req && req.body !== undefined ? req.body : {};

    if (Buffer.isBuffer(body)) body = body.toString('utf8');

    if (typeof body === 'string') {
      try { body = JSON.parse(body || '{}'); }
      catch { body = {}; }
    }

    if (!body || typeof body !== 'object') body = {};

    const payload = body.payload && typeof body.payload === 'object' ? body.payload : body;

    const cleanTag = v => String(v || '')
      .trim()
      .replace(/\s+/g, '_')
      .replace(/[^A-Za-z0-9_-]/g, '')
      .toUpperCase();

    const tag = cleanTag(payload.tag || payload.employeeTag);
    const hash = String(payload.hash || payload.password || '').trim();
    const displayName = String(payload.displayName || payload.cn || payload.name || '').trim();

    const bankAccountId = String(payload.bankAccountId || payload.bid || '').trim();

    if (!tag || !hash || !displayName || !bankAccountId) {
      return res.status(400).json({
        ok: false,
        error: 'Employee tag, hash, display name, and bank account ID are required.'
      });
    }

    const access = String(payload.access || payload.al || 'User').trim() || 'User';
    const status = String(payload.status || payload.st || 'Active').trim() || 'Active';
    const occupation = String(payload.occupation || payload.occ || '').trim();
    const currency = String(payload.currency || payload.cur || 'USD').trim() || 'USD';
    const balance = Number(payload.balance ?? payload.bal ?? 0);
    const avatar = normalizeLmiAssetUrl_(payload.avatar || payload.av || '');
    const wallpaper = normalizeLmiAssetUrl_(payload.wallpaper || payload.wp || '');

    const shellPrefs = {
      iconSize: 60,
      gridSnap: true
    };

    const { execFile } = await import('node:child_process');

    const py = `
import sys, json, sqlite3, os, time, re

request = json.loads(sys.stdin.read() or "{}")

db_candidates = [
    os.environ.get("SQLITE_DB", ""),
    os.environ.get("DB_PATH", ""),
    "/data/brokensynapse.sqlite",
    "/app/data/brokensynapse.sqlite",
    "data/brokensynapse.sqlite",
]

db = None
for cand in db_candidates:
    if cand and os.path.exists(cand):
        db = cand
        break

if not db:
    print(json.dumps({"ok": False, "error": "SQLite database not found.", "checked": db_candidates}))
    sys.exit(0)

con = sqlite3.connect(db)
cur = con.cursor()

row = cur.execute("select rows_json from sheets where name='core'").fetchone()
rows = json.loads(row[0]) if row and row[0] else []

tag = request["tag"].upper()
display_name = request["displayName"]

for r in rows:
    if str(r.get("tag","")).upper() == tag:
        print(json.dumps({"ok": False, "error": "Employee tag already exists."}))
        sys.exit(0)

existing_cids = {str(r.get("cid","")) for r in rows}
base = "c_" + re.sub(r"[^a-z0-9_]+", "_", tag.lower()).strip("_")
cid = base or ("c_user_" + str(int(time.time())))

if cid in existing_cids:
    n = 2
    while f"{cid}_{n}" in existing_cids:
        n += 1
    cid = f"{cid}_{n}"

new_row = {
    "cid": cid,
    "tag": tag,
    "hash": request["hash"],
    "cn": display_name,
    "al": request["access"],
    "st": request["status"],
    "occ": request.get("occupation",""),
    "cur": request.get("currency","USD"),
    "bal": request.get("balance",0),
    "bid": request.get("bankAccountId",""),
    "av": request.get("avatar",""),
    "wp": request.get("wallpaper",""),
    "shellPrefs": request.get("shellPrefs") or {"iconSize":60,"gridSnap":True}
}

rows.append(new_row)

cur.execute("update sheets set rows_json=? where name='core'", (json.dumps(rows, separators=(",", ":")),))

# Create a matching desktop row so icon layout/installed apps can save per-user.
desk_row = cur.execute("select rows_json from sheets where name='desk'").fetchone()
desk_rows = json.loads(desk_row[0]) if desk_row and desk_row[0] else []

if not any(str(d.get("cid","")) == cid for d in desk_rows):
    default_apps = "x"
    default_lay = "x:0,18,80,70,980,680,0,0;bipac:0,18,80,70,980,680,0,0"

    desk_rows.append({
        "cid": cid,
        "apps": default_apps,
        "lay": default_lay
    })

    cur.execute(
        "update sheets set rows_json=? where name='desk'",
        (json.dumps(desk_rows, separators=(",", ":")),)
    )

con.commit()

print(json.dumps({
    "ok": True,
    "data": {
        "user": {
            "cid": cid,
            "tag": tag,
            "displayName": display_name,
            "access": request["access"],
            "status": request["status"]
        },
        "db": db
    }
}))
`;

    const request = {
      tag,
      hash,
      displayName,
      access,
      status,
      occupation,
      currency,
      balance: Number.isFinite(balance) ? balance : 0,
      bankAccountId,
      avatar,
      wallpaper,
      shellPrefs
    };

    const result = await new Promise((resolve) => {
      const child = execFile('python3', ['-c', py], { timeout: 8000 }, (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: err.message || String(err), stderr });
          return;
        }

        try {
          resolve(JSON.parse(String(stdout || '{}')));
        } catch {
          resolve({ ok: false, error: 'Bad Python JSON response.', stdout, stderr });
        }
      });

      child.stdin.write(JSON.stringify(request));
      child.stdin.end();
    });

    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}


async function getShellPrefsForRelay_(req, res) {
  try {
    let body = req && req.body !== undefined ? req.body : {};

    if (Buffer.isBuffer(body)) body = body.toString('utf8');

    if (typeof body === 'string') {
      try { body = JSON.parse(body || '{}'); }
      catch { body = {}; }
    }

    if (!body || typeof body !== 'object') body = {};

    const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
    const user =
      body.user ||
      payload.user ||
      body.session?.user ||
      payload.session?.user ||
      req.user ||
      req.lmiUser ||
      {};

    const cid = String(user.cid || payload.cid || body.cid || user.id || '').trim();
    const tag = String(user.tag || payload.tag || body.tag || user.employeeTag || payload.employeeTag || body.employeeTag || '').trim().toUpperCase();
    const displayName = String(user.displayName || user.cn || user.name || payload.displayName || payload.cn || payload.name || body.displayName || body.cn || body.name || '').trim();

    if (!cid && !tag && !displayName) {
      return res.status(400).json({
        ok: false,
        error: 'Missing user cid/tag/displayName for shell prefs load.'
      });
    }

    const { execFile } = await import('node:child_process');

    const py = `
import sys, json, sqlite3, os

request = json.loads(sys.stdin.read() or "{}")
cid = str(request.get("cid") or "").strip()
tag = str(request.get("tag") or "").strip().upper()
display_name = str(request.get("displayName") or "").strip().lower()

db_candidates = [
    os.environ.get("SQLITE_DB", ""),
    os.environ.get("DB_PATH", ""),
    "/data/brokensynapse.sqlite",
    "/app/data/brokensynapse.sqlite",
    "data/brokensynapse.sqlite",
]

db = None
for cand in db_candidates:
    if cand and os.path.exists(cand):
        db = cand
        break

if not db:
    print(json.dumps({"ok": False, "error": "SQLite database not found.", "checked": db_candidates}))
    sys.exit(0)

con = sqlite3.connect(db)
cur = con.cursor()
row = cur.execute("select rows_json from sheets where name='core'").fetchone()
rows = json.loads(row[0]) if row and row[0] else []

found = None
for r in rows:
    r_cid = str(r.get("cid") or "").strip()
    r_tag = str(r.get("tag") or "").strip().upper()
    r_name = str(r.get("cn") or r.get("displayName") or r.get("name") or "").strip().lower()
    if (cid and r_cid == cid) or (tag and r_tag == tag) or (display_name and r_name == display_name):
        found = r
        break

if not found:
    print(json.dumps({"ok": False, "error": "User not found for shell prefs load.", "debug": {"cid": cid, "tag": tag, "db": db}}))
    sys.exit(0)

prefs = found.get("shellPrefs") or {}
if isinstance(prefs, str):
    try:
        prefs = json.loads(prefs)
    except Exception:
        prefs = {}
if not isinstance(prefs, dict):
    prefs = {}

print(json.dumps({
    "ok": True,
    "data": {
        "shellPrefs": prefs,
        "user": {
            "cid": found.get("cid"),
            "tag": found.get("tag"),
            "displayName": found.get("cn") or found.get("displayName") or found.get("tag"),
            "access": found.get("al") or found.get("access")
        },
        "db": db
    }
}))
`;

    const result = await new Promise((resolve) => {
      const child = execFile('python3', ['-c', py], { timeout: 8000 }, (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: err.message || String(err), stderr });
          return;
        }

        try {
          resolve(JSON.parse(String(stdout || '{}')));
        } catch {
          resolve({ ok: false, error: 'Bad Python JSON response.', stdout, stderr });
        }
      });

      child.stdin.write(JSON.stringify({ cid, tag, displayName }));
      child.stdin.end();
    });

    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}


async function saveShellPrefsForRelay_(req, res) {
  try {
    let body = req && req.body !== undefined ? req.body : {};

    if (Buffer.isBuffer(body)) {
      body = body.toString('utf8');
    }

    if (typeof body === 'string') {
      try { body = JSON.parse(body || '{}'); }
      catch { body = {}; }
    }

    if (!body || typeof body !== 'object') body = {};

    const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};

    const user =
      body.user ||
      payload.user ||
      body.session?.user ||
      payload.session?.user ||
      req.user ||
      req.lmiUser ||
      {};

    const cid = String(
      user.cid ||
      payload.cid ||
      body.cid ||
      user.id ||
      ''
    ).trim();

    const tag = String(
      user.tag ||
      payload.tag ||
      body.tag ||
      user.employeeTag ||
      payload.employeeTag ||
      body.employeeTag ||
      ''
    ).trim().toUpperCase();

    const displayName = String(
      user.displayName ||
      user.cn ||
      user.name ||
      payload.displayName ||
      payload.cn ||
      payload.name ||
      body.displayName ||
      body.cn ||
      body.name ||
      ''
    ).trim();

    if (!cid && !tag && !displayName) {
      return res.status(400).json({
        ok: false,
        error: 'Missing user cid/tag/displayName for shell prefs save.',
        debug: {
          bodyKeys: Object.keys(body || {}),
          payloadKeys: Object.keys(payload || {}),
          userKeys: Object.keys(user || {})
        }
      });
    }

    const incoming = normalizeShellPrefs_(payload.prefs || payload.shellPrefs || body.prefs || body.shellPrefs || {});

    const { execFile } = await import('node:child_process');

    const py = `
import sys, json, sqlite3, os

request = json.loads(sys.stdin.read() or "{}")
cid = str(request.get("cid") or "").strip()
tag = str(request.get("tag") or "").strip().upper()
display_name = str(request.get("displayName") or "").strip().lower()
incoming = request.get("incoming") or {}

db_candidates = [
    os.environ.get("SQLITE_DB", ""),
    os.environ.get("DB_PATH", ""),
    "/data/brokensynapse.sqlite",
    "/app/data/brokensynapse.sqlite",
    "data/brokensynapse.sqlite",
]

db = None
for cand in db_candidates:
    if cand and os.path.exists(cand):
        db = cand
        break

if not db:
    print(json.dumps({"ok": False, "error": "SQLite database not found.", "checked": db_candidates}))
    sys.exit(0)

con = sqlite3.connect(db)
cur = con.cursor()

row = cur.execute("select rows_json from sheets where name='core'").fetchone()
rows = json.loads(row[0]) if row and row[0] else []

idx = -1
for i, r in enumerate(rows):
    r_cid = str(r.get("cid") or "").strip()
    r_tag = str(r.get("tag") or "").strip().upper()
    r_name = str(r.get("cn") or r.get("displayName") or r.get("name") or "").strip().lower()
    if (cid and r_cid == cid) or (tag and r_tag == tag) or (display_name and r_name == display_name):
        idx = i
        break

if idx < 0:
    print(json.dumps({"ok": False, "error": "User not found for shell prefs save.", "debug": {"cid": cid, "tag": tag, "db": db}}))
    sys.exit(0)

old = rows[idx].get("shellPrefs") or {}
if isinstance(old, str):
    try:
        old = json.loads(old)
    except Exception:
        old = {}
if not isinstance(old, dict):
    old = {}

next_prefs = dict(old)
next_prefs.update(incoming)

rows[idx]["shellPrefs"] = next_prefs

cur.execute("update sheets set rows_json=? where name='core'", (json.dumps(rows, separators=(",", ":")),))
con.commit()

user = rows[idx]
print(json.dumps({
    "ok": True,
    "data": {
        "shellPrefs": next_prefs,
        "user": {
            "cid": user.get("cid"),
            "tag": user.get("tag"),
            "displayName": user.get("cn") or user.get("displayName") or user.get("tag"),
            "access": user.get("al") or user.get("access")
        },
        "db": db
    }
}))
`;

    const result = await new Promise((resolve) => {
      const child = execFile('python3', ['-c', py], { timeout: 8000 }, (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: err.message || String(err), stderr });
          return;
        }

        try {
          resolve(JSON.parse(String(stdout || '{}')));
        } catch {
          resolve({ ok: false, error: 'Bad Python JSON response.', stdout, stderr });
        }
      });

      child.stdin.write(JSON.stringify({ cid, tag, displayName, incoming }));
      child.stdin.end();
    });

    if (!result.ok) {
      return res.status(400).json(result);
    }

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}




// -----------------------------------------------------------------------------
// HARD SETTINGS.LMX COMPAT CATCH
// This sits before the normal /api/relay handler so Settings cannot die from
// "Unknown action: getCurrentAccount" even if the routes table is stale/busted.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// EARLY SHELL PREFS RELAY CATCH
// Must run before the normal /api/relay handler. The normal route path is
// currently resolving user.shell.get to the wrong/blank row, so this makes
// cid/tag/name lookup explicit and returns the exact core.shellPrefs blob.
// -----------------------------------------------------------------------------
app.post('/api/relay', express.json({ limit: '5mb' }), async (req, res, next) => {
  try {
    const body = req.body || {};
    const action = String(body.action || '').trim();

    if (action !== 'user.shell.get' && action !== 'user.shell.save') {
      return next();
    }

    const payload = body.payload || {};
    const user = body.user || payload.user || {};

    const rows = rows_('core');

    function pickCore(u) {
      u = u || {};

      const cid = String(u.cid || u.id || '').trim();
      if (cid) {
        const hit = rows.find(r => String(r.cid || r.id || '').trim() === cid);
        if (hit) return hit;
      }

      const tag = String(u.tag || u.username || '').trim().toLowerCase();
      if (tag) {
        const hit = rows.find(r => String(r.tag || r.username || '').trim().toLowerCase() === tag);
        if (hit) return hit;
      }

      const name = String(u.displayName || u.cn || u.name || '').trim().toLowerCase();
      if (name) {
        const hit = rows.find(r => String(r.cn || r.displayName || r.name || '').trim().toLowerCase() === name);
        if (hit) return hit;
      }

      return rows[0] || {};
    }

    function parsePrefs(c) {
      let raw = c && c.shellPrefs;

      if (!raw && c && c.prefs) raw = c.prefs;

      if (!raw) return {};

      if (typeof raw === 'object') {
        return normalizeShellPrefs_(raw);
      }

      try {
        return normalizeShellPrefs_(JSON.parse(String(raw)));
      } catch {
        return {};
      }
    }

    const c = pickCore(user);
    const cid = String(c.cid || c.id || '').trim();
    const oldPrefs = parsePrefs(c);

    if (action === 'user.shell.get') {
      return res.json({
        ok: true,
        data: {
          prefs: oldPrefs,
          shellPrefs: oldPrefs,
          cid,
          tag: c.tag || '',
          user: userFromCore_(c)
        }
      });
    }

    const incoming = normalizeShellPrefs_(
      (payload && (payload.prefs || payload.shellPrefs)) || {}
    );

    const prefs = normalizeShellPrefs_(Object.assign({}, oldPrefs, incoming));

    const changed = updateRows_(
      'core',
      r => String(r.cid || r.id || '').trim() === cid,
      r => Object.assign(r, { shellPrefs: JSON.stringify(prefs) })
    );

    try {
      appendSafe_('audit', ['id','t','cid','action','ok','blob'], {
        id: 'a_' + Date.now(),
        t: now_(),
        cid,
        action,
        ok: changed ? 1 : 0,
        blob: pack_({ shellPrefs: prefs })
      });
    } catch {}

    return res.json({
      ok: true,
      data: {
        saved: !!changed,
        prefs,
        shellPrefs: prefs,
        cid,
        tag: c.tag || ''
      }
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: String(err && err.message ? err.message : err)
    });
  }
});


app.post('/api/relay', express.json({ limit: '5mb' }), async (req, res, next) => {
  try {
    const body = req.body || {};
    const action = String(body.action || '').trim();

    if (action !== 'getCurrentAccount' &&
        action !== 'updateCurrentAccount' &&
        action !== 'account.current.get' &&
        action !== 'account.current.update') {
      return next();
    }

    const payload = body.payload || {};
    const user = body.user || {};
    const c = coreFromUserStrict_((payload && payload.user) || user || {});

    if (action === 'getCurrentAccount' || action === 'account.current.get') {
      const prefs = shellPrefsFromCore_(c);
      return res.json({
        ok: true,
        data: {
          user: userFromCore_(c),
          raw: c,
          prefs,
          shellPrefs: prefs
        }
      });
    }

    const patch = payload.patch && typeof payload.patch === 'object'
      ? payload.patch
      : payload;

    const nextPatch = {};

    function first() {
      for (const k of arguments) {
        if (patch[k] !== undefined) return patch[k];
      }
      return undefined;
    }

    const displayName = first('displayName', 'cn', 'characterName');
    if (displayName !== undefined) nextPatch.cn = String(displayName || '').trim();

    const tag = first('tag');
    if (tag !== undefined) nextPatch.tag = String(tag || '').trim();

    const hash = first('hash');
    if (hash !== undefined) nextPatch.hash = String(hash || '');

    const access = first('access', 'al');
    if (access !== undefined) nextPatch.al = String(access || '').trim();

    const status = first('status', 'st');
    if (status !== undefined) nextPatch.st = String(status || '').trim();

    const occupation = first('occupation', 'occ');
    if (occupation !== undefined) nextPatch.occ = String(occupation || '').trim();

    const currency = first('currency', 'cur');
    if (currency !== undefined) nextPatch.cur = String(currency || '').trim();

    const bankAccountId = first('bankAccountId', 'bid');
    if (bankAccountId !== undefined) nextPatch.bid = String(bankAccountId || '').trim();

    const avatar = first('avatar', 'av');
    if (avatar !== undefined) nextPatch.av = String(avatar || '').trim();

    const wallpaper = first('wallpaper', 'wp');
    if (wallpaper !== undefined) nextPatch.wp = String(wallpaper || '').trim();

    const incomingPrefs = first('shellPrefs', 'prefs', 'desktopPrefs');
    if (incomingPrefs !== undefined) {
      const oldPrefs = shellPrefsFromCore_(c);
      const newPrefs = normalizeShellPrefs_(incomingPrefs || {});
      nextPatch.shellPrefs = JSON.stringify(Object.assign({}, oldPrefs, newPrefs));
    }

    let changed = 0;
    if (Object.keys(nextPatch).length) {
      changed = updateRows_(
        'core',
        r => String(r.cid) === String(c.cid),
        r => Object.assign(r, nextPatch)
      );
    }

    try {
      appendSafe_('audit', ['id','t','cid','action','ok','blob'], {
        id: 'a_' + Date.now(),
        t: now_(),
        cid: c.cid,
        action,
        ok: changed ? 1 : 0,
        blob: pack_({ changed: !!changed, keys: Object.keys(nextPatch) })
      });
    } catch {}

    const fresh = coreFromUserStrict_({ cid: c.cid });
    const prefs = shellPrefsFromCore_(fresh);

    return res.json({
      ok: true,
      data: {
        saved: !!changed,
        user: userFromCore_(fresh),
        raw: fresh,
        prefs,
        shellPrefs: prefs
      }
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: String(err && err.message ? err.message : err)
    });
  }
});


app.post('/api/relay', express.json({ limit: '5mb' }), async (req, res, next) => {
  const action = String((req.body || {}).action || '').trim();

  if (action === 'saveShellPrefs' || action === 'writeShellPrefs' || action === 'setShellPrefs') {
    return saveShellPrefsForRelay_(req, res);
  }

  return next();
});

app.post('/api/relay', handleRelay);
app.get('/api/admin/sheets', requireAdmin, (req,res)=>res.json({ok:true,sheets:listSheets()}));
app.get('/api/admin/sheets/:name', requireAdmin, (req,res)=>res.json({ok:true,sheet:getSheet(req.params.name)}));
app.post('/api/admin/sheets/:name', requireAdmin, (req,res)=>{ const b=parseBody(req); const out=putSheet(req.params.name,b.rows||[],b.headers||[]); appendAudit('admin.putSheet','admin',{name:req.params.name,rowCount:out.rowCount}); res.json({ok:true,...out}); });

app.listen(PORT, '0.0.0.0', ()=>console.log(`BrokenSynapse VM API listening on ${PORT}`));
