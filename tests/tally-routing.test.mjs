import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile, access} from 'node:fs/promises';
import handler from '../api/invoice-lifecycle.js';
import {config} from '../config.js';

const WORKSPACE='10000000-0000-4000-8000-000000000001';
const OWNER='20000000-0000-4000-8000-000000000001';
const OWNER_JWT='Bearer owner-jwt-from-dashboard';
const savedFetch=globalThis.fetch;
const savedURL=process.env.SUPABASE_URL;
const savedKey=process.env.SUPABASE_PUBLISHABLE_KEY;
afterEach(()=>{
 globalThis.fetch=savedFetch;
 if(savedURL===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=savedURL;
 if(savedKey===undefined)delete process.env.SUPABASE_PUBLISHABLE_KEY;else process.env.SUPABASE_PUBLISHABLE_KEY=savedKey;
});
function response(){return {statusCode:null,body:null,status(code){this.statusCode=code;return this},json(body){this.body=body;return this}}}
function transport({role='owner'}={}){
 delete process.env.SUPABASE_URL;delete process.env.SUPABASE_PUBLISHABLE_KEY;
 const calls=[];let writes=0;
 const plan={planHash:'db-plan-v1',workspaceCurrency:'INR',customers:[{name:'Acme',email:'',phone:'',guid:'',originalId:'',action:'create',reason:null,customerRef:'new:1'}],invoices:[],counts:{customers:{created:1,skipped:0,failed:0},invoices:{created:0,skipped:0,failed:0}}};
 globalThis.fetch=async(input,init={})=>{
  const url=new URL(String(input));calls.push({url,init});
  if(url.pathname==='/auth/v1/user')return Response.json({id:OWNER});
  if(url.pathname==='/rest/v1/workspace_members')return Response.json([{workspace_id:WORKSPACE,user_id:OWNER,role}]);
  if(url.pathname==='/rest/v1/workspace_settings')return Response.json([{default_currency:'INR'}]);
  if(url.pathname==='/rest/v1/rpc/preview_tally')return Response.json(plan);
  if(url.pathname==='/rest/v1/rpc/import_tally'){writes++;return Response.json({customers:{created:1,skipped:0,failed:0},invoices:{created:0,skipped:0,failed:0},failures:[]})}
  throw Error(`Unexpected request ${url.pathname}`);
 };
 return {calls,plan,get writes(){return writes}};
}
async function invoke(route,body,{method='POST',authorization=OWNER_JWT}={}){
 const res=response();await handler({method,headers:authorization?{authorization}:{},body,...route},res);return res;
}
test('Tally shares the lifecycle function and keeps the complete deployment inside the Hobby budget',async()=>{
 const root=new URL('../',import.meta.url),runtime=/\.(?:[cm]?[jt]s|[jt]sx|py|go|rb|rs)$/i;
 async function entries(directory){const result=[];for(const entry of await readdir(directory,{withFileTypes:true})){const path=new URL(entry.name+(entry.isDirectory()?'/':''),directory);if(entry.isDirectory())result.push(...await entries(path));else if(runtime.test(entry.name))result.push(path.pathname)}return result}
 const api=await entries(new URL('api/',root));
 const middleware=(await readdir(root)).filter(name=>/^middleware\.(?:[cm]?[jt]s|[jt]sx)$/.test(name));
 assert.ok(api.length+middleware.length<=12,`${api.length} API functions + ${middleware.length} middleware functions exceed Hobby's 12-function limit`);
 assert.equal(api.some(path=>path.endsWith('/api/tally-import.js')),false);
 await assert.rejects(access(new URL('api/tally-import.js',root)),{code:'ENOENT'});
 const vercel=JSON.parse(await readFile(new URL('vercel.json',root),'utf8'));
 assert.deepEqual(vercel.rewrites.find(rewrite=>rewrite.source==='/api/tally-import'),{source:'/api/tally-import',destination:'/api/invoice-lifecycle?route=tally-import'});
});
test('the shared endpoint previews a Tally payload above the lifecycle cap and confirms only the reviewed plan',async()=>{
 const f=transport();const content='Name,GSTIN\nAcme,'+'x'.repeat(20000);
 const body=JSON.stringify({action:'preview',workspaceId:WORKSPACE,filename:'tally.csv',content});assert.ok(Buffer.byteLength(body)>8192);
 const preview=await invoke({url:'/api/invoice-lifecycle?route=tally-import'},body);
 assert.equal(preview.statusCode,200);assert.equal(preview.body.plan.counts.customers.created,1);assert.equal(f.writes,0);
 assert.equal(f.calls.some(({url})=>url.pathname.includes('invoice_lifecycle_action')),false);
 const bad=await invoke({url:'/api/tally-import'},{action:'confirm',workspaceId:WORKSPACE,filename:'tally.csv',content,previewId:'unreviewed',planHash:f.plan.planHash});
 assert.equal(bad.statusCode,400);assert.equal(f.writes,0);
 const confirmation=await invoke({url:'/api/tally-import'},{action:'confirm',workspaceId:WORKSPACE,filename:'tally.csv',content,previewId:preview.body.previewId,planHash:f.plan.planHash});
 assert.equal(confirmation.statusCode,200);assert.equal(f.writes,1);assert.equal(confirmation.body.customers.created,1);
 for(const {url,init} of f.calls){assert.equal(url.origin,config.url);assert.equal(init.headers.apikey,config.key);assert.equal(init.headers.Authorization,OWNER_JWT)}
 const rpc=f.calls.find(({url})=>url.pathname.endsWith('/import_tally'));assert.equal(JSON.parse(rpc.init.body).p_expected_hash,f.plan.planHash);
});
test('query, rewritten URL and public path dispatch to Tally and preserve its POST-only behavior',async()=>{
 transport();
 for(const route of [{url:'/api/invoice-lifecycle',query:{route:'tally-import'}},{url:'/api/invoice-lifecycle?route=tally-import'},{url:'/api/tally-import'}]){
  const res=await invoke(route,undefined,{method:'GET'});assert.equal(res.statusCode,405);assert.deepEqual(res.body,{error:'Use POST.'});
 }
});
test('Tally routing retains authentication and owner checks before any preview or write RPC',async()=>{
 const body={action:'preview',workspaceId:WORKSPACE,filename:'tally.csv',content:'Name\nAcme'};
 let f=transport();const unsigned=await invoke({url:'/api/tally-import'},body,{authorization:null});assert.equal(unsigned.statusCode,401);assert.equal(f.calls.length,0);
 f=transport({role:'member'});const member=await invoke({url:'/api/invoice-lifecycle',query:{route:'tally-import'}},body);assert.equal(member.statusCode,403);assert.match(member.body.error,/Only the workspace owner/);assert.equal(f.calls.some(({url})=>url.pathname.includes('/rpc/')),false);
});
