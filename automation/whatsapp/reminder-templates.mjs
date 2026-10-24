// Meta Utility catalog. Replacement approvals are checked separately before sending.
const update='Hi, this is {{1}}. Invoice {{2}} for {{3}} has an update.';
const gentle='Hi, this is {{1}}. A quick note about invoice {{2}} for {{3}}. Questions? Just reply here.';
const details=[
  ['relaxed',"Hi {{1}} 👋 I'm Cetld, {{2}}'s assistant. A quick heads-up: invoice {{3}} has {{4}} outstanding, due on {{5}}. Questions? Just reply here 😊"],
  ['firm',"Hi {{1}}, I'm Cetld, {{2}}'s assistant. 📌 Invoice {{3}} has an outstanding balance of {{4}}, due on {{5}}. Please confirm your expected payment date, or let us know if there is an issue."],
  ['professional',"Hi {{1}}, I'm Cetld, {{2}}'s assistant. 🧾 Invoice {{3}} has an outstanding balance of {{4}}, due on {{5}}. Please reply if you have any questions."],
];
export const APPROVED_REMINDER_WABA='1734116767674237';
// Retained only for the frozen scheduled-owner-test contract. Never appended.
export const APPROVED_REMINDER_FOOTER='Reply STOP to opt out';
// One-line version swaps; senders, diagnostics and existing stored selections share this config.
export const REMINDER_TEMPLATE_REPLACEMENTS=Object.freeze({
  cetld_invoice_update_v2:'cetld_invoice_update_v3',
  cetld_invoice_update_btn_v2:'cetld_invoice_update_btn_v3',
  cetld_invoice_gentle_v1:'cetld_invoice_gentle_v2',
  cetld_invoice_gentle_btn_v1:'cetld_invoice_gentle_btn_v2',
});
export const REMINDER_TEMPLATES=Object.freeze([
  [REMINDER_TEMPLATE_REPLACEMENTS.cetld_invoice_update_v2,'professional',false,update],
  [REMINDER_TEMPLATE_REPLACEMENTS.cetld_invoice_update_btn_v2,'professional',true,update],
  [REMINDER_TEMPLATE_REPLACEMENTS.cetld_invoice_gentle_v1,'gentle',false,gentle],
  [REMINDER_TEMPLATE_REPLACEMENTS.cetld_invoice_gentle_btn_v1,'gentle',true,gentle],
].map(([name,tone,buttonVariant,body])=>Object.freeze({name,tone,buttonVariant,body,
  language:'en',category:'UTILITY',status:'APPROVED',parameterCount:3,revision:'approved-20261018-nf'})).concat(
  details.map(([tone,body])=>Object.freeze({name:`cetld_invoice_details_${tone}_v1`,tone,body,buttonVariant:false,
    language:'en',category:'UTILITY',status:'APPROVED',parameterCount:5,revision:'approved-20261018'}))));

export function selectReminderTemplate(preferences={}){
  const tone=preferences.tone==='gentle'?'gentle':'professional';
  return REMINDER_TEMPLATES.find(t=>t.parameterCount===3&&t.tone===tone&&t.buttonVariant===(preferences.templateButtons===true));
}

export const REMINDER_TONES=Object.freeze(['gentle','relaxed','firm','professional']);
export function selectInvoiceReminderTemplate(preferences={},debtorTone=null){
  if(debtorTone!==null&&!REMINDER_TONES.includes(debtorTone))throw Error('Invalid debtor tone');
  // Existing stored names resolve to their no-footer replacements.
  // The isolated scheduled owner test continues to use selectReminderTemplate.
  if(debtorTone===null&&preferences.templateName!==undefined){
    const entry=REMINDER_TEMPLATES.find(t=>t.parameterCount===3&&t.name===(REMINDER_TEMPLATE_REPLACEMENTS[preferences.templateName]??preferences.templateName));
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
  return !entry.buttonVariant&&bodies.length===1&&typeof bodies[0].text==='string'&&bodies[0].text.trim().length>0&&bodies[0].text===entry.body
    &&actual.components.every(c=>c.type==='BODY');
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

/** @type {Readonly<{name: 'cetld_test_reminder_v1', language: 'en', body: string, parameterCount: 3}>} */
// Draft definition only for separate owner submission to Meta. Not approved,
// not in REMINDER_TEMPLATES, and never eligible for dispatch or auto-submission.
export const TEST_REMINDER_TEMPLATE_DRAFT=Object.freeze({
  name:'cetld_test_reminder_v1',language:'en',parameterCount:3,
  body:"TEST — NO PAYMENT REQUIRED\nHi {{1}}, this is Cetld, an assistant for {{2}}. This is a test reminder for invoice {{3}}. No payment is required. Please disregard any nominal invoice balance or due date.",
});
