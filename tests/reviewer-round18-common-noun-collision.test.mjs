import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareWhatsAppDispatch} from '../automation/whatsapp/private-dispatch.mjs';
import {PRIVATE_CHAT_REPLY} from '../ai/private-chat.mjs';

// Reviewer round 18: ordinary-role regression expectations against synthetic
// recipient indexes. The dense case attests every word, including homographs
// of registered names and identifiers. The remaining cases isolate observed
// false blocks and preserve citation controls. These are behavioral specs,
// not an implementation prescription or proof that POS alone is sufficient.
// R5 explicitly reconciles the bare compound expectation: an attested value
// after a personal verb can be its recipient. That case remains blocked;
// determiner-led grammar and source-imported generic copy must still pass.
const phone='+12025550901';
const frame=body=>({to:phone.slice(1),type:'text',text:{body}});

test('source generic reply survives all-token party, identifier and mixed indexes',async t=>{
 const words=[...new Set(PRIVATE_CHAT_REPLY.toLowerCase().match(/[a-z]+/g))];
 for(const forms of [['party:'],['identifier:'],['party:','identifier:']])await t.test(forms.join('+'),async()=>{
  const terms=words.flatMap(w=>forms.map(kind=>kind+w));
  const supabase={rpc:async()=>({data:{terms,identifiers:[],values:[],files:[]}})};
  const admission=await prepareWhatsAppDispatch({supabase,phone});
  assert.doesNotThrow(()=>admission(frame(PRIVATE_CHAT_REPLY)),'generic source copy must survive every attested token');
 });
});

test('ordinary noun/adverb/modal roles absorb attested homographs',async t=>{
 const cases=[
  ['party:can','I can only answer now.'],
  ['identifier:can','I can also send it.'],
  ['party:invoice','Answer the invoice questions.'],
  ['identifier:invoice','Use the invoice menu.'],
  ['party:records','I got it from verified records.'],
  ['party:request','Send an unrelated chat request separately.'],
  ['party:separately','Send it separately.'],
  ['party:review','Continue the upload review.'],
  ['party:check','Use the menu to check a balance.'],
  ['party:correct','Correct or confirm it.'],
  ['party:an','Send an invoice.'],
 ];
 for(const [term,body] of cases)await t.test(body,async()=>{
  const supabase={rpc:async()=>({data:{terms:[term],identifiers:[],values:[],files:[]}})};
  const admission=await prepareWhatsAppDispatch({supabase,phone});
  assert.doesNotThrow(()=>admission(frame(body)));
 });
});

test('capital, field, copula and proper citations of the same words still block',async t=>{
 const cases=[
  ['party:records','Customer name is Records'],
  ['party:records','The customer is records'],
  ['party:records','Customer: records'],
  ['party:records','Send it to Records.'],
  ['party:review','I billed Review yesterday'],
  ['party:questions','Questions owes 500.'],
  ['party:an','I billed An yesterday'],
  ['identifier:can','Invoice number on file is can'],
 ];
 for(const [term,body] of cases)await t.test('blocks '+body,async()=>{
  const supabase={rpc:async()=>({data:{terms:[term],identifiers:[],values:[],files:[]}})};
  const admission=await prepareWhatsAppDispatch({supabase,phone});
  assert.throws(()=>admission(frame(body)),{code:'PRIVATE_PAYLOAD_BLOCKED'});
 });
});

// Explicit R5 expectation reconciliation: Invoice can be a retained party or
// field in the first-object slot. A competing compound parse is not proof.
test('ambiguous former bare-compound positive remains conservatively blocked',async()=>{
 for(const kind of ['party:','identifier:']){const supabase={rpc:async()=>({data:{terms:[kind+'invoice'],identifiers:[],values:[],files:[]}})};const admission=await prepareWhatsAppDispatch({supabase,phone});assert.throws(()=>admission(frame('Answer invoice questions.')),{code:'PRIVATE_PAYLOAD_BLOCKED'});}
});
