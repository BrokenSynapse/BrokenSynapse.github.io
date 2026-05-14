import { getSheet } from '../lib/store.js';

function argValue(name, fallback = '') {
  const prefix = `${name}=`;
  const hit = process.argv.slice(2).find(arg => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function decodeLayout(text) {
  if (!text) return {};
  const raw = String(text || '').trim();

  if (raw.startsWith('{')) {
    try {
      return JSON.parse(raw);
    } catch {}
  }

  const out = {};
  raw.split(';').filter(Boolean).forEach(part => {
    const bits = part.split(':');
    if (bits.length < 2) return;
    const key = bits[0];
    const v = bits[1].split(',').map(x => Number(x || 0));
    out[key] = {
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

const userArg = String(argValue('--user', process.argv.slice(2)[0] || '') || '').trim().toLowerCase();
const core = getSheet('core');
const desk = getSheet('desk');

const user = core.rows.find(row => {
  if (!userArg) return false;
  return [row.cid, row.tag, row.cn, row.displayName, row.name]
    .map(v => String(v || '').trim().toLowerCase())
    .includes(userArg);
});

if (!user) {
  console.log(JSON.stringify({
    ok: false,
    error: 'User not found. Pass --user=<cid|tag|name>.',
    knownUsers: core.rows.map(row => ({
      cid: row.cid || '',
      tag: row.tag || '',
      name: row.cn || row.displayName || row.name || ''
    }))
  }, null, 2));
  process.exit(1);
}

const row = desk.rows.find(d => String(d.cid || '').trim() === String(user.cid || '').trim());

console.log(JSON.stringify({
  ok: true,
  user: {
    cid: user.cid || '',
    tag: user.tag || '',
    name: user.cn || user.displayName || user.name || ''
  },
  desk: row || null,
  layout: decodeLayout(row && row.lay)
}, null, 2));
