(function(){
  if(window.__LMI_DESKTOP_HANDOFF__) return;
  window.__LMI_DESKTOP_HANDOFF__ = true;

  function parseMaybeJson(v){
    if(!v) return null;
    if(typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return null; }
  }

  function getHandoff(){
    const user =
      parseMaybeJson(sessionStorage.getItem('LMI_CURRENT_USER')) ||
      parseMaybeJson(localStorage.getItem('LMI_LAST_USER'));

    const session =
      parseMaybeJson(sessionStorage.getItem('LMI_SESSION')) ||
      (user ? { user, at:Date.now() } : null);

    return { user, session };
  }

  function exposeUser(user, session){
    if(!user) return false;

    window.LMI_USER = user;
    window.currentUser = user;
    window.user = user;
    window.sessionUser = user;
    window.LMI_SESSION = session || { user, at:Date.now() };

    try{
      sessionStorage.setItem('LMI_CURRENT_USER', JSON.stringify(user));
      sessionStorage.setItem('LMI_SESSION', JSON.stringify(window.LMI_SESSION));
    }catch{}

    document.documentElement.dataset.lmiCid = user.cid || '';
    document.documentElement.dataset.lmiTag = user.tag || '';
    document.documentElement.dataset.lmiUser = user.displayName || user.cn || user.tag || '';

    return true;
  }

  function isLoginThing(el){
    if(!el || el === document.documentElement || el === document.body) return false;

    const txt = String(el.innerText || el.textContent || '').toLowerCase();

    return !!(
      el.querySelector?.('input[type="password"]') &&
      (
        txt.includes('submit an lmi employee tag') ||
        txt.includes('employee tag') ||
        txt.includes('hash') ||
        txt.includes('awaiting credentials')
      )
    );
  }

  function removeNestedLogin(){
    // Do not remove the whole body. Only remove panels/forms that look like login islands.
    document.querySelectorAll('form, main, section, div').forEach(el => {
      if(isLoginThing(el)){
        el.remove();
      }
    });
  }

  function ensureOperatorLabel(user){
    if(!user) return;

    const name = user.displayName || user.cn || user.name || user.tag || 'Unknown';
    const access = user.access || user.al || 'User';
    const wanted = `Operator: ${name} / ${access}`;

    let el = Array.from(document.querySelectorAll('*')).find(x =>
      String(x.textContent || '').trim().startsWith('Operator:')
    );

    if(el){
      el.textContent = wanted;
      return;
    }

    // If desktop header exists, add operator label on the right.
    const header = Array.from(document.querySelectorAll('header, .topbar, .desktop-header, body > div'))
      .find(x => /L\.M\.I\.\s*DESKTOP/i.test(x.textContent || ''));

    if(header){
      el = document.createElement('div');
      el.textContent = wanted;
      el.style.position = 'fixed';
      el.style.right = '10px';
      el.style.top = '12px';
      el.style.zIndex = '99999';
      el.style.color = '#fff';
      el.style.fontFamily = 'monospace';
      el.style.fontSize = '12px';
      document.body.appendChild(el);
    }
  }

  function normalizeUserShape(user){
    if(!user) return null;

    return {
      ...user,
      cid: user.cid || user.id || '',
      tag: user.tag || user.employeeTag || '',
      displayName: user.displayName || user.cn || user.name || user.tag || '',
      access: user.access || user.al || 'User',
      wallpaper: user.wallpaper || user.wp || '',
      avatar: user.avatar || user.av || '',
      bankAccountId: user.bankAccountId || user.bid || '',
      currency: user.currency || user.cur || '',
      occupation: user.occupation || user.occ || '',
      shellPrefs: user.shellPrefs || {}
    };
  }

  function applyWallpaper(user){
    const wp = user?.wallpaper || user?.wp;
    if(!wp) return;

    let src = String(wp).trim().replace(/^LMC:\s*/i,'');
    if(src.startsWith('/assets/')) src = '/lmi' + src;
    if(!src.startsWith('/')) src = '/lmi/assets/' + src.replace(/^assets\//,'');

    document.documentElement.style.setProperty('--wallpaper', `url("${src}")`);
    document.body.style.backgroundImage = `url("${src}")`;
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
  }

  async function refreshUserFromRelay(user){
    if(!user || (!user.cid && !user.tag)) return user;

    try{
      const res = await fetch('/api/relay', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'login',
          payload:{
            tag:user.tag,
            hash:user.hash || ''
          },
          user
        })
      });

      // Don't rely on this; login requires hash. This is only a harmless best effort.
      const data = await res.json().catch(()=>null);
      if(data?.ok && data?.data?.user){
        return normalizeUserShape(data.data.user);
      }
    }catch{}

    return user;
  }

  function boot(){
    const handoff = getHandoff();
    let user = normalizeUserShape(handoff.user);

    if(!user){
      console.warn('[LMI Desktop Handoff] No user handoff found; returning to login.');
      location.href = '/lmi/?missingSession=' + Date.now();
      return;
    }

    exposeUser(user, handoff.session || { user, at:Date.now() });
    removeNestedLogin();
    ensureOperatorLabel(user);
    applyWallpaper(user);

    // Keep killing any login island that late auth scripts inject.
    const obs = new MutationObserver(() => {
      exposeUser(user, handoff.session || { user, at:Date.now() });
      removeNestedLogin();
      ensureOperatorLabel(user);
    });

    obs.observe(document.documentElement, {
      childList:true,
      subtree:true,
      characterData:true
    });

    setTimeout(()=>{ removeNestedLogin(); ensureOperatorLabel(user); applyWallpaper(user); }, 250);
    setTimeout(()=>{ removeNestedLogin(); ensureOperatorLabel(user); applyWallpaper(user); }, 1000);
    setTimeout(()=>{ removeNestedLogin(); ensureOperatorLabel(user); applyWallpaper(user); }, 2500);
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', boot);
  }else{
    boot();
  }
})();
