import fs from 'node:fs';
import fsp from 'node:fs/promises';
import https from 'https';
import path from 'path';
import * as XLSX from 'xlsx';
import { putSheet, listSheets } from '../lib/store.js';

const SHEET_ID = process.env.SHEET_ID || '1Kis40W84qlJVKvC6One9DX1iQvl0V71GL3UYXuZdWQc';
const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`;
const outPath = '/tmp/brokensynapse-gsheet.xlsx';

function download(url, file){
  return new Promise((resolve, reject)=>{
    const f=fs.createWriteStream(file);
    https.get(url, res=>{
      if(res.statusCode && res.statusCode>=300 && res.statusCode<400 && res.headers.location){
        f.close(); fs.rmSync(file,{force:true}); return download(res.headers.location, file).then(resolve,reject);
      }
      if(res.statusCode !== 200){ f.close(); return reject(new Error(`Download failed HTTP ${res.statusCode}`)); }
      res.pipe(f); f.on('finish',()=>f.close(resolve));
    }).on('error', reject);
  });
}
function cleanCell(v){
  if(v == null) return '';
  if(v instanceof Date) return v.toISOString();
  return v;
}
function sheetToRows(ws){
  const matrix = XLSX.utils.sheet_to_json(ws, { header:1, raw:false, defval:'' });
  if(!matrix.length) return { headers:[], rows:[] };
  const headers = (matrix[0]||[]).map(h=>String(h||'').trim()).filter(Boolean);
  const rows = matrix.slice(1).filter(r=>r.some(v=>String(v||'').trim() !== '')).map(r=>{
    const o={}; headers.forEach((h,i)=>o[h]=cleanCell(r[i])); return o;
  });
  return { headers, rows };
}

console.log(`Downloading Google Sheet ${SHEET_ID}...`);
await download(url, outPath);
const wb = XLSX.read(await fsp.readFile(outPath), { type:'buffer', cellDates:true });
for(const name of wb.SheetNames){
  const {headers, rows}=sheetToRows(wb.Sheets[name]);
  putSheet(name, rows, headers);
  console.log(`${name}: ${rows.length} row(s)`);
}
console.log('Imported sheets:', listSheets().map(s=>`${s.name}(${s.rowCount})`).join(', '));

process.exit(0);
