(function(){
  if(window.__LMI_THEME_RELAY_HOOK__) return;
  window.__LMI_THEME_RELAY_HOOK__ = true;

  const THEME_KEY = 'LMI_PENDING_ACCOUNT_THEME';

  const ALIASES = {
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

  let lastTheme = null;
  let lastUser = null;

  function normalizeVars(vars){
    const out = {};
    if(!vars || typeof vars !== 'object') return out;

    for(const [k,v] of Object.entries(vars)){
      let key = String(k || '').trim().toLowerCase();
      const val = String(v || '').trim();
      if(!key || !val) continue;

      key = key.replace(/^__+/, '--').replace(/^_+/, '--');
      if(!key.startsWith('--')) key = '--' + key.replace(/^[-_]+/, '');

      out[key] = val;
    }

    return out;
  }

  function isLoginVisible(){
    const txt = (document.body?.innerText || '').toLowerCase();
    const hasDesktop =
      document.querySelector('#desktopIcons') ||
      document.querySelector('.desktop-icon') ||
      document.querySelector('.taskbar') ||
      /Operator:\s*[^\/\n]+?\s*\/\s*[^\n]+/i.test(document.body?.innerText || '');

    if(hasDesktop) return false;

    return !!(
      document.querySelector('input[type="password"]') &&
      (
        txt.includes('submit an lmi employee tag') ||
        txt.includes('employee tag') ||
        txt.includes('hash')
      )
    );
  }

  function desktopReady(){
    const txt = document.body?.innerText || '';
    return !!(
      document.querySelector('#desktopIcons') ||
      document.querySelector('.desktop-icon') ||
      document.querySelector('.taskbar') ||
      /Operator:\s*[^\/\n]+?\s*\/\s*[^\n]+/i.test(txt)
    );
  }

  function applyTheme(vars){
    vars = normalizeVars(vars);
    if(!Object.keys(vars).length) return false;

    lastTheme = vars;

    for(const [key,val] of Object.entries(vars)){
      const keys = [key, ...(ALIASES[key] || [])];

      for(const k of keys){
        document.documentElement.style.setProperty(k, val);
        if(document.body) document.body.style.setProperty(k, val);
      }
    }

    // Push into same-origin module iframes/windows if present.
    document.querySelectorAll('iframe').forEach(frame=>{
      try{
        const doc = frame.contentDocument;
        if(!doc) return;

        for(const [key,val] of Object.entries(vars)){
          const keys = [key, ...(ALIASES[key] || [])];

          for(const k of keys){
            doc.documentElement.style.setProperty(k, val);
            if(doc.body) doc.body.style.setProperty(k, val);
          }
        }
      }catch{}
    });

    document.documentElement.classList.add('lmi-account-theme-active');
    if(document.body) document.body.classList.add('lmi-account-theme-active');

    return true;
  }

  function savePending(user, vars){
    vars = normalizeVars(vars);
    if(!Object.keys(vars).length) return;

    lastUser = user || lastUser || null;
    lastTheme = vars;

    try{
      sessionStorage.setItem(THEME_KEY, JSON.stringify({
        user:lastUser,
        themeVars:vars,
        at:Date.now()
      }));
    }catch{}
  }

  function loadPending(){
    try{
      const raw = sessionStorage.getItem(THEME_KEY);
      if(!raw) return null;
      const data = JSON.parse(raw);
      if(data && data.themeVars) return data;
    }catch{}
    return null;
  }

  function extractThemeFromRelay(data){
    if(!data || typeof data !== 'object') return null;

    const candidates = [
      data.data?.user?.shellPrefs?.themeVars,
      data.data?.shellPrefs?.themeVars,
      data.user?.shellPrefs?.themeVars,
      data.shellPrefs?.themeVars,
      data.payload?.shellPrefs?.themeVars
    ];

    return candidates.find(x => x && typeof x === 'object') || null;
  }

  function extractUserFromRelay(data){
    return (
      data?.data?.user ||
      data?.user ||
      data?.data?.session?.user ||
      null
    );
  }


  const LOGIN_BASE_THEME = {
    '--bg': '#020104',
    '--panel': '#08050d',
    '--panel2': '#12091f',
    '--text': '#ffffff',
    '--muted': '#b8a8d6',
    '--line': '#8d54ff',
    '--line2': '#5b2ea6',
    '--accent': '#a45cff',
    '--accent2': '#7b35e8',
    '--good': '#88ffbd',
    '--bad': '#ff6b9a',
    '--warn': '#ffd36b'
  };

  function clearAccountThemeForLogin(){
    lastTheme = null;
    lastUser = null;

    try{ sessionStorage.removeItem(THEME_KEY); }catch{}

    // Reset the known shell vars back to the fixed LMI login/default style.
    for(const [key,val] of Object.entries(LOGIN_BASE_THEME)){
      const keys = [key, ...(ALIASES[key] || [])];

      for(const k of keys){
        document.documentElement.style.setProperty(k, val);
        if(document.body) document.body.style.setProperty(k, val);
      }
    }

    document.documentElement.classList.remove('lmi-account-theme-active');
    if(document.body) document.body.classList.remove('lmi-account-theme-active');
  }


  function applyWhenDesktopReady(reason=''){
    const pending = loadPending();

    if(pending?.themeVars){
      lastTheme = pending.themeVars;
      lastUser = pending.user || lastUser;
    }

    if(!lastTheme) return false;

    // Do not theme the login form. If we returned to login/logout, undo account theme.
    if(isLoginVisible() && !desktopReady()){
      clearAccountThemeForLogin();
      return false;
    }

    if(desktopReady()){
      applyTheme(lastTheme);
      setTimeout(()=>applyTheme(lastTheme), 250);
      setTimeout(()=>applyTheme(lastTheme), 750);
      setTimeout(()=>applyTheme(lastTheme), 1500);
      setTimeout(()=>applyTheme(lastTheme), 3000);
      return true;
    }

    return false;
  }

  function inspectRelayRequest(input, init){
    try{
      const url = typeof input === 'string' ? input : input?.url || '';
      if(!String(url).includes('/api/relay')) return null;

      let body = init?.body;
      if(!body && input && typeof input === 'object') body = input.body;
      if(typeof body !== 'string') return null;

      return JSON.parse(body);
    }catch{
      return null;
    }
  }

  const nativeFetch = window.fetch.bind(window);

  window.fetch = async function(input, init){
    const reqBody = inspectRelayRequest(input, init);
    const res = await nativeFetch(input, init);

    try{
      if(reqBody){
        const clone = res.clone();
        const data = await clone.json().catch(()=>null);

        const vars = extractThemeFromRelay(data);
        const user = extractUserFromRelay(data);

        if(vars){
          savePending(user, vars);
          applyWhenDesktopReady('relay:' + (reqBody.action || 'unknown'));
        }

        // If the desktop state is requested after login, consume pending theme then.
        if(String(reqBody.action || '').toLowerCase().includes('desktop')){
          applyWhenDesktopReady('desktop-state');
        }
      }
    }catch(e){
      console.warn('[LMIThemeRelayHook] relay inspection failed', e);
    }

    return res;
  };


  function acceptLiveTheme(vars){
    vars = normalizeVars(vars);
    if(!Object.keys(vars).length) return false;

    lastTheme = vars;

    try{
      sessionStorage.setItem(THEME_KEY, JSON.stringify({
        user:lastUser,
        themeVars:vars,
        at:Date.now()
      }));
      sessionStorage.setItem('LMI_ACTIVE_ACCOUNT_THEME', JSON.stringify(vars));
      if(location.pathname.replace(/\/+$/,'').toLowerCase().endsWith('/lmi/desktop')){
        localStorage.setItem('LMI_THEME_VARS', JSON.stringify(vars));
      }
    }catch{}

    applyTheme(vars);
    return true;
  }


  window.LMIThemeRelayHook = {
    applyTheme,
    acceptLiveTheme,
    applyWhenDesktopReady,
    loadPending,
    get lastTheme(){ return lastTheme; },
    get lastUser(){ return lastUser; },
    clearAccountThemeForLogin,
    debug(){
      return {
        desktopReady: desktopReady(),
        loginVisible: isLoginVisible(),
        pending: loadPending(),
        lastUser,
        lastTheme,
        cssBg:getComputedStyle(document.documentElement).getPropertyValue('--bg'),
        cssPanel:getComputedStyle(document.documentElement).getPropertyValue('--panel'),
        cssPanel2:getComputedStyle(document.documentElement).getPropertyValue('--panel2')
      };
    }
  };


  // LMI_THEME_PATCH_ACCEPT_LIVE
  window.addEventListener('message', ev => {
    const data = ev.data || {};
    if(data.type === 'LMI_THEME_PATCH' && data.vars){
      acceptLiveTheme(data.vars);
    }
  });

  // Watch the login → desktop transition.
  const obs = new MutationObserver(()=>applyWhenDesktopReady('mutation'));
  if(document.documentElement){
    obs.observe(document.documentElement, {childList:true, subtree:true, characterData:true});
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', ()=>applyWhenDesktopReady('dom'));
  }else{
    applyWhenDesktopReady('immediate');
  }

  setTimeout(()=>applyWhenDesktopReady('late-500'), 500);
  setTimeout(()=>applyWhenDesktopReady('late-1500'), 1500);
  setTimeout(()=>applyWhenDesktopReady('late-3000'), 3000);
  setInterval(()=>applyWhenDesktopReady('interval'), 5000);
})();
