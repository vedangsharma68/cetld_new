import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareWhatsAppDispatch} from '../automation/whatsapp/private-dispatch.mjs';
const phone='+12025550901';
const frame=body=>({to:phone.slice(1),type:'text',text:{body}});
async function make(kind){return prepareWhatsAppDispatch({supabase:{rpc:async()=>({data:{terms:[kind+'review'],identifiers:[],values:[],files:[]}})},phone});}
for(const kind of ['party:','identifier:','party-ref:','party-inferred:']){
 for(const body of ['Customer:\nthe review','Customer name is\nthe review','Customer: the invoice\nand the review'])test(kind+' field formatting does not end declaration: '+JSON.stringify(body),async()=>{
  const admission=await make(kind);assert.throws(()=>admission(frame(body)),{code:'PRIVATE_PAYLOAD_BLOCKED'});
 });
 for(const body of ['Customer: a label\nYou can review the invoice.','Customer: a label. You can review the invoice.'])test(kind+' independent ordinary clause stays usable: '+JSON.stringify(body),async()=>{
  const admission=await make(kind);assert.doesNotThrow(()=>admission(frame(body)));
 });
}
