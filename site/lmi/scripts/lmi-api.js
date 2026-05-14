(function(){
  const DEFAULT_RELAY = '/api/relay';
  function normalizeRelayUrl(url){
    url=String(url||'').trim();
    if(!url) return DEFAULT_RELAY;
    return url;
  }
  function getRelayUrl(){ return normalizeRelayUrl(localStorage.getItem(window.LMI_CONFIG.localKeys.relayUrl)||DEFAULT_RELAY); }
  function setRelayUrl(url){ localStorage.setItem(window.LMI_CONFIG.localKeys.relayUrl,normalizeRelayUrl(url)); localStorage.setItem(window.LMI_CONFIG.localKeys.relaySavedAt,new Date().toISOString()); }
  function forgetRelayUrl(){ localStorage.removeItem(window.LMI_CONFIG.localKeys.relayUrl); localStorage.removeItem(window.LMI_CONFIG.localKeys.relaySavedAt); }
  function isAllowedRelayUrl(relayUrl){
  if(!relayUrl) return false;

  const raw = String(relayUrl).trim();

  // Preferred VM/local API forms.
  if(raw === '/api/relay') return true;
  if(raw.startsWith('/api/')) return true;

  try {
    const u = new URL(raw, window.location.origin);

    // Allow same-origin VM API.
    if(u.origin === window.location.origin && u.pathname.startsWith('/api/')) return true;

    // Allow the actual BrokenSynapse public API URL.
    if((u.hostname === 'brokensynapse.us' || u.hostname === 'www.brokensynapse.us') && u.pathname.startsWith('/api/')) return true;

    // Legacy Google Apps Script support.
    if(
      u.protocol === 'https:' &&
      (u.hostname === 'script.google.com' || u.hostname === 'script.googleusercontent.com') &&
      u.pathname.includes('/macros/')
    ){
      return true;
    }

    return false;
  } catch {
    return false;
  }
}
  async function callRelay(action,payload,user){
    const relayUrl=getRelayUrl();
    if(!isAllowedRelayUrl(relayUrl)) throw new Error('Relay rejected: expected /api/relay, same-origin /api/*, or a legacy Google Apps Script URL.');
    const res=await fetch(relayUrl,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action,payload:payload||{},user:user||window.LMI_RUNTIME?.user||null,client:'LMI'})});
    const txt=await res.text();
    try{return JSON.parse(txt)}catch(e){return {ok:res.ok,text:txt,status:res.status}}
  }
  window.LMI_API={getRelayUrl,setRelayUrl,forgetRelayUrl,isAllowedRelayUrl,callRelay,DEFAULT_RELAY};
})();
