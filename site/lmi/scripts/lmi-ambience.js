(function(){
  if(window.__LMI_AMBIENCE_PER_ACCOUNT_V3__) return;
  window.__LMI_AMBIENCE_PER_ACCOUNT_V3__ = true;

  const AUDIO_ID = 'lmiAmbienceAudio';
  const STATE_KEY = 'LMI_ACTIVE_AMBIENCE_STATE';

  let lastUserKey = '';
  let lastSrc = '';
  let lastEnabled = null;
  let booted = false;

  function isDesktopRoute(){
    return location.pathname.replace(/\/+$/,'').toLowerCase().endsWith('/lmi/desktop');
  }

  function parse(v){
    if(!v) return null;
    if(typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return null; }
  }

  function getSessionUser(){
    const direct =
      parse(sessionStorage.getItem('LMI_CURRENT_USER')) ||
      parse(sessionStorage.getItem('lmiUser'));

    if(direct?.user) return direct.user;
    if(direct) return direct;

    const session =
      parse(sessionStorage.getItem('LMI_SESSION')) ||
      parse(sessionStorage.getItem('lmiSession'));

    if(session?.user) return session.user;

    // Deliberately do NOT fall back to localStorage.LMI_LAST_USER.
    // That is what causes ambience to bleed across logins.
    return null;
  }

  function normalizeUser(u){
    if(!u) return null;
    return {
      ...u,
      cid: u.cid || u.id || '',
      tag: u.tag || u.employeeTag || '',
      displayName: u.displayName || u.cn || u.name || u.tag || '',
      shellPrefs: u.shellPrefs || {}
    };
  }

  function userKey(user){
    user = normalizeUser(user);
    return String(user?.cid || user?.tag || user?.displayName || '').trim().toLowerCase();
  }

  function normalizePath(src){
    src = String(src || '').trim().replace(/\\/g,'/').replace(/^LMC:\s*/i,'');
    if(!src) return '';

    if(src.startsWith('/assets/')) src = '/lmi' + src;
    if(!src.startsWith('/')){
      src = '/lmi/assets/' + src.replace(/^lmi\/assets\//,'').replace(/^assets\//,'');
    }

    return src.replace(/\/+/g,'/');
  }

  function getPrefs(user){
    user = normalizeUser(user);
    const prefs = user?.shellPrefs || {};

    return {
      ambienceSrc: normalizePath(prefs.ambienceSrc || prefs.ambience || prefs.audio || ''),
      ambienceVolume: Math.max(0, Math.min(1, Number(prefs.ambienceVolume ?? prefs.volume ?? 0.05))),
      ambienceEnabled: !!prefs.ambienceEnabled
    };
  }

  function getAudio(){
    let audio = document.getElementById(AUDIO_ID);

    if(!audio){
      audio = document.createElement('audio');
      audio.id = AUDIO_ID;
      audio.loop = true;
      audio.preload = 'auto';
      audio.style.display = 'none';
      audio.setAttribute('data-lmi-ambience', '1');
      document.body.appendChild(audio);
    }

    return audio;
  }

  function stop(reason=''){
    const audio = document.getElementById(AUDIO_ID);

    if(audio){
      try{
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }catch{}
    }

    lastSrc = '';
    lastEnabled = false;

    try{ sessionStorage.removeItem(STATE_KEY); }catch{}

    updateTray();

    if(reason) console.log('[LMIAmbience] stopped:', reason);
  }

  function mutedKey(user){
    return 'LMI_AMBIENCE_MUTED_' + (userKey(user) || 'unknown');
  }

  function isMuted(user){
    try{
      return sessionStorage.getItem(mutedKey(user)) === '1';
    }catch{
      return false;
    }
  }

  function setMuted(muted){
    const user = normalizeUser(getSessionUser());
    if(!user) return false;

    try{
      sessionStorage.setItem(mutedKey(user), muted ? '1' : '0');
    }catch{}

    const audio = document.getElementById(AUDIO_ID);
    if(audio) audio.muted = !!muted;

    updateTray();
    return !!muted;
  }

  function toggleMute(){
    const user = normalizeUser(getSessionUser());
    if(!user) return false;

    const prefs = getPrefs(user);

    // No track assigned/enabled for this account. Do not fake-unmute silence.
    if(!prefs.ambienceEnabled || !prefs.ambienceSrc){
      updateTray();
      return false;
    }

    return setMuted(!isMuted(user));
  }

  async function playForCurrentUser(reason=''){
    if(!isDesktopRoute()){
      stop('not desktop route');
      return false;
    }

    const user = normalizeUser(getSessionUser());

    if(!user){
      stop('no current session user');
      return false;
    }

    const key = userKey(user);
    const prefs = getPrefs(user);

    // If the user changed, kill old audio first before deciding what this user gets.
    if(lastUserKey && key && key !== lastUserKey){
      stop('user changed');
    }

    lastUserKey = key;

    if(!prefs.ambienceEnabled || !prefs.ambienceSrc){
      stop('ambience disabled or empty for current user');
      updateTray();
      return false;
    }

    const audio = getAudio();
    const muted = isMuted(user);

    if(audio.getAttribute('src') !== prefs.ambienceSrc){
      audio.pause();
      audio.src = prefs.ambienceSrc;
      audio.load();
    }

    audio.volume = prefs.ambienceVolume;
    audio.muted = muted;
    audio.dataset.userKey = key;
    audio.dataset.src = prefs.ambienceSrc;

    lastSrc = prefs.ambienceSrc;
    lastEnabled = true;

    try{
      sessionStorage.setItem(STATE_KEY, JSON.stringify({
        userKey:key,
        src:prefs.ambienceSrc,
        volume:prefs.ambienceVolume,
        enabled:prefs.ambienceEnabled,
        muted,
        at:Date.now()
      }));
    }catch{}

    updateTray();

    try{
      await audio.play();
      console.log('[LMIAmbience] playing:', prefs.ambienceSrc, reason);
      updateTray();
      return true;
    }catch(e){
      // Browser may require first click/key. We arm that below.
      console.warn('[LMIAmbience] play blocked until user gesture:', e.message || e);
      updateTray();
      return false;
    }
  }

  function refresh(reason='refresh'){
    return playForCurrentUser(reason);
  }

  function updateTray(){
    const user = normalizeUser(getSessionUser());
    const audio = document.getElementById(AUDIO_ID);
    const btn = document.getElementById('lmiAmbienceTaskbarButton2') || document.getElementById('lmiAmbienceTaskbarButton');

    if(!btn) return;

    const prefs = getPrefs(user);
    const hasAmbience = !!(prefs.ambienceEnabled && prefs.ambienceSrc);
    const muted = user ? isMuted(user) : false;
    const active = !!(audio && !audio.paused && hasAmbience);

    if(!hasAmbience){
      btn.textContent = '◇';
      btn.title = 'No ambience configured for this account';
      btn.style.opacity = '0.55';
      btn.dataset.active = '0';
      btn.dataset.muted = '0';
      btn.dataset.empty = '1';
      return;
    }

    btn.style.opacity = '1';
    btn.textContent = muted || !active ? '🔇' : '🔊';
    btn.title = muted
      ? 'Ambience muted'
      : active
        ? 'Ambience playing'
        : 'Ambience available; click or press a key to start';

    btn.dataset.active = active ? '1' : '0';
    btn.dataset.muted = muted ? '1' : '0';
    btn.dataset.empty = '0';
  }

  function armAutoplay(){
    const go = () => playForCurrentUser('user gesture');

    document.addEventListener('pointerdown', go, { passive:true });
    document.addEventListener('keydown', go, { passive:true });
  }

  function watchUserChanges(){
    setInterval(() => {
      if(!isDesktopRoute()){
        stop('left desktop');
        return;
      }

      const user = normalizeUser(getSessionUser());
      const key = userKey(user);
      const prefs = getPrefs(user);
      const sig = JSON.stringify({
        key,
        src:prefs.ambienceSrc,
        enabled:prefs.ambienceEnabled,
        volume:prefs.ambienceVolume,
        muted:user ? isMuted(user) : false
      });

      if(watchUserChanges.lastSig !== sig){
        watchUserChanges.lastSig = sig;
        playForCurrentUser('state changed');
      }else{
        updateTray();
      }
    }, 1000);
  }

  window.LMIAmbience = {
    refresh,
    stop,
    toggleMute,
    setMuted,
    isMuted: () => isMuted(getSessionUser()),
    updateTray,
    get status(){
      const audio = document.getElementById(AUDIO_ID);
      const user = normalizeUser(getSessionUser());
      return {
        route: location.pathname,
        userKey: userKey(user),
        prefs: getPrefs(user),
        audioExists: !!audio,
        paused: audio ? audio.paused : true,
        muted: audio ? audio.muted : false,
        src: audio ? audio.getAttribute('src') : '',
        volume: audio ? audio.volume : null
      };
    }
  };

  function boot(){
    if(booted) return;
    booted = true;

    armAutoplay();
    playForCurrentUser('boot');
    watchUserChanges();

    setTimeout(()=>playForCurrentUser('late-250'), 250);
    setTimeout(()=>playForCurrentUser('late-1000'), 1000);
    setTimeout(()=>playForCurrentUser('late-2500'), 2500);
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', boot);
  }else{
    boot();
  }
})();
