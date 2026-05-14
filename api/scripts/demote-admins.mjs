import { getSheet, putSheet, appendAudit } from '../lib/store.js';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');

function argValue(name, fallback = '') {
  const prefix = `${name}=`;
  const hit = process.argv.slice(2).find(arg => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

const keepAdmins = new Set(
  splitList(argValue('--keep', process.env.KEEP_ADMIN_TAGS || ''))
    .map(v => v.toLowerCase())
);

const demoteTo = argValue('--to', process.env.DEMOTE_TO || 'User').trim() || 'User';
const core = getSheet('core');

function userKeys(row) {
  return [
    row.cid,
    row.id,
    row.tag,
    row.username,
    row.cn,
    row.displayName,
    row.name
  ]
    .map(v => String(v || '').trim())
    .filter(Boolean);
}

function isAdmin(row) {
  return ['al', 'access', 'role'].some(key => {
    const value = String(row[key] || '').trim().toLowerCase();
    return value === 'admin' || value === 'administrator' || value === 'owner';
  });
}

function shouldKeep(row) {
  return userKeys(row).some(key => keepAdmins.has(key.toLowerCase()));
}

const demoted = [];
const rows = core.rows.map(row => {
  const next = { ...row };

  if (isAdmin(row) && !shouldKeep(row)) {
    demoted.push({
      cid: row.cid || '',
      tag: row.tag || row.username || '',
      name: row.cn || row.displayName || row.name || '',
      from: row.al || row.access || row.role || 'Admin',
      to: demoteTo
    });

    if (next.al !== undefined || (!next.access && !next.role)) next.al = demoteTo;
    if (next.access !== undefined) next.access = demoteTo;
    if (next.role !== undefined) next.role = demoteTo;
  }

  return next;
});

const kept = core.rows
  .filter(row => isAdmin(row) && shouldKeep(row))
  .map(row => ({
    cid: row.cid || '',
    tag: row.tag || row.username || '',
    name: row.cn || row.displayName || row.name || ''
  }));

console.log(JSON.stringify({
  ok: true,
  mode: apply ? 'apply' : 'dry-run',
  sheet: 'core',
  totalRows: core.rows.length,
  keepAdmins: [...keepAdmins],
  demoteTo,
  keptAdmins: kept,
  demoted
}, null, 2));

if (!apply) {
  console.log('\nDry run only. Re-run with --apply to write these changes.');
  process.exit(0);
}

putSheet('core', rows, core.headers);
appendAudit('maintenance.demoteAdmins', 'script', {
  demoteTo,
  keepAdmins: [...keepAdmins],
  demoted
});

console.log(`\nApplied: demoted ${demoted.length} admin row(s).`);
