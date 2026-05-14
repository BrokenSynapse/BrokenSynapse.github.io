(async function(){
  const runtime=window.LMI_RUNTIME={user:null,session:null,apps:[],desktopState:null};
  const $=id=>document.getElementById(id);
  const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
  function setStatus(txt,cls=''){ const el=$('loginStatus'); if(el){el.textContent=txt; el.className='login-status '+cls;} }
  function getInstalled(){ try{return JSON.parse(localStorage.getItem(LMI_CONFIG.localKeys.installed)||'null')}catch{return null} }
  function setInstalled(ids){ localStorage.setItem(LMI_CONFIG.localKeys.installed,JSON.stringify(ids)); }
  function getLayout(){ try{return JSON.parse(localStorage.getItem(LMI_CONFIG.localKeys.layout)||'{}')}catch{return {}} }
  function saveLayout(o){ localStorage.setItem(LMI_CONFIG.localKeys.layout,JSON.stringify(o||{})); }
  function themeVars(){
    try{
      const path = location.pathname.replace(/\/+$/,'').toLowerCase();
      if(path === '/lmi') return {};
      return JSON.parse(localStorage.getItem('LMI_THEME_VARS') || sessionStorage.getItem('LMI_ACTIVE_ACCOUNT_THEME') || '{}');
    }catch{return {}}
  }

  function publishRuntimeUser_(){
    try{
      if(!runtime.user) return;
      window.LMI_USER = runtime.user;
      window.currentUser = runtime.user;
      window.sessionUser = runtime.user;
      sessionStorage.setItem('LMI_CURRENT_USER', JSON.stringify(runtime.user));
      const sess = JSON.parse(sessionStorage.getItem('LMI_SESSION') || '{}') || {};
      sess.user = runtime.user;
      sessionStorage.setItem('LMI_SESSION', JSON.stringify(sess));
      localStorage.setItem('LMI_LAST_USER', JSON.stringify(runtime.user));
    }catch(e){
      console.warn('publishRuntimeUser failed', e);
    }
  }


  function forceApplyShellPrefsFromDb_(reason){
    const user = runtime.user || window.LMI_USER || window.currentUser || window.sessionUser;
    if(!user || !window.LMI_API?.callRelay) return;

    LMI_API.callRelay('user.shell.get', {}, user).then(resp=>{
      const prefs = resp?.data?.shellPrefs || resp?.data?.prefs || null;
      if(!prefs || typeof prefs !== 'object') return;

      const iconSize = Math.max(44, Math.min(120, Math.round(Number(prefs.iconSize || 72))));
      prefs.iconSize = iconSize;

      runtime.user = Object.assign({}, runtime.user || user, { shellPrefs:prefs });
      window.LMI_USER = runtime.user;
      window.currentUser = runtime.user;
      window.sessionUser = runtime.user;
      window.LMIShellPrefs = Object.assign(window.LMIShellPrefs || {}, prefs);

      try{
        localStorage.setItem(SHELL_PREFS_KEY, JSON.stringify(prefs));
        sessionStorage.setItem('LMI_CURRENT_USER', JSON.stringify(runtime.user));
        localStorage.setItem('LMI_LAST_USER', JSON.stringify(runtime.user));
      }catch{}

      applyShellPrefs(prefs);

      // Hard-set the exact CSS variables used by LMI-Desktop.html.
      const tileW = Math.max(76, Math.round(iconSize * 1.55));
      const tileH = Math.max(92, Math.round(iconSize * 1.72));
      const r = document.documentElement.style;
      r.setProperty('--lmi-icon-size', iconSize + 'px');
      r.setProperty('--lmi-icon-tile-w', tileW + 'px');
      r.setProperty('--lmi-icon-tile-h', tileH + 'px');
      r.setProperty('--lmi-icon-font', Math.max(18, Math.round(iconSize * .38)) + 'px');
      r.setProperty('--lmi-icon-label', Math.max(10, Math.round(iconSize * .18)) + 'px');

      if(document.body){
        document.body.dataset.gridSnap = prefs.gridSnap === false ? 'off' : 'on';
      }

      try{ renderDesktop(); }catch(e){ console.warn('renderDesktop after shell pref force failed', e); }

      console.log('[LMI] forced DB shell prefs', reason, prefs);
    }).catch(e=>console.warn('forceApplyShellPrefsFromDb failed', reason, e));
  }

  function scheduleShellPrefsAuthority_(){
    // Run after all late scripts, QOL injectors, and handoff bits have had a chance to stomp defaults.
    setTimeout(()=>forceApplyShellPrefsFromDb_('boot+150'),150);
    setTimeout(()=>forceApplyShellPrefsFromDb_('boot+750'),750);
    setTimeout(()=>forceApplyShellPrefsFromDb_('boot+1600'),1600);
  }


  async function attachShellPrefsBeforeDesktop_(result){
    try{
      if(!result) return result;
      result.user = result.user || {};
      const resp = await LMI_API.callRelay('user.shell.get', {}, result.user);
      const prefs = resp?.data?.shellPrefs || resp?.data?.prefs || null;

      if(prefs && typeof prefs === 'object'){
        result.user.shellPrefs = prefs;

        try{
          localStorage.setItem(SHELL_PREFS_KEY, JSON.stringify(prefs));
          sessionStorage.setItem('LMI_CURRENT_USER', JSON.stringify(result.user));
          localStorage.setItem('LMI_LAST_USER', JSON.stringify(result.user));

          const sess = JSON.parse(sessionStorage.getItem('LMI_SESSION') || '{}') || {};
          sess.user = result.user;
          sessionStorage.setItem('LMI_SESSION', JSON.stringify(sess));
        }catch{}

        window.LMI_USER = result.user;
        window.currentUser = result.user;
        window.sessionUser = result.user;
        window.LMIShellPrefs = Object.assign(window.LMIShellPrefs || {}, prefs);

        applyShellPrefs(prefs);

        console.log('[LMI] login attached shellPrefs before enterDesktop', prefs);
      } else {
        console.warn('[LMI] login shellPrefs fetch returned no prefs', resp);
      }
    }catch(e){
      console.warn('[LMI] attachShellPrefsBeforeDesktop failed', e);
    }

    return result;
  }

  function applyTheme(vars){ vars=vars||themeVars(); Object.entries(vars).forEach(([k,v])=>{ if(k.startsWith('--')) document.documentElement.style.setProperty(k,String(v)); }); document.body.dataset.themeLive='1'; }

  const SHELL_PREFS_KEY='LMI_SHELL_PREFS';

  function readShellPrefs(){
    let saved={};
    try{
      saved =
        runtime.user?.shellPrefs ||
        window.LMI_USER?.shellPrefs ||
        window.currentUser?.shellPrefs ||
        window.sessionUser?.shellPrefs ||
        {};
    }catch{}
    if(!saved || !Object.keys(saved).length){
      try{ saved=JSON.parse(localStorage.getItem(SHELL_PREFS_KEY)||'{}')||{}; }catch{}
    }
    if(runtime.user && runtime.user.shellPrefs) saved=Object.assign({},saved,runtime.user.shellPrefs);
    const iconSize=clamp(Math.round(Number(saved.iconSize||72)),44,120);
    return Object.assign({}, saved, {iconSize,gridSnap:saved.gridSnap!==false});
  }


  function primeShellPrefsFromUser_(user){
    const prefs = user?.shellPrefs;
    if(!prefs || typeof prefs !== 'object') return false;

    const iconSize = clamp(Math.round(Number(prefs.iconSize || 72)),44,120);
    prefs.iconSize = iconSize;

    runtime.user.shellPrefs = prefs;
    window.LMI_USER = runtime.user;
    window.currentUser = runtime.user;
    window.sessionUser = runtime.user;
    window.LMIShellPrefs = Object.assign(window.LMIShellPrefs || {}, prefs);

    try{
      localStorage.setItem(SHELL_PREFS_KEY, JSON.stringify(prefs));
      sessionStorage.setItem('LMI_CURRENT_USER', JSON.stringify(runtime.user));
      localStorage.setItem('LMI_LAST_USER', JSON.stringify(runtime.user));
    }catch{}

    applyShellPrefs(prefs);
    return true;
  }

  function shellMetrics(prefs=readShellPrefs()){
    const iconSize=clamp(Math.round(Number(prefs.iconSize||72)),44,120);
    const tileW=Math.max(76,Math.round(iconSize*1.55));
    const tileH=Math.max(92,Math.round(iconSize*1.72));
    const gridX=tileW+Math.max(12,Math.round(iconSize*.22));
    const gridY=tileH+Math.max(10,Math.round(iconSize*.20));

    // This is the visual grid origin used by renderDesktop default placement
    // and the CSS dot-grid background. snapPoint MUST use the same origin.
    const originX=0;
    const originY=18;

    return {iconSize,tileW,tileH,gridX,gridY,originX,originY};
  }

  function applyShellPrefs(prefs=readShellPrefs()){
    const m=shellMetrics(prefs);
    const r=document.documentElement.style;
    r.setProperty('--lmi-icon-size',m.iconSize+'px');
    r.setProperty('--lmi-icon-tile-w',m.tileW+'px');
    r.setProperty('--lmi-icon-tile-h',m.tileH+'px');
    r.setProperty('--lmi-icon-font',Math.max(18,Math.round(m.iconSize*.38))+'px');
    r.setProperty('--lmi-icon-label',Math.max(10,Math.round(m.iconSize*.18))+'px');
    document.body.dataset.gridSnap=prefs.gridSnap?'on':'off';
  }

  function snapPoint(x,y,prefs=readShellPrefs()){
    const px=Math.round(Number(x)||0);
    const py=Math.round(Number(y)||0);

    if(!prefs.gridSnap) return {x:px,y:py};

    const m=shellMetrics(prefs);
    const ox=Number.isFinite(m.originX)?m.originX:Math.round(m.gridX*.35);
    const oy=Number.isFinite(m.originY)?m.originY:18;

    return {
      x:ox+Math.round((px-ox)/m.gridX)*m.gridX,
      y:oy+Math.round((py-oy)/m.gridY)*m.gridY
    };
  }

  function setShellPrefs(prefs,opts){
    const base=(opts&&opts.merge===false)?{}:readShellPrefs();
    const next=Object.assign({},base,prefs||{});
    next.iconSize=clamp(Math.round(Number(next.iconSize||72)),44,120);
    next.gridSnap=next.gridSnap!==false;

    localStorage.setItem(SHELL_PREFS_KEY,JSON.stringify(next));

    if(runtime.user){
      runtime.user.shellPrefs=next;
      publishRuntimeUser_();
    }
    if(runtime.desktopState){
      runtime.desktopState.settings=Object.assign({},runtime.desktopState.settings||{});
      runtime.desktopState.settings.shellPrefs=next;
    }

    applyShellPrefs(next);
    renderDesktop();

    if((opts&&opts.persist) && window.LMI_API?.callRelay){
      LMI_API.callRelay('user.shell.save',{prefs:next},runtime.user).catch(e=>console.warn('shell prefs DB save failed',e));
    }

    return next;
  }

  function applyWallpaper(user){ const desk=document.querySelector('.desktop'); const wp=user?.wallpaper||user?.wp||localStorage.getItem('LMI_WALLPAPER')||''; if(wp){document.documentElement.style.setProperty('--wallpaper-url',`url("${wp}")`); desk?.classList.add('wallpapered')}else desk?.classList.remove('wallpapered'); }
  function setDesktopWallpaper(wp){ wp=String(wp||'').trim(); if(wp){ localStorage.setItem('LMI_WALLPAPER',wp); } else { localStorage.removeItem('LMI_WALLPAPER'); } if(runtime.user){ runtime.user.wallpaper=wp; runtime.user.wp=wp; } applyWallpaper(runtime.user||{}); }
  function saveShellPrefs(prefs){ return setShellPrefs(prefs,{persist:true}); }
  function previewShellPrefs(prefs){ return setShellPrefs(prefs,{persist:false}); }

  window.LMI_DESKTOP={
    getSavedWindow(id){return getLayout()[id]||null},
        saveWindow(id,data){
      const app = (runtime.apps || []).find(a =>
        String(a.id || '').toLowerCase() === String(id || '').toLowerCase() ||
        String(a.key || '').toLowerCase() === String(id || '').toLowerCase()
      ) || {};

      const appId = app.id || id;
      const key = app.key || app.k || id;

      const l = getLayout();
      l[appId] = Object.assign({}, l[appId] || {}, data);
      l[key] = Object.assign({}, l[key] || {}, data);
      saveLayout(l);

      if(window.LMI_API?.callRelay && runtime.user){
        LMI_API.callRelay('saveDesktopLayout', {
          appId,
          key,
          id: appId,
          layout: data
        }, runtime.user).then(resp => {
          if(!resp?.ok) console.warn('saveDesktopLayout failed', appId, key, resp);
          else console.log('[LMI] saved desktop layout', appId, key, data);
        }).catch(e => console.warn('saveDesktopLayout failed', appId, key, e));
      } else {
        console.warn('[LMI] saveWindow could not call relay', {hasApi:!!window.LMI_API?.callRelay, user:runtime.user, id, data});
      }
    },
    refreshApps:renderDesktop,
    getApps(){return runtime.apps||[];},
    getShellPrefs:readShellPrefs,
    setShellPrefs:saveShellPrefs,
    previewShellPrefs
  };
  runtime.getShellPrefs=readShellPrefs;
  runtime.setShellPrefs=saveShellPrefs;
  runtime.previewShellPrefs=previewShellPrefs;
  async function loadManifest(){ try{ const res=await fetch(LMI_CONFIG.manifestPath,{cache:'no-store'}); if(res.ok)return await res.json(); }catch{} return []; }

  function ensureFileExplorerApp(apps){
    apps = Array.isArray(apps) ? apps : [];
    const app = {
      id:'fileExplorer',
      name:'FileExplorer.LMX',
      title:'FileExplorer.LMX',
      icon:'FE',
      module:'modules/fileExplorer.html',
      url:'modules/fileExplorer.html',
      desc:'Profile and item asset manager'
    };

    const idx = apps.findIndex(a => a && (a.id === 'fileExplorer' || a.name === 'FileExplorer.LMX'));
    if(idx >= 0){
      apps[idx] = Object.assign({}, app, apps[idx], {
        id:'fileExplorer',
        module:'modules/fileExplorer.html',
        url:'modules/fileExplorer.html'
      });
    } else {
      apps.push(app);
    }
    return apps;
  }


  function normalizeApp(a){return {id:a.id||a.appId, key:a.key||a.k, name:a.name||a.nm||a.id, title:a.title||a.name||a.nm, path:a.path||a.modulePath, icon:a.icon||a.ico||'□', description:a.description||a.desc||'', w:Number(a.w||a.defaultW||900), h:Number(a.h||a.defaultH||620), x:Number(a.x||80), y:Number(a.y||70), iconX:Number(a.iconX||0), iconY:Number(a.iconY||0)} }
  function visibleApps(){ const installed=(runtime.session?.mode==='relay')?null:getInstalled(); return runtime.apps.filter(a=>!installed||installed.includes(a.id)||['settings','bipac','fileExplorer'].includes(a.id)); }
  function desktopBounds(){
    // Pass 10: icon dragging must be bounded by the real desktop workspace,
    // not the icon layer. The icon layer can report a bogus/child-sized
    // height on some browsers, which trapped icons in the top strip.
    const w=document.querySelector('.workspace')?.getBoundingClientRect();
    if(w && w.width>40 && w.height>40) return w;
    return {left:0,top:46,width:window.innerWidth,height:Math.max(0,window.innerHeight-82)};
  }
  
  async function saveDesktopLayoutRemote(){
    try{
      const positions = {};
      document.querySelectorAll('.desktop-icon[data-id]').forEach(el=>{
        const id = el.dataset.id;
        if(!id) return;
        positions[id] = {
          x: parseInt(el.style.left || el.offsetLeft || 0, 10) || 0,
          y: parseInt(el.style.top || el.offsetTop || 0, 10) || 0
        };
      });

      // Keep local cache too, but do not depend on it.
      localStorage.setItem('LMI_DESKTOP_LAYOUT', JSON.stringify(positions));

      if(LMI_API && LMI_API.getRelayUrl && LMI_API.getRelayUrl()){
        await LMI_API.callRelay('desktop.layout.save', { positions }, runtime.user);
      }
    }catch(e){
      console.warn('desktop layout save failed', e);
    }
  }

function renderDesktop(){
    const desk=$('desktopIcons'); if(!desk)return; desk.innerHTML='';
    const layout=getLayout();
    const prefs=runtime.user?.shellPrefs || readShellPrefs();
    const metrics=shellMetrics(prefs);
    applyShellPrefs(prefs);

    const bounds=desktopBounds();
    const cols=Math.max(1,Math.floor((bounds.width-20)/metrics.gridX));

    visibleApps().forEach((app,i)=>{
      const saved=layout[app.id]||layout[app.key]||{};
      const defaultX=(i%cols)*metrics.gridX+metrics.originX;
      const defaultY=Math.floor(i/cols)*metrics.gridY+metrics.originY;

      let ix=Number.isFinite(Number(saved.iconX))?Number(saved.iconX):(Number(app.iconX)||defaultX);
      let iy=Number.isFinite(Number(saved.iconY))?Number(saved.iconY):(Number(app.iconY)||defaultY);

      if(prefs.gridSnap){
        const sp=snapPoint(ix,iy,prefs);
        ix=sp.x;
        iy=sp.y;
      }

      const b=document.createElement('button');
      b.className='desktop-icon';
      b.dataset.app=app.id;
      b.dataset.id=app.id;
      b.setAttribute('draggable','false');

      const rr=desktopBounds();
      b.style.left=clamp(ix,0,Math.max(0,rr.width-metrics.tileW))+'px';
      b.style.top=clamp(iy,0,Math.max(0,rr.height-metrics.tileH))+'px';
      b.innerHTML=`<span class="icon-box">${app.icon||'□'}</span><strong>${app.name}</strong><em>${app.description||''}</em>`;

      let moved=false, suppressClick=false, downAt=0;

      b.addEventListener('pointerdown',ev=>{
        if(ev.button!==0)return;
        ev.preventDefault();
        ev.stopPropagation();
        moved=false;
        suppressClick=false;
        downAt=Date.now();

        document.querySelectorAll('.desktop-icon').forEach(x=>x.classList.remove('selected'));
        b.classList.add('selected');
        b.classList.add('dragging');

        const br=b.getBoundingClientRect();
        const ox=ev.clientX-br.left, oy=ev.clientY-br.top;
        const sx=ev.clientX, sy=ev.clientY;
        b.setPointerCapture?.(ev.pointerId);

        function place(e){
          const d=desktopBounds();
          const maxX=Math.max(0,d.width-b.offsetWidth);
          const maxY=Math.max(0,d.height-b.offsetHeight);
          const x=clamp(e.clientX-d.left-ox,0,maxX);
          const y=clamp(e.clientY-d.top-oy,0,maxY);
          b.style.left=Math.round(x)+'px';
          b.style.top=Math.round(y)+'px';
        }

        function mv(e){
          const dx=Math.abs(e.clientX-sx);
          const dy=Math.abs(e.clientY-sy);

          // Tiny pointer noise during click/double-click should not turn into a drag.
          if(!moved && dx<=6 && dy<=6) return;

          moved=true;
          suppressClick=true;
          place(e);
        }

        function up(e){
          try{b.releasePointerCapture?.(ev.pointerId)}catch{}
          b.classList.remove('dragging');
          document.removeEventListener('pointermove',mv,true);
          document.removeEventListener('pointerup',up,true);
          document.removeEventListener('pointercancel',up,true);

          if(moved){
            const prefsNow=readShellPrefs();
            let x=parseInt(b.style.left,10)||0;
            let y=parseInt(b.style.top,10)||0;

            if(prefsNow.gridSnap){
              const d=desktopBounds();
              const m=shellMetrics(prefsNow);
              const sp=snapPoint(x,y,prefsNow);
              x=clamp(sp.x,0,Math.max(0,d.width-m.tileW));
              y=clamp(sp.y,0,Math.max(0,d.height-m.tileH));
              b.style.left=x+'px';
              b.style.top=y+'px';
            }

            app.iconX=x;
            app.iconY=y;
            window.LMI_DESKTOP.saveWindow(app.key || app.id,{iconX:x,iconY:y});
            setTimeout(()=>{suppressClick=false},180);
          }
        }

        document.addEventListener('pointermove',mv,true);
        document.addEventListener('pointerup',up,true);
        document.addEventListener('pointercancel',up,true);
      },true);

      b.addEventListener('click',e=>{
        if(suppressClick||moved||Date.now()-downAt>700){
          e.preventDefault();
          return;
        }
        document.querySelectorAll('.desktop-icon').forEach(x=>x.classList.remove('selected'));
        b.classList.add('selected');
      });

      b.addEventListener('dblclick',e=>{
        if(!moved){
          e.preventDefault();
          LMI_WM.openWindow(app);
        }
      });

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
  async function loadDesktopState(user){
    let manifest=(await loadManifest()).map(normalizeApp);
    if(LMI_API.getRelayUrl()){
      try{
        const resp=await LMI_API.callRelay('getDesktopState',{},user);
        const data=(resp&&resp.data)||resp;
        if(data&&Array.isArray(data.apps)&&data.apps.length){
          runtime.desktopState=data;
          runtime.user=Object.assign({},runtime.user||{},data.user||{});

          const dbShell=data.settings?.shellPrefs||data.user?.shellPrefs;
          if(dbShell){
            localStorage.setItem(SHELL_PREFS_KEY,JSON.stringify(dbShell));
            runtime.user.shellPrefs=dbShell;
            applyShellPrefs(dbShell);
          }

          const remote=data.apps.map(normalizeApp);
          const byId=new Map(remote.map(a=>[a.id,a]));
          manifest.forEach(a=>{
            if(['settings','bipac','fileExplorer'].includes(a.id) && !byId.has(a.id)) remote.push(a);
          });
          return remote;
        }
      }catch(e){
        setStatus('Backend desktop state failed; using local manifest. '+(e.message||e),'warn');
      }
    }
    return manifest;
  }

  async function enterDesktop(user,session){
    runtime.user=user;
    runtime.session=session;
    primeShellPrefsFromUser_(runtime.user);
    publishRuntimeUser_();

    $('operatorPlate').textContent=`Operator: ${user.displayName||user.tag} / ${user.access||'User'}`;
    document.body.classList.add('logged-in');
    document.body.classList.remove('auth-locked');

    // Use the logged-in user object as source of truth. Login already returns shellPrefs.
    if(runtime.user?.shellPrefs){
      window.LMIShellPrefs = Object.assign(window.LMIShellPrefs || {}, runtime.user.shellPrefs);
      localStorage.setItem(SHELL_PREFS_KEY, JSON.stringify(runtime.user.shellPrefs));
      applyShellPrefs(runtime.user.shellPrefs);
    }

    runtime.apps=ensureFileExplorerApp(await loadDesktopState(user));
    if(!getInstalled()) setInstalled(runtime.apps.map(a=>a.id));

    applyTheme();
    applyShellPrefs(runtime.user?.shellPrefs || readShellPrefs());
    applyWallpaper(runtime.user||user);
    renderDesktop();
    scheduleShellPrefsAuthority_();

    updateClock();
    setInterval(updateClock,1000);
  }

  async function refreshDesktopApps(){
    try{
      if(runtime.user){
        runtime.apps = ensureFileExplorerApp(await loadDesktopState(runtime.user));

        // Keep installed app cache in sync with backend/default app list.
        // This prevents BIPAC installs from requiring a full page refresh.
        setInstalled(runtime.apps.map(a => a.id));

        renderDesktop();
        setStatus('Desktop apps refreshed.', 'good');
        return true;
      }
    }catch(e){
      setStatus('Desktop app refresh failed: '+(e.message||e), 'warn');
    }

    renderDesktop();
    return false;
  }


  function updateClock(){ const c=$('clock'); if(c)c.textContent=new Date().toLocaleString([], {year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit'}); }


  function applyAccountThemeFromUser_(user){
    const vars = user?.shellPrefs?.themeVars;
    if(!vars || typeof vars !== 'object') return false;

    const aliases = {
      '--bg': ['--background','--app-bg','--desktop-bg'],
      '--panel': ['--surface','--surface-bg','--card','--card-bg','--window-bg','--module-bg','--panel-bg','--app-panel'],
      '--panel2': ['--surface2','--surface-2','--card2','--card-bg-2','--window-bg-2','--header-bg','--module-header-bg','--app-panel2'],
      '--text': ['--fg','--foreground','--text-color'],
      '--muted': ['--subtext','--muted-text','--dim'],
      '--line': ['--border','--border-color','--outline'],
      '--line2': ['--border2','--border-color-2','--outline2'],
      '--accent': ['--primary','--primary-accent','--glow'],
      '--accent2': ['--accent-2','--secondary','--secondary-accent','--highlight2','--focus'],
      '--good': ['--success'],
      '--bad': ['--danger','--error'],
      '--warn': ['--warning']
    };

    const norm = {};
    for(const [rawKey, rawVal] of Object.entries(vars)){
      let key = String(rawKey || '').trim().toLowerCase();
      const val = String(rawVal || '').trim();
      if(!key || !val) continue;
      if(!key.startsWith('--')) key = '--' + key.replace(/^[-_]+/, '');
      norm[key] = val;
    }

    for(const [key,val] of Object.entries(norm)){
      const keys = [key, ...(aliases[key] || [])];
      for(const k of keys){
        document.documentElement.style.setProperty(k, val);
        if(document.body) document.body.style.setProperty(k, val);
      }
    }

    try{
      sessionStorage.setItem('LMI_ACTIVE_ACCOUNT_THEME', JSON.stringify(norm));
      if(location.pathname.replace(/\/+$/,'').toLowerCase().endsWith('/lmi/desktop')){
        localStorage.setItem('LMI_THEME_VARS', JSON.stringify(norm));
      }
    }catch{}

    document.documentElement.classList.add('lmi-account-theme-active');
    if(document.body) document.body.classList.add('lmi-account-theme-active');

    return true;
  }

  function bindDesktopChromeHandlers_(){
    const startBtn = $('startBtn');
    const startMenu = $('startMenu');

    if(startBtn && !startBtn.dataset.lmiBound){
      startBtn.dataset.lmiBound = '1';
      startBtn.addEventListener('click', e => {
        e.stopPropagation();
        const sm = $('startMenu');
        sm?.classList.toggle('hidden');
        if(sm && !sm.classList.contains('hidden')){
          setTimeout(() => sm.querySelector('#startSearch')?.focus(), 0);
        }
      });
    }

    if(!document.documentElement.dataset.lmiStartDocBound){
      document.documentElement.dataset.lmiStartDocBound = '1';
      document.addEventListener('click', e => {
        if(!e.target.closest('.taskbar')) $('startMenu')?.classList.add('hidden');
      });
    }
  }

  function hideDesktopRouteLoginScreen_(){
    if(!isDesktopRoute()) return;
    document.querySelectorAll('.login-screen').forEach(el => {
      el.style.display = 'none';
      el.setAttribute('aria-hidden', 'true');
    });
  }


  function isDesktopRoute(){
    return location.pathname.replace(/\/+$/,'').toLowerCase().endsWith('/lmi/desktop');
  }

  function parseStoredJson_(v){
    if(!v) return null;
    try { return JSON.parse(v); } catch { return null; }
  }

  function getDesktopHandoff_(){
    const session =
      parseStoredJson_(sessionStorage.getItem('LMI_SESSION')) ||
      parseStoredJson_(sessionStorage.getItem('lmiSession')) ||
      null;

    const user =
      parseStoredJson_(sessionStorage.getItem('LMI_CURRENT_USER')) ||
      parseStoredJson_(sessionStorage.getItem('lmiUser')) ||
      session?.user ||
      parseStoredJson_(localStorage.getItem('LMI_LAST_USER')) ||
      null;

    if(!user) return null;

    user.cid = user.cid || user.id || '';
    user.tag = user.tag || user.employeeTag || '';
    user.displayName = user.displayName || user.cn || user.name || user.tag || '';
    user.access = user.access || user.al || 'User';
    user.wallpaper = user.wallpaper || user.wp || '';
    user.avatar = user.avatar || user.av || '';
    user.bankAccountId = user.bankAccountId || user.bid || '';
    user.currency = user.currency || user.cur || '';
    user.occupation = user.occupation || user.occ || '';
    user.shellPrefs = user.shellPrefs || {};

    return {
      user,
      session: session || {
        mode:'handoff',
        at:new Date().toISOString(),
        user
      }
    };
  }

  function bootDesktopRouteFromHandoff_(){
    if(!isDesktopRoute()) return false;

    const handoff = getDesktopHandoff_();

    if(!handoff || !handoff.user){
      location.replace('/lmi/?missingSession=' + Date.now());
      return true;
    }

    window.LMI_USER = handoff.user;
    window.LMI_SESSION = handoff.session;
    window.currentUser = handoff.user;
    window.sessionUser = handoff.user;
    window.user = handoff.user;

    try{
      sessionStorage.setItem('LMI_CURRENT_USER', JSON.stringify(handoff.user));
      sessionStorage.setItem('LMI_SESSION', JSON.stringify(handoff.session));
      localStorage.setItem('LMI_LAST_USER', JSON.stringify(handoff.user));
    }catch{}

    hideDesktopRouteLoginScreen_();
    applyAccountThemeFromUser_(handoff.user);

    attachShellPrefsBeforeDesktop_({user:handoff.user,session:handoff.session}).then(r=>enterDesktop(r.user,r.session));

    bindDesktopChromeHandlers_();

    // Re-apply because default/local theme code can run late.
    setTimeout(() => { hideDesktopRouteLoginScreen_(); applyAccountThemeFromUser_(handoff.user); bindDesktopChromeHandlers_(); }, 100);
    setTimeout(() => { hideDesktopRouteLoginScreen_(); applyAccountThemeFromUser_(handoff.user); bindDesktopChromeHandlers_(); }, 500);
    setTimeout(() => { hideDesktopRouteLoginScreen_(); applyAccountThemeFromUser_(handoff.user); bindDesktopChromeHandlers_(); }, 1500);

    return true;
  }


  function initLogin(){
    if(location.pathname.replace(/\/+$/,'').toLowerCase() === '/lmi'){
      try{
        sessionStorage.removeItem('LMI_ACTIVE_ACCOUNT_THEME');
        sessionStorage.removeItem('LMI_PENDING_ACCOUNT_THEME');
      }catch{}
    }
    applyTheme(); applyShellPrefs(); applyShellPrefs(); if(bootDesktopRouteFromHandoff_()) return; const saved=localStorage.getItem(LMI_CONFIG.localKeys.relayUrl)||LMI_API.DEFAULT_RELAY||'/api/relay'; $('relayUrl').value=saved; const last=LMI_AUTH.loadLastUser(); if(last?.tag) $('loginUsername').value=last.tag; $('saveRelay').onclick=()=>{ const url=$('relayUrl').value.trim(); if(url&&!LMI_API.isAllowedRelayUrl(url)){setStatus('Relay rejected: expected /api/relay or same-origin /api/*.','bad'); return;} if(url){LMI_API.setRelayUrl(url); setStatus('Relay endpoint cached locally.','good');}else{LMI_API.forgetRelayUrl(); setStatus('Relay link cleared.','warn');} }; $('forgetRelay').onclick=()=>{LMI_API.forgetRelayUrl(); $('relayUrl').value=''; setStatus('Relay endpoint reset to local /api/relay.','warn');}; const clearBtn=$('clearLocalCache'); if(clearBtn) clearBtn.onclick=async()=>{ if(!confirm('Clear all LMI cached data for this site? This removes relay link, saved layout, themes, currency preferences, and local session data.')) return; try{localStorage.clear(); sessionStorage.clear(); if(window.caches){ const keys=await caches.keys(); await Promise.all(keys.map(k=>caches.delete(k))); }}catch(e){} setStatus('Local site cache cleared. Reloading...','good'); setTimeout(()=>location.reload(),450); }; $('loginButton').onclick=async()=>{ try{ if($('relayUrl').value.trim()) LMI_API.setRelayUrl($('relayUrl').value.trim()); setStatus('Reading credentials...'); let result=await LMI_AUTH.login($('loginUsername').value,$('loginPassword').value); result=await attachShellPrefsBeforeDesktop_(result); setStatus('Credential accepted.','good'); enterDesktop(result.user,result.session); }catch(e){ setStatus(e.message||String(e),'bad'); } }; $('loginPassword').addEventListener('keydown',e=>{if(e.key==='Enter') $('loginButton').click();}); $('relayUrl').addEventListener('keydown',e=>{if(e.key==='Enter') $('saveRelay').click();}); $('startBtn')?.addEventListener('click',e=>{e.stopPropagation(); const sm=$('startMenu'); sm?.classList.toggle('hidden'); if(sm&&!sm.classList.contains('hidden')) setTimeout(()=>sm.querySelector('#startSearch')?.focus(),0);}); document.addEventListener('click',e=>{ if(!e.target.closest('.taskbar')) $('startMenu')?.classList.add('hidden'); }); }
  window.addEventListener('message',async event=>{ if(event.origin!==location.origin) return; const msg=event.data||{}; if(msg.type==='LMI_REQUEST_CONTEXT'){ event.source.postMessage({type:'LMI_CONTEXT',requestId:msg.requestId,context:{user:runtime.user,session:runtime.session,hasRelay:!!LMI_API.getRelayUrl(),apps:runtime.apps}},event.origin); } if(msg.type==='LMI_API_REQUEST'){ try{ const data=await LMI_API.callRelay(msg.action,msg.payload,runtime.user); event.source.postMessage({type:'LMI_API_RESPONSE',requestId:msg.requestId,ok:true,data},event.origin); } catch(e){ event.source.postMessage({type:'LMI_API_RESPONSE',requestId:msg.requestId,ok:false,error:e.message||String(e)},event.origin); } } if(msg.type==='LMI_SET_RELAY_URL'){ const url=String(msg.url||'').trim(); if(url&&!LMI_API.isAllowedRelayUrl(url)){event.source.postMessage({type:'LMI_RELAY_URL_STATUS',ok:false,message:'Rejected relay URL.'},event.origin);return;} if(url)LMI_API.setRelayUrl(url); else LMI_API.forgetRelayUrl(); event.source.postMessage({type:'LMI_RELAY_URL_STATUS',ok:true,message:url?'Relay saved locally.':'Relay cleared.'},event.origin); } if(msg.type==='LMI_REFRESH_APPS'){ refreshDesktopApps(); } if(msg.type==='LMI_SET_WALLPAPER'){ setDesktopWallpaper(msg.wallpaper||msg.wp||''); document.querySelectorAll('.win-frame').forEach(fr=>fr.contentWindow?.postMessage({type:'LMI_WALLPAPER_PATCH',wallpaper:msg.wallpaper||msg.wp||''},location.origin)); } if(msg.type==='LMI_THEME_PATCH'){ const liveThemeVars = msg.vars || {};
        sessionStorage.setItem('LMI_ACTIVE_ACCOUNT_THEME', JSON.stringify(liveThemeVars));
        localStorage.setItem('LMI_THEME_VARS', JSON.stringify(liveThemeVars));
        applyTheme(liveThemeVars); document.querySelectorAll('.win-frame').forEach(fr=>fr.contentWindow?.postMessage({type:'LMI_THEME_PATCH',vars:msg.vars||{}},location.origin)); } if(msg.type==='LMI_CURRENCY_PATCH'){ localStorage.setItem('LMI_CURRENCY_PREF',JSON.stringify(msg.currency||{})); document.querySelectorAll('.win-frame').forEach(fr=>fr.contentWindow?.postMessage({type:'LMI_CURRENCY_PATCH',currency:msg.currency||{}},location.origin)); } if(msg.type==='LMI_SHELL_PREFS_PATCH'){ const prefs=setShellPrefs(msg.prefs||{},{persist:true}); document.querySelectorAll('.win-frame').forEach(fr=>fr.contentWindow?.postMessage({type:'LMI_SHELL_PREFS_PATCH',prefs},location.origin)); } });

  function clearDesktopSelection(){
    document.querySelectorAll('.desktop-icon.selected').forEach(el=>el.classList.remove('selected'));
  }

  function isDesktopSelectionExempt(target){
    return !!(
      target.closest?.('.desktop-icon') ||
      target.closest?.('.win') ||
      target.closest?.('.taskbar') ||
      target.closest?.('#startMenu') ||
      target.closest?.('.start-menu') ||
      target.closest?.('.start-panel') ||
      target.closest?.('.desktop-menu') ||
      target.closest?.('button,input,select,textarea,a,label')
    );
  }

  document.addEventListener('pointerdown',ev=>{
    if(isDesktopSelectionExempt(ev.target))return;

    const onDesktop =
      ev.target === document.body ||
      ev.target.id === 'desktopIcons' ||
      ev.target.closest?.('.workspace') ||
      ev.target.closest?.('.desktop');

    if(onDesktop)clearDesktopSelection();
  },true);

  document.addEventListener('keydown',ev=>{
    if(ev.key === 'Escape')clearDesktopSelection();
  },true);


  document.addEventListener('DOMContentLoaded',initLogin);
})();
