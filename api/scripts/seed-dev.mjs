import { putSheet } from '../lib/store.js';

putSheet('core', [{ cid:'c_bs', tag:'bs', hash:'bs', cn:'BrokenSynapse', al:'Admin', th:'Default', bid:'ACC-BS', cur:'LGD', st:'Active' }], ['cid','tag','hash','cn','al','th','bid','cur','st']);
putSheet('desk', [{ cid:'c_bs', apps:'x', lay:'x:0,18,80,70,980,680,0,0;bipac:0,18,80,70,980,680,0,0' }], ['cid','apps','lay']);
putSheet('dictApps', [
  { k:'r', id:'browser', nm:'ATOMIKA Browser', path:'modules/browser.html?v=2026051605', ico:'O', desc:'Low Data Rate Quantum Entangled Transit Environment', w:1180, h:820 },
  { k:'k', id:'bank', nm:'Bank.LMX', path:'modules/bank.html', ico:'B', desc:'Bank', w:860, h:620 },
  { k:'w', id:'work', nm:'Work.LMX', path:'modules/work.html', ico:'$', desc:'Work', w:860, h:620 },
  { k:'p', id:'pointOfSale', nm:'POS.LMX', path:'modules/pointOfSale.html?v=2026051501', ico:'POS', desc:'Point of Sale', w:1280, h:780 },
  { k:'d', id:'dealership', nm:'Fleetline.LMX', path:'modules/dealership.html?v=2026051701', ico:'FL', desc:'Curated vehicle marketplace and showroom', w:1240, h:820 },
  { k:'g', id:'garage', nm:'Garage.LMX', path:'modules/garage.html?v=2026051701', ico:'G', desc:'Owned vehicle garage, fueling, documents, and service hub', w:1240, h:820 },
  { k:'m', id:'bodyMods', nm:'BodyMods.LMX', path:'modules/bodyMods.html?v=2026051507', ico:'+', desc:'Body Mods', w:980, h:700 },
  { k:'h', id:'chat', nm:'Chat.LMX', path:'modules/chat.html', ico:'#', desc:'Chat', w:850, h:620 },
  { k:'ph', id:'pharma', nm:'PHARMA.LMX', path:'modules/pharma.html?v=2026051501', ico:'Rx', desc:'Pharma', w:1180, h:800 },
  { k:'s', id:'settings', nm:'Settings.LMX', path:'modules/settings-v2.html', ico:'S', desc:'Settings', w:1120, h:760 },
  { k:'x', id:'bipac', nm:'LMI Terminal', path:'modules/bipac.html?v=2026051611', ico:'>_', desc:'Command shell for module discovery, descriptions, install, and launch', w:980, h:680 },
  { k:'cv', id:'convert', nm:'Convert.LMX', path:'modules/convert.html', ico:'CV', desc:'Converter', w:760, h:560 },
  { k:'ax', id:'axeom', nm:'AXEOM.LMX', path:'modules/axeom.html?v=2026051702', ico:'AX', desc:'Sequential eteph spellcraft compiler', w:1180, h:780 },
  { k:'df', id:'dataEditor', nm:'DataForge.LMX', path:'modules/dataEditor.html?v=2026051502', ico:'DF', desc:'Sheet entry formatter', w:980, h:720 },
  { k:'qv', id:'qvault', nm:'QVault.LMX', path:'modules/qvault.html?v=2026051502', ico:'QV', desc:'Personal inventory grid', w:980, h:760 }
], ['k','id','nm','path','ico','desc','w','h']);
putSheet('bank', [{ lid:'l_0', bid:'ACC-BS', cid:'c_bs', t:new Date().toISOString(), typ:'opening', amt:777777, cur:'LGD', memo:'Dev seed opening balance', by:'system', blob:'' }], ['lid','bid','cid','t','typ','amt','cur','memo','by','blob']);
putSheet('currencySettings', [
  { code:'LGD', label:'Leviathan Gold Dollar', symbol:'LGD', ratePerLGD:1, precision:3, mode:'fixed', notes:'Base currency.' },
  { code:'D', label:'Legacy Dinari', symbol:'D', ratePerLGD:1, precision:3, mode:'fixed', notes:'Legacy display.' }
], ['code','label','symbol','ratePerLGD','precision','mode','notes']);
console.log('Seeded dev login: tag bs / hash bs');
