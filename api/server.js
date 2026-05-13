import express from 'express';
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
  tag = String(tag || '').trim(); hash = String(hash || '').trim();
  const row = rows_('core').find(r => String(r.tag).toLowerCase() === tag.toLowerCase() && String(r.hash) === hash && String(r.st || 'Active').toLowerCase() !== 'disabled');
  if (!row) throw new Error('Invalid employee tag or hash.');
  return row;
}
function coreFromUser_(user) {
  const cid = user && user.cid;
  const tag = user && user.tag;
  if (cid) { const row = rows_('core').find(r => r.cid === cid); if (row) return row; }
  if (tag) { const row = rows_('core').find(r => String(r.tag).toLowerCase() === String(tag).toLowerCase()); if (row) return row; }
  throw new Error('No authenticated LMI user context.');
}
function userFromCore_(c) {
  return { cid: c.cid, tag: c.tag, displayName: c.cn || c.tag, access: c.al || 'User', theme: c.th || 'Default', avatar: c.av || '', wallpaper: c.wp || '', bankAccountId: c.bid || '', currency: c.cur || 'LGD' };
}

function login(payload) {
  const c = getCoreByLogin_(payload.tag || payload.employeeTag, payload.hash || payload.loginHash);
  return { user: userFromCore_(c), session: { mode: 'relay', at: now_() } };
}

function appDict_() {
  const out = {};
  rows_('dictApps').forEach(a => out[String(a.k)] = a);
  return out;
}
function decodeLayout_(text) {
  if (!text) return {};
  const out = {};
  String(text).split(';').filter(Boolean).forEach(part => {
    const bits = part.split(':'); if (bits.length < 2) return;
    const a = bits[0]; const v = bits[1].split(',').map(x => Number(x || 0));
    out[a] = { iconX: v[0], iconY: v[1], x: v[2], y: v[3], w: v[4], h: v[5], minimized: !!v[6], maximized: !!v[7] };
  });
  return out;
}
function encodeLayout_(layout) {
  return Object.keys(layout || {}).map(k => {
    const v = layout[k] || {};
    return [k, [v.iconX || 40, v.iconY || 80, v.x || 120, v.y || 90, v.w || 800, v.h || 600, v.minimized ? 1 : 0, v.maximized ? 1 : 0].join(',')].join(':');
  }).join(';');
}
function getDesktopState(payload, user) {
  const c = payload && payload.tag ? getCoreByLogin_(payload.tag, payload.hash) : coreFromUser_(user);
  const desk = rows_('desk').find(d => d.cid === c.cid) || { apps: '', lay: '' };
  const dict = appDict_(); const layout = decodeLayout_(desk.lay);
  const apps = String(desk.apps || '').split(',').filter(Boolean).map(k => {
    const a = dict[k]; if (!a) return null;
    const l = layout[k] || {};
    return { key: k, id: a.id, name: a.nm, path: a.path, icon: a.ico, description: a.desc, min: a.min, w: Number(l.w || a.w || 900), h: Number(l.h || a.h || 620), x: Number(l.x || 80), y: Number(l.y || 70), iconX: Number(l.iconX || 40), iconY: Number(l.iconY || 80) };
  }).filter(Boolean);
  return { user: userFromCore_(c), apps, settings: { theme: c.th || 'Default', source: 'sheet' } };
}
function getModuleIndex() { return rows_('dictApps'); }
function saveDesktopLayout(payload, user) {
  const c = coreFromUser_(user);
  const dict = appDict_();
  const appId = payload.appId;
  const key = Object.keys(dict).find(k => dict[k].id === appId || k === appId);
  if (!key) throw new Error('Unknown app: ' + appId);
  const changed = updateRows_('desk', r => r.cid === c.cid, r => {
    const lay = decodeLayout_(r.lay);
    lay[key] = Object.assign({}, lay[key] || {}, payload.layout || {});
    return { lay: encodeLayout_(lay) };
  });
  return { changed };
}
function installApp(payload, user) { return toggleApp_(payload, user, true); }
function uninstallApp(payload, user) { return toggleApp_(payload, user, false); }
function toggleApp_(payload, user, install) {
  const c = coreFromUser_(user); const dict = appDict_();
  const key = Object.keys(dict).find(k => dict[k].id === payload.appId || k === payload.appId);
  if (!key) throw new Error('Unknown app: ' + payload.appId);
  updateRows_('desk', r => r.cid === c.cid, r => {
    let apps = String(r.apps || '').split(',').filter(Boolean);
    if (install && apps.indexOf(key) < 0) apps.push(key);
    if (!install) apps = apps.filter(x => x !== key);
    return { apps: apps.join(',') };
  });
  return { appKey: key, installed: install };
}

