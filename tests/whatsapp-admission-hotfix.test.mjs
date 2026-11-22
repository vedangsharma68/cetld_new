import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareWhatsAppDispatch,dispatchWhatsApp} from '../automation/whatsapp/private-dispatch.mjs';
const phone='+12025550901';
const snapshot={terms:['invoice','identifier:invoice','review','You','party:you','party:mark','identifier:ZX-594','number:1250','date:2026-10-31'],identifiers:['identifier:OWN-808'],values:['number:9000'],files:[]};
const client=data=>({rpc:async()=>({data})});
const frame=body=>({to:phone.slice(1),type:'text',text:{body}});
test('dispatch occurrence roles accept ordinary product prose without certifying private field homographs',async t=>{
 const admission=await prepareWhatsAppDispatch({supabase:client(snapshot),phone});
 for(const body of ['You can review your invoice.','Your invoice is ready.','Please review the details.','WhatsApp updates are off. We won’t message you again.','You can receive WhatsApp updates again. Reply STOP to opt out.','Your invoice OWN-808 is INR 9000'])await t.test('ordinary/certified '+body,async()=>{
  const bytes=JSON.stringify(frame(body));let sends=0;await dispatchWhatsApp({admission,url:'https://fixture.invalid/messages',init:{body:bytes},fetchImpl:async(_,init)=>{assert.equal(init.body,bytes);sends++;return {};}});assert.equal(sends,1);
 });
 for(const body of ['Invoice number: i-n-v-o-i-c-e','Invoice number: r e v i e w','The customer is You','Customer name is You','The invoice number is invoice','The invoice number is review','Customer: You','Customer: review','Invoice number: invoice','I contacted review yesterday','I checked in on mark yesterday','Your invoice ZX-594 is ready','send 1250 today','Due 31 Oct 2026','Your invoice OWN-808 is 1250'])await t.test('foreign/field '+body,()=>assert.throws(()=>admission(frame(body)),{code:'PRIVATE_PAYLOAD_BLOCKED'}));
 assert.throws(()=>admission({...frame('Safe reply'),to:'12025550902'}),{privacyCategory:'recipient_mismatch'});
});
test('snapshot transport, status and shape failures are retryable and never call transport',async t=>{
 for(const response of [{error:{code:'57014',message:'secret statement'}},{error:{status:503}},{data:null},{data:{terms:'invalid'}},{data:{terms:[{}]}},{data:{terms:[],values:'bad'}},{data:{terms:[],files:[null]}},'throw'])await t.test(JSON.stringify(response),async()=>{
  let sends=0;const supabase={rpc:async()=>{if(response==='throw')throw Error('secret network details');return response;}};
  await assert.rejects(dispatchWhatsApp({supabase,phone,url:'https://fixture.invalid/messages',init:{body:JSON.stringify(frame('A safe reply'))},fetchImpl:async()=>{sends++;}}),error=>error.code==='PRIVATE_PAYLOAD_BLOCKED'&&error.retryable===true&&error.privacyCategory==='snapshot_unavailable'&&!error.message.includes('secret'));
  assert.equal(sends,0);
 });
});
