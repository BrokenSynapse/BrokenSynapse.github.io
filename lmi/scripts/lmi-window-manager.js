(function(){
  let z=20;
  function clamp(v,min,max){return Math.max(min,Math.min(max,v));}
  function openWindow(app){
    const host=document.getElementById('windowLayer');
    let existing=host.querySelector(`.lmi-window[data-app="${app.id}"]`);
    if(existing){ existing.classList.remove('minimized'); focusWindow(existing); return existing; }
    const win=document.createElement('section');
    win.className='lmi-window'; win.dataset.app=app.id;
    const layout=window.LMI_DESKTOP?.getSavedWindow(app.id)||{};
    const w=layout.w||app.w||900,h=layout.h||app.h||620,x=layout.x||app.x||80,y=layout.y||app.y||70;
    Object.assign(win.style,{width:w+'px',height:h+'px',left:x+'px',top:y+'px',zIndex:++z});
    win.innerHTML=`<div class="win-titlebar"><div class="win-title"><span class="win-icon">${app.icon||'□'}</span>${app.title||app.name}</div><div class="win-controls"><button data-act="min">_</button><button data-act="max">□</button><button data-act="close">×</button></div></div><iframe class="win-frame" src="${app.path}" title="${app.name}"></iframe><div class="resize-handle"></div>`;
    host.appendChild(win); const fr=win.querySelector('.win-frame'); fr.addEventListener('load',()=>{try{const vars=JSON.parse(localStorage.getItem('LMI_THEME_VARS')||'{}'); fr.contentWindow?.postMessage({type:'LMI_THEME_PATCH',vars},location.origin)}catch{}}); makeInteractive(win,app); addTask(app,win); focusWindow(win); return win;
  }
  function focusWindow(win){ win.style.zIndex=++z; document.querySelectorAll('.task-btn').forEach(b=>b.classList.toggle('active',b.dataset.app===win.dataset.app)); }
  function addTask(app,win){
    const group=document.getElementById('taskGroup'); let btn=group.querySelector(`[data-app="${app.id}"]`);
    if(!btn){ btn=document.createElement('button'); btn.className='task-btn'; btn.dataset.app=app.id; btn.innerHTML=`<span>${app.icon||'□'}</span> ${app.name}`; group.appendChild(btn); btn.onclick=()=>{ win.classList.toggle('minimized'); if(!win.classList.contains('minimized')) focusWindow(win); }; }
  }
  function removeTask(id){ const b=document.querySelector(`.task-btn[data-app="${id}"]`); if(b)b.remove(); }
  function makeInteractive(win,app){
    const bar=win.querySelector('.win-titlebar'), handle=win.querySelector('.resize-handle');
    bar.addEventListener('mousedown',e=>{ if(e.target.closest('button'))return; focusWindow(win); let sx=e.clientX,sy=e.clientY,r=win.getBoundingClientRect(); function move(ev){ win.style.left=clamp(r.left+ev.clientX-sx,0,window.innerWidth-80)+'px'; win.style.top=clamp(r.top+ev.clientY-sy,46,window.innerHeight-45)+'px'; } function up(){ document.removeEventListener('mousemove',move); document.removeEventListener('mouseup',up); save(app,win);} document.addEventListener('mousemove',move); document.addEventListener('mouseup',up); });
    handle.addEventListener('mousedown',e=>{ focusWindow(win); let sx=e.clientX,sy=e.clientY,r=win.getBoundingClientRect(); function move(ev){ win.style.width=Math.max(420,r.width+ev.clientX-sx)+'px'; win.style.height=Math.max(280,r.height+ev.clientY-sy)+'px'; } function up(){ document.removeEventListener('mousemove',move); document.removeEventListener('mouseup',up); save(app,win);} document.addEventListener('mousemove',move); document.addEventListener('mouseup',up); e.preventDefault(); });
    win.addEventListener('mousedown',()=>focusWindow(win));
    win.querySelector('[data-act="close"]').onclick=()=>{save(app,win); removeTask(app.id); win.remove();};
    win.querySelector('[data-act="min"]').onclick=()=>win.classList.add('minimized');
    win.querySelector('[data-act="max"]').onclick=()=>{ if(win.classList.toggle('maxed')){win.dataset.old=JSON.stringify({left:win.style.left,top:win.style.top,width:win.style.width,height:win.style.height}); Object.assign(win.style,{left:'0px',top:'46px',width:'100vw',height:'calc(100vh - 82px)'});}else{try{Object.assign(win.style,JSON.parse(win.dataset.old||'{}'))}catch{}} };
  }
  function save(app,win){ window.LMI_DESKTOP?.saveWindow(app.id,{x:parseInt(win.style.left)||0,y:parseInt(win.style.top)||0,w:parseInt(win.style.width)||app.w,h:parseInt(win.style.height)||app.h}); }
  window.LMI_WM={openWindow,focusWindow};
})();