function catalogSearch(payload) {
  const q = String((payload && payload.query) || '').toLowerCase();
  const limit = Math.min(Number(payload && payload.limit || 500), 5000);
  const all = rows_('catalog').map(r => {
    const price = pick_(r, ['price','Price','retail','Retail','cost','Cost'], '') !== '' ? moneyVal_(pick_(r, ['price','Price','retail','Retail','cost','Cost'], 0)) : centsToNumber_(pick_(r, ['cents','Cents'], 0));
    return { id: pick_(r,['iid','id','ID','Item ID','itemId'],''), sku: pick_(r,['pn','sku','SKU','part','Part Number','Part'],''), upc: pick_(r,['upc','UPC'],''), name: pick_(r,['nm','name','Name','item','Item','description','Description'],''), price, manufacturer: pick_(r,['mfg','manufacturer','Manufacturer','brand','Brand'],''), description: pick_(r,['desc','description','Description','notes','Notes'],''), category: [pick_(r,['c1','Main Category','mainCategory','Department','department'],''), pick_(r,['c2','Second Category','secondCategory','Category','category'],''), pick_(r,['c3','Third Category','thirdCategory','Subcategory','subcategory'], '')].filter(Boolean).join(' / '), image: pick_(r,['img','image','Image','imageUrl','Image URL'],''), quality: pick_(r,['q','quality','Quality','qualityTier'], '') };
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
function bodyMods() { ensureSheet_('mods', ['mid','slot','nm','cat','st','mfg','desc','fx','draw','rare','compat','diff','vis','lockChild','locks','replace','cost','unCost','validSlots','supportType','lmexCertified','cardiovascularOutput','pressureTolerance','renalClearance','hepaticProcessing','thermalLoad','neuralBuffer','sleepState','glucoseElectrolyte','supportNotes']); return { mods: rows_('mods') }; }
function bodySlots() { ensureSheet_('bodySlots', ['slot','label','region','ord','note']); return { slots: rows_('bodySlots').map(r => r.slot || r.label).filter(Boolean) }; }
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
  append_('audit', { id: 'a_' + Date.now(), t: now_(), cid: c.cid, action: 'pos.tender', ok: 1, blob: pack_(payload) });
  return { tendered: true, txid, cents };
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
  return { slots: bodySlots().slots, mods: bodyMods().mods, installed: bodyInstalled(payload || {}, user).installed };
}

function boolish_(v) { return v === true || String(v).toLowerCase() === 'true' || String(v) === '1' || String(v).toLowerCase() === 'yes'; }
function n_(v) { var x = Number(v || 0); return isNaN(x) ? 0 : x; }
function pharmaSheet_() {
  return ensureSheet_('pharmaItems', ['pid','sku','nm','company','category','publicOutletTier','form','quantity','labelUse','priceCents','buyable','subscription','purityGrade','workUtility','shiftCompatibility','dependency','tolerance','withdrawal','abuseLoop','supportNeed','requiredRatings','disclaimers','warnings','effects','sideEffects','interactions','tags','structure','img','desc']);
}
function pharmaNormalize_(r) {
  var price = pick_(r, ['priceCents','cents','Price Cents','price','Price'], '') !== '' ? moneyVal_(pick_(r, ['priceCents','cents','Price Cents','price','Price'], 0)) : 0;
  if (pick_(r, ['priceCents','cents','Price Cents'], '') !== '' && price < 100 && Number(pick_(r, ['priceCents','cents','Price Cents'], 0)) > 100) price = Number(pick_(r, ['priceCents','cents','Price Cents'], 0)) / 100;
  return {
    pid: pick_(r,['pid','id','ID','compoundId'],''), sku: pick_(r,['sku','SKU','pn'],''), name: pick_(r,['nm','name','Name'],''), company: pick_(r,['company','mfg','manufacturer','Manufacturer'],''),
    category: pick_(r,['category','cat','Category'],''), publicOutletTier: pick_(r,['publicOutletTier','tier','Public Outlet Tier'],''), form: pick_(r,['form','Form'],''), quantity: pick_(r,['quantity','qty','Quantity'],''),
    labelUse: pick_(r,['labelUse','suggestedUse','Suggested Use','use'],''), price: price, buyable: boolish_(pick_(r,['buyable','Buyable'],true)), subscription: boolish_(pick_(r,['subscription','Subscription'],false)),
    purityGrade: pick_(r,['purityGrade','Purity Grade'],''), workUtility: pick_(r,['workUtility','Work Utility'],''), shiftCompatibility: pick_(r,['shiftCompatibility','Shift Compatibility'],''),
    dependency: n_(pick_(r,['dependency','addictiveness','Addictiveness'],0)), tolerance: n_(pick_(r,['tolerance','toleranceBuildup'],0)), withdrawal: n_(pick_(r,['withdrawal','withdrawalBurden'],0)), abuseLoop: n_(pick_(r,['abuseLoop','abuseLoopRisk'],0)), supportNeed: n_(pick_(r,['supportNeed','support'],0)),
    requiredRatings: pick_(r,['requiredRatings','Required Ratings'],''), disclaimers: pick_(r,['disclaimers','Disclaimer'],''), warnings: pick_(r,['warnings','Warnings'],''), effects: pick_(r,['effects','Effects'],''), sideEffects: pick_(r,['sideEffects','Side Effects'],''), interactions: pick_(r,['interactions','Interactions'],''), tags: pick_(r,['tags','Tags'],''), structure: pick_(r,['structure','Structure'],''), image: pick_(r,['img','image','Image','imageUrl'],''), description: pick_(r,['desc','description','Description'],'')
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
  return { bought:true, item:item, qty:qty, amount:amount, compat:compat };
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
  const allowed = ['core','catalog','vehicles','mods','bodySlots','dictApps','themes','chatRooms','work','pharmaItems','currencySettings','bodyProfiles','bodyInstalled'];
  const sheet = String(payload && payload.sheet || '').trim();
  if (allowed.indexOf(sheet) < 0) throw new Error('DataForge refused sheet: ' + sheet);
  const record = payload.record || {};
  const s = ensureSheet_(sheet, Object.keys(record).length ? Object.keys(record) : ['id','blob']);
  const headers = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0].map(String);
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
  append_('desk', { cid, apps: 'b,x,k,w,r,m,s', lay: '' });
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

const routes = {
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
  'core.search': coreSearch,
  'pos.tender': posTender,
  'chat.rooms': chatRooms,
  'chat.posts': chatPosts,
  'chat.post': chatPost,
  'body.mods': bodyMods,
  'body.slots': bodySlots,
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
  'work.jobs': workJobs,
  'work.cashOut': workCashOut,
  createProfile,
  packTest
};

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
    if(!routes[action]) throw new Error('Unknown action: '+action);
    const data=await routes[action](payload, user, body);
    res.json({ok:true,data});
  }catch(err){
    res.status(200).json({ok:false,error:String(err && err.message ? err.message : err)});
  }
}
function requireAdmin(req,res,next){
  if(!ADMIN_TOKEN) return next();
  const got=req.headers['x-admin-token'] || req.query.token;
  if(got !== ADMIN_TOKEN) return res.status(401).json({ok:false,error:'admin token required'});
  next();
}

app.get('/api/status', (req,res)=>res.json({ok:true,name:'BrokenSynapse VM Relay',status:'online',version:'1.0.0',sheets:listSheets()}));
app.get('/api/relay', (req,res)=>res.json({ok:true,data:{name:'BrokenSynapse VM Relay',status:'online',version:'1.0.0'}}));
app.post('/api/relay', handleRelay);
app.get('/api/admin/sheets', requireAdmin, (req,res)=>res.json({ok:true,sheets:listSheets()}));
app.get('/api/admin/sheets/:name', requireAdmin, (req,res)=>res.json({ok:true,sheet:getSheet(req.params.name)}));
app.post('/api/admin/sheets/:name', requireAdmin, (req,res)=>{ const b=parseBody(req); const out=putSheet(req.params.name,b.rows||[],b.headers||[]); appendAudit('admin.putSheet','admin',{name:req.params.name,rowCount:out.rowCount}); res.json({ok:true,...out}); });

app.listen(PORT, '0.0.0.0', ()=>console.log(`BrokenSynapse VM API listening on ${PORT}`));
