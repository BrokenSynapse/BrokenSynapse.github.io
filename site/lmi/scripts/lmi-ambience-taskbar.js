(function(){
  if(window.__LMI_AMBIENCE_TASKBAR_V3__) return;
  window.__LMI_AMBIENCE_TASKBAR_V3__ = true;

  function isDesktopRoute(){
    return location.pathname.replace(/\/+$/,'').toLowerCase().endsWith('/lmi/desktop');
  }

  function ensureButton(){
    if(!isDesktopRoute()) return null;

    let btn = document.getElementById('lmiAmbienceTaskbarButton2') || document.getElementById('lmiAmbienceTaskbarButton');

    if(!btn){
      btn = document.createElement('button');
      btn.id = 'lmiAmbienceTaskbarButton2';
      btn.type = 'button';
      btn.textContent = '🔇';
      document.body.appendChild(btn);
    }

    btn.style.position = 'fixed';
    btn.style.right = '178px';
    btn.style.bottom = '8px';
    btn.style.zIndex = '999999';
    btn.style.width = '18px';
    btn.style.height = '18px';
    btn.style.border = '0';
    btn.style.background = 'transparent';
    btn.style.boxShadow = 'none';
    btn.style.borderRadius = '0';
    btn.style.padding = '0';
    btn.style.margin = '0';
    btn.style.color = '#d8c7ff';
    btn.style.fontSize = '15px';
    btn.style.lineHeight = '18px';
    btn.style.cursor = 'pointer';
    btn.style.fontFamily = 'monospace';

    if(!btn.dataset.boundAmbienceMute){
      btn.dataset.boundAmbienceMute = '1';

      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();

        if(window.LMIAmbience){
          window.LMIAmbience.toggleMute();
          window.LMIAmbience.updateTray?.();
        }
      }, true);
    }

    return btn;
  }

  function tick(){
    const btn = ensureButton();

    if(btn && window.LMIAmbience){
      window.LMIAmbience.updateTray?.();
    }
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', tick);
  }else{
    tick();
  }

  setInterval(tick, 1000);
})();
