(function(){
  const pending=new Map(); let context=null; let busyCount=0;
  function rid(){return 'r'+Math.random().toString(36).slice(2)+Date.now().toString(36)}
  function normalize(resp){ if(resp && resp.ok===true && Object.prototype.hasOwnProperty.call(resp,'data')) return resp.data; return resp; }
  function themeVars(){ try{return JSON.parse(localStorage.getItem('LMI_THEME_VARS')||'{}')}catch{return {}} }
  function applyTheme(vars){ vars=vars||themeVars(); Object.entries(vars).forEach(([k,v])=>{ if(k.startsWith('--')) document.documentElement.style.setProperty(k,String(v)); }); }
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
  });
  window.addEventListener('storage',e=>{ if(e.key==='LMI_THEME_VARS') applyTheme(); });
  function ask(type,payload,timeoutMs=30000){return new Promise((resolve,reject)=>{const requestId=rid(); pending.set(requestId,{resolve,reject}); if(window.parent&&window.parent!==window){window.parent.postMessage(Object.assign({type,requestId},payload||{}),location.origin);}else{reject(new Error('No LMI desktop parent.'));} setTimeout(()=>{if(pending.has(requestId)){pending.delete(requestId); reject(new Error('LMI desktop did not respond.'));}},timeoutMs);});}
  async function getContext(){ if(context)return context; try{context=await ask('LMI_REQUEST_CONTEXT',{},8000); return context;}catch{return {user:{tag:'LOCAL',displayName:'Standalone',access:'Local'},session:{mode:'standalone'},hasRelay:!!localStorage.getItem('LMI_RELAY_URL')}} }
  async function api(action,payload,opts){ const silent=opts&&opts.silent; if(!silent)setBusy(true,opts&&opts.label||'Polling relay…'); try{ try{return await ask('LMI_API_REQUEST',{action,payload},opts&&opts.timeout||45000);}catch(e){ const url=localStorage.getItem('LMI_RELAY_URL'); if(!url) throw e; const ctl=new AbortController(); const t=setTimeout(()=>ctl.abort(),opts&&opts.timeout||45000); const res=await fetch(url,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action,payload}),signal:ctl.signal}); clearTimeout(t); const txt=await res.text(); let resp; try{resp=JSON.parse(txt)}catch{return {ok:res.ok,text:txt}} return normalize(resp); } } finally{ if(!silent)setBusy(false); } }
  function setRelayUrl(url){ if(window.parent&&window.parent!==window) window.parent.postMessage({type:'LMI_SET_RELAY_URL',url},location.origin); else { if(url)localStorage.setItem('LMI_RELAY_URL',url); else localStorage.removeItem('LMI_RELAY_URL'); document.dispatchEvent(new CustomEvent('lmi-relay-status',{detail:{ok:true,message:url?'Relay saved locally.':'Relay cleared.'}})); } }
  function refreshApps(){ if(window.parent&&window.parent!==window) window.parent.postMessage({type:'LMI_REFRESH_APPS'},location.origin); }
  function broadcastTheme(vars){ localStorage.setItem('LMI_THEME_VARS',JSON.stringify(vars||{})); applyTheme(vars||{}); if(window.parent&&window.parent!==window) window.parent.postMessage({type:'LMI_THEME_PATCH',vars},location.origin); }
  function ready(appId,fn){ document.addEventListener('DOMContentLoaded',async()=>{ applyTheme(); ensureLoader(); fn(await getContext()); }); }
  window.LMI={ready,getContext,api,setRelayUrl,refreshApps,broadcastTheme,applyTheme,setBusy};
})();