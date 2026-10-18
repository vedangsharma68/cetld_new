// Owner-verified Meta Utility catalog. No model-authored text or template selection.
const update='Hi, this is {{1}}. Invoice {{2}} for {{3}} has an update.';
const gentle='Hi, this is {{1}}. A quick note about invoice {{2}} for {{3}}. Questions? Just reply here.';
const details=[
  ['relaxed',"Hi {{1}} 👋 I'm Cetld, {{2}}'s assistant. A quick heads-up: invoice {{3}} has {{4}} outstanding, due on {{5}}. Questions? Just reply here 😊"],
  ['firm',"Hi {{1}}, I'm Cetld, {{2}}'s assistant. 📌 Invoice {{3}} has an outstanding balance of {{4}}, due on {{5}}. Please confirm your expected payment date, or let us know if there is an issue."],
  ['professional',"Hi {{1}}, I'm Cetld, {{2}}'s assistant. 🧾 Invoice {{3}} has an outstanding balance of {{4}}, due on {{5}}. Please reply if you have any questions."],
];
export const APPROVED_REMINDER_WABA='1734116767674237';
export const APPROVED_REMINDER_FOOTER='Reply STOP to opt out';
export const REMINDER_TEMPLATES=Object.freeze([
  ['cetld_invoice_update_v2','professional',false,update],
  ['cetld_invoice_update_btn_v2','professional',true,update],
  ['cetld_invoice_gentle_v1','gentle',false,gentle],
  ['cetld_invoice_gentle_btn_v1','gentle',true,gentle],
].map(([name,tone,buttonVariant,body])=>Object.freeze({name,tone,buttonVariant,body,
  language:'en',category:'UTILITY',status:'APPROVED',parameterCount:3,revision:'approved-20261005'})).concat(
  details.map(([tone,body])=>Object.freeze({name:`cetld_invoice_details_${tone}_v1`,tone,body,buttonVariant:false,
    language:'en',category:'UTILITY',status:'APPROVED',parameterCount:5,revision:'approved-20261018'}))));

export function selectReminderTemplate(preferences={}){
  const tone=preferences.tone==='gentle'?'gentle':'professional';
  return REMINDER_TEMPLATES.find(t=>t.parameterCount===3&&t.tone===tone&&t.buttonVariant===(preferences.templateButtons===true));
}

export const REMINDER_TONES=Object.freeze(['gentle','relaxed','firm','professional']);
export function selectInvoiceReminderTemplate(preferences={},debtorTone=null){
  if(debtorTone!==null&&!REMINDER_TONES.includes(debtorTone))throw Error('Invalid debtor tone');
  // Explicit legacy names and the existing button toggle retain the old catalog.
  // The isolated scheduled owner test continues to use selectReminderTemplate.
  if(debtorTone===null&&preferences.templateName!==undefined){
    const entry=REMINDER_TEMPLATES.find(t=>t.parameterCount===3&&t.name===preferences.templateName);
    if(!entry)throw Error('Invalid legacy reminder template');
    return entry;
  }
  if(debtorTone===null&&preferences.templateButtons===true)return selectReminderTemplate(preferences);
  const tone=debtorTone??preferences.tone;
  const mapped=tone==='gentle'||tone==='relaxed'?'relaxed':tone==='firm'?'firm':'professional';
  return REMINDER_TEMPLATES.find(t=>t.parameterCount===5&&t.tone===mapped);
}

export function matchesApprovedReminderTemplate(actual,entry){
  if(!REMINDER_TEMPLATES.includes(entry)||!actual?.found||actual.name!==entry.name
    ||actual.language!==entry.language||actual.status!=='APPROVED'||actual.category!=='UTILITY'
    ||(actual.parameter_format!==undefined&&actual.parameter_format!=='POSITIONAL')
    ||!Array.isArray(actual.components))return false;
  const bodies=actual.components.filter(c=>c.type==='BODY');
  const footers=actual.components.filter(c=>c.type==='FOOTER');
  return !entry.buttonVariant&&bodies.length===1&&bodies[0].text===entry.body
    &&footers.length<=1&&footers.every(c=>c.text===APPROVED_REMINDER_FOOTER)
    &&actual.components.every(c=>c.type==='BODY'||c.type==='FOOTER');
}
export function buildReminderTemplate(entry,parameters){
  if(!REMINDER_TEMPLATES.includes(entry)||!Array.isArray(parameters)||parameters.length!==entry.parameterCount
    ||parameters.some(v=>typeof v!=='string'||!v.trim()||v.length>256||/[{}\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v)))throw Error('Invalid approved template facts');
  const body=entry.body.replace(/\{\{([1-5])\}\}/g,(_,n)=>parameters[Number(n)-1]);
  // Static quick-reply buttons belong to the approved Meta template; no URL,
  // label, count or payload is invented before live components are verified.
  return {body,template:{name:entry.name,language:{code:entry.language},components:[
    {type:'body',parameters:parameters.map(text=>({type:'text',text}))},
  ]}};
}
