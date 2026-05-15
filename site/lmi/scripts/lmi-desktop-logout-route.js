(function(){
  if(window.__LMI_DESKTOP_LOGOUT_ROUTE__) return;
  window.__LMI_DESKTOP_LOGOUT_ROUTE__ = true;

  function isLogoutish(el){
    if(!el) return false;

    const txt = String(el.textContent || el.value || el.title || '').trim().toLowerCase();
    const act = String(el.dataset?.act || el.dataset?.action || el.getAttribute?.('data-command') || '').toLowerCase();
    const href = String(el.getAttribute?.('href') || '').toLowerCase();

    return (
      txt.includes('return to login') ||
      txt === 'logout' ||
      txt === 'log out' ||
      txt.includes('sign out') ||
      act.includes('logout') ||
      act.includes('login') ||
      href.endsWith('/lmi') ||
      href.endsWith('/lmi/')
    );
  }

  async function logout(){
    try{ await window.LMI_DESKTOP?.saveCurrentIconLayout?.(); }catch{}
    try{ await window.LMI_DESKTOP?.flushLayoutSaves?.(); }catch{}
    try{ window.LMIAmbience?.stop?.('logout'); }catch{}
    try{ sessionStorage.removeItem('LMI_ACTIVE_AMBIENCE_STATE'); }catch{}
    try{
      sessionStorage.removeItem('LMI_CURRENT_USER');
      sessionStorage.removeItem('LMI_SESSION');
      sessionStorage.removeItem('lmiUser');
      sessionStorage.removeItem('lmiSession');
      sessionStorage.removeItem('LMI_PENDING_ACCOUNT_THEME');
      sessionStorage.removeItem('LMI_ACTIVE_ACCOUNT_THEME');
    }catch{}

    try{
      localStorage.removeItem('LMI_INSTALLED_APPS');
      localStorage.removeItem('LMI_THEME_VARS');
    }catch{}

    location.href = '/lmi/?logout=' + Date.now();
  }

  document.addEventListener('click', e=>{
    const target = e.target.closest?.('button,a,[role="button"],.menu-item,.start-item,li,div');
    if(!target) return;

    if(isLogoutish(target)){
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      logout();
    }
  }, true);

  window.LMIDesktopLogoutRoute = { logout };
})();
