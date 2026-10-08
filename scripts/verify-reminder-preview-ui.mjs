import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Isolated full-app browser fixture. Every API and external request is intercepted.
// It never uses a real session, provider or database, and never clicks Send one test.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {chromium}=createRequire(import.meta.url)(process.env.CETLD_PLAYWRIGHT_PATH||'playwright');
const artifacts=process.env.CETLD_PREVIEW_ARTIFACTS||'/tmp/cetld-reminder-preview-browser-artifacts';
await mkdir(artifacts,{recursive:true});
const baseline=process.env.CETLD_PREVIEW_BASELINE_REF;
const baselineApp=baseline?execFileSync('git',['show',baseline+':app.js'],{cwd:root,encoding:'utf8'}):null;
const settingsScript=await readFile(path.join(root,'scripts/verify-settings-ux.mjs'),'utf8');
const moduleFunction=settingsScript.slice(settingsScript.indexOf('function supabaseModule()'),settingsScript.indexOf('async function installMocks'));
const fixture={user:{id:'preview-owner',email:'preview@example.test',user_metadata:{full_name:'Preview QA'}},profile:{user_id:'preview-owner',full_name:'Preview QA'},workspace:{id:'preview-workspace',owner_id:'preview-owner',name:'Preview QA Business',created_at:'2026-01-01T00:00:00Z'},settings:{workspace_id:'preview-workspace',business_name:'Preview QA Business',default_currency:'INR',default_timezone:'Asia/Kolkata',whatsapp_owner_phone:'+919871367051'}};
const baseModule=vm.runInNewContext(moduleFunction+'supabaseModule()',{fixture}).replace('gte() { return this; }','gte() { return this; } is() { return this; } in() { return this; } not() { return this; } neq() { return this; }');
let serverPosts=0;
const server=createServer(async(req,res)=>{
  try{
    if(req.method!=='GET'){serverPosts++;res.writeHead(405);res.end();return;}
    const name=new URL(req.url,'http://localhost').pathname;const file=path.resolve(root,'.'+(name==='/app/'?'/app/index.html':name));
    if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
    const content=name==='/app.js'&&baselineApp?baselineApp:await readFile(file);
    const type=name.endsWith('.js')||name.endsWith('.mjs')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':'text/html';res.writeHead(200,{'Content-Type':type});res.end(content);
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.CETLD_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',args:['--no-sandbox']});
const report={baseline:baseline||null,cases:[],whatsappPostRequests:0,serverPostRequests:0,productionRequests:0};
const preview={test:true,synthetic:true,recipient:'+919871367051',language:'en',templateName:'cetld_invoice_update_v2',text:'Hi, this is Preview QA Business. Invoice CETLD-TEST-20261005 for Preview QA has an update.'};
async function scenario(name,{hold=false,error=false,staleSession=false,holdAuth=false}={}){
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),requests=[],held=[];const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  let fail=error;
  const module=baseModule.replace("const session = { access_token:",`const session = { expires_at: ${staleSession?0:Math.floor(Date.now()/1000)+3600}, access_token:`).replace('async getSession() { return', 'async getSession() { if(window.__holdPreviewToken)return await new Promise(resolve=>window.__resolvePreviewToken=()=>resolve({data:{session},error:null})); return');
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.href==='https://esm.sh/@supabase/supabase-js@2.116.0')return route.fulfill({status:200,contentType:'application/javascript',body:module});
    if(url.origin!==origin){report.productionRequests++;return route.abort();}
    if(!url.pathname.startsWith('/api/'))return route.continue();
    if(url.pathname==='/api/whatsapp-test-send'){
      const request=route.request();requests.push({method:request.method(),action:url.searchParams.get('action')});
      if(request.method()!=='GET'){report.whatsappPostRequests++;return route.abort();}
      if(hold){held.push(route);return;}
      return route.fulfill({status:fail?409:200,json:fail?{error:'TEST_RECIPIENT_INELIGIBLE'}:preview});
    }
    return route.fulfill({status:200,json:url.searchParams.get('action')==='settings'?{role:'owner',primary_model:'@cf/meta/llama-3.3-70b-instruct-fp8-fast',fallback_model:null}:url.searchParams.get('action')==='models'?{models:[],fallbackModels:[],extractionModels:[]}:{}});
  });
  await page.goto(origin+'/app/',{waitUntil:'domcontentloaded'});await page.locator('.utility-nav [data-page="Settings"]').click();
  const button=page.getByRole('button',{name:'Preview test message',exact:true});await button.waitFor();
  if(holdAuth)await page.evaluate(()=>{window.__holdPreviewToken=true});
  await page.clock.install();await button.click();await page.waitForTimeout(80);
  if(baseline){assert.equal(await page.locator('#dialog').evaluate(d=>d.open),false);assert.equal(await button.isDisabled(),false);assert.equal(requests.length,1);report.cases.push({name:'baseline stalled GET',dialog:false,loading:false,requests:requests.length});await context.close();return;}
  if(hold||holdAuth&&staleSession){
    assert.equal(await page.locator('#dialog').evaluate(d=>d.open),true);assert.match(await page.locator('#dialog [role=status]').textContent(),/Preparing test preview/);assert.equal(await button.isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Try preview again'}).isVisible(),false);assert.equal(await page.locator('[data-action=reminder-proof-send]').count(),0);
    await button.dispatchEvent('click');assert.equal(requests.length,holdAuth?0:1);
    await page.screenshot({path:path.join(artifacts,name+'-loading.png')});
    if(name==='cancel'){
      await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await page.locator('#dialog').evaluate(d=>d.open),false);
      for(const route of held)await route.fulfill({json:preview}).catch(()=>{});await page.waitForTimeout(80);assert.equal(await page.locator('#dialog').evaluate(d=>d.open),false);
    }else{
      await page.clock.fastForward(30001);await page.getByRole('alert').filter({hasText:'Preview timed out'}).waitFor();assert.equal(await page.locator('[data-action=reminder-proof-send]').count(),0);
      if(holdAuth){await page.evaluate(()=>{window.__holdPreviewToken=false;window.__resolvePreviewToken?.()});await page.waitForTimeout(80);assert.equal(requests.length,0);}
      await page.screenshot({path:path.join(artifacts,name+'-timeout.png')});
    }
  }else if(error){
    await page.getByRole('alert').filter({hasText:'not currently eligible'}).waitFor();assert.equal(await page.locator('[data-action=reminder-proof-send]').count(),0);await page.screenshot({path:path.join(artifacts,name+'-error.png')});
    fail=false;await page.getByRole('button',{name:'Try preview again'}).click();await page.getByRole('button',{name:'Send one test',exact:true}).waitFor();assert.equal(requests.length,2);
  }else{
    await page.getByRole('button',{name:'Send one test',exact:true}).waitFor();assert.match(await page.locator('#dialog').textContent(),/CETLD-TEST-20261005/);assert.equal(requests.length,1);await page.screenshot({path:path.join(artifacts,name+'-review.png')});
  }
  assert.equal(errors.length,0,errors.join('\n'));assert.equal(requests.every(r=>r.method==='GET'&&r.action==='approved-template-test'),true);report.cases.push({name,requests:requests.length,pageErrors:errors.length});await context.close();
}
try{
  if(baseline)await scenario('baseline',{hold:true});else{
    await scenario('success');await scenario('slow-get',{hold:true});await scenario('cancel',{hold:true});await scenario('auth-cache',{holdAuth:true});await scenario('expired-auth',{staleSession:true,holdAuth:true});await scenario('error',{error:true});
  }
  report.serverPostRequests=serverPosts;assert.equal(report.whatsappPostRequests,0);assert.equal(serverPosts,0);assert.equal(report.productionRequests,0);await writeFile(path.join(artifacts,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
