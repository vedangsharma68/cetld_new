// Owner-verified Meta Utility catalog. No model-authored text or template selection.
const update='Hi, this is {{1}}. Invoice {{2}} for {{3}} has an update.';
const gentle='Hi, this is {{1}}. A quick note about invoice {{2}} for {{3}}. Questions? Just reply here.';
export const APPROVED_REMINDER_WABA='1734116767674237';
export const APPROVED_REMINDER_FOOTER='Reply STOP to opt out';
export const REMINDER_TEMPLATES=Object.freeze([
  ['cetld_invoice_update_v2','professional',false,update],
  ['cetld_invoice_update_btn_v2','professional',true,update],
  ['cetld_invoice_gentle_v1','gentle',false,gentle],
  ['cetld_invoice_gentle_btn_v1','gentle',true,gentle],
].map(([name,tone,buttonVariant,body])=>Object.freeze({name,tone,buttonVariant,body,
  language:'en',category:'UTILITY',status:'APPROVED',parameterCount:3,revision:'approved-20261005'})));

export function selectReminderTemplate(preferences={}){
  const tone=preferences.tone==='gentle'?'gentle':'professional';
  return REMINDER_TEMPLATES.find(t=>t.tone===tone&&t.buttonVariant===(preferences.templateButtons===true));
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
  if(!REMINDER_TEMPLATES.includes(entry)||!Array.isArray(parameters)||parameters.length!==3
    ||parameters.some(v=>typeof v!=='string'||!v.trim()||v.length>256||/[\r\n{}\u0000-\u001f\u007f]/.test(v)))throw Error('Invalid approved template facts');
  const body=entry.body.replace(/\{\{([1-3])\}\}/g,(_,n)=>parameters[Number(n)-1]);
  // Static quick-reply buttons belong to the approved Meta template; no URL,
  // label, count or payload is invented before live components are verified.
  return {body,template:{name:entry.name,language:{code:entry.language},components:[
    {type:'body',parameters:parameters.map(text=>({type:'text',text}))},
  ]}};
}
