import test from 'node:test';import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';import {setup} from './fixtures/reviewer-round8-harness.mjs';
const evidence=[];test.after(()=>writeFile('work/r8-topic-routing.json',JSON.stringify(evidence,null,2)));
test('ordinary people and nonfinancial meanings remain ordinary in marked and unmarked workspaces',async t=>{
 const f=await setup();try{for(const marked of [false,true]){
  if(marked){const r=await f.supabase.rpc('owner_assistant_offline_provenance',{p_workspace_id:f.scope.workspaceId,p_owner_id:f.scope.ownerId,p_mark:true});assert.equal(r.data,true);f.restart();}
  for(const audience of ['owner','customer'])for(const input of ["What does 'paid attention' mean?",'Is Bill Nye a scientist?','Is Bill Gates a scientist?','Explain why the balance of an ecosystem matters','Explain photosynthesis'])await t.test(audience+'/'+marked+'/'+input,async()=>{await f.clear();const row={kind:'ordinary-topic',privateTurn:false,marked,...await f.turn(audience,input)};evidence.push(row);assert.equal(row.wires.length,1,JSON.stringify(row));});
 }}finally{await f.close();}
});
