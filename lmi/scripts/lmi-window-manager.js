(function(){
  let z=20;
  const MIN_W=420, MIN_H=280;
  function num(v,fb=0){ const n=parseInt(v,10); return Number.isFinite(n)?n:fb; }
  function clamp(v,min,max){ return Math.max(min,Math.min(max,v)); }
  function hostRect(){ const host=document.getElementById('windowLayer'); return host ? host.getBoundingClientRect() : {left:0,top:0,width:window.innerWidth,height:window.innerHeight}; }
  function bounds(){ const r=hostRect(); return {w:r.width||window.innerWidth,h:r.height||window.innerHeight}; }
  function frameShield(on){ document.querySelectorAll('.win-frame').forEach(fr=>{fr.style.pointerEvents=on?'none':'';}); document.body.classList.toggle('resizing-window',!!on); }
  function validRect(rect){
    const b=bounds();
    const w=clamp(num(rect.w,900),MIN_W,Math.max(MIN_W,b.w));
    const h=clamp(num(rect.h,620),MIN_H,Math.max(MIN_H,b.h));
    const x=clamp(num(rect.x,80),0,Math.max(0,b.w-80));
    const y=clamp(num(rect.y,70),0,Math.max(0,b.h-34));
    return {x,y,w,h};
  }
  function applyRect(win,r){ Object.assign(win.style,{left:r.x+'px',top:r.y+'px',width:r.w+'px',height:r.h+'px'}); }
  function rectFromWin(win){ return {x:num(win.style.left),y:num(win.style.top),w:num(win.style.width,win.offsetWidth),h:num(win.style.height,win.offsetHeight)}; }
  function openWindow(app){
    const host=document.getElementById('windowLayer');
    let existing=host.querySelector(`.lmi-window[data-app="${app.id}"]`);
    if(existing){ existing.classList.remove('minimized'); focusWindow(existing); return existing; }
    const win=document.createElement('section');
    win.className='lmi-window'; win.dataset.app=app.id;
    const layout=window.LMI_DESKTOP?.getSavedWindow(app.id)||{};
    const r=validRect({w:layout.w||app.w||900,h:layout.h||app.h||620,x:layout.x??app.x??80,y:layout.y??app.y??70});
    applyRect(win,r); win.style.zIndex=++z;
    win.innerHTML=`<div class="win-titlebar"><div class="win-title"><span class="win-icon">${app.icon||'□'}</span>${app.title||app.name}</div><div class="win-controls"><button data-act="min">_</button><button data-act="max">□</button><button data-act="close">×</button></div></div><iframe class="win-frame" src="${app.path}" title="${app.name}"></iframe><div class="resize-handle n" data-dir="n"></div><div class="resize-handle e" data-dir="e"></div><div class="resize-handle s" data-dir="s"></div><div class="resize-handle w" data-dir="w"></div><div class="resize-handle ne" data-dir="ne"></div><div class="resize-handle nw" data-dir="nw"></div><div class="resize-handle se" data-dir="se"></div><div class="resize-handle sw" data-dir="sw"></div>`;
    host.appendChild(win);
    const fr=win.querySelector('.win-frame');
    fr.addEventListener('load',()=>{try{const vars=JSON.parse(localStorage.getItem('LMI_THEME_VARS')||'{}'); fr.contentWindow?.postMessage({type:'LMI_THEME_PATCH',vars},location.origin)}catch{}});
    makeInteractive(win,app); addTask(app,win); focusWindow(win); return win;
  }
  function focusWindow(win){ win.style.zIndex=++z; document.querySelectorAll('.task-btn').forEach(b=>b.classList.toggle('active',b.dataset.app===win.dataset.app)); }
  function addTask(app,win){
    const group=document.getElementById('taskGroup'); let btn=group.querySelector(`[data-app="${app.id}"]`);
    if(!btn){ btn=document.createElement('button'); btn.className='task-btn'; btn.dataset.app=app.id; btn.innerHTML=`<span>${app.icon||'□'}</span> ${app.name}`; group.appendChild(btn); btn.onclick=()=>{ win.classList.toggle('minimized'); if(!win.classList.contains('minimized')) focusWindow(win); }; }
  }
  function removeTask(id){ const b=document.querySelector(`.task-btn[data-app="${id}"]`); if(b)b.remove(); }

  function edgeDir(win,e){
    const r=win.getBoundingClientRect(); const m=12;
    const left=e.clientX-r.left<=m, right=r.right-e.clientX<=m, top=e.clientY-r.top<=m, bottom=r.bottom-e.clientY<=m;
    if(top&&left) return 'nw'; if(top&&right) return 'ne'; if(bottom&&left) return 'sw'; if(bottom&&right) return 'se';
    if(left) return 'w'; if(right) return 'e'; if(top) return 'n'; if(bottom) return 's'; return '';
  }
  function cursorForDir(dir){ return ({n:'ns-resize',s:'ns-resize',e:'ew-resize',w:'ew-resize',ne:'nesw-resize',sw:'nesw-resize',nw:'nwse-resize',se:'nwse-resize'}[dir]||''); }
  function startResize(win,app,e,dir){
    e.preventDefault(); e.stopPropagation(); focusWindow(win); if(win.classList.contains('maxed')) return;
    const start=rectFromWin(win), sx=e.clientX, sy=e.clientY, b=bounds(); frameShield(true);
    function move(ev){
      const dx=ev.clientX-sx, dy=ev.clientY-sy; let x=start.x,y=start.y,w=start.w,h=start.h;
      if(dir.includes('e')) w=start.w+dx;
      if(dir.includes('s')) h=start.h+dy;
      if(dir.includes('w')){ w=start.w-dx; x=start.x+dx; }
      if(dir.includes('n')){ h=start.h-dy; y=start.y+dy; }
      if(w<MIN_W){ if(dir.includes('w')) x=start.x+start.w-MIN_W; w=MIN_W; }
      if(h<MIN_H){ if(dir.includes('n')) y=start.y+start.h-MIN_H; h=MIN_H; }
      x=clamp(x,0,Math.max(0,b.w-MIN_W)); y=clamp(y,0,Math.max(0,b.h-MIN_H));
      w=clamp(w,MIN_W,Math.max(MIN_W,b.w-x)); h=clamp(h,MIN_H,Math.max(MIN_H,b.h-y));
      applyRect(win,{x,y,w,h});
    }
    function up(){ frameShield(false); document.removeEventListener('pointermove',move); document.removeEventListener('pointerup',up); document.removeEventListener('pointercancel',up); save(app,win); }
    document.addEventListener('pointermove',move); document.addEventListener('pointerup',up); document.addEventListener('pointercancel',up);
  }
  function makeInteractive(win,app){
    const bar=win.querySelector('.win-titlebar');
    bar.addEventListener('pointerdown',e=>{
      if(e.target.closest('button'))return; e.preventDefault(); focusWindow(win);
      if(win.classList.contains('maxed')) return;
      const start=rectFromWin(win), sx=e.clientX, sy=e.clientY, b=bounds();
      frameShield(true);
      bar.setPointerCapture?.(e.pointerId);
      function move(ev){ applyRect(win,{w:start.w,h:start.h,x:clamp(start.x+ev.clientX-sx,0,Math.max(0,b.w-80)),y:clamp(start.y+ev.clientY-sy,0,Math.max(0,b.h-34))}); }
      function up(ev){ try{bar.releasePointerCapture?.(e.pointerId)}catch{} frameShield(false); document.removeEventListener('pointermove',move); document.removeEventListener('pointerup',up); save(app,win); }
      document.addEventListener('pointermove',move); document.addEventListener('pointerup',up);
    });
    win.addEventListener('pointermove',e=>{
      if(e.buttons) return;
      const dir=edgeDir(win,e); const c=cursorForDir(dir);
      win.style.cursor=c||''; win.classList.toggle('edge-hot',!!dir);
    });
    win.addEventListener('pointerleave',()=>{win.style.cursor=''; win.classList.remove('edge-hot');});
    win.addEventListener('pointerdown',e=>{
      if(e.button!==0) return;
      if(e.target.closest('.win-controls')) return;
      const dir=edgeDir(win,e);
      if(dir){ startResize(win,app,e,dir); }
    },true);
    win.querySelectorAll('.resize-handle').forEach(handle=>handle.addEventListener('pointerdown',e=>startResize(win,app,e,handle.dataset.dir||'se')));
    win.addEventListener('mousedown',()=>focusWindow(win));
    win.querySelector('[data-act="close"]').onclick=()=>{save(app,win); removeTask(app.id); win.remove();};
    win.querySelector('[data-act="min"]').onclick=()=>win.classList.add('minimized');
    win.querySelector('[data-act="max"]').onclick=()=>{ if(win.classList.toggle('maxed')){win.dataset.old=JSON.stringify(rectFromWin(win)); const b=bounds(); applyRect(win,{x:0,y:0,w:b.w,h:b.h});}else{try{applyRect(win,validRect(JSON.parse(win.dataset.old||'{}')))}catch{}} };
  }
  function save(app,win){ const r=rectFromWin(win); window.LMI_DESKTOP?.saveWindow(app.id,{x:r.x,y:r.y,w:r.w,h:r.h}); }
  window.addEventListener('resize',()=>{ document.querySelectorAll('.lmi-window:not(.maxed)').forEach(w=>{ const r=validRect(rectFromWin(w)); applyRect(w,r); }); document.querySelectorAll('.lmi-window.maxed').forEach(w=>{const b=bounds(); applyRect(w,{x:0,y:0,w:b.w,h:b.h});}); });
  window.LMI_WM={openWindow,focusWindow};
})();