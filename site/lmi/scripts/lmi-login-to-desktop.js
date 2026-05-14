(function(){
  if(window.__LMI_LOGIN_TO_DESKTOP__) return;
  window.__LMI_LOGIN_TO_DESKTOP__ = true;

  const DESKTOP_URL = '/lmi/desktop';

  function isLoginShell(){
    const txt = (document.body?.innerText || '').toLowerCase();
    return !!(
      document.querySelector('input[type="password"]') &&
      (
        txt.includes('submit an lmi employee tag') ||
        txt.includes('employee tag') ||
        txt.includes('hash')
      )
    );
  }

  function parseRelayBody(input, init){
    try{
      const url = typeof input === 'string' ? input : input?.url || '';
      if(!String(url).includes('/api/relay')) return null;

      const body = init?.body || input?.body;
      if(typeof body !== 'string') return null;

      return JSON.parse(body);
    }catch{
      return null;
    }
  }

  function storeLogin(data){
    const user = data?.data?.user || data?.user || null;
    const session = data?.data?.session || data?.session || null;

    if(!user) return;

    const payload = {
      user,
      session,
      at: Date.now()
    };

    try{
      sessionStorage.setItem('LMI_CURRENT_USER', JSON.stringify(user));
      sessionStorage.setItem('LMI_SESSION', JSON.stringify(payload));
      localStorage.setItem('LMI_LAST_USER', JSON.stringify(user));
      localStorage.setItem('LMI_SHELL_PREFS_CACHE_' + (user.cid || user.tag || 'current'), JSON.stringify({
        user,
        shellPrefs: user.shellPrefs || {},
        at: Date.now()
      }));
    }catch{}

    try{
      if(user.shellPrefs?.themeVars){
        sessionStorage.setItem('LMI_PENDING_ACCOUNT_THEME', JSON.stringify({
          user,
          themeVars: user.shellPrefs.themeVars,
          at: Date.now()
        }));
      }
    }catch{}
  }

  const nativeFetch = window.fetch.bind(window);

  window.fetch = async function(input, init){
    const req = parseRelayBody(input, init);
    const res = await nativeFetch(input, init);

    try{
      if(req && String(req.action || '').toLowerCase() === 'login'){
        const data = await res.clone().json().catch(()=>null);

        if(data?.ok && data?.data?.user){
          storeLogin(data);

          // Let the original login script finish its own storage/UI work, then route out.
          setTimeout(() => {
            if(isLoginShell() || !location.pathname.replace(/\/+$/,'').endsWith('/desktop')){
              location.href = DESKTOP_URL + '?v=' + Date.now();
            }
          }, 80);
        }
      }
    }catch(e){
      console.warn('[LMI login redirect] failed:', e);
    }

    return res;
  };
})();