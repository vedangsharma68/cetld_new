import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import {createNativePostgresFixture} from './fixtures/native-postgres.mjs';
import {OFFLINE_SQL_BOOTSTRAP,offlineSqlMigrationSources} from './fixtures/offline-sql-network.mjs';
import {privateBackfillBatchSQL} from '../scripts/backfill-private-invoice-terms.mjs';

test('native dense numeric writes and a thousand-source cold rebuild obey unchanged statement and batch budgets',async()=>{
 await mkdir('work',{recursive:true});
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 const pg=await createNativePostgresFixture({port});let db;const evidence={statementTimeout:'5s',numbersPerNote:900,sourceRows:1000,seedStatements:[],backfill:[]};
 const note=offset=>Array.from({length:900},(_,i)=>String(101+(i+offset)%900)).join(',');
 try{
  await pg.initialise();await pg.start();db=pg.getPgClient();await db.connect();await db.query(OFFLINE_SQL_BOOTSTRAP);for(const [,sql] of await offlineSqlMigrationSources([]))await db.query(sql);
  await db.query("set statement_timeout='5s'");
  const owner=randomUUID();await db.query('insert into auth.users(id) values($1)',[owner]);await db.query("select set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claim.sub',$1,false)",[owner]);
  const workspace=(await db.query('select (create_workspace($1,$2)).id',['Dense scale fixture',randomUUID()])).rows[0].id,customer=(await db.query("insert into customers(workspace_id,name) values($1,'Scale Cedar Studio') returning id",[workspace])).rows[0].id;
  const ids=[];
  for(let start=0;start<1000;start+=59){
   const count=Math.min(59,1000-start),notes=Array.from({length:count},(_,i)=>note(start+i)),began=performance.now();
   const rows=(await db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status,notes) select $1,$2,'DENSE-'||($3::integer+n),1250,'INR','draft',value from unnest($4::text[]) with ordinality x(value,n) returning id",[workspace,customer,start,notes])).rows;
   assert.equal(rows.length,count);ids.push(...rows.map(r=>r.id));evidence.seedStatements.push({rows:count,ms:performance.now()-began});
  }
  // Different raw bodies force a cold notes parse, rather than reusing the
  // preceding capture cache. The SQL statement still contains 59 source rows.
  const updates=Array.from({length:59},(_,i)=>note(i).replace('101','0101')),beganUpdate=performance.now();
  assert.equal((await db.query('update invoices i set notes=n.value from unnest($1::uuid[],$2::text[]) n(id,value) where i.id=n.id',[ids.slice(0,59),updates])).rowCount,59);
  evidence.cold59RowUpdateMs=performance.now()-beganUpdate;
  await db.query('truncate whatsapp_private_invoice_terms');
  assert.equal((await db.query('select count(*)::int n from app.private_invoice_canonical_inputs')).rows[0].n,0);
  let complete=false,rows=0;const beganBackfill=performance.now();
  for(let batch=0;!complete;batch++){
   assert.ok(batch<1005,'Every committed batch must make bounded progress');
   const began=performance.now(),result=await db.query(privateBackfillBatchSQL(25)),status=result.find(x=>x.rows?.[0]?.result)?.rows[0].result;
   assert.ok(status);assert.ok(status.rows<=25);assert.equal(status.busy,undefined);
   evidence.backfill.push({rows:status.rows,source:status.source,ms:performance.now()-began});rows+=status.rows;complete=status.allComplete;
  }
  evidence.aggregateBackfillMs=performance.now()-beganBackfill;evidence.rebuiltSourceRows=rows;assert.equal(rows,1000);
  evidence.aliasRows=(await db.query('select count(*)::int n from whatsapp_private_invoice_terms where workspace_id=$1',[workspace])).rows[0].n;
  assert.equal((await db.query("select count(*)::int n from whatsapp_private_invoice_backfill where complete")).rows[0].n,4);
  console.log(JSON.stringify({denseSourceRows:1000,cold59RowUpdateMs:evidence.cold59RowUpdateMs,maxSeedStatementMs:Math.max(...evidence.seedStatements.map(x=>x.ms)),maxBackfillStatementMs:Math.max(...evidence.backfill.map(x=>x.ms)),aggregateBackfillMs:evidence.aggregateBackfillMs,aliasRows:evidence.aliasRows}));
 }finally{if(db)await db.end().catch(()=>{});await pg.stop();await writeFile('work/r8-numeric-scale.json',JSON.stringify(evidence,null,2));}
});
