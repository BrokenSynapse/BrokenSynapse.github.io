export function createRestartNotice(call){
 const notice=document.getElementById('restart-notice');let current=null,offset=0,generation=0,enabled=false;
 function paint(){const now=Date.now()+offset,remaining=current?.nextRestartAt-now,show=enabled&&current?.enabled&&now>=current.warningStartsAt&&remaining>0;notice.hidden=!show;if(!show)return;const seconds=Math.ceil(remaining/1000),label='Server restarts in '+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');if(notice.textContent!==label)notice.textContent=label;notice.title='Scheduled server restart at '+new Date(current.nextRestartAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});}
 async function refresh(){if(!enabled)return;const id=generation;try{const result=await call('platform-status');if(id!==generation||!enabled)return;current=result;offset=result.serverTime-Date.now();paint();}catch{}}
 setInterval(paint,1000);setInterval(()=>void refresh(),5*60000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});
 return {refresh,start(){generation++;enabled=true;void refresh();},stop(){generation++;enabled=false;current=null;paint();}};
}
