import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

test('an in-flight assistant reply cannot render or change loading state after switching accounts',async()=>{
 const source=await readFile(new URL('../app.js',import.meta.url),'utf8');
 const send=source.slice(source.indexOf('async function sendAssistant('),source.indexOf('function extractionField('));
 let finish,progress;
 const pending=new Promise(resolve=>{finish=resolve;});
 const state={user:{id:'owner-a'},workspace:{id:'business-a'},assistantMessages:[],assistantStatus:'idle'};
 const context={state,render(){},scrollAssistant(){},assistantWorkingCopy:()=>'',assistantClient:{send(options){progress=options.onProgress;return pending;}},requestAnimationFrame(){},document:{querySelector(){throw Error('No stale reply may touch the DOM');}},$:()=>null};
 runInNewContext(send+';globalThis.sendAssistant=sendAssistant;',context);
 const operation=context.sendAssistant('What is overdue?');
 state.user={id:'owner-b'};state.workspace={id:'business-b'};state.assistantMessages=[];state.assistantStatus='loading';state.assistantError='New account status';
 progress('Private owner A reply');finish('Private owner A reply');await operation;
 assert.deepEqual(state.assistantMessages,[]);assert.equal(state.assistantStatus,'loading');assert.equal(state.assistantError,'New account status');
});
