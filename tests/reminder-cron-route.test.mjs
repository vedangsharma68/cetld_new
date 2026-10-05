import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createWhatsAppProcessHandler} from '../api/whatsapp-process.js';
import {createReminderCronHandler} from '../automation/reminder-cron.mjs';

test('two daily cron jobs share the existing function without exceeding Hobby function count',async()=>{
  const config=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));
  assert.deepEqual(config.crons,[{path:'/api/whatsapp-process',schedule:'0 0 * * *'},
    {path:'/api/whatsapp-process',schedule:'0 4 * * *'}]);
  const routes=(await readdir(new URL('../api/',import.meta.url))).filter(name=>/\.(?:js|ts|mjs)$/.test(name));
  assert.ok(routes.length<=12,`Deployment would contain ${routes.length} API functions`);
  assert.equal(routes.includes('reminders.js'),false);
});

test('reminder cron selection still authenticates and stays disabled before any runtime or send',async()=>{
  let runtimeCalls=0,processCalls=0;
  const route=createWhatsAppProcessHandler({processHandler:()=>processCalls++,
    reminderHandler:createReminderCronHandler({env:{CRON_SECRET:'isolated-test'},
      runtimeFactory:()=>{runtimeCalls++;throw Error('must not run');}})});
  const response=()=>({code:null,body:null,setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}});
  let res=response();
  await route({method:'GET',headers:{'x-vercel-cron-schedule':'0 4 * * *'}},res);
  assert.equal(res.code,401);
  res=response();
  await route({method:'GET',headers:{'x-vercel-cron-schedule':'0 4 * * *',authorization:'Bearer isolated-test'}},res);
  assert.equal(res.code,200);assert.deepEqual(res.body,{disabled:true,processed:0});
  assert.equal(runtimeCalls,0);assert.equal(processCalls,0);
});

test('midnight and manual processing preserve the existing authenticated handler and forced process flag',async()=>{
  const received=[];
  const route=createWhatsAppProcessHandler({processHandler:req=>received.push(req),reminderHandler:()=>assert.fail('wrong route')});
  for(const headers of [{'x-vercel-cron-schedule':'0 0 * * *',authorization:'Bearer fixture'},{}])
    await route({method:'GET',headers,query:{process:'0'},url:'/api/whatsapp-process'},{});
  assert.equal(received.length,2);
  assert.ok(received.every(req=>req.query.process==='1'));
  assert.equal(received[0].headers.authorization,'Bearer fixture');
});
