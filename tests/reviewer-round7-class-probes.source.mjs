import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {fixture} from '../tests/fixtures/private-invoice.mjs';
import {AIProvider} from '../ai/provider.mjs';
import {createWhatsAppBoundMessageHandler} from '../automation/whatsapp/assistant-handler.mjs';
import {privateOriginKeys,privateOriginStart,privateFieldKeys,privatePartyKeys,createPrivateValueMatcher} from '../ai/private-value-matcher.mjs';
const evidence={turns:[],origins:[],parity:[]},wires=[];
const factory=options=>new AIProvider({...options,cfAccountId:'independent-round7',cfApiToken:'independent-round7',maxAttempts:1,logger:{info(){},warn(){}},fetchImpl:async(url,init)=>{assert.equal(new URL(url).hostname,'api.cloudflare.com');const body=JSON.parse(init.body);wires.push({url,body,serializedMessages:JSON.stringify(body.messages)});return Response.json({choices:[{message:{content:'An ordinary answer'}}]});}});
const f=await fixture({providerFactory:factory});let customer,n=0;
const restart=()=>{f.restart();customer=createWhatsAppBoundMessageHandler({supabase:f.supabase,audience:'customer',authorizeScope:async()=>true,providerFactory:factory,logger:{error(){}}});};
const turn=async(a,message)=>{const r=a==='owner'?await f.turn(message):await customer({...f.scope,message,messageId:'r7-probe-'+(++n)});return r?.answer??r;};
const terms=async()=>(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1 order by term',[f.scope.workspaceId])).rows.map(r=>r.term);
const clearMemory=async()=>{await f.db.query('delete from whatsapp_provider_memory where workspace_id=$1',[f.scope.workspaceId]);restart();};
const reset=async()=>{await f.db.query('delete from owner_assistant_turns where workspace_id=$1',[f.scope.workspaceId]);await f.db.query('delete from whatsapp_conversation_turns where workspace_id=$1',[f.scope.workspaceId]);await f.db.query('delete from whatsapp_provider_memory where workspace_id=$1',[f.scope.workspaceId]);await f.db.query('delete from whatsapp_private_invoice_terms where workspace_id=$1',[f.scope.workspaceId]);restart();};
const run=async(kind,stored,inputs)=>{
 await reset();await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,stored]);const retained=await terms();
 for(const audience of ['owner','customer'])for(const [input,expectedPrivate]of inputs){await clearMemory();const start=wires.length,result=await turn(audience,input);evidence.turns.push({kind,audience,stored,retained,input,expectedPrivate,result,wires:wires.slice(start)});}
};
try{
 await run('enumeration',{total:1250},[
  ['The amounts: 1250,77',true],['The amounts = 1250,77',true],['The amounts are (1250,77)',true],['The amounts — 1250,77',true],['The amounts are [1250,77]',true],['The amounts are: 1250,77',true],['The amounts are respectively 1250,77',true],['Choose from 1250,77',true],['Choose one: 1250,77',true],['The amounts = 77,1250',true],['The amounts include 1250,77',true],['The amounts = 77,2500',false],['Put 1250,77 on the shopping list',false],['The amounts are 100,77',false],
 ]);
 await run('formal-van',{partyNames:['Van Harper']},[
  ['Ask Van for advice',true],['Ask Van if he is free',true],['Ask Van when he is free',true],['Call Van now',true],['Van called me',true],['Van arrived yesterday',true],['I spoke to Van recently',true],['Van is coming tomorrow',true],['I met Van last week',true],["Van's suggestion helped",true],["Tell me about Van's idea",true],['Is Van available?',true],['Please thank Van',true],
  ['Travel by van',false],['We travel by van today',false],['Can we go by van tomorrow?',false],['A van is useful',false],['The van was red',false],['I bought a van',false],['The word van describes a vehicle',false],['Van Gogh painted sunflowers',false],['We use a delivery van',false],['I hired a blue van today',false],['Please send the van tomorrow',false],
 ]);
 await run('formal-an',{partyNames:['An Harper']},[['Ask An for advice',true],['An called me',true],['An is coming tomorrow',true],['I met An yesterday',true],['An apple is tasty',false],['Ask an expert for advice',false]]);
 await run('dates',{dueDate:'2026-10-31'},[['Is it due 31–Oct–2026?',true],['Is it due 31‑Oct‑2026?',true],["Is it due 31st October '26?",true],['Is it due 31 Oct. 2026?',true],['Is it due 31/Oct/26?',true],['Is it due ३१–अक्टूबर–२०२६?',true],['Is it due 31–Oct–2027?',false],['Is it due 31/10/2027?',false],['Is it due 30–Oct–2026?',false]]);
 const sources=[
  'I invoiced Alder Finch for 6847',
  'I billed Alder Finch 6847',
  'I sent Alder Finch an invoice for 6847',
  'Invoice: 6847 for Alder Finch',
  'Invoice: Alder Finch for 6847',
  'Invoice to Alder Finch for 6847',
  'Invoice of 6847 to Alder Finch',
  'Invoice #AB-6847\nAlder Finch\nTotal 6847\nDue 16 July 2027',
  'Invoice #AB-6847\nDate: 16 July 2027\nAlder Finch\nTotal 6847',
  'I issued an invoice of 6847 to Alder Finch, due 16 July 2027',
  'Invoice no. AB-6847\nAlder Finch\nTotal 6847',
  'Bill #AB-6847\nAlder Finch\nAmount 6847',
 ];
 for(const source of sources){
  const sql=(await f.db.query('select distinct k from app.private_invoice_origin_aliases($1) k order by k',[source])).rows.map(r=>r.k),js=[...new Set(privateOriginKeys(source))].sort();evidence.parity.push({source,sql,js,equal:JSON.stringify(sql)===JSON.stringify(js),start:privateOriginStart(source)});
  for(const audience of ['owner','customer']){
   await reset();const before=wires.length,first=await turn(audience,source),sourceWires=wires.slice(before),retained=await terms();restart();
   const followups=[];for(const input of ['send 6847 today','Ask Alder for advice','Is it due 16 July 2027?']){await clearMemory();const start=wires.length,result=await turn(audience,input);followups.push({input,result,wires:wires.slice(start)});}
   evidence.origins.push({source,audience,first,sourceWires,retained,followups});
  }
 }
 console.log(JSON.stringify({turns:evidence.turns.length,unexpectedPrivateForward:evidence.turns.filter(r=>r.expectedPrivate&&r.wires.length).map(r=>({kind:r.kind,audience:r.audience,input:r.input,messages:r.wires.at(-1).body.messages})),unexpectedOrdinaryBlock:evidence.turns.filter(r=>!r.expectedPrivate&&!r.wires.length).map(r=>({kind:r.kind,audience:r.audience,input:r.input,result:r.result})),originCases:evidence.origins.length,parityMismatches:evidence.parity.filter(r=>!r.equal)}));
}finally{await writeFile('work/r7-class-probes.json',JSON.stringify(evidence,null,2));await f.close();}
