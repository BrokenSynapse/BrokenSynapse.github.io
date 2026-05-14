(function(){
  if(window.__LMI_DESKTOP_LAYOUT_USER_FIX__) return;
  window.__LMI_DESKTOP_LAYOUT_USER_FIX__ = true;

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
      shellPrefs: u.shellPrefs || {}
    };
  }

  function currentUser(){
    let u =
      normalizeUser(window.LMI_USER) ||
      normalizeUser(window.currentUser) ||
      normalizeUser(window.sessionUser) ||
      normalizeUser(parse(sessionStorage.getItem('LMI_CURRENT_USER'))) ||
      normalizeUser(parse(sessionStorage.getItem('LMI_SESSION'))?.user) ||
      normalizeUser(parse(sessionStorage.getItem('lmiUser'))) ||
      normalizeUser(parse(sessionStorage.getItem('lmiSession'))?.user);

    if(!u){
      return null;
    }

    window.LMI_USER = u;
    window.currentUser = u;
    window.sessionUser = u;

    try{
      sessionStorage.setItem('LMI_CURRENT_USER', JSON.stringify(u));

      const sess = parse(sessionStorage.getItem('LMI_SESSION')) || {};
      sess.user = u;
      sessionStorage.setItem('LMI_SESSION', JSON.stringify(sess));
    }catch{}

    return u;
  }

  function userKey(u){
    u = normalizeUser(u);
    return String(u?.cid || u?.tag || u?.displayName || '').trim().toLowerCase();
  }

  function clearStaleLayoutCachesForUser(){
    const u = currentUser();
    const key = userKey(u);
    if(!key) return;

    const activeKey = sessionStorage.getItem('LMI_ACTIVE_LAYOUT_USER_KEY');

    if(activeKey && activeKey !== key){
      // These are browser-local layout caches that can overpower DB/user layout after route split.
      [
        'LMI_DESKTOP_LAYOUT',
        'LMI_DESKTOP_POSITIONS',
        'LMI_ICON_POSITIONS',
        'LMI_DESK_LAYOUT',
        'BIPEX_DESKTOP_LAYOUT'
      ].forEach(k => {
        try{ localStorage.removeItem(k); }catch{}
        try{ sessionStorage.removeItem(k); }catch{}
      });
    }

    sessionStorage.setItem('LMI_ACTIVE_LAYOUT_USER_KEY', key);
  }

  function patchRelayBody(obj){
    const u = currentUser();
    if(!u || !obj || typeof obj !== 'object') return obj;

    const userPatch = {
      cid: u.cid,
      tag: u.tag,
      displayName: u.displayName,
      access: u.access
    };

    obj.user = Object.assign({}, obj.user || {}, userPatch);

    obj.payload = obj.payload || {};
    obj.payload.user = Object.assign({}, obj.payload.user || {}, userPatch);

    // Some older code used top-level fields.
    obj.cid = obj.cid || u.cid;
    obj.tag = obj.tag || u.tag;

    return obj;
  }

  function patchBodyString(body){
    if(typeof body !== 'string') return body;

    try{
      const obj = JSON.parse(body);
      return JSON.stringify(patchRelayBody(obj));
    }catch{
      return body;
    }
  }

  // fetch relay guard
  const nativeFetch = window.fetch?.bind(window);

  if(nativeFetch){
    window.fetch = function(input, init){
      try{
        const url = String(typeof input === 'string' ? input : input?.url || '');

        if(url.includes('/api/relay')){
          init = init || {};

          if(typeof init.body === 'string'){
            init.body = patchBodyString(init.body);
          }else if(init.body && typeof init.body === 'object'){
            init.body = JSON.stringify(patchRelayBody(init.body));
            init.headers = Object.assign({'Content-Type':'application/json'}, init.headers || {});
          }
        }
      }catch(e){
        console.warn('[LayoutUserFix] fetch patch skipped:', e);
      }

      return nativeFetch(input, init);
    };
  }

  // XHR relay guard
  const NativeXHR = window.XMLHttpRequest;

  if(NativeXHR && !NativeXHR.__LMI_PATCHED_FOR_LAYOUT_USER__){
    function PatchedXHR(){
      const xhr = new NativeXHR();
      let relayUrl = '';

      const open = xhr.open;
      xhr.open = function(method, url){
        relayUrl = String(url || '');
        return open.apply(xhr, arguments);
      };

      const send = xhr.send;
      xhr.send = function(body){
        if(relayUrl.includes('/api/relay') && typeof body === 'string'){
          body = patchBodyString(body);
        }

        return send.call(xhr, body);
      };

      return xhr;
    }

    PatchedXHR.__LMI_PATCHED_FOR_LAYOUT_USER__ = true;
    window.XMLHttpRequest = PatchedXHR;
  }

  // sendBeacon relay guard, just in case layout uses unload save.
  if(navigator.sendBeacon){
    const nativeBeacon = navigator.sendBeacon.bind(navigator);

    navigator.sendBeacon = function(url, data){
      try{
        if(String(url || '').includes('/api/relay') && typeof data === 'string'){
          data = patchBodyString(data);
        }
      }catch(e){
        console.warn('[LayoutUserFix] beacon patch skipped:', e);
      }

      return nativeBeacon(url, data);
    };
  }

  clearStaleLayoutCachesForUser();

  setInterval(() => {
    currentUser();
    clearStaleLayoutCachesForUser();
  }, 1500);

  window.LMIDesktopLayoutUserFix = {
    currentUser,
    patchRelayBody,
    clearStaleLayoutCachesForUser
  };

  console.log('[LayoutUserFix] active user:', currentUser());
})();
