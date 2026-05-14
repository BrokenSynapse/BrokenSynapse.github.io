import { getSheet, putSheet, appendAudit } from '../lib/store.js';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');

function normalizeAssetUrl(value) {
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

function normalizePrefs(raw) {
  if (!raw) return raw;

  let prefs = raw;
  let wasString = false;

  if (typeof raw === 'string') {
    try {
      prefs = JSON.parse(raw);
      wasString = true;
    } catch {
      return raw;
    }
  }

  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return raw;

  const next = { ...prefs };
  if (Object.prototype.hasOwnProperty.call(next, 'ambienceSrc')) {
    next.ambienceSrc = normalizeAssetUrl(next.ambienceSrc);
  }

  return wasString ? JSON.stringify(next) : next;
}

const core = getSheet('core');
const changes = [];

const rows = core.rows.map((row, index) => {
  const next = { ...row };
  const before = {
    av: next.av ?? next.avatar ?? '',
    wp: next.wp ?? next.wallpaper ?? '',
    shellPrefs: next.shellPrefs
  };

  if (next.av !== undefined) next.av = normalizeAssetUrl(next.av);
  if (next.avatar !== undefined) next.avatar = normalizeAssetUrl(next.avatar);
  if (next.wp !== undefined) next.wp = normalizeAssetUrl(next.wp);
  if (next.wallpaper !== undefined) next.wallpaper = normalizeAssetUrl(next.wallpaper);
  if (next.shellPrefs !== undefined) next.shellPrefs = normalizePrefs(next.shellPrefs);

  const after = {
    av: next.av ?? next.avatar ?? '',
    wp: next.wp ?? next.wallpaper ?? '',
    shellPrefs: next.shellPrefs
  };

  if (JSON.stringify(before) !== JSON.stringify(after)) {
    changes.push({
      index,
      cid: row.cid || '',
      tag: row.tag || row.username || '',
      name: row.cn || row.displayName || row.name || '',
      before,
      after
    });
  }

  return next;
});

console.log(JSON.stringify({
  ok: true,
  mode: apply ? 'apply' : 'dry-run',
  sheet: 'core',
  totalRows: core.rows.length,
  changedRows: changes.length,
  changes
}, null, 2));

if (!apply) {
  console.log('\nDry run only. Re-run with --apply to write these changes.');
  process.exit(0);
}

putSheet('core', rows, core.headers);
appendAudit('maintenance.normalizeCoreAssets', 'script', { changedRows: changes.length, changes });

console.log(`\nApplied: normalized ${changes.length} core asset row(s).`);
