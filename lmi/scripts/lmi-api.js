(function(){
  function getRelayUrl(){ return localStorage.getItem(window.LMI_CONFIG.localKeys.relayUrl)||''; }
  function setRelayUrl(url){ localStorage.setItem(window.LMI_CONFIG.localKeys.relayUrl,String(url||'').trim()); localStorage.setItem(window.LMI_CONFIG.localKeys.relaySavedAt,new Date().toISOString()); }
  function forgetRelayUrl(){ localStorage.removeItem(window.LMI_CONFIG.localKeys.relayUrl); localStorage.removeItem(window.LMI_CONFIG.localKeys.relaySavedAt); }
  function isAllowedRelayUrl(url){ try{ const u=new URL(url); return u.protocol==='https:' && (u.hostname==='script.google.com'||u.hostname==='script.googleusercontent.com') && u.pathname.includes('/macros/'); }catch(e){ return false; } }
  async function callRelay(action,payload,user){
    const relayUrl=getRelayUrl();
    if(!relayUrl) throw new Error('No LMI relay link saved in this browser.');
    const res=await fetch(relayUrl,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action,payload:payload||{},user:user||window.LMI_RUNTIME?.user||null,client:'LMI'})});
    const txt=await res.text();
    try{return JSON.parse(txt)}catch(e){return {ok:res.ok,text:txt,status:res.status}}
  }
  window.LMI_API={getRelayUrl,setRelayUrl,forgetRelayUrl,isAllowedRelayUrl,callRelay};
})();
