import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_PATH = process.env.DB_PATH || '/data/brokensynapse.sqlite';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS sheets (
  name TEXT PRIMARY KEY,
  headers_json TEXT NOT NULL DEFAULT '[]',
  rows_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  action TEXT,
  actor TEXT,
  payload_json TEXT
);
`);

function parseJson(text, fallback){ try { return JSON.parse(text || ''); } catch { return fallback; } }
function normalizeHeaders(headers){ return Array.from(new Set((headers||[]).map(x=>String(x||'').trim()).filter(Boolean))); }
function unionHeaders(a,b){ return normalizeHeaders([...(a||[]), ...(b||[])]); }
function sheetRecord(name){ return db.prepare('SELECT name, headers_json, rows_json FROM sheets WHERE name=?').get(name); }

export function listSheets(){
  return db.prepare('SELECT name, json_array_length(rows_json) AS rowCount, updated_at FROM sheets ORDER BY name').all();
}
export function getSheet(name){
  const rec=sheetRecord(name);
  if(!rec) return { name, headers: [], rows: [] };
  return { name, headers: parseJson(rec.headers_json, []), rows: parseJson(rec.rows_json, []) };
}
export function rows(name){ return getSheet(name).rows; }
export function ensureSheet(name, headers=[]){
  const current=getSheet(name);
  const finalHeaders=unionHeaders(current.headers, headers);
  db.prepare(`INSERT INTO sheets(name,headers_json,rows_json,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP)
              ON CONFLICT(name) DO UPDATE SET headers_json=excluded.headers_json, updated_at=CURRENT_TIMESTAMP`).run(name, JSON.stringify(finalHeaders), JSON.stringify(current.rows || []));
  return getSheet(name);
}
export function putSheet(name, rowsIn=[], headers=[]){
  const rows=(rowsIn||[]).map(r=>Object.assign({}, r));
  let finalHeaders=normalizeHeaders(headers);
  for(const r of rows) finalHeaders=unionHeaders(finalHeaders, Object.keys(r));
  db.prepare(`INSERT INTO sheets(name,headers_json,rows_json,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP)
              ON CONFLICT(name) DO UPDATE SET headers_json=excluded.headers_json, rows_json=excluded.rows_json, updated_at=CURRENT_TIMESTAMP`).run(name, JSON.stringify(finalHeaders), JSON.stringify(rows));
  return { name, headers: finalHeaders, rowCount: rows.length };
}
export function appendRow(name, obj={}){
  const sh=ensureSheet(name, Object.keys(obj));
  const next=[...sh.rows, Object.assign({}, obj)];
  return putSheet(name, next, unionHeaders(sh.headers, Object.keys(obj)));
}
export function updateRows(name, predicate, patcher){
  const sh=ensureSheet(name, []);
  let changed=0;
  const next=sh.rows.map(row=>{
    const copy=Object.assign({}, row);
    if(predicate(copy)){
      const patch=patcher(Object.assign({}, copy)) || {};
      Object.keys(patch).forEach(k=>{ if(patch[k] !== undefined) copy[k]=patch[k]; });
      changed++;
    }
    return copy;
  });
  if(changed) putSheet(name, next, unionHeaders(sh.headers, next.flatMap(r=>Object.keys(r))));
  return changed;
}
export function appendAudit(action, actor, payload){
  db.prepare('INSERT INTO audit_log(action,actor,payload_json) VALUES(?,?,?)').run(action||'', actor||'', JSON.stringify(payload||{}));
}
export function exportAll(){
  const out={ sheets:{}, meta:{ exportedAt:new Date().toISOString() } };
  for(const s of listSheets()) out.sheets[s.name]=getSheet(s.name);
  return out;
}
