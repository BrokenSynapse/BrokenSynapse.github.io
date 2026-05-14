(function(){
  if(window.__LMI_SHELLPREFS_HYDRATOR__) return;
  window.__LMI_SHELLPREFS_HYDRATOR__ = true;

  function parse(v){
    if(!v) return null;
    if(typeof v === 'object') return v;
    try{return JSON.parse(v);}catch{return null;}
  }

  function currentUser(){
    return window.LMI_RUNTIME?.user ||
      window.LMI_USER ||
      window.currentUser ||
      window.sessionUser ||
      parse(sessionStorage.getItem('LMI_CURRENT_USER')) ||
      parse(sessionStorage.getItem('LMI_SESSION'))?.user ||
      null;
  }

  function relayUrl(){
    try{
      return window.LMI_API?.relayUrl?.() ||
        window.LMI_API?.getRelayUrl?.() ||
        localStorage.getItem('LMI_RELAY_URL') ||
        '/api/relay';
    }catch{
      return '/api/relay';
    }
  }

  async function relay(action, payload){
    if(window.LMI_API?.callRelay){
      return await window.LMI_API.callRelay(action, payload || {}, currentUser());
    }

    const res = await fetch(relayUrl(), {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        action,
        payload: payload || {},
        user: currentUser()
      })
    });

    return await res.json();
  }

  function mergeShellPrefs(prefs){
    if(!prefs || typeof prefs !== 'object') return null;

    const u = currentUser();
    if(u){
      u.shellPrefs = Object.assign({}, u.shellPrefs || {}, prefs);

      window.LMI_USER = u;
      window.currentUser = u;
      window.sessionUser = u;

      if(window.LMI_RUNTIME){
        window.LMI_RUNTIME.user = u;
      }

      sessionStorage.setItem('LMI_CURRENT_USER', JSON.stringify(u));

      const sess = parse(sessionStorage.getItem('LMI_SESSION')) || {};
      sess.user = u;
      sessionStorage.setItem('LMI_SESSION', JSON.stringify(sess));
    }

    window.LMIShellPrefs = Object.assign({}, window.LMIShellPrefs || {}, prefs);

    if(prefs.iconPack){
      document.body.dataset.iconPack = prefs.iconPack;
    }

    try{
      (window.LMI_DESKTOP?.previewShellPrefs || window.LMI_RUNTIME?.previewShellPrefs)?.(window.LMIShellPrefs);
    }catch{}

    try{
      window.LMI_DESKTOP?.previewShellPrefs?.(window.LMIShellPrefs);
    }catch{}

    try{
      window.LMIIconPacks?.refresh?.();
    }catch{}

    window.dispatchEvent(new CustomEvent('LMI_SHELLPREFS_HYDRATED', {
      detail: { prefs: window.LMIShellPrefs }
    }));

    return window.LMIShellPrefs;
  }

  async function hydrate(){
    const u = currentUser();
    if(!u) return null;

    // Apply whatever was handed off immediately.
    if(u.shellPrefs){
      mergeShellPrefs(u.shellPrefs);
    }

    // Then fetch DB-fresh account data.
    try{
      const data = await relay('user.shell.get', {
        user: {
          cid: u.cid,
          tag: u.tag,
          displayName: u.displayName || u.cn || u.name
        }
      });

      const dbUser = data?.data?.user || data?.user;
      const prefs = dbUser?.shellPrefs;

      if(prefs){
        return mergeShellPrefs(prefs);
      }
    }catch(e){
      console.warn('[ShellPrefsHydrator] DB hydrate failed:', e);
    }

    return window.LMIShellPrefs || u.shellPrefs || null;
  }

  window.LMIShellPrefsHydrator = {
    hydrate,
    mergeShellPrefs,
    currentUser
  };

  // Run repeatedly around boot because desktop/user handoff is async.
  setTimeout(hydrate, 50);
  setTimeout(hydrate, 250);
  setTimeout(hydrate, 800);
  setTimeout(hydrate, 1600);
})();
