import test from 'node:test';import assert from 'node:assert/strict';
import {createServer} from 'node:net';import {randomUUID} from 'node:crypto';import {readFile,writeFile} from 'node:fs/promises';import {createNativePostgresFixture} from '../tests/fixtures/native-postgres.mjs';import {OFFLINE_SQL_BOOTSTRAP,offlineSqlMigrationSources} from '../tests/fixtures/offline-sql-network.mjs';
const out=[];
test('isolated parent/head cold numeric retention obeys the unchanged source statement budget',async t=>{
try{for(const version of ['61fea77','c5ce31c']){
 const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));const pg=await createNativePostgresFixture({port});let db;
 try{
  await pg.initialise();await pg.start();db=pg.getPgClient();await db.connect();await db.query(OFFLINE_SQL_BOOTSTRAP);for(let [file,sql]of await offlineSqlMigrationSources([])){if(version==='61fea77'&&file.includes('20261101120327'))sql=await readFile('work/migration-61fea77.sql','utf8');await db.query(sql);}await db.query("set statement_timeout='5s'");
  const owner=randomUUID();await db.query('insert into auth.users(id) values($1)',[owner]);await db.query(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}'`);const workspace=(await db.query('select (create_workspace($1,$2)).id',['Round7 numeric budget '+version,randomUUID()])).rows[0].id,c=(await db.query("insert into customers(workspace_id,name) values($1,'Budget Cedar') returning id",[workspace])).rows[0].id;
  for(const count of [33,100,500,900]){
   const notes=Array.from({length:count},(_,i)=>String(101+i)).join(','),request={sql:"insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status,notes) values($1,$2,$3,1250,'INR','draft',$4)",params:[workspace,c,version+'-'+count,notes]},start=performance.now();let result;
   try{await db.query(request.sql,request.params);result={ok:true};}catch(e){result={ok:false,code:e.code,message:e.message};}
   out.push({version,count,chars:notes.length,ms:performance.now()-start,request,result});await t.test(version+'/'+count,()=>assert.equal(result.ok,true,JSON.stringify(out.at(-1))));
  }
 }finally{if(db)await db.end().catch(()=>{});await pg.stop();}
}console.log(JSON.stringify(out));}finally{await writeFile('work/r7-numeric-budget-quiet.json',JSON.stringify(out,null,2));}

});
