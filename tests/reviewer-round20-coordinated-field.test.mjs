import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareWhatsAppDispatch} from '../automation/whatsapp/private-dispatch.mjs';
const phone='+12025550901';
async function make(kind){return prepareWhatsAppDispatch({supabase:{rpc:async()=>({data:{terms:[kind+'review'],identifiers:[],values:[],files:[]}})},phone});}
const frame=body=>({to:phone.slice(1),type:'text',text:{body}});
for(const kind of ['party:','identifier:','party-ref:','party-inferred:']){
 for(const body of ['Customer: the invoice and review','Customer name is the invoice and review','The customer is the invoice or the review','The client was the invoice and the review','Invoice number is the invoice and review'])test(kind+' explicit coordinated field: '+body,async()=>{
  const admission=await make(kind);
  assert.throws(()=>admission(frame(body)),{code:'PRIVATE_PAYLOAD_BLOCKED'});
 });
 for(const body of ['Customer: a label. You can review the invoice.','Send the invoice and review it.'])test(kind+' independent ordinary role: '+body,async()=>{
  const admission=await make(kind);
  assert.doesNotThrow(()=>admission(frame(body)));
 });
}
