import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareWhatsAppDispatch} from '../automation/whatsapp/private-dispatch.mjs';
const phone='+12025550901';
const frame=body=>({to:phone.slice(1),type:'text',text:{body}});
const pairs=[['“','”'],['‘','’'],['«','»'],['「','」']];
async function make(kind){return prepareWhatsAppDispatch({supabase:{rpc:async()=>({data:{terms:[kind+'review'],identifiers:[],values:[],files:[]}})},phone});}
for(const kind of ['party:','identifier:','party-ref:','party-inferred:'])for(const [open,close] of pairs){
 test(kind+' open field literal retains action-looking continuation '+open+close,async()=>{
  const admission=await make(kind);
  assert.throws(()=>admission(frame('Customer: '+open+'a label\nYou can review the invoice'+close)),{code:'PRIVATE_PAYLOAD_BLOCKED'});
 });
 test(kind+' completed quoted value permits independent action '+open+close,async()=>{
  const admission=await make(kind);
  assert.doesNotThrow(()=>admission(frame('Customer: '+open+'a label'+close+'\nYou can review the invoice.')));
 });
}
