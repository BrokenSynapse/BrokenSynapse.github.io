(function(){
  console.log('[LMIAccountTheme] script loaded', location.href);

  window.LMIAccountTheme = window.LMIAccountTheme || {};
  window.__LMI_ACCOUNT_THEME_V2__ = true;

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

  let lastThemeVars = null;
  let lastUser = null;

  function isLoginShell(){
    const txtRaw = document.body && document.body.innerText || '';
    const txt = txtRaw.toLowerCase();

    // Desktop/operator evidence wins. Some desktop builds keep login markup/text
    // around after auth, so password/hash text alone is not enough.
    if(
      /Operator:\s*[^\/\n]+?\s*\/\s*[^\n]+/i.test(txtRaw) ||
      txt.includes('l.m.i. desktop') ||
      document.querySelector('.desktop-icon') ||
      document.querySelector('[data-app-id]') ||
      document.querySelector('#desktopIcons')
    ){
      return false;
    }

    return !!(
      document.querySelector('input[type="password"]') &&
      (
        txt.includes('submit an lmi employee tag') ||
        txt.includes('employee tag') ||
        txt.includes('hash')
      )
    );
  }

  function cleanVarKey(k){
    k = String(k || '').trim().toLowerCase();
    if(!k) return '';
    if(!k.startsWith('--')) k = '--' + k.replace(/^[-_]+/, '');
    return k;
  }

  function normalizeThemeVars(vars){
    const out = {};
    if(!vars || typeof vars !== 'object') return out;

    for(const [rawKey, rawVal] of Object.entries(vars)){
      const key = cleanVarKey(rawKey);
      const val = String(rawVal || '').trim();
      if(key && val) out[key] = val;
    }

    return out;
  }

  function findVisibleUser(){
    const txt = document.body?.innerText || '';

    let m = txt.match(/Operator:\s*([^\/\n]+?)\s*\/\s*([^\n]+)/i);
    if(m){
      return { displayName: m[1].trim(), access: m[2].trim() };
    }

    m = txt.match(/Settings\.LMX\s+([^\/\n]+?)\s*\/\s*([^\n]+)/i);
    if(m){
      return { displayName: m[1].trim(), access: m[2].trim() };
    }

    return null;
  }

  function applyThemeVars(vars){
    vars = normalizeThemeVars(vars);
    if(!Object.keys(vars).length) return false;

    lastThemeVars = vars;

    for(const [key,val] of Object.entries(vars)){
      const keys = [key, ...(ALIASES[key] || [])];

      for(const k of keys){
        document.documentElement.style.setProperty(k, val);
        if(document.body) document.body.style.setProperty(k, val);
      }
    }

    return true;
  }

  async function fetchAccountTheme(){
    if(isLoginShell()){
      console.log('[LMIAccountTheme] login shell detected, not applying account theme');
      return false;
    }

    const user = findVisibleUser();

    if(!user || !user.displayName){
      console.warn('[LMIAccountTheme] No visible operator found.', document.body?.innerText?.slice(0, 300));
      return false;
    }

    lastUser = user;

    try{
      const res = await fetch('/api/relay', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'getShellPrefs',
          payload:{
            displayName:user.displayName,
            name:user.displayName,
            cn:user.displayName
          },
          user:{
            displayName:user.displayName,
            name:user.displayName,
            cn:user.displayName
          }
        })
      });

      const data = await res.json();

      if(!data || !data.ok){
        console.warn('[LMIAccountTheme] getShellPrefs failed:', data);
        return false;
      }

      const prefs = data.data && data.data.shellPrefs;
      const vars = prefs && prefs.themeVars;

      if(!vars){
        console.warn('[LMIAccountTheme] No themeVars for:', user.displayName, prefs);
        return false;
      }

      console.log('[LMIAccountTheme] Applying theme for:', user.displayName, vars);

      applyThemeVars(vars);
      setTimeout(()=>applyThemeVars(vars), 250);
      setTimeout(()=>applyThemeVars(vars), 750);
      setTimeout(()=>applyThemeVars(vars), 1500);
      setTimeout(()=>applyThemeVars(vars), 3000);

      return true;
    }catch(e){
      console.warn('[LMIAccountTheme] fetch/apply failed:', e);
      return false;
    }
  }

  function reapplyLast(){
    if(lastThemeVars && !isLoginShell()){
      applyThemeVars(lastThemeVars);
    }
  }

  Object.assign(window.LMIAccountTheme, {
    fetchAccountTheme,
    applyThemeVars,
    acceptLiveTheme,
    normalizeThemeVars,
    findVisibleUser,
    debug(){
      return {
        loaded:true,
        href:location.href,
        isLogin:isLoginShell(),
        visibleUser:findVisibleUser(),
        lastUser,
        lastThemeVars,
        cssBg:getComputedStyle(document.documentElement).getPropertyValue('--bg'),
        cssPanel:getComputedStyle(document.documentElement).getPropertyValue('--panel'),
        cssPanel2:getComputedStyle(document.documentElement).getPropertyValue('--panel2')
      };
    }
  });

  setTimeout(fetchAccountTheme, 0);
  setTimeout(fetchAccountTheme, 500);
  setTimeout(fetchAccountTheme, 1500);
  setTimeout(fetchAccountTheme, 3000);
  setInterval(reapplyLast, 5000);
})();
