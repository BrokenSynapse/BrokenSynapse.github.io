(function(){
  const key=window.LMI_CONFIG.localKeys.user;
  function loadLastUser(){ try{return JSON.parse(localStorage.getItem(key)||'null')}catch{return null} }
  function saveLastUser(user){ localStorage.setItem(key,JSON.stringify(user||{})); }
  async function login(tag,hash){
    tag=String(tag||'').trim(); hash=String(hash||'').trim();
    if(!tag||!hash) throw new Error('Employee tag and hash required.');
    const relay=window.LMI_API.getRelayUrl();
    if(relay){
      const data=await window.LMI_API.callRelay('login',{tag,hash},null).catch(err=>({ok:false,error:String(err.message||err)}));
      if(data && data.ok===false) throw new Error(data.error||data.message||'Relay rejected credentials.');
      const user=(data&&data.user)||{tag,displayName:tag,access:'Operator'};
      user.tag=user.tag||tag; user.displayName=user.displayName||tag;
      saveLastUser(user); return {ok:true,user,session:(data&&data.session)||{mode:'relay'}};
    }
    const user={tag,displayName:tag,access:'Offline / Local'};
    saveLastUser(user); return {ok:true,user,session:{mode:'offline'}};
  }
  window.LMI_AUTH={login,loadLastUser,saveLastUser};
})();
