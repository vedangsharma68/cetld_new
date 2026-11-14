import {createOfflineSqlNetwork as createNetwork} from './offline-sql-network.mjs';
import {privateBackfillBatchSQL} from '../../scripts/backfill-private-invoice-terms.mjs';
import {readFile} from 'node:fs/promises';
export async function completeDispatchFixtureSchema(db){
 if(!(await db.query("select to_regclass('public.whatsapp_private_invoice_backfill') present")).rows[0].present)
  await db.exec(await readFile(new URL('../../supabase/migrations/20261101120327_private_whatsapp_chat_memory.sql',import.meta.url),'utf8'));
 for(;;){const batches=await db.exec(privateBackfillBatchSQL());if(batches.find(r=>r.rows?.[0]?.result)?.rows[0].result.allComplete)break;}
}
// Historical reminder fixtures install the privacy migration later themselves.
// Opt those fixtures into the same real bootstrap completion used by ordinary
// createOfflineSqlNetwork. Readiness/rollback tests keep the original fixture.
export async function createOfflineSqlNetwork(options){
 const f=await createNetwork(options),exec=f.db.exec.bind(f.db);
 f.db.exec=async(sql,...args)=>{
  const result=await exec(sql,...args);
  if(typeof sql==='string'&&/\bcreate(?:\s+or\s+replace)?\s+function\s+app\.backfill_private_invoice_terms\s*\(/i.test(sql)){
   for(;;){const batches=await exec(privateBackfillBatchSQL());if(batches.find(r=>r.rows?.[0]?.result)?.rows[0].result.allComplete)break;}
  }
  return result;
 };
 return f;
}
