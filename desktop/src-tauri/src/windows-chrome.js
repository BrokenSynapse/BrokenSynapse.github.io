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
      #horizon-update-panel {
        position: fixed; inset: var(--horizon-caption-height) 0 0; z-index: 990;
        display: grid; place-content: center; justify-items: center; gap: 13px;
        padding: 24px; color: #fff3e9; background: #17121c; text-align: center;
        font: 14px "Segoe UI", sans-serif;
      }
      #horizon-update-panel h2, #horizon-update-panel p { margin: 0; }
      #horizon-update-status { min-height: 1.3em; color: #dcc6bc; }
      .horizon-update-orbit {
        --orbit-progress: 0%;
        position: relative; width: min(42vmin, 164px); aspect-ratio: 1;
        display: grid; place-items: center; margin-bottom: 12px;
        border-radius: 50%; background: #0a0710; isolation: isolate;
        box-shadow: 0 0 28px #fe6c2933, 0 0 48px #85246d33, inset 0 0 22px #89332a45;
      }
      .horizon-update-orbit::before {
        content: ""; position: absolute; inset: 0; border-radius: inherit;
        background: conic-gradient(#ffd187 0, #f57b34 var(--orbit-progress), #503042 var(--orbit-progress));
        mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 0);
      }
      .horizon-update-eyes { display: flex; gap: 13%; width: 57%; justify-content: center; }
      .horizon-update-eye {
        display: block; width: 43%; aspect-ratio: 1.9;
        background: radial-gradient(ellipse at 60% 25%, #261013 0 15%, #ffb249 19% 38%, #cb481f 65%, #6d223c);
        clip-path: polygon(0 8%, 100% 40%, 77% 91%, 32% 90%, 10% 61%);
        animation: horizon-update-blink 5.8s ease-in-out infinite;
      }
      .horizon-update-eye + .horizon-update-eye { scale: -1 1; }
      @keyframes horizon-update-blink {
        0%, 40%, 47%, 100% { transform: scaleY(1); }
        44% { transform: scaleY(.14); }
      }
      @media (prefers-reduced-motion: reduce) {
        .horizon-update-eye { animation: none; }
      }
      @media (forced-colors: active) {
        #horizon-update-panel { color: CanvasText; background: Canvas; }
        #horizon-update-status { color: CanvasText; }
        .horizon-update-orbit { border: 1px solid CanvasText; }
      }
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
    const panel = document.createElement('section');
    panel.id = 'horizon-update-panel';
    panel.hidden = true;
    panel.innerHTML = `
      <div class="horizon-update-orbit" role="progressbar" aria-label="Update download" aria-valuemin="0" aria-valuemax="100">
        <div class="horizon-update-eyes" aria-hidden="true"><span class="horizon-update-eye"></span><span class="horizon-update-eye"></span></div>
      </div>
      <h2 id="horizon-update-heading">Updating Horizon</h2>
      <p id="horizon-update-status" role="status"></p>
    `;
    panel.setAttribute('aria-labelledby', 'horizon-update-heading');
    document.body.append(panel);
    const orbit = panel.firstElementChild;
    const updateStatus = panel.lastElementChild;
    const update = frame.querySelector('.horizon-window-update');
    const updateLabel = update.lastElementChild;
    let version;
    let updating = false;
    function paintUpdate(label, message) {
      updateLabel.textContent = label;
      update.title = message;
      update.setAttribute('aria-label', message);
    }
    async function check() {
      if (updating) return;
      try {
        const available = await invoke('desktop_update_version');
        if (updating) return;
        version = available;
        update.hidden = !version;
        if (version) paintUpdate('Update', 'Install Horizon ' + version + ' and restart');
      } catch {
        if (!updating) update.hidden = true;
      }
    }
    addEventListener('horizon-update-progress', ({ detail }) => {
      const { phase, percent } = detail || {};
      if (!updating || !Number.isInteger(percent) || percent < 0 || percent > 100) return;
      const phases = {
        download: ['Downloading', 'Downloading the update'],
        unpack: ['Unpacking', 'Unpacking the verified update'],
        restart: ['Restarting…', 'Restarting Horizon…'],
      };
      if (!Object.hasOwn(phases, phase)) return;
      const [label, message] = phases[phase];
      orbit.style.setProperty('--orbit-progress', percent + '%');
      orbit.setAttribute('aria-label', message);
      if (phase === 'restart') orbit.removeAttribute('aria-valuenow');
      else orbit.setAttribute('aria-valuenow', percent);
      if (updateStatus.textContent !== message) updateStatus.textContent = message;
      paintUpdate(phase === 'restart' ? label : label + ' ' + percent + '%', message);
    });
    update.addEventListener('click', async () => {
      if (!version || updating) return;
      updating = update.disabled = true;
      panel.hidden = false;
      orbit.style.setProperty('--orbit-progress', '0%');
      orbit.setAttribute('aria-valuenow', '0');
      updateStatus.textContent = 'Downloading Horizon ' + version + '…';
      paintUpdate('Downloading…', 'Downloading the Horizon update');
      try {
        await invoke('desktop_install_update', { available: version });
      } catch (error) {
        updating = update.disabled = false;
        panel.hidden = true;
        paintUpdate('Retry update', 'Retry Horizon update');
        alert(typeof error === 'string' ? error : 'Horizon could not complete the update. Try again.');
        update.focus();
      }
    });
    void check();
    setInterval(check, 6 * 60 * 60 * 1000);
  }, { once: true });
})();
