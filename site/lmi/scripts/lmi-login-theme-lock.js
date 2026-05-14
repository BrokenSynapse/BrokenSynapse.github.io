(function(){
  if(window.__LMI_LOGIN_THEME_LOCK__) return;
  window.__LMI_LOGIN_THEME_LOCK__ = true;

  const BASE = {
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

  function isLoginRoute(){
    return location.pathname.replace(/\/+$/,'').toLowerCase() === '/lmi';
  }

  function isLoginVisible(){
    const txt = (document.body?.innerText || '').toLowerCase();
    return !!(
      document.querySelector('input[type="password"]') &&
      (
        txt.includes('please submit an lmi employee tag') ||
        txt.includes('employee tag') ||
        txt.includes('hash')
      )
    );
  }

  function applyBase(){
    if(!isLoginRoute() && !isLoginVisible()) return false;

    try{
      sessionStorage.removeItem('LMI_PENDING_ACCOUNT_THEME');
      sessionStorage.removeItem('LMI_ACTIVE_ACCOUNT_THEME');
      localStorage.removeItem('LMI_THEME_VARS');
    }catch{}

    for(const [key,val] of Object.entries(BASE)){
      const keys = [key, ...(ALIASES[key] || [])];
      for(const k of keys){
        document.documentElement.style.setProperty(k, val);
        if(document.body) document.body.style.setProperty(k, val);
      }
    }

    document.documentElement.classList.remove('lmi-account-theme-active');
    document.body?.classList.remove('lmi-account-theme-active');
    return true;
  }

  window.LMILoginThemeLock = { applyBase, isLoginVisible };

  applyBase();
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', applyBase);
  }
  setTimeout(applyBase, 50);
  setTimeout(applyBase, 250);
  setTimeout(applyBase, 750);
  setInterval(applyBase, 1000);
})();
