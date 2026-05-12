(async function(){
  const runtime=window.LMI_RUNTIME={user:null,session:null,apps:[],desktopState:null};
  const $=id=>document.getElementById(id);
  function setStatus(txt,cls=''){ const el=$('loginStatus'); if(el){el.textContent=txt; el.className='login-status '+cls;} }
  function getInstalled(){ try{return JSON.parse(localStorage.getItem(LMI_CONFIG.localKeys.installed)||'null')}catch{return null} }
  function setInstalled(ids){ localStorage.setItem(LMI_CONFIG.localKeys.installed,JSON.stringify(ids)); }
  function getLayout(){ try{return JSON.parse(localStorage.getItem(LMI_CONFIG.localKeys.layout)||'{}')}catch{return {}} }
  function saveLayout(o){ localStorage.setItem(LMI_CONFIG.localKeys.layout,JSON.stringify(o||{})); }
  window.LMI_DESKTOP={
    getSavedWindow(id){return getLayout()[id]||null},
    saveWindow(id,data){const l=getLayout(); l[id]=Object.assign({},l[id]||{},data); saveLayout(l); if(runtime.session?.mode==='relay') LMI_API.callRelay('saveDesktopLayout',{appId:id,layout:data},runtime.user).catch(()=>{});},
    refreshApps:renderDesktop,
    getApps(){return runtime.apps||[];}
  };
  async function loadManifest(){
    try{ const res=await fetch(LMI_CONFIG.manifestPath,{cache:'no-store'}); if(res.ok)return await res.json(); }catch{}
    return [];
  }
  function normalizeApp(a){return {id:a.id||a.appId, name:a.name||a.nm||a.id, title:a.title||a.name||a.nm, path:a.path||a.modulePath, icon:a.icon||a.ico||'□', description:a.description||a.desc||'', w:Number(a.w||a.defaultW||900), h:Number(a.h||a.defaultH||620), x:Number(a.x||80), y:Number(a.y||70)} }
  function renderDesktop(){
    const desk=$('desktopIcons'); if(!desk)return; desk.innerHTML='';
    const installed=(runtime.session?.mode==='relay')?null:getInstalled();
    const apps=runtime.apps.filter(a=>!installed||installed.includes(a.id)||a.id==='settings'||a.id==='bipac');
    apps.forEach((app,i)=>{ const b=document.createElement('button'); b.className='desktop-icon'; b.style.left=(Number(app.iconX)||((i%6)*145+36))+'px'; b.style.top=(Number(app.iconY)||(Math.floor(i/6)*145+72))+'px'; b.innerHTML=`<span class="icon-box">${app.icon||'□'}</span><strong>${app.name}</strong><em>${app.description||''}</em>`; b.ondblclick=()=>LMI_WM.openWindow(app); b.onclick=()=>{document.querySelectorAll('.desktop-icon').forEach(x=>x.classList.remove('selected')); b.classList.add('selected');}; desk.appendChild(b); });
  }
  async function loadDesktopState(user){
    let manifest=(await loadManifest()).map(normalizeApp);
    if(LMI_API.getRelayUrl()){
      try{
        const resp=await LMI_API.callRelay('getDesktopState',{},user);
        const data=(resp&&resp.data)||resp;
        if(data&&Array.isArray(data.apps)&&data.apps.length){ runtime.desktopState=data; runtime.user=Object.assign({},runtime.user||{},data.user||{}); return data.apps.map(normalizeApp); }
      }catch(e){ setStatus('Backend desktop state failed; using local manifest. '+(e.message||e),'warn'); }
    }
    return manifest;
  }
  async function enterDesktop(user,session){
    runtime.user=user; runtime.session=session;
    $('operatorPlate').textContent=`Operator: ${user.displayName||user.tag} / ${user.access||'User'}`;
    document.body.classList.add('logged-in'); document.body.classList.remove('auth-locked');
    runtime.apps=await loadDesktopState(user);
    if(!getInstalled()) setInstalled(runtime.apps.map(a=>a.id));
    renderDesktop(); updateClock(); setInterval(updateClock,1000);
  }
  function updateClock(){ const c=$('clock'); if(c)c.textContent=new Date().toLocaleString([], {year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit'}); }
  function initLogin(){
    const saved=localStorage.getItem(LMI_CONFIG.localKeys.relayUrl)||''; $('relayUrl').value=saved;
    const last=LMI_AUTH.loadLastUser(); if(last?.tag) $('loginUsername').value=last.tag;
    $('saveRelay').onclick=()=>{ const url=$('relayUrl').value.trim(); if(url&&!LMI_API.isAllowedRelayUrl(url)){setStatus('Relay rejected: expected a Google Apps Script web app URL.','bad'); return;} if(url){LMI_API.setRelayUrl(url); setStatus('Relay link cached in this browser only.','good');}else{LMI_API.forgetRelayUrl(); setStatus('Relay link cleared.','warn');} };
    $('forgetRelay').onclick=()=>{LMI_API.forgetRelayUrl(); $('relayUrl').value=''; setStatus('Relay link forgotten from this browser.','warn');};
    $('loginButton').onclick=async()=>{ try{ if($('relayUrl').value.trim()) LMI_API.setRelayUrl($('relayUrl').value.trim()); setStatus('Reading credentials...'); const result=await LMI_AUTH.login($('loginUsername').value,$('loginPassword').value); setStatus('Credential accepted.','good'); enterDesktop(result.user,result.session); }catch(e){ setStatus(e.message||String(e),'bad'); } };
    $('loginPassword').addEventListener('keydown',e=>{if(e.key==='Enter') $('loginButton').click();});
    $('relayUrl').addEventListener('keydown',e=>{if(e.key==='Enter') $('saveRelay').click();});
  }
  window.addEventListener('message',async event=>{
    if(event.origin!==location.origin) return;
    const msg=event.data||{};
    if(msg.type==='LMI_REQUEST_CONTEXT'){
      event.source.postMessage({type:'LMI_CONTEXT',requestId:msg.requestId,context:{user:runtime.user,session:runtime.session,hasRelay:!!LMI_API.getRelayUrl(),apps:runtime.apps}},event.origin);
    }
    if(msg.type==='LMI_API_REQUEST'){
      try{ const data=await LMI_API.callRelay(msg.action,msg.payload,runtime.user); event.source.postMessage({type:'LMI_API_RESPONSE',requestId:msg.requestId,ok:true,data},event.origin); }
      catch(e){ event.source.postMessage({type:'LMI_API_RESPONSE',requestId:msg.requestId,ok:false,error:e.message||String(e)},event.origin); }
    }
    if(msg.type==='LMI_SET_RELAY_URL'){
      const url=String(msg.url||'').trim();
      if(url&&!LMI_API.isAllowedRelayUrl(url)){event.source.postMessage({type:'LMI_RELAY_URL_STATUS',ok:false,message:'Rejected relay URL.'},event.origin);return;}
      if(url)LMI_API.setRelayUrl(url); else LMI_API.forgetRelayUrl();
      event.source.postMessage({type:'LMI_RELAY_URL_STATUS',ok:true,message:url?'Relay saved locally.':'Relay cleared.'},event.origin);
    }
    if(msg.type==='LMI_REFRESH_APPS'){ renderDesktop(); }
  });
  document.addEventListener('DOMContentLoaded',initLogin);
})();
