(function(){
  if(window.__LMI_LOGIN_AUDIO_ARM__) return;
  window.__LMI_LOGIN_AUDIO_ARM__ = true;

  function isLoginShell(){
    const txt = (document.body && document.body.innerText || '').toLowerCase();
    return !!(
      document.querySelector('input[type="password"]') &&
      (
        txt.includes('submit an lmi employee tag') ||
        txt.includes('employee tag') ||
        txt.includes('hash')
      )
    );
  }

  function armAmbience(){
    try { sessionStorage.setItem('LMI_AUDIO_ARMED_FROM_LOGIN','1'); } catch {}
    try { sessionStorage.setItem('LMI_AUDIO_UNLOCKED','1'); } catch {}

    // Helpful if login transitions into desktop without full page reload.
    try {
      window.postMessage({type:'LMI_AUDIO_ARMED_FROM_LOGIN'}, '*');
      parent.postMessage({type:'LMI_AUDIO_ARMED_FROM_LOGIN'}, '*');
    } catch {}
  }

  document.addEventListener('keydown', ev => {
    if(!isLoginShell()) return;
    if(ev.key === 'Enter') armAmbience();
  }, true);

  document.addEventListener('pointerdown', ev => {
    if(!isLoginShell()) return;

    const t = ev.target;
    const txt = String(t?.textContent || t?.value || '').toLowerCase();

    if(
      t?.closest?.('button') ||
      t?.matches?.('input[type="submit"]') ||
      txt.includes('submit')
    ){
      armAmbience();
    }
  }, true);

  document.addEventListener('submit', ev => {
    if(isLoginShell()) armAmbience();
  }, true);
})();
