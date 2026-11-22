import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareWhatsAppDispatch,dispatchWhatsApp} from '../automation/whatsapp/private-dispatch.mjs';
const phone='+12025550901';
const client=data=>({rpc:async()=>({data})});
const frame=body=>({to:phone.slice(1),type:'text',text:{body}});

// Attested private values keep their identity in every grammatical position.
// A homograph earns its ordinary role only where the occurrence itself is
// ordinary: pronouns in ordinary casing, modals with a following verb. The
// recipient-owned certification path is unchanged.
test('attested party and identifier homographs block wherever their value is cited, while ordinary roles still pass',async t=>{
 const snapshot={terms:['party:you','identifier:can'],identifiers:[],values:[],files:[]};
 const admission=await prepareWhatsAppDispatch({supabase:client(snapshot),phone});
 for(const body of [
  'I billed You yesterday',          // registered party casing, mid-sentence
  'The customer is You',
  'Customer name is You',
  'Customer: You',
  'Invoice number on file is can',   // registered identifier as copula value
  'The invoice number is can',
  'Invoice number: can',
 ])await t.test('foreign value '+body,()=>assert.throws(()=>admission(frame(body)),{code:'PRIVATE_PAYLOAD_BLOCKED'}));
 for(const body of [
  'You can review your invoice.',
  'We won’t message you again.',
  'You can send an unrelated chat request separately.',
  'Can you check this?',
  'I billed you yesterday',          // ordinary lowercase pronoun
  'You can pay when you are ready.',
 ])await t.test('ordinary role '+body,async()=>{
  const bytes=JSON.stringify(frame(body));let sends=0;
  await dispatchWhatsApp({admission,url:'https://fixture.invalid/messages',init:{body:bytes},fetchImpl:async(_,init)=>{assert.equal(init.body,bytes);sends++;return {};}});
  assert.equal(sends,1);
 });
});

// A partial snapshot is an unavailable snapshot, never an empty universe.
// Only the complete four-array contract may build an admission index.
test('incomplete snapshots are retryable-unavailable and never reach transport',async t=>{
 for(const response of [
  {data:{terms:[]}},
  {data:{terms:[],identifiers:[]}},
  {data:{terms:[],values:[],files:[]}},
  {data:{terms:[],identifiers:[],files:[]}},
  {data:{terms:[],identifiers:[],values:[]}},
  {data:{terms:[],identifiers:[],values:[]}},
  {data:{terms:['party:mark'],identifiers:null,values:[],files:[]}},
  {data:{terms:['party:mark'],identifiers:[],values:[],files:null}},
 ])await t.test(JSON.stringify(response).slice(0,80),async()=>{
  let sends=0;
  await assert.rejects(dispatchWhatsApp({supabase:client(response.data),phone,url:'https://fixture.invalid/messages',init:{body:JSON.stringify(frame('A safe reply'))},fetchImpl:async()=>{sends++;}}),
   error=>error.code==='PRIVATE_PAYLOAD_BLOCKED'&&error.retryable===true&&error.privacyCategory==='snapshot_unavailable');
  assert.equal(sends,0);
 });
});

// A complete empty universe admits ordinary prose and still rejects a changed
// recipient or a foreign value the moment one is attested.
test('a complete but empty snapshot stays valid without failing open on later data',async()=>{
 const admission=await prepareWhatsAppDispatch({supabase:client({terms:[],identifiers:[],values:[],files:[]}),phone});
 admission(frame('Your request is being reviewed.'));
 assert.throws(()=>admission({...frame('Safe reply'),to:'12025550902'}),{privacyCategory:'recipient_mismatch'});
});
