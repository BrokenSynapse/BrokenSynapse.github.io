(() => {
  addEventListener('DOMContentLoaded', () => {
    const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
    const action = name => invoke('desktop_window_action', { action: name }).catch(() => false);
    const frame = document.createElement('header');
    frame.id = 'horizon-window-chrome';
    frame.setAttribute('aria-label', 'Horizon Chat window controls');
    frame.innerHTML = `
      <div class="horizon-window-drag"><img alt="" width="22" height="22" draggable="false"><span>Horizon Chat</span></div>
      <button type="button" class="horizon-window-update" hidden aria-label="Client update available" title="Client update available"><span aria-hidden="true">↓</span><span>Update</span></button>
      <button type="button" data-window-action="minimize" aria-label="Minimize" title="Minimize"><span aria-hidden="true">−</span></button>
      <button type="button" data-window-action="maximize" aria-label="Maximize" title="Maximize"><span aria-hidden="true">□</span></button>
      <button type="button" data-window-action="close" aria-label="Close" title="Close"><span aria-hidden="true">×</span></button>
    `;
    frame.querySelector('img').src = window.__HORIZON_TITLEBAR_ICON__;
    const style = document.createElement('style');
    style.textContent = `
      :root { --horizon-caption-height: 34px; --horizon-edged-viewport: calc(100dvh - var(--horizon-caption-height)); }
      body { padding-top: var(--horizon-caption-height); }
      #desktop-connection:not([hidden]) { top: calc(var(--horizon-caption-height) + .5rem); }
      body > .app, #preferences, #server-settings-screen { height: var(--horizon-edged-viewport); }
      #preferences, #server-settings-screen { inset-block-start: var(--horizon-caption-height); }
      #horizon-window-chrome {
        position: fixed; inset: 0 0 auto; z-index: 1000; height: var(--horizon-caption-height);
        display: flex; align-items: stretch; color: #e9e2ed; background: #221e28;
        border-bottom: 1px solid #ffffff20; font: 12px "Segoe UI", sans-serif; user-select: none;
      }
      #horizon-window-chrome .horizon-window-drag { flex: 1; display: flex; min-width: 0; align-items: center; gap: 7px; padding-inline: 9px; }
      #horizon-window-chrome button { display: grid; place-items: center; min-width: 45px; padding: 0; border: 0; border-radius: 0; color: inherit; background: transparent; font: 17px "Segoe UI", sans-serif; }
      #horizon-window-chrome button:hover { background: #ffffff19; }
      #horizon-window-chrome button:focus-visible { outline: 2px solid currentColor; outline-offset: -3px; }
      #horizon-window-chrome [data-window-action=close]:hover { background: #c62b39; color: white; }
      #horizon-window-chrome .horizon-window-update { display: flex; gap: 5px; padding-inline: 10px; justify-content: center; font-size: 12px; font-weight: 650; color: #ffd1a3; }
      #horizon-window-chrome .horizon-window-update span:first-child { font-size: 17px; }
      @media (forced-colors: active) {
        #horizon-window-chrome, #horizon-window-chrome button { background: Canvas; color: CanvasText; border-color: ButtonText; }
      }
    `;
    document.head.append(style);
    document.body.prepend(frame);
    const maximize = frame.querySelector('[data-window-action=maximize]');
    const syncMaximize = async () => {
      const expanded = await action('state');
      maximize.title = expanded ? 'Restore' : 'Maximize';
      maximize.setAttribute('aria-label', maximize.title);
      maximize.firstElementChild.textContent = expanded ? '❐' : '□';
    };
    for (const button of frame.querySelectorAll('[data-window-action]')) {
      button.addEventListener('click', async () => {
        await action(button.dataset.windowAction);
        if (button === maximize) void syncMaximize();
      });
    }
    frame.firstElementChild.addEventListener('pointerdown', event => {
      if (event.button === 0 && event.isPrimary) void action('drag');
    });
    frame.firstElementChild.addEventListener('dblclick', () => void action('maximize').then(syncMaximize));
    addEventListener('resize', syncMaximize);
    void syncMaximize();
    const update = frame.querySelector('.horizon-window-update');
    let version;
    async function check() {
      try {
        version = await invoke('desktop_update_version');
        update.hidden = !version;
        if (version) {
          update.title = 'Horizon ' + version + ' is available';
          update.setAttribute('aria-label', update.title);
        }
      } catch { update.hidden = true; }
    }
    update.addEventListener('click', () => {
      if (version) void invoke('desktop_open_update', { available: version }).catch(() => {});
    });
    void check();
    setInterval(check, 6 * 60 * 60 * 1000);
  }, { once: true });
})();
