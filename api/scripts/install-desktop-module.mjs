import { getSheet, putSheet } from '../lib/store.js';

function argValue(name, fallback = '') {
  const prefix = `${name}=`;
  const hit = process.argv.slice(2).find(arg => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function mergeHeaders(headers, rows) {
  const seen = new Set((headers || []).filter(Boolean));
  for (const row of rows) for (const key of Object.keys(row || {})) seen.add(key);
  return [...seen];
}

const apply = process.argv.includes('--apply');
const userArg = String(argValue('--user', '') || '').trim().toLowerCase();
const appArg = String(argValue('--app', process.argv.slice(2).find(x => !x.startsWith('--')) || '') || '').trim().toLowerCase();

const core = getSheet('core');
const dict = getSheet('dictApps');
const desk = getSheet('desk');

const user = core.rows.find(row => [row.cid, row.tag, row.cn, row.displayName, row.name]
  .map(v => String(v || '').trim().toLowerCase())
  .includes(userArg));

if (!user || !appArg) {
  console.log(JSON.stringify({
    ok: false,
    error: 'Pass --user=<cid|tag|name> --app=<key|id|name>.',
    knownUsers: core.rows.map(row => ({ cid: row.cid || '', tag: row.tag || '', name: row.cn || row.displayName || row.name || '' }))
  }, null, 2));
  process.exit(1);
}

const app = dict.rows.find(row => [row.k, row.key, row.id, row.nm, row.name]
  .map(v => String(v || '').trim().toLowerCase())
  .includes(appArg));

if (!app) {
  console.log(JSON.stringify({
    ok: false,
    error: `App not found: ${appArg}`,
    knownApps: dict.rows.map(row => ({ key: row.k || row.key || '', id: row.id || '', name: row.nm || row.name || '' }))
  }, null, 2));
  process.exit(1);
}

const appKey = String(app.k || app.key || app.id || '').trim();
const terminalKey = 'x';
let foundDesk = false;

const nextDesk = desk.rows.map(row => {
  if (String(row.cid || '').trim() !== String(user.cid || '').trim()) return row;
  foundDesk = true;
  const apps = String(row.apps || '')
    .split(',')
    .map(x => String(x || '').trim())
    .filter(Boolean);
  if (!apps.includes(terminalKey)) apps.unshift(terminalKey);
  if (!apps.includes(appKey)) apps.push(appKey);
  return Object.assign({}, row, { apps: [...new Set(apps)].join(',') });
});

if (!foundDesk) {
  nextDesk.push({ cid: user.cid, apps: [terminalKey, appKey].filter(Boolean).join(','), lay: 'x:0,18,80,70,980,680,0,0;bipac:0,18,80,70,980,680,0,0' });
}

const result = {
  ok: true,
  mode: apply ? 'apply' : 'dry-run',
  user: { cid: user.cid || '', tag: user.tag || '', name: user.cn || user.displayName || user.name || '' },
  app: { key: appKey, id: app.id || '', name: app.nm || app.name || '' },
  before: desk.rows.find(row => String(row.cid || '').trim() === String(user.cid || '').trim()) || null,
  after: nextDesk.find(row => String(row.cid || '').trim() === String(user.cid || '').trim()) || null
};

if (apply) putSheet('desk', nextDesk, mergeHeaders(desk.headers, nextDesk));

console.log(JSON.stringify(result, null, 2));
console.log(apply ? `Applied: installed ${appKey} for ${user.tag || user.cid}.` : 'Dry run only. Re-run with --apply to write this change.');
