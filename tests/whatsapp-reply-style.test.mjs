import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createWhatsAppAssistantChannel,WHATSAPP_REPLY_GUIDANCE} from '../ai/whatsapp-channel.mjs';
import {runOwnerAgent,ownerAgentFailureReply,ownerReplySafetyIssue} from '../automation/whatsapp/owner-agent.mjs';
import {invoiceReviewClarification} from '../automation/whatsapp/assistant-handler.mjs';
import {ownerGroundingIssue} from '../automation/whatsapp/owner-grounding.mjs';
import {standaloneOwnerGreeting} from '../automation/whatsapp/owner-handler.mjs';
import {businessNameReminderNotice} from '../business-name-reminders.mjs';
import {INVOICE_IMAGE_REPLIES} from '../ai/extraction.mjs';
import {TEXT_INVOICE_FORMAT,textInvoiceFailure} from '../automation/whatsapp/text-invoice.mjs';
import {OWNER_CHAT_SCOPE as scope} from './fixtures/owner-chat-battery.mjs';

const source=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const block=(path,start,end)=>source(path).split(start)[1].split(end)[0];
// Scan the fixed reply surfaces, excluding model instructions, approved Meta
// templates and consent wording. Interpolated records are checked below.
const replySources=[
  block('automation/whatsapp/owner-agent.mjs','const SAFE_ERRORS =','const WRITE_TOOLS'),
  block('automation/whatsapp/owner-agent.mjs','export function ownerAgentFailureReply','function ownerAgentTimeoutError'),
  block('automation/whatsapp/owner-agent.mjs','const failureReplies=','if(last?.ok'),
  block('automation/whatsapp/assistant-handler.mjs','export function invoiceReviewClarification','function extractionValidationIssues'),
  block('automation/whatsapp/cloud-outbound.mjs','const linkText =','if (kind === \'normal\')'),
  ...source('automation/whatsapp/owner-agent.mjs').split('\n').filter(line=>
    /\bmessage:\s*['"]|return response\(['"]/.test(line)
    && !/UNKNOWN_TOOL|Owner-selected attachment processing tool/.test(line)),
  ...['ai/whatsapp-channel.mjs','automation/whatsapp/assistant-handler.mjs','automation/whatsapp/cloud-inbound.mjs',
    'automation/whatsapp/cloud-outbound.mjs','automation/whatsapp/owner-handler.mjs','automation/whatsapp/owner-next-actions.mjs',
    'automation/whatsapp/text-invoice.mjs'].flatMap(path=>source(path).split('\n').filter(line=>
      /\breturn\s+['"`]|\b(?:answer|reply):\s*['"`]|\bconst (?:\w*REPLY|stopReply|TEXT_INVOICE_FORMAT)\s*=/.test(line))),
];
// Tokenize comments and strings together so apostrophes inside comments do not
// become copy. Templates contain variable data and are tested as rendered text.
const literalPattern=/\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:\\[\s\S]|[^`\\])*`|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"/g;
const fixed=replySources.flatMap(text=>[...text.matchAll(literalPattern)].filter(([token])=>/^["']/.test(token))
  .map(([token])=>runInNewContext(token)).filter(text=>typeof text==='string'&&text.trim().includes(' ')&&text.length>15));

function plain(text,{limit=140}={}){
  assert.ok(text.length<=limit,`${text.length} chars: ${text}`);
  assert.doesNotMatch(text,/\bplease\b|\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\uFE0F\u200D]/iu);
  assert.doesNotMatch(text,/\b(?:dashboard|binding|extraction|migration|reconciled|receivable|idempotency|stale|ledger|tool)\b/i);
  assert.doesNotMatch(text,/\*\*|(?:^|\n)[•*-] /);
}

test('fixed WhatsApp replies are short, plain, jargon-free and emoji-free',()=>{
  assert.ok(fixed.length>100,'keep the full fixed-reply surface in the battery');
  const failures=[];
  for(const text of [...fixed,...Object.values(INVOICE_IMAGE_REPLIES),TEXT_INVOICE_FORMAT,
    ...['INVALID','INVOICE_EXISTS','DATABASE_UNAVAILABLE'].map(code=>textInvoiceFailure({ok:false,code})),
    ...['hi','how are you','what can you do'].map(standaloneOwnerGreeting)]){try{plain(text);}catch(error){failures.push(error.message);}}
  assert.deepEqual(failures,[]);
  for(const count of [1,3,100])for(const saved of [false,true]){
    const text=businessNameReminderNotice(count,{saved});plain(text);
    assert.ok(text.startsWith(`${count} approved reminder`));
    assert.match(text,/paused.*name change.*until you re-approve.*Conversations/);
  }
  for(const code of ['TIMEOUT','OWNER_AGENT_TOOL_FAILED','OWNER_REPLY_REPAIR_FAILED','UNAVAILABLE']){
    plain(ownerAgentFailureReply(code));
    const reply=ownerAgentFailureReply(code,{writeAttempted:true});plain(reply);
    assert.match(reply,/confirm.*completed|confirm if the change completed/);
    assert.match(reply,/check cetld before retrying/i);
  }
});

function guidance(messages){
  const instruction=messages.filter(item=>item.role==='system').map(item=>item.content).join('\n');
  assert.ok(instruction.includes(WHATSAPP_REPLY_GUIDANCE));
  for(const rule of ['Answer first in 1-2 short sentences','plain text','No bold or bullets unless listing 3+ items',
    'No emojis unless the user used one first','under about 40 words unless the user asked for detail'])assert.ok(instruction.includes(rule));
}
const prompts=[
  ['What is due on INV-42?','INV-42 has USD 500 due on 25 October.'],
  ['Did my payment go through?','I can’t verify that payment yet. Check cetld before trying again.'],
  ['What can you help with?','I can help with invoices, payments, customers, and balances.'],
];
for(const [message,answer] of prompts)test(`mock model replies stay under 40 words: ${message}`,async()=>{
  let customerCalls=0,ownerCalls=0;
  const provider={async generate(request){customerCalls++;guidance(request.messages);return {content:answer};}};
  const channel=createWhatsAppAssistantChannel({provider,authorizeChannel:async input=>({...input,allowed:true}),
    createCustomerScopedStore:()=>({query:async()=>{throw Error('No live data');}}),
    answer:async({provider,message})=>({answer:(await provider.generate({messages:[{role:'system',content:'Use verified records only.'},{role:'user',content:message}]})).content})});
  const customer=await channel.ask({...scope,message});
  const owner=await runOwnerAgent({scope,message,initialToolResults:[{name:'workspaceData',args:{operation:'read',table:'invoices'},result:{ok:true,readOnly:true,table:'invoices',rows:[{invoice_number:'INV-42',currency:'USD',total_amount:500,amount_paid:0,due_date:'2026-10-25'}]}}],logger:{info(){}},tools:{definitions:[],execute(){throw Error('No write or send');}},
    provider:{async generate(request){ownerCalls++;guidance(request.messages);return {content:answer};}}});
  for(const result of [customer,owner]){
    assert.equal(result.answer,answer,'preserve full amounts, dates and uncertainty');
    assert.ok(result.answer.split(/\s+/).length<40);plain(result.answer);
  }
  assert.equal(customerCalls,1);assert.equal(ownerCalls,1);
});

test('detail requests retain all requested facts without a hard word truncation',async()=>{
  const answer='Here are the details you asked for. '+Array.from({length:8},(_,i)=>`Invoice INV-${i+1} has USD ${i+10} due on 25 October.`).join(' ');
  const channel=createWhatsAppAssistantChannel({provider:{async generate({messages}){guidance(messages);return {content:answer};}},
    authorizeChannel:async input=>({...input,allowed:true}),createCustomerScopedStore:()=>({query:async()=>[]}),
    answer:async({provider})=>({answer:(await provider.generate({messages:[{role:'system',content:'Answer from records.'}]})).content})});
  assert.equal((await channel.ask({...scope,message:'Give me the full invoice details'})).answer,answer);
});

test('shorter review warnings still satisfy the existing safety checks',()=>{
  for(const missingFields of [['currency'],['direction'],['currency','direction']]){
    const action={missingFields,validationIssues:['PAYMENT_STATUS_CONFLICT'],paymentEvidence:{status:'paid'}};
    const answer=invoiceReviewClarification(action);
    assert.equal(ownerReplySafetyIssue(answer,{attachmentReview:{...action,incomplete:true}}),null);
    assert.equal(ownerGroundingIssue(answer,[{ok:false,code:'INVALID',outcome:'review_incomplete'}]),null);
    assert.match(answer,/No payment was recorded.*Nothing was saved/);
  }
  for(const failureCode of ['EXTRACTION_UNAVAILABLE','INVOICE_REVIEW_UNAVAILABLE'])for(const failureReason of ['TIMEOUT','UNAVAILABLE']){
    const action={failureCode,failureReason},answer=invoiceReviewClarification(action);
    plain(answer);
    assert.equal(ownerReplySafetyIssue(answer,{attachmentReview:action}),null);
  }
});

test('saved and payment receipts stay short while keeping amounts and pause status',async()=>{
  const invoice={invoiceNumber:'INV-42',clientName:'Ravi',currency:'INR',total:2500,dueDate:'2026-10-25'};
  const channel=createWhatsAppAssistantChannel({authorizeChannel:async input=>({...input,allowed:true}),
    createCustomerScopedStore:()=>({query:async()=>[]}),
    loadInvoiceReview:async()=>({action:{type:'invoice_review_draft',stage:'saved',invoice}}),
    transitionInvoiceReview:async()=>{throw Error('Already saved; no write');}});
  const saved=await channel.ask({...scope,message:'yes'});plain(saved.answer);
  assert.match(saved.answer,/already saved.*Ravi: INR 2,500/);
  const payment=await runOwnerAgent({message:'yes',logger:{info(){}},
    provider:{generate(){throw Error('Receipt needs no model or send');}},
    tools:{definitions:[{type:'function',function:{name:'workspaceData',parameters:{type:'object'}}}],
      getOwnerPaymentDecision:()=> 'confirm',
      async execute(name,args){
        assert.equal(name,'workspaceData');assert.equal(args.operation,'confirm');
        return {ok:true,completed:true,action:'invoice.payment_recorded',invoiceNumber:'INV-42',currency:'INR',
          paymentAmount:1000,outstandingAmount:1500,remindersPaused:true};
      }}});
  plain(payment.answer);
  assert.match(payment.answer,/Recorded INR 1000\.00 on INV-42.*INR 1500\.00.*Reminders are paused/);
});

test('payment refusals do not imply that all payment history is empty',()=>{
  const replies=runInNewContext('('+block('automation/whatsapp/owner-agent.mjs','const failureReplies=','if(last?.ok').trim().replace(/;$/,'')+')');
  const read={ok:true,readOnly:true,operation:'read',table:'invoices',rows:[{invoice_number:'INV-42',amount_paid:0}]};
  for(const [code,answer] of Object.entries(replies)){
    plain(answer);
    assert.equal(ownerReplySafetyIssue(answer),null,code);
    assert.equal(ownerGroundingIssue(answer,[read,{ok:false,code}]),null,code);
  }
});
