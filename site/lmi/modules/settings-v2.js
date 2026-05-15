(function(){
  const THEME_KEYS = ['--bg','--panel','--panel2','--text','--muted','--line','--line2','--accent','--accent2','--good','--bad','--warn'];

  const DEFAULT_THEME = {
    '--bg':'#020104',
    '--panel':'#08050d',
    '--panel2':'#12091f',
    '--text':'#ffffff',
    '--muted':'#b8a8d6',
    '--line':'#8d54ff',
    '--line2':'#5b2ea6',
    '--accent':'#a45cff',
    '--accent2':'#7b35e8',
    '--good':'#88ffbd',
    '--bad':'#ff6b9a',
    '--warn':'#ffd36b'
  };

  const $ = id => document.getElementById(id);

  let state = {
    user:null,
    options:{ occupations:[], currencies:[], accessLevels:[], statuses:[] },
    testAudio:null
  };

  function parse(v){
    if(!v) return null;
    if(typeof v === 'object') return v;
    try{return JSON.parse(v);}catch{return null;}
  }

  function currentUserHint(){
    try{
      // Most important: use the real desktop runtime user. It has the correct cid.
      return parent.window.LMI_RUNTIME?.user ||
        parent.window.LMI_USER ||
        parent.window.currentUser ||
        parent.window.sessionUser ||
        parse(parent.sessionStorage.getItem('LMI_CURRENT_USER')) ||
        parse(parent.sessionStorage.getItem('LMI_SESSION'))?.user ||
        parse(parent.localStorage.getItem('LMI_LAST_USER'));
    }catch{
      return parse(sessionStorage.getItem('LMI_CURRENT_USER')) || parse(sessionStorage.getItem('LMI_SESSION'))?.user;
    }
  }

  async function relay(action, payload={}){
    const user = currentUserHint() || state.user || {};

    try{
      if(parent.window.LMI_API?.callRelay){
        return await parent.window.LMI_API.callRelay(action, payload, user);
      }
    }catch{}

    // Translate old Settings-only actions to real LMI relay actions before fetch().
    // Nothing should hit /api/relay as getCurrentAccount/updateCurrentAccount.
    if (action === 'getCurrentAccount') {
      action = 'user.profile.get';
      payload = {};
    }

    if (action === 'updateCurrentAccount') {
      const patch = payload && payload.patch && typeof payload.patch === 'object'
        ? payload.patch
        : (payload || {});

      const incomingPrefs = patch.shellPrefs || patch.prefs || patch.desktopPrefs;

      if (incomingPrefs !== undefined) {
        action = 'user.shell.save';
        payload = { prefs: incomingPrefs };
      } else {
        action = 'user.profile.save';
        payload = patch;
      }
    }

    const res = await fetch('/api/relay', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ action, payload, user })
    });

    return res.json();
  }

  function normalizePath(src){
    try{
      return parent.window.LMI_NORMALIZE_ASSET_URL
        ? parent.window.LMI_NORMALIZE_ASSET_URL(src)
        : String(src || '').trim();
    }catch{
      return String(src || '').trim();
    }
  }

  function setStatus(id,msg,good=true){
    const el = $(id);
    if(!el) return;
    el.textContent = msg || '';
    el.style.color = good ? 'var(--good,#88ffbd)' : 'var(--bad,#ff6b9a)';
  }

  function fillSelect(sel, values, current){
    sel.innerHTML = '';
    values = [...new Set((values || []).filter(Boolean))];

    if(current && !values.includes(current)) values.unshift(current);

    values.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      sel.appendChild(opt);
    });

    if(current) sel.value = current;
  }

  function normalizeTheme(vars){
    const out = {};
    vars = vars || {};

    for(const k of THEME_KEYS){
      out[k] = String(vars[k] || DEFAULT_THEME[k] || '').trim();
    }

    return out;
  }

  function applyTheme(vars){
    vars = normalizeTheme(vars);

    const docs = [document];

    try{
      if(parent.document && parent.document !== document) docs.push(parent.document);
    }catch{}

    for(const doc of docs){
      for(const [k,v] of Object.entries(vars)){
        doc.documentElement.style.setProperty(k,v);
        doc.body?.style.setProperty(k,v);
      }
    }

    try{
      parent.localStorage.setItem('LMI_THEME_VARS', JSON.stringify(vars));
      parent.sessionStorage.setItem('LMI_ACTIVE_ACCOUNT_THEME', JSON.stringify(vars));
    }catch{}

    return vars;
  }

  function readThemeInputs(){
    const vars = {};

    for(const key of THEME_KEYS){
      vars[key] = $(`theme_${key.slice(2)}`)?.value || DEFAULT_THEME[key];
    }

    return normalizeTheme(vars);
  }

  function writeThemeInputs(vars){
    vars = normalizeTheme(vars);

    for(const key of THEME_KEYS){
      const text = $(`theme_${key.slice(2)}`);
      const color = $(`theme_color_${key.slice(2)}`);

      if(text) text.value = vars[key];
      if(color && /^#[0-9a-f]{6}$/i.test(vars[key])) color.value = vars[key];
    }
  }

  function renderThemeGrid(){
    const grid = $('themeGrid');
    grid.innerHTML = '';

    for(const key of THEME_KEYS){
      const wrap = document.createElement('div');
      wrap.className = 'sv2-theme-var';

      wrap.innerHTML = `
        <label>${key}</label>
        <div class="row">
          <input type="color" id="theme_color_${key.slice(2)}">
          <input id="theme_${key.slice(2)}">
        </div>
      `;

      grid.appendChild(wrap);
    }

    for(const key of THEME_KEYS){
      const text = $(`theme_${key.slice(2)}`);
      const color = $(`theme_color_${key.slice(2)}`);

      text.addEventListener('input', () => {
        if(/^#[0-9a-f]{6}$/i.test(text.value) && color) color.value = text.value;
        applyTheme(readThemeInputs());
      });

      color.addEventListener('input', () => {
        text.value = color.value;
        applyTheme(readThemeInputs());
      });
    }
  }

  function prefs(){
    state.user.shellPrefs = state.user.shellPrefs || {};
    return state.user.shellPrefs;
  }

  function syncParentUser(){
    try{
      parent.window.LMI_USER = state.user;
      parent.window.currentUser = state.user;
      parent.window.sessionUser = state.user;
      parent.sessionStorage.setItem('LMI_CURRENT_USER', JSON.stringify(state.user));
      const sess = parse(parent.sessionStorage.getItem('LMI_SESSION')) || {};
      sess.user = state.user;
      parent.sessionStorage.setItem('LMI_SESSION', JSON.stringify(sess));
      parent.localStorage.setItem('LMI_LAST_USER', JSON.stringify(state.user));
    }catch{}
  }

  function paintAccount(){
    const u = state.user;
    $('displayNameInput').value = u.displayName || '';
    $('tagInput').value = u.tag || '';
    $('hashInput').value = u.hash || '';
    $('bankIdInput').value = u.bankAccountId || '';

    fillSelect($('accessSelect'), state.options.accessLevels || ['Admin','User','Guest'], u.access || 'User');
    fillSelect($('statusSelect'), state.options.statuses || ['Active'], u.status || 'Active');
    fillSelect($('occupationSelect'), state.options.occupations || ['Unemployed'], u.occupation || '');
    fillSelect($('currencySelect'), state.options.currencies || ['LSD','CRED','USD'], u.currency || '');

    $('avatarInput').value = u.avatar || '';
    $('wallpaperInput').value = u.wallpaper || '';
    updateWallpaperPreview();

    const p = prefs();
    $('ambienceSrcInput').value = p.ambienceSrc || '';
    $('ambienceEnabledInput').checked = !!p.ambienceEnabled;
    $('ambienceVolumeInput').value = Math.round(Number(p.ambienceVolume ?? 0.05) * 100);
    updateAmbienceVolumeLabel();

    writeThemeInputs(p.themeVars || DEFAULT_THEME);
    applyTheme(p.themeVars || DEFAULT_THEME);

    const name = u.displayName || u.tag || 'Unknown';
    $('sv2UserLine').textContent = `${name} / ${u.access || 'User'}`;

    const av = normalizePath(u.avatar || '');
    const avBox = $('sv2Avatar');
    avBox.textContent = av ? '' : 'ID';
    avBox.style.backgroundImage = av ? `url("${av}")` : '';
  }

  function accountPatch(){
    return {
      displayName:$('displayNameInput').value.trim(),
      tag:$('tagInput').value.trim(),
      hash:$('hashInput').value,
      bankAccountId:$('bankIdInput').value.trim(),
      access:$('accessSelect').value,
      status:$('statusSelect').value,
      occupation:$('occupationSelect').value,
      currency:$('currencySelect').value
    };
  }

  async function saveAccount(){
    const data = await relay('user.profile.save', accountPatch());
    if(!data.ok) return alert(data.error || 'Save failed.');

    state.user = Object.assign({}, state.user || {}, data.data.user || {});
    syncParentUser();
    paintAccount();
  }

  function updateWallpaperPreview(){
    const src = normalizePath($('wallpaperInput').value);
    $('wallpaperPreview').style.backgroundImage = src ? `url("${src}")` : '';
  }

  function wallpaperPatch(){
    return {
      avatar: $('avatarInput').value.trim(),
      wallpaper: $('wallpaperInput').value.trim()
    };
  }

  function liveWallpaper(){
    const wp = normalizePath($('wallpaperInput').value);
    try{
      if(wp){
        parent.document.body.style.backgroundImage = `url("${wp}")`;
        parent.document.body.style.backgroundSize = 'cover';
        parent.document.body.style.backgroundPosition = 'center';
      }
    }catch{}
  }

  async function savePersonalization(extraPrefs={}){
    const p = Object.assign({}, prefs(), extraPrefs);

    const profile = await relay('user.profile.save', {
      avatar:$('avatarInput').value.trim(),
      wallpaper:$('wallpaperInput').value.trim()
    });
    if(!profile.ok) return alert(profile.error || 'Profile save failed.');

    const shell = await relay('user.shell.save', { prefs:p });
    if(!shell.ok) return alert(shell.error || 'Shell prefs save failed.');

    state.user = Object.assign({}, state.user || {}, profile.data.user || {});
    state.user.shellPrefs = shell.data.shellPrefs || shell.data.prefs || p;

    syncParentUser();

    try{
      parent.window.LMI_DESKTOP?.previewShellPrefs?.(state.user.shellPrefs);
      parent.window.postMessage({type:'LMI_SET_WALLPAPER', wallpaper:state.user.wallpaper || state.user.wp || ''}, location.origin);
    }catch{}

    paintAccount();
  }

  function ambiencePrefsFromUi(){
    const vol = Number($('ambienceVolumeInput').value || 5) / 100;

    return {
      ambienceSrc: normalizePath($('ambienceSrcInput').value),
      ambienceEnabled: $('ambienceEnabledInput').checked,
      ambienceVolume: Math.max(0, Math.min(1, vol))
    };
  }

  function updateAmbienceVolumeLabel(){
    $('ambienceVolumeLabel').textContent = `${$('ambienceVolumeInput').value}%`;
  }

  function liveAmbienceUpdate(){
    Object.assign(prefs(), ambiencePrefsFromUi());
    syncParentUser();

    try{
      parent.window.LMIAmbience?.refresh?.('settings-v2 live');
      parent.window.LMIAmbience?.updateTray?.();
    }catch{}
  }

  async function testAmbience(){
    const ap = ambiencePrefsFromUi();

    if(!ap.ambienceSrc){
      setStatus('ambienceStatus','No ambience path set.',false);
      return;
    }

    try{ parent.window.LMIAmbience?.stop?.('settings-v2 test'); }catch{}

    if(state.testAudio){
      state.testAudio.pause();
      state.testAudio = null;
    }

    state.testAudio = new Audio(ap.ambienceSrc);
    state.testAudio.loop = true;
    state.testAudio.volume = ap.ambienceVolume;

    try{
      await state.testAudio.play();
      setStatus('ambienceStatus','Testing ambience.',true);
    }catch(e){
      setStatus('ambienceStatus','Browser blocked audio until another click/key.',false);
    }
  }

  function stopLocalAmbience(){
    if(state.testAudio){
      state.testAudio.pause();
      state.testAudio = null;
    }
    liveAmbienceUpdate();
    setStatus('ambienceStatus','Stopped local test.',true);
  }

  async function saveAmbience(){
    if(state.testAudio){
      state.testAudio.pause();
      state.testAudio = null;
    }

    const ap = ambiencePrefsFromUi();
    Object.assign(prefs(), ap);
    await savePersonalization(prefs());

    try{ parent.window.LMIAmbience?.refresh?.('settings-v2 save'); }catch{}
    setStatus('ambienceStatus','Saved ambience.',true);
  }

  function desktopPrefsFromUi(){
    return {
      iconSize: Number($('iconSizeInput').value || 72),
      gridSnap: $('gridSnapInput').checked,
      hiddenTaskbar: $('hideTaskbarInput').checked,
      iconPack: $('iconPackSelect').value || 'default'
    };
  }

  function applyDesktopPrefs(){
    const p = Object.assign({}, prefs(), desktopPrefsFromUi());
    state.user.shellPrefs = p;

    try{
      parent.window.LMIShellPrefs = Object.assign(parent.window.LMIShellPrefs || {}, p);

      // Let the desktop runtime calculate all tile/font/grid variables.
      // Do not fight it with separate CSS writes here.
      if(parent.window.LMI_DESKTOP?.previewShellPrefs){
        parent.window.LMI_DESKTOP.previewShellPrefs(p);
      }else{
        parent.document.documentElement.style.setProperty('--lmi-icon-size', `${p.iconSize}px`);
      }

      parent.document.body.dataset.gridSnap = p.gridSnap ? 'on' : 'off';
      parent.document.body.dataset.hiddenTaskbar = p.hiddenTaskbar ? '1' : '0';
      parent.document.body.dataset.iconPack = p.iconPack || 'default';
    }catch{}

    $('iconSizeLabel').textContent = p.iconSize;
  }

  async function saveDesktop(){
    const p = Object.assign({}, prefs(), desktopPrefsFromUi());
    state.user.shellPrefs = p;

    try{ await parent.window.LMI_DESKTOP?.saveCurrentIconLayout?.(); }catch{}

    applyDesktopPrefs();

    const shell = await relay('user.shell.save', { prefs:p });
    if(!shell.ok) return alert(shell.error || 'Desktop save failed.');

    const savedPrefs = shell.data?.shellPrefs || shell.data?.prefs || p;
    state.user.shellPrefs = savedPrefs;

    try{
      if(parent.window.LMI_RUNTIME?.user) parent.window.LMI_RUNTIME.user.shellPrefs = savedPrefs;
      parent.window.LMI_USER = Object.assign({}, parent.window.LMI_RUNTIME?.user || state.user, { shellPrefs:savedPrefs });
      parent.window.currentUser = parent.window.LMI_USER;
      parent.window.sessionUser = parent.window.LMI_USER;
      parent.sessionStorage.setItem('LMI_CURRENT_USER', JSON.stringify(parent.window.LMI_USER));
      parent.localStorage.setItem('LMI_LAST_USER', JSON.stringify(parent.window.LMI_USER));
      parent.window.LMI_DESKTOP?.previewShellPrefs?.(savedPrefs);
      parent.window.LMI_DESKTOP?.refreshApps?.();
      await parent.window.LMI_DESKTOP?.saveCurrentIconLayout?.();
      await parent.window.LMI_DESKTOP?.flushLayoutSaves?.();
    }catch{}

    syncParentUser();
    paintDesktop();
  }

  function paintDesktop(){
    const p = prefs();

    $('iconSizeInput').value = Number(p.iconSize ?? 72);
    $('iconSizeLabel').textContent = $('iconSizeInput').value;
    $('gridSnapInput').checked = p.gridSnap !== false;
    $('hideTaskbarInput').checked = !!p.hiddenTaskbar;

    fillSelect($('iconPackSelect'), ['default'], p.iconPack || 'default');
  }

  function refreshState(){
    const out = {
      user: state.user,
      shellPrefs: prefs(),
      localTheme: parse(parent.localStorage.getItem('LMI_THEME_VARS')),
      ambience: parent.window.LMIAmbience?.status || null
    };

    $('statePre').textContent = JSON.stringify(out,null,2);
  }

  function bind(){
    document.querySelectorAll('.sv2-tabs button').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sv2-tabs button').forEach(b => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.sv2-page').forEach(p => p.classList.toggle('active', p.dataset.page === btn.dataset.page));
        if(btn.dataset.page === 'state') refreshState();
      });
    });

    $('saveAccountBtn').onclick = saveAccount;

    $('previewWallpaperBtn').onclick = () => { updateWallpaperPreview(); liveWallpaper(); };
    $('saveWallpaperBtn').onclick = () => savePersonalization(wallpaperPatch());
    $('clearWallpaperBtn').onclick = () => {
      $('wallpaperInput').value = '';
      updateWallpaperPreview();
      liveWallpaper();
    };
    $('savePersonalizationBtn').onclick = () => savePersonalization(Object.assign({}, prefs(), { themeVars:readThemeInputs() }, ambiencePrefsFromUi()));

    $('wallpaperInput').addEventListener('input', updateWallpaperPreview);
    $('avatarInput').addEventListener('input', () => {});

    $('ambienceVolumeInput').addEventListener('input', () => { updateAmbienceVolumeLabel(); liveAmbienceUpdate(); });
    $('ambienceEnabledInput').addEventListener('change', liveAmbienceUpdate);
    $('ambienceSrcInput').addEventListener('change', liveAmbienceUpdate);

    $('testAmbienceBtn').onclick = testAmbience;
    $('stopAmbienceBtn').onclick = stopLocalAmbience;
    $('saveAmbienceBtn').onclick = saveAmbience;

    $('applyThemeBtn').onclick = () => applyTheme(readThemeInputs());
    $('resetThemeBtn').onclick = () => { writeThemeInputs(DEFAULT_THEME); applyTheme(DEFAULT_THEME); };
    $('saveThemeBtn').onclick = () => savePersonalization(Object.assign({}, prefs(), { themeVars:readThemeInputs() }));

    $('iconSizeInput').addEventListener('input', applyDesktopPrefs);
    $('gridSnapInput').addEventListener('change', applyDesktopPrefs);
    $('hideTaskbarInput').addEventListener('change', applyDesktopPrefs);
    $('iconPackSelect').addEventListener('change', applyDesktopPrefs);
    $('saveDesktopBtn').onclick = saveDesktop;

    $('refreshStateBtn').onclick = refreshState;
  }

  async function boot(){
    renderThemeGrid();
    bind();

    const opts = await relay('listAccountOptions', {});
    if(opts.ok) state.options = opts.data || {};

    const account = await relay('user.profile.get', {});
    if(!account.ok){
      document.body.innerHTML = `<pre>${account.error || 'Unable to load account.'}</pre>`;
      return;
    }

    state.user = account.data.user || {};
    const shell = await relay('user.shell.get', {});
    if(shell.ok){
      state.user.shellPrefs = shell.data.shellPrefs || shell.data.prefs || state.user.shellPrefs || {};
    }
    syncParentUser();
    paintAccount();
    paintDesktop();
    applyDesktopPrefs();
  }

  boot();
})();
