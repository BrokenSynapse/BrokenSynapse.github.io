
(function(){
 const $=id=>document.getElementById(id);
 function setStatus(msg,cls=''){const el=$('loginStatus'); if(el){el.textContent=msg; el.className='status '+cls;}}
 function showLogin(){ $('loginScreen').classList.remove('hidden'); $('desktop').classList.add('hidden'); }
 function showDesktop(user){ $('loginScreen').classList.add('hidden'); $('desktop').classList.remove('hidden'); $('desktopUser').innerHTML=`Operator: <strong>${escapeHtml(user.id||user.username||'Unknown')}</strong> / ${escapeHtml(user.access||'User')}`; renderIcons(user); }
 function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
 function allowedModules(user){
   const flags=String(user.flags||'').toLowerCase();
   const all=window.LMI_CONFIG.modules;
   if(!flags || /all|admin|\*/.test(flags) || /admin/i.test(user.access||'')) return all;
   const tokens=flags.split(/[,;\s|]+/).filter(Boolean);
   return all.filter(m=>tokens.includes(m.id.toLowerCase()) || tokens.includes(m.name.toLowerCase()));
 }
 function renderIcons(user){
   const grid=$('iconGrid'); grid.innerHTML='';
   allowedModules(user).forEach(app=>{const b=document.createElement('button'); b.className='desktop-icon'; b.dataset.app=app.id; b.innerHTML=`<span class="glyph">${escapeHtml(app.icon||'□')}</span><span class="name">${escapeHtml(app.name)}</span>`; b.title=app.desc||app.name; b.addEventListener('dblclick',()=>window.LMI_WINDOWS.create(app)); b.addEventListener('click',()=>{ if(matchMedia('(max-width:760px)').matches) window.LMI_WINDOWS.create(app); }); grid.appendChild(b);});
 }
 async function attemptLogin(){
   const tag=$('loginTag').value, hash=$('loginHash').value;
   if(!tag||!hash){setStatus('Enter employee tag and hash.','bad');return;}
   try{setStatus('Reading credential sheet...'); const user=await window.LMI_AUTH.login(tag,hash); setStatus('Credential accepted.','good'); showDesktop(user);}catch(e){setStatus(e.message||String(e),'bad');}
 }
 function init(){
   $('loginButton').addEventListener('click',attemptLogin); $('logoutButton').addEventListener('click',()=>window.LMI_AUTH.logout());
   ['loginTag','loginHash'].forEach(id=>$(id).addEventListener('keydown',e=>{if(e.key==='Enter')attemptLogin();}));
   const user=window.LMI_AUTH.currentUser(); if(user) showDesktop(user); else showLogin();
   window.addEventListener('message',e=>{const d=e.data||{}; if(d.type==='LMI_REQUEST_CONTEXT'){e.source?.postMessage({type:'LMI_CONTEXT',user:window.LMI_AUTH.currentUser(),config:window.LMI_CONFIG},'*');}});
 }
 document.addEventListener('DOMContentLoaded',init);
})();
