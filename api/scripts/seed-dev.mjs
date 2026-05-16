import { putSheet } from '../lib/store.js';
putSheet('core', [{cid:'c_bs', tag:'bs', hash:'bs', cn:'BrokenSynapse', al:'Admin', th:'Default', bid:'ACC-BS', cur:'LGD', st:'Active'}], ['cid','tag','hash','cn','al','th','bid','cur','st']);
putSheet('desk', [{cid:'c_bs', apps:'x', lay:'x:0,18,80,70,980,680,0,0;bipac:0,18,80,70,980,680,0,0'}], ['cid','apps','lay']);
putSheet('dictApps', [
  {k:'b',id:'browser',nm:'Browser.LMX',path:'modules/browser.html',ico:'⌁',desc:'LDRQE browser',w:900,h:640},
  {k:'k',id:'bank',nm:'Bank.LMX',path:'modules/bank.html',ico:'₿',desc:'Bank',w:860,h:620},
  {k:'w',id:'work',nm:'Work.LMX',path:'modules/work.html',ico:'◈',desc:'Work',w:860,h:620},
  {k:'p',id:'pos',nm:'POS.LMX',path:'modules/pointOfSale.html',ico:'▣',desc:'Point of Sale',w:960,h:680},
  {k:'d',id:'dealership',nm:'Dealership.LMX',path:'modules/dealership.html',ico:'◆',desc:'Vehicles',w:960,h:680},
  {k:'m',id:'bodyMods',nm:'BodyMods.LMX',path:'modules/bodyMods.html',ico:'☥',desc:'Body Mods',w:980,h:700},
  {k:'h',id:'pharma',nm:'PHARMA.LMX',path:'modules/pharma.html',ico:'✚',desc:'Pharma',w:960,h:680},
  {k:'s',id:'settings',nm:'Settings',path:'modules/settings-v2.html',ico:'⚙',desc:'Settings',w:760,h:560},
  {k:'x',id:'bipac',nm:'LMI Terminal',path:'modules/bipac.html?v=2026051602',ico:'>_',desc:'Command shell for module discovery, descriptions, install, and launch',w:980,h:680},
  {k:'r',id:'convert',nm:'Convert.LMX',path:'modules/convert.html',ico:'⇄',desc:'Converter',w:760,h:560}
], ['k','id','nm','path','ico','desc','w','h']);
putSheet('bank', [{lid:'l_0', bid:'ACC-BS', cid:'c_bs', t:new Date().toISOString(), typ:'opening', amt:777777, cur:'LGD', memo:'Dev seed opening balance', by:'system', blob:''}], ['lid','bid','cid','t','typ','amt','cur','memo','by','blob']);
putSheet('currencySettings', [
  {code:'LGD', label:'Leviathan Gold Dollar', symbol:'Ł', ratePerLGD:1, precision:3, mode:'fixed', notes:'Base currency.'},
  {code:'D', label:'Legacy Dinari', symbol:'D', ratePerLGD:1, precision:3, mode:'fixed', notes:'Legacy display.'}
], ['code','label','symbol','ratePerLGD','precision','mode','notes']);
console.log('Seeded dev login: tag bs / hash bs');
