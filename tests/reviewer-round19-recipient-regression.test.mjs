import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareWhatsAppDispatch} from '../automation/whatsapp/private-dispatch.mjs';
const phone='+12025550901';
// Recipient/direct-person readings must not be absorbed by a noun-compound
// interpretation merely because a following time adverb or object is NN.
for(const [word,body] of [
 ['review','I contacted review yesterday'],
 ['bill','I bought bill lunch.'],
 ['bill','I emailed bill records.'],
])for(const kind of ['party:','identifier:'])test(kind+word+' recipient: '+body,async()=>{
 const admission=await prepareWhatsAppDispatch({supabase:{rpc:async()=>({data:{terms:[kind+word],identifiers:[],values:[],files:[]}})},phone});
 assert.throws(()=>admission({to:phone.slice(1),type:'text',text:{body}}),{code:'PRIVATE_PAYLOAD_BLOCKED'});
});
