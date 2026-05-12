
(function(){
 let z=100, windows=new Map();
 function clamp(n,min,max){return Math.max(min,Math.min(max,n));}
 function create(app){
   if(windows.has(app.id)){focus(app.id); restore(app.id); return windows.get(app.id);}
   const desk=document.getElementById('desktopArea');
   const win=document.createElement('div'); win.className='lmi-window'; win.dataset.app=app.id;
   const w=clamp(app.w||900,330,innerWidth-20), h=clamp(app.h||650,240,innerHeight-80);
   const x=clamp(80+windows.size*34,0,innerWidth-w-10), y=clamp(72+windows.size*28,48,innerHeight-h-42);
   Object.assign(win.style,{left:x+'px',top:y+'px',width:w+'px',height:h+'px',zIndex:++z});
   win.innerHTML=`<div class="window-titlebar"><div class="window-title">${app.name}</div><div class="window-controls"><button data-act="min" title="Minimize">_</button><button data-act="max" title="Maximize">□</button><button data-act="close" title="Close">×</button></div></div><div class="window-body"><iframe src="${app.path}" title="${app.name}" loading="eager"></iframe></div><div class="resize-handle"></div>`;
   desk.appendChild(win); windows.set(app.id,win); wire(win,app); addTask(app); focus(app.id); return win;
 }
 function wire(win,app){
   win.addEventListener('pointerdown',()=>focus(app.id));
   const bar=win.querySelector('.window-titlebar'); let drag=null;
   bar.addEventListener('pointerdown',e=>{ if(e.target.tagName==='BUTTON') return; drag={sx:e.clientX,sy:e.clientY,l:win.offsetLeft,t:win.offsetTop}; bar.setPointerCapture(e.pointerId); });
   bar.addEventListener('pointermove',e=>{ if(!drag||win.classList.contains('maximized'))return; win.style.left=clamp(drag.l+e.clientX-drag.sx,0,innerWidth-80)+'px'; win.style.top=clamp(drag.t+e.clientY-drag.sy,48,innerHeight-80)+'px'; });
   bar.addEventListener('pointerup',()=>drag=null); bar.addEventListener('pointercancel',()=>drag=null);
   win.querySelector('.window-controls').addEventListener('click',e=>{const a=e.target.dataset.act; if(a==='close') close(app.id); if(a==='min') minimize(app.id); if(a==='max') maximize(app.id);});
   const handle=win.querySelector('.resize-handle'); let rs=null;
   handle.addEventListener('pointerdown',e=>{rs={sx:e.clientX,sy:e.clientY,w:win.offsetWidth,h:win.offsetHeight}; handle.setPointerCapture(e.pointerId); e.preventDefault();});
   handle.addEventListener('pointermove',e=>{if(!rs||win.classList.contains('maximized'))return; win.style.width=clamp(rs.w+e.clientX-rs.sx,330,innerWidth-win.offsetLeft)+'px'; win.style.height=clamp(rs.h+e.clientY-rs.sy,240,innerHeight-win.offsetTop-42)+'px';});
   handle.addEventListener('pointerup',()=>rs=null); handle.addEventListener('pointercancel',()=>rs=null);
 }
 function focus(id){const win=windows.get(id); if(!win)return; win.style.zIndex=++z; document.querySelectorAll('.task-btn').forEach(b=>b.classList.toggle('active',b.dataset.app===id));}
 function minimize(id){const win=windows.get(id); if(win) win.classList.add('hidden');}
 function restore(id){const win=windows.get(id); if(win){win.classList.remove('hidden'); focus(id);}}
 function maximize(id){const win=windows.get(id); if(win){win.classList.toggle('maximized'); focus(id);}}
 function close(id){const win=windows.get(id); if(win){win.remove(); windows.delete(id);} const t=document.querySelector(`.task-btn[data-app="${id}"]`); if(t)t.remove();}
 function addTask(app){const items=document.getElementById('taskItems'); const b=document.createElement('button'); b.className='task-btn'; b.dataset.app=app.id; b.textContent=app.name; b.onclick=()=>{const w=windows.get(app.id); if(!w)return; w.classList.contains('hidden')?restore(app.id):focus(app.id)}; items.appendChild(b);}
 window.LMI_WINDOWS={create,focus,minimize,restore,maximize,close};
})();
