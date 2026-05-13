(async function(){
  const runtime=window.LMI_RUNTIME={user:null,session:null,apps:[],desktopState:null};
  const $=id=>document.getElementById(id);
  const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
  function setStatus(txt,cls=''){ const el=$('loginStatus'); if(el){el.textContent=txt; el.className='login-status '+cls;} }
  function getInstalled(){ try{return JSON.parse(localStorage.getItem(LMI_CONFIG.localKeys.installed)||'null')}catch{return null} }
  function setInstalled(ids){ localStorage.setItem(LMI_CONFIG.localKeys.installed,JSON.stringify(ids)); }
  function getLayout(){ try{return JSON.parse(localStorage.getItem(LMI_CONFIG.localKeys.layout)||'{}')}catch{return {}} }
  function saveLayout(o){ localStorage.setItem(LMI_CONFIG.localKeys.layout,JSON.stringify(o||{})); }
  function themeVars(){ try{return JSON.parse(localStorage.getItem('LMI_THEME_VARS')||'{}')}catch{return {}} }
  function applyTheme(vars){ vars=vars||themeVars(); Object.entries(vars).forEach(([k,v])=>{ if(k.startsWith('--')) document.documentElement.style.setProperty(k,String(v)); }); document.body.dataset.themeLive='1'; }
  function applyWallpaper(user){ const desk=document.querySelector('.desktop'); const wp=user?.wallpaper||user?.wp||localStorage.getItem('LMI_WALLPAPER')||''; if(wp){document.documentElement.style.setProperty('--wallpaper-url',`url("${wp}")`); desk?.classList.add('wallpapered')}else desk?.classList.remove('wallpapered'); }
  window.LMI_DESKTOP={
    getSavedWindow(id){return getLayout()[id]||null},
    saveWindow(id,data){const l=getLayout(); l[id]=Object.assign({},l[id]||{},data); saveLayout(l); if(runtime.session?.mode==='relay') LMI_API.callRelay('saveDesktopLayout',{appId:id,layout:data},runtime.user).catch(()=>{});},
    refreshApps:renderDesktop,
    getApps(){return runtime.apps||[];}
  };
  async function loadManifest(){ try{ const res=await fetch(LMI_CONFIG.manifestPath,{cache:'no-store'}); if(res.ok)return await res.json(); }catch{} return []; }
  function normalizeApp(a){return {id:a.id||a.appId, key:a.key||a.k, name:a.name||a.nm||a.id, title:a.title||a.name||a.nm, path:a.path||a.modulePath, icon:a.icon||a.ico||'□', description:a.description||a.desc||'', w:Number(a.w||a.defaultW||900), h:Number(a.h||a.defaultH||620), x:Number(a.x||80), y:Number(a.y||70), iconX:Number(a.iconX||0), iconY:Number(a.iconY||0)} }
  function visibleApps(){ const installed=(runtime.session?.mode==='relay')?null:getInstalled(); return runtime.apps.filter(a=>!installed||installed.includes(a.id)||['settings','bipac','themeLab','dataEditor'].includes(a.id)); }
  function desktopBounds(){
    // Pass 10: icon dragging must be bounded by the real desktop workspace,
    // not the icon layer. The icon layer can report a bogus/child-sized
    // height on some browsers, which trapped icons in the top strip.
    const w=document.querySelector('.workspace')?.getBoundingClientRect();
    if(w && w.width>40 && w.height>40) return w;
    return {left:0,top:46,width:window.innerWidth,height:Math.max(0,window.innerHeight-82)};
  }
  function renderDesktop(){
    const desk=$('desktopIcons'); if(!desk)return; desk.innerHTML='';
    const layout=getLayout();
    visibleApps().forEach((app,i)=>{
      const saved=layout[app.id]||{};
      const ix=Number.isFinite(Number(saved.iconX))?Number(saved.iconX):(Number(app.iconX)||((i%12)*112+44));
      const iy=Number.isFinite(Number(saved.iconY))?Number(saved.iconY):(Number(app.iconY)||(Math.floor(i/12)*128+18));
      const b=document.createElement('button'); b.className='desktop-icon'; b.dataset.app=app.id; b.setAttribute('draggable','false');
      const rr=desktopBounds(); b.style.left=clamp(ix,0,Math.max(0,rr.width-112))+'px'; b.style.top=clamp(iy,0,Math.max(0,rr.height-120))+'px';
      b.innerHTML=`<span class="icon-box">${app.icon||'□'}</span><strong>${app.name}</strong><em>${app.description||''}</em>`;
      let moved=false, suppressClick=false, downAt=0;
      b.addEventListener('pointerdown',ev=>{
        if(ev.button!==0)return; ev.preventDefault(); ev.stopPropagation(); moved=false; suppressClick=false; downAt=Date.now();
        document.querySelectorAll('.desktop-icon').forEach(x=>x.classList.remove('selected')); b.classList.add('selected'); b.classList.add('dragging');
        const d0=desktopBounds(); const br=b.getBoundingClientRect();
        const ox=ev.clientX-br.left, oy=ev.clientY-br.top; const sx=ev.clientX, sy=ev.clientY;
        b.setPointerCapture?.(ev.pointerId);
        function place(e){
          const d=desktopBounds();
          const maxX=Math.max(0,d.width-b.offsetWidth);
          const maxY=Math.max(0,d.height-b.offsetHeight);
          const x=clamp(e.clientX-d.left-ox,0,maxX);
          const y=clamp(e.clientY-d.top-oy,0,maxY);
          b.style.left=Math.round(x)+'px'; b.style.top=Math.round(y)+'px';
        }
        function mv(e){
          if(Math.abs(e.clientX-sx)>3||Math.abs(e.clientY-sy)>3){moved=true; suppressClick=true;}
          place(e);
        }
        function up(e){
          try{b.releasePointerCapture?.(ev.pointerId)}catch{} b.classList.remove('dragging');
          document.removeEventListener('pointermove',mv,true); document.removeEventListener('pointerup',up,true); document.removeEventListener('pointercancel',up,true);
          if(moved){ app.iconX=parseInt(b.style.left,10)||0; app.iconY=parseInt(b.style.top,10)||0; window.LMI_DESKTOP.saveWindow(app.id,{iconX:app.iconX,iconY:app.iconY}); setTimeout(()=>{suppressClick=false},180); }
        }
        document.addEventListener('pointermove',mv,true); document.addEventListener('pointerup',up,true); document.addEventListener('pointercancel',up,true);
      },true);
      b.addEventListener('click',e=>{ if(suppressClick||moved||Date.now()-downAt>500){e.preventDefault();return;} document.querySelectorAll('.desktop-icon').forEach(x=>x.classList.remove('selected')); b.classList.add('selected');});
      b.addEventListener('dblclick',e=>{ if(!moved){ e.preventDefault(); LMI_WM.openWindow(app); }});
      desk.appendChild(b);
    });
    renderStartMenu();
  }
  function renderStartMenu(){
    const sm=$('startMenu'); if(!sm)return;
    const user=runtime.user||{}; const apps=visibleApps();
    const favorites=['pharma','pointOfSale','bodyMods','dataEditor','themeLab','settings'].map(id=>apps.find(a=>a.id===id)).filter(Boolean);
    sm.innerHTML=`<div class="start-profile"><div class="start-avatar">${String(user.displayName||user.tag||'U').trim().slice(0,2).toUpperCase()}</div><div><b>${user.displayName||user.tag||'Unknown Operator'}</b><em>${user.access||user.role||'User'} · ${runtime.session?.mode==='relay'?'Cloud relay':'Local session'}</em><small>${apps.length} modules installed</small></div></div><div class="start-search-wrap"><input id="startSearch" class="start-search" placeholder="Search modules / actions"></div><div class="start-section"><span>Quick launch</span></div><div id="startQuick" class="start-list"></div><div class="start-section"><span>Search results</span></div><div id="startResults" class="start-list"><div class="start-empty">Type to find a module. This menu no longer dumps every app at you.</div></div><hr><button class="start-item" data-act="home"><span class="si">⌂</span><span><b>Show Desktop</b><em>Minimize open modules</em></span></button><button class="start-item" data-act="layout"><span class="si">↺</span><span><b>Reset Saved Layout</b><em>Clear broken icon/window coordinates</em></span></button><button class="start-item" data-act="logout"><span class="si">×</span><span><b>Lock Terminal</b><em>Return to login</em></span></button>`;
    function item(app){ return `<button class="start-item" data-app="${app.id}"><span class="si">${app.icon||'□'}</span><span><b>${app.name}</b><em>${app.description||''}</em></span></button>`; }
    function wire(container){ container.querySelectorAll('[data-app]').forEach(b=>b.onclick=()=>{const app=runtime.apps.find(a=>a.id===b.dataset.app); if(app)LMI_WM.openWindow(app); sm.classList.add('hidden')}); }
    const quick=sm.querySelector('#startQuick'); quick.innerHTML=favorites.map(item).join('')||'<div class="start-empty">No pinned modules.</div>'; wire(quick);
    const results=sm.querySelector('#startResults'); const search=sm.querySelector('#startSearch');
    search.addEventListener('input',()=>{ const q=search.value.trim().toLowerCase(); if(!q){results.innerHTML='<div class="start-empty">Type to find a module. This menu no longer dumps every app at you.</div>';return;} const hits=apps.filter(a=>(a.name+' '+a.description+' '+a.id).toLowerCase().includes(q)); results.innerHTML=hits.map(item).join('')||'<div class="start-empty">No modules match that search.</div>'; wire(results); });
    sm.querySelector('[data-act="home"]').onclick=()=>{document.querySelectorAll('.lmi-window').forEach(w=>w.classList.add('minimized')); sm.classList.add('hidden')};
    sm.querySelector('[data-act="layout"]').onclick=()=>{localStorage.removeItem(LMI_CONFIG.localKeys.layout); document.querySelectorAll('.lmi-window').forEach(w=>w.remove()); const tg=$('taskGroup'); if(tg)tg.innerHTML=''; renderDesktop(); sm.classList.add('hidden')};
    sm.querySelector('[data-act="logout"]').onclick=()=>location.reload();
  }
  async function loadDesktopState(user){ let manifest=(await loadManifest()).map(normalizeApp); if(LMI_API.getRelayUrl()){ try{ const resp=await LMI_API.callRelay('getDesktopState',{},user); const data=(resp&&resp.data)||resp; if(data&&Array.isArray(data.apps)&&data.apps.length){ runtime.desktopState=data; runtime.user=Object.assign({},runtime.user||{},data.user||{}); { const remote=data.apps.map(normalizeApp); const byId=new Map(remote.map(a=>[a.id,a])); manifest.forEach(a=>{ if(['settings','bipac','themeLab','dataEditor'].includes(a.id) && !byId.has(a.id)) remote.push(a); }); return remote; } } }catch(e){ setStatus('Backend desktop state failed; using local manifest. '+(e.message||e),'warn'); } } return manifest; }
  async function enterDesktop(user,session){ runtime.user=user; runtime.session=session; $('operatorPlate').textContent=`Operator: ${user.displayName||user.tag} / ${user.access||'User'}`; document.body.classList.add('logged-in'); document.body.classList.remove('auth-locked'); runtime.apps=await loadDesktopState(user); if(!getInstalled()) setInstalled(runtime.apps.map(a=>a.id)); applyTheme(); applyWallpaper(runtime.user||user); renderDesktop(); updateClock(); setInterval(updateClock,1000); }
  function updateClock(){ const c=$('clock'); if(c)c.textContent=new Date().toLocaleString([], {year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit'}); }
  function initLogin(){ applyTheme(); const saved=localStorage.getItem(LMI_CONFIG.localKeys.relayUrl)||LMI_API.DEFAULT_RELAY||'/api/relay'; $('relayUrl').value=saved; const last=LMI_AUTH.loadLastUser(); if(last?.tag) $('loginUsername').value=last.tag; $('saveRelay').onclick=()=>{ const url=$('relayUrl').value.trim(); if(url&&!LMI_API.isAllowedRelayUrl(url)){setStatus('Relay rejected: expected /api/relay or same-origin /api/*.','bad'); return;} if(url){LMI_API.setRelayUrl(url); setStatus('Relay endpoint cached locally.','good');}else{LMI_API.forgetRelayUrl(); setStatus('Relay link cleared.','warn');} }; $('forgetRelay').onclick=()=>{LMI_API.forgetRelayUrl(); $('relayUrl').value=''; setStatus('Relay endpoint reset to local /api/relay.','warn');}; const clearBtn=$('clearLocalCache'); if(clearBtn) clearBtn.onclick=async()=>{ if(!confirm('Clear all LMI cached data for this site? This removes relay link, saved layout, themes, currency preferences, and local session data.')) return; try{localStorage.clear(); sessionStorage.clear(); if(window.caches){ const keys=await caches.keys(); await Promise.all(keys.map(k=>caches.delete(k))); }}catch(e){} setStatus('Local site cache cleared. Reloading...','good'); setTimeout(()=>location.reload(),450); }; $('loginButton').onclick=async()=>{ try{ if($('relayUrl').value.trim()) LMI_API.setRelayUrl($('relayUrl').value.trim()); setStatus('Reading credentials...'); const result=await LMI_AUTH.login($('loginUsername').value,$('loginPassword').value); setStatus('Credential accepted.','good'); enterDesktop(result.user,result.session); }catch(e){ setStatus(e.message||String(e),'bad'); } }; $('loginPassword').addEventListener('keydown',e=>{if(e.key==='Enter') $('loginButton').click();}); $('relayUrl').addEventListener('keydown',e=>{if(e.key==='Enter') $('saveRelay').click();}); $('startBtn')?.addEventListener('click',e=>{e.stopPropagation(); const sm=$('startMenu'); sm?.classList.toggle('hidden'); if(sm&&!sm.classList.contains('hidden')) setTimeout(()=>sm.querySelector('#startSearch')?.focus(),0);}); document.addEventListener('click',e=>{ if(!e.target.closest('.taskbar')) $('startMenu')?.classList.add('hidden'); }); }
  window.addEventListener('message',async event=>{ if(event.origin!==location.origin) return; const msg=event.data||{}; if(msg.type==='LMI_REQUEST_CONTEXT'){ event.source.postMessage({type:'LMI_CONTEXT',requestId:msg.requestId,context:{user:runtime.user,session:runtime.session,hasRelay:!!LMI_API.getRelayUrl(),apps:runtime.apps}},event.origin); } if(msg.type==='LMI_API_REQUEST'){ try{ const data=await LMI_API.callRelay(msg.action,msg.payload,runtime.user); event.source.postMessage({type:'LMI_API_RESPONSE',requestId:msg.requestId,ok:true,data},event.origin); } catch(e){ event.source.postMessage({type:'LMI_API_RESPONSE',requestId:msg.requestId,ok:false,error:e.message||String(e)},event.origin); } } if(msg.type==='LMI_SET_RELAY_URL'){ const url=String(msg.url||'').trim(); if(url&&!LMI_API.isAllowedRelayUrl(url)){event.source.postMessage({type:'LMI_RELAY_URL_STATUS',ok:false,message:'Rejected relay URL.'},event.origin);return;} if(url)LMI_API.setRelayUrl(url); else LMI_API.forgetRelayUrl(); event.source.postMessage({type:'LMI_RELAY_URL_STATUS',ok:true,message:url?'Relay saved locally.':'Relay cleared.'},event.origin); } if(msg.type==='LMI_REFRESH_APPS'){ renderDesktop(); } if(msg.type==='LMI_THEME_PATCH'){ localStorage.setItem('LMI_THEME_VARS',JSON.stringify(msg.vars||{})); applyTheme(msg.vars||{}); document.querySelectorAll('.win-frame').forEach(fr=>fr.contentWindow?.postMessage({type:'LMI_THEME_PATCH',vars:msg.vars||{}},location.origin)); } if(msg.type==='LMI_CURRENCY_PATCH'){ localStorage.setItem('LMI_CURRENCY_PREF',JSON.stringify(msg.currency||{})); document.querySelectorAll('.win-frame').forEach(fr=>fr.contentWindow?.postMessage({type:'LMI_CURRENCY_PATCH',currency:msg.currency||{}},location.origin)); } });
  document.addEventListener('DOMContentLoaded',initLogin);
})();
