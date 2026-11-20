import { readFileSync } from 'node:fs';
export function restartStatus(config,now=Date.now()){
 if(!config?.enabled)return {enabled:false,serverTime:now};
 const timeZone=config.timeZone||'America/New_York',hours=config.hours||[0,12];
 const formatter=new Intl.DateTimeFormat('en-US',{timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 let next=Math.floor(now/3600000)*3600000+3600000;
 for(let i=0;i<27;i++,next+=3600000){const parts=formatter.formatToParts(next),hour=Number(parts.find(p=>p.type==='hour').value),minute=Number(parts.find(p=>p.type==='minute').value);if(hours.includes(hour)&&minute===0)return {enabled:true,serverTime:now,nextRestartAt:next,warningStartsAt:next-(config.warningMinutes||10)*60000,timeZone};}
 return {enabled:false,serverTime:now};
}
export function configuredRestartStatus(){try{return restartStatus(JSON.parse(readFileSync(new URL('./maintenance-schedule.json',import.meta.url),'utf8')));}catch{return {enabled:false,serverTime:Date.now()};}}
