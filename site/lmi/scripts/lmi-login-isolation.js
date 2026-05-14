(function(){
  if(window.__LMI_LOGIN_ISOLATION__) return;
  window.__LMI_LOGIN_ISOLATION__ = true;

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

  function isolateLogin(){
    if(!isLoginShell()) return;

    // Stop ambience if it somehow exists on login.
    const a = document.getElementById('lmiAmbienceAudio');
    if(a) a.pause();

    try{
      window.LMIAmbience && window.LMIAmbience.stop && window.LMIAmbience.stop();
    }catch{}

    // Remove likely account/theme classes from login only.
    const cls = Array.from(document.documentElement.classList);
    cls.forEach(c => {
      if(/^theme-|^lmi-theme-|^wallpaper-|^user-theme-/.test(c)){
        document.documentElement.classList.remove(c);
      }
    });

    const bodyCls = Array.from(document.body.classList);
    bodyCls.forEach(c => {
      if(/^theme-|^lmi-theme-|^wallpaper-|^user-theme-/.test(c)){
        document.body.classList.remove(c);
      }
    });

    // Keep landing visually stable. Do not mess with desktop after login.
    document.body.classList.add('lmi-login-isolated');
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', isolateLogin);
  }else{
    isolateLogin();
  }

  setTimeout(isolateLogin, 250);
  setTimeout(isolateLogin, 1000);
})();
