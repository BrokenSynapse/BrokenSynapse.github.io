
(function(){
 const pending=[]; let context=null;
 window.LMI={
   requestContext(){return new Promise(resolve=>{ if(context) return resolve(context); pending.push(resolve); parent.postMessage({type:'LMI_REQUEST_CONTEXT'},'*'); setTimeout(()=>resolve(context||{}),2500);});},
   get context(){return context;}
 };
 window.addEventListener('message',e=>{const d=e.data||{}; if(d.type==='LMI_CONTEXT'){context=d; while(pending.length) pending.shift()(context);}});
 window.addEventListener('DOMContentLoaded',()=>window.LMI.requestContext());
})();
