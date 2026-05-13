(function(){
  const pending=new Map(); let context=null; let busyCount=0;
  const CURRENCY_KEY='LMI_CURRENCY_PREF';
  const CURRENCY_RATE_KEY='LMI_CURRENCY_RATES';
  const defaultCurrency={code:'LGD',label:'Leviathan Gold Dollar',symbol:'Ł',ratePerLGD:1,precision:3,mode:'fixed'};
  let currency=Object.assign({},defaultCurrency);
  function rid(){return 'r'+Math.random().toString(36).slice(2)+Date.now().toString(36)}
  function normalize(resp){ if(resp && resp.ok===true && Object.prototype.hasOwnProperty.call(resp,'data')) return resp.data; return resp; }
  function themeVars(){ try{return JSON.parse(localStorage.getItem('LMI_THEME_VARS')||'{}')}catch{return {}} }
  function applyTheme(vars){ vars=vars||themeVars(); Object.entries(vars).forEach(([k,v])=>{ if(k.startsWith('--')) document.documentElement.style.setProperty(k,String(v)); }); }
  function readCurrency(){ try{return Object.assign({},defaultCurrency,JSON.parse(localStorage.getItem(CURRENCY_KEY)||'{}'))}catch{return Object.assign({},defaultCurrency)} }
  function readRates(){ try{return JSON.parse(localStorage.getItem(CURRENCY_RATE_KEY)||'{}')}catch{return {}} }
  function saveCurrency(pref){ currency=Object.assign({},defaultCurrency,pref||{}); localStorage.setItem(CURRENCY_KEY,JSON.stringify(currency)); document.dispatchEvent(new CustomEvent('lmi-currency-change',{detail:currency})); return currency; }
  function emitCurrency(){ document.dispatchEvent(new CustomEvent('lmi-currency-change',{detail:currency})); }
  async function initCurrency(){
    currency=readCurrency();
    if(currency.mode==='liveGold'||currency.code==='USD_LIVE'){
      const cached=readRates();
      const age=Date.now()-Number(cached.savedAt||0);
      if(cached.usdPerLGD && age<30*60*1000){ currency.ratePerLGD=Number(cached.usdPerLGD)||currency.ratePerLGD||4.5; currency.source=cached.source||currency.source; currency.asOf=cached.asOf||currency.asOf; emitCurrency(); return currency; }
      try{
        const r=await api('currency.gold',{}, {silent:true,timeout:10000});
        const usd=Number(r.usdPerLGD||r.grainUsd||r.value||0);
        if(usd>0){
          currency=Object.assign({},currency,{code:'USD_LIVE',label:'US Dollar / live gold grain',symbol:'$',ratePerLGD:usd,precision:2,mode:'liveGold',source:r.source||'gold spot',asOf:r.asOf||new Date().toISOString()});
          localStorage.setItem(CURRENCY_RATE_KEY,JSON.stringify({usdPerLGD:usd,source:currency.source,asOf:currency.asOf,savedAt:Date.now()}));
          localStorage.setItem(CURRENCY_KEY,JSON.stringify(currency));
        }
      }catch(e){
        const cached=readRates();
        if(cached.usdPerLGD) currency.ratePerLGD=Number(cached.usdPerLGD);
        else currency.ratePerLGD=Number(currency.ratePerLGD||4.5);
        currency.source='fallback/cached';
      }
    }
    emitCurrency(); return currency;
  }
  function formatMoney(lgdAmount,opts){ const pref=currency||readCurrency(); const n=Number(lgdAmount||0)*Number(pref.ratePerLGD||1); const prec=Number.isFinite(Number(pref.precision))?Number(pref.precision):3; const body=Number(n||0).toLocaleString(undefined,{minimumFractionDigits:prec,maximumFractionDigits:prec}); return (pref.symbol||pref.code||'Ł')+body; }
  function toDisplay(lgdAmount){return Number(lgdAmount||0)*Number((currency||readCurrency()).ratePerLGD||1)}
  function currentCurrency(){return Object.assign({},currency||readCurrency())}
  function ensureLoader(){
    if(document.getElementById('lmiBusy')) return;
    const d=document.createElement('div'); d.id='lmiBusy'; d.className='lmi-busy'; d.innerHTML='<div class="lmi-spinner"></div><div class="lmi-busy-text">Polling relay…</div>';
    document.body.appendChild(d);
  }
  function setBusy(on,label){ ensureLoader(); busyCount=Math.max(0,busyCount+(on?1:-1)); const el=document.getElementById('lmiBusy'); if(label) el.querySelector('.lmi-busy-text').textContent=label; el.classList.toggle('active',busyCount>0); }
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin)return;
    const msg=event.data||{};
    if(msg.type==='LMI_CONTEXT'&&pending.has(msg.requestId)){pending.get(msg.requestId).resolve(msg.context); pending.delete(msg.requestId);}
    if(msg.type==='LMI_API_RESPONSE'&&pending.has(msg.requestId)){(msg.ok?pending.get(msg.requestId).resolve(normalize(msg.data)):pending.get(msg.requestId).reject(new Error(msg.error||'API error'))); pending.delete(msg.requestId);}
    if(msg.type==='LMI_RELAY_URL_STATUS') document.dispatchEvent(new CustomEvent('lmi-relay-status',{detail:msg}));
    if(msg.type==='LMI_THEME_PATCH'){ localStorage.setItem('LMI_THEME_VARS',JSON.stringify(msg.vars||{})); applyTheme(msg.vars||{}); }
    if(msg.type==='LMI_CURRENCY_PATCH'){ saveCurrency(msg.currency||{}); }
  });
  window.addEventListener('storage',e=>{ if(e.key==='LMI_THEME_VARS') applyTheme(); if(e.key===CURRENCY_KEY){currency=readCurrency(); emitCurrency();} });
  function ask(type,payload,timeoutMs=30000){return new Promise((resolve,reject)=>{const requestId=rid(); pending.set(requestId,{resolve,reject}); if(window.parent&&window.parent!==window){window.parent.postMessage(Object.assign({type,requestId},payload||{}),location.origin);}else{reject(new Error('No LMI desktop parent.'));} setTimeout(()=>{if(pending.has(requestId)){pending.delete(requestId); reject(new Error('LMI desktop did not respond.'));}},timeoutMs);});}
  async function getContext(){ if(context)return context; try{context=await ask('LMI_REQUEST_CONTEXT',{},8000); return context;}catch{return {user:{tag:'LOCAL',displayName:'Standalone',access:'Local'},session:{mode:'standalone'},hasRelay:!!localStorage.getItem('LMI_RELAY_URL')}} }
  async function api(action,payload,opts){ const silent=opts&&opts.silent; if(!silent)setBusy(true,opts&&opts.label||'Polling relay…'); try{ try{return await ask('LMI_API_REQUEST',{action,payload},opts&&opts.timeout||45000);}catch(e){ const url=localStorage.getItem('LMI_RELAY_URL'); if(!url) throw e; const ctl=new AbortController(); const t=setTimeout(()=>ctl.abort(),opts&&opts.timeout||45000); const res=await fetch(url,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action,payload}),signal:ctl.signal}); clearTimeout(t); const txt=await res.text(); let resp; try{resp=JSON.parse(txt)}catch{return {ok:res.ok,text:txt}} return normalize(resp); } } finally{ if(!silent)setBusy(false); } }
  function setRelayUrl(url){ if(window.parent&&window.parent!==window) window.parent.postMessage({type:'LMI_SET_RELAY_URL',url},location.origin); else { if(url)localStorage.setItem('LMI_RELAY_URL',url); else localStorage.removeItem('LMI_RELAY_URL'); document.dispatchEvent(new CustomEvent('lmi-relay-status',{detail:{ok:true,message:url?'Relay saved locally.':'Relay cleared.'}})); } }
  function refreshApps(){ if(window.parent&&window.parent!==window) window.parent.postMessage({type:'LMI_REFRESH_APPS'},location.origin); }
  function broadcastTheme(vars){ localStorage.setItem('LMI_THEME_VARS',JSON.stringify(vars||{})); applyTheme(vars||{}); if(window.parent&&window.parent!==window) window.parent.postMessage({type:'LMI_THEME_PATCH',vars},location.origin); }
  function broadcastCurrency(pref){ const c=saveCurrency(pref); if(window.parent&&window.parent!==window) window.parent.postMessage({type:'LMI_CURRENCY_PATCH',currency:c},location.origin); }
  function ready(appId,fn){ async function run(){ applyTheme(); ensureLoader(); await initCurrency(); fn(await getContext()); } if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',run,{once:true}); else run(); }
  window.LMI={ready,getContext,api,setRelayUrl,refreshApps,broadcastTheme,applyTheme,setBusy,broadcastCurrency,money:{format:formatMoney,toDisplay,current:currentCurrency,init:initCurrency,save:saveCurrency,key:CURRENCY_KEY}};
})();
