import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildFrontend} from '../scripts/build-frontend.mjs';
import {watchAppVersion} from '../app-update.mjs';

test('frontend build fingerprints transitive imports and CSS, stamps assets, and is repeatable',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'cetld-frontend-'));
  try{
    await mkdir(path.join(root,'app'));
    for(const [file,content] of Object.entries({'app.js':"import './child.mjs';",'child.mjs':'export const x=1;', 'styles.css':'body{}','LatticeLoader.css':'div{}','app/index.html':'<meta name="app-version" content="development"><link href="/styles.css"><script src="/app.js"></script>'}))await writeFile(path.join(root,file),content);
    const first=await buildFrontend(root);assert.equal(await buildFrontend(root),first);
    assert.match(await readFile(path.join(root,'app/index.html'),'utf8'),new RegExp('/styles.css\\?v='+first));
    await writeFile(path.join(root,'child.mjs'),'export const x=2;');const second=await buildFrontend(root);assert.notEqual(first,second);
    await writeFile(path.join(root,'styles.css'),'body{color:red}');assert.notEqual(await buildFrontend(root),second);
  }finally{await rm(root,{recursive:true,force:true})}
});

test('version checks tolerate offline errors, prompt once, and require an explicit refresh',async()=>{
  const events={},nodes=[],version='a'.repeat(64);let polls,requests=0,reloads=0;
  const make=()=>({setAttribute(){},append(...items){this.children=items},addEventListener(name,fn){this[name]=fn}});
  const doc={querySelector:()=>({content:version}),visibilityState:'visible',body:{append:n=>nodes.push(n)},createElement:make,addEventListener:(n,f)=>events[n]=f,removeEventListener:n=>delete events[n]};
  const win={setInterval:f=>(polls=f,1),clearInterval(){},addEventListener:(n,f)=>events[n]=f,removeEventListener:n=>delete events[n],confirm:()=>false,location:{reload(){reloads++}}};
  const cleanup=watchAppVersion({document:doc,window:win,fetchImpl:async(url,options)=>{assert.equal(options.cache,'no-store');requests++;if(requests===1)throw Error('offline');return {ok:true,json:async()=>({version:'b'.repeat(64)})}}});
  await new Promise(r=>setImmediate(r));assert.equal(nodes.length,0);
  await events.focus();assert.equal(nodes.length,1);await polls();assert.equal(requests,2);
  const button=nodes[0].children[1];button.click();assert.equal(reloads,0);win.confirm=()=>true;button.click();assert.equal(reloads,1);cleanup();assert.deepEqual(Object.keys(events),[]);
});
