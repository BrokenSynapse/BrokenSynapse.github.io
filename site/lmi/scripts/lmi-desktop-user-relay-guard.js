(function(){
  if(window.__LMI_DESKTOP_USER_RELAY_GUARD__) return;
  window.__LMI_DESKTOP_USER_RELAY_GUARD__ = true;

  function isDesktopRoute(){
    return location.pathname.replace(/\/+$/,'').toLowerCase().endsWith('/lmi/desktop');
  }

  if(!isDesktopRoute()) return;

  function parse(v){
    if(!v) return null;
    if(typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return null; }
  }

  function normalizeUser(u){
    if(!u) return null;

    return {
      ...u,
      cid: u.cid || u.id || '',
      tag: u.tag || u.employeeTag || '',
      displayName: u.displayName || u.cn || u.name || u.tag || '',
      access: u.access || u.al || 'User',
      wallpaper: u.wallpaper || u.wp || '',
      avatar: u.avatar || u.av || '',
      shellPrefs: u.shellPrefs || {}
    };
  }

  function getDesktopUser(){
    const u =
      normalizeUser(window.LMI_USER) ||
      normalizeUser(window.currentUser) ||
      normalizeUser(window.sessionUser) ||
      normalizeUser(parse(sessionStorage.getItem('LMI_CURRENT_USER'))) ||
      normalizeUser(parse(sessionStorage.getItem('LMI_SESSION'))?.user) ||
      normalizeUser(parse(sessionStorage.getItem('lmiUser'))) ||
      normalizeUser(parse(sessionStorage.getItem('lmiSession'))?.user);

    if(u){
      window.LMI_USER = u;
      window.currentUser = u;
      window.sessionUser = u;

      try{
        sessionStorage.setItem('LMI_CURRENT_USER', JSON.stringify(u));
        const sess = parse(sessionStorage.getItem('LMI_SESSION')) || {};
        sess.user = u;
        sessionStorage.setItem('LMI_SESSION', JSON.stringify(sess));
      }catch{}
    }

    return u;
  }

  function patchRelayBody(body){
    if(!body || typeof body !== 'object') return body;

    const user = getDesktopUser();
    if(!user) return body;

    // Always force the active desktop user onto relay calls from /lmi/desktop.
    body.user = Object.assign({}, body.user || {}, {
      cid: user.cid,
      tag: user.tag,
      displayName: user.displayName,
      access: user.access
    });

    // Some older relay actions look inside payload.user instead.
    body.payload = body.payload || {};
    body.payload.user = Object.assign({}, body.payload.user || {}, {
      cid: user.cid,
      tag: user.tag,
      displayName: user.displayName,
      access: user.access
    });

    // Layout-specific convenience fields for old handlers.
    body.cid = body.cid || user.cid;
    body.tag = body.tag || user.tag;

    return body;
  }

  const nativeFetch = window.fetch.bind(window);

  window.fetch = function(input, init){
    try{
      const url = typeof input === 'string' ? input : input?.url || '';

      if(String(url).includes('/api/relay')){
        init = init || {};

        let body = init.body;

        if(typeof body === 'string'){
          const parsed = JSON.parse(body);
          init.body = JSON.stringify(patchRelayBody(parsed));
        }else if(body && typeof body === 'object'){
          init.body = JSON.stringify(patchRelayBody(body));
          init.headers = Object.assign({'Content-Type':'application/json'}, init.headers || {});
        }
      }
    }catch(e){
      console.warn('[DesktopUserRelayGuard] fetch patch skipped:', e);
    }

    return nativeFetch(input, init);
  };

  window.LMIDesktopUserRelayGuard = {
    getDesktopUser,
    patchRelayBody
  };

  getDesktopUser();
  console.log('[DesktopUserRelayGuard] active user:', getDesktopUser());
})();
