import { getSheet, putSheet } from '../lib/store.js';

const apply = process.argv.includes('--apply');
const resetDesktops = process.argv.includes('--reset-desktops');
const terminalKey = 'x';
const terminalLayout = 'x:0,18,80,70,980,680,0,0;bipac:0,18,80,70,980,680,0,0';
const terminalApp = {
  k: terminalKey,
  id: 'bipac',
  nm: 'LMI Terminal',
  path: 'modules/bipac.html?v=2026051611',
  ico: '>_',
  desc: 'Command shell for module discovery, descriptions, install, and launch',
  w: 980,
  h: 680,
  min: 'FALSE'
};

function mergeHeaders(headers, rows) {
  const seen = new Set((headers || []).filter(Boolean));
  for (const row of rows) {
    for (const key of Object.keys(row || {})) seen.add(key);
  }
  return [...seen];
}

const dict = getSheet('dictApps');
let terminalFound = false;
const seenKeys = new Set();
const nextApps = [];
dict.rows.forEach(row => {
  const key = String(row.k || row.key || '').trim().toLowerCase();
  const id = String(row.id || '').trim().toLowerCase();
  if (key === terminalKey || id === 'bipac') {
    if (terminalFound) return;
    terminalFound = true;
    nextApps.push(Object.assign({}, row, terminalApp));
    seenKeys.add(terminalKey);
    return;
  }
  const dedupeKey = key || id;
  if (dedupeKey && seenKeys.has(dedupeKey)) return;
  if (dedupeKey) seenKeys.add(dedupeKey);
  nextApps.push(row);
});
if (!terminalFound) nextApps.unshift(terminalApp);

const desk = getSheet('desk');
function normalizeDeskRow(row) {
  if (resetDesktops) return Object.assign({}, row, { apps: terminalKey, lay: terminalLayout });

  const apps = String(row.apps || '')
    .split(',')
    .map(x => String(x || '').trim())
    .filter(Boolean)
    .filter((x, i, arr) => arr.indexOf(x) === i);

  if (!apps.includes(terminalKey)) apps.unshift(terminalKey);

  const lay = String(row.lay || '').trim() || terminalLayout;
  return Object.assign({}, row, { apps: apps.join(','), lay });
}

const nextDesk = desk.rows.map(normalizeDeskRow);
const deskChanges = desk.rows.map((row, i) => ({
  cid: row.cid || '',
  before: { apps: row.apps || '', lay: row.lay || '' },
  after: { apps: nextDesk[i].apps || '', lay: nextDesk[i].lay || '' }
})).filter(change => change.before.apps !== change.after.apps || change.before.lay !== change.after.lay);

const result = {
  ok: true,
  mode: apply ? 'apply' : 'dry-run',
  dictAppsChanged: !terminalFound || JSON.stringify(nextApps) !== JSON.stringify(dict.rows),
  deskRows: desk.rows.length,
  changedDeskRows: deskChanges.length,
  changes: deskChanges
};

if (apply) {
  putSheet('dictApps', nextApps, mergeHeaders(dict.headers, nextApps));
  putSheet('desk', nextDesk, mergeHeaders(desk.headers, nextDesk));
}

console.log(JSON.stringify(result, null, 2));
console.log(apply
  ? `Applied: normalized ${deskChanges.length} desktop row(s).${resetDesktops ? ' Reset all desktops to LMI Terminal only.' : ' Preserved installed modules.'}`
  : 'Dry run only. Re-run with --apply to write these changes. Add --reset-desktops to wipe desktops back to Terminal only.');
