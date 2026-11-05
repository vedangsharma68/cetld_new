#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import path from 'node:path';
export function privateBackfillBatchSQL(batchSize=25){
 if(!Number.isInteger(batchSize)||batchSize<1||batchSize>100)throw new TypeError('Batch size must be 1..100');
 return `begin;set local lock_timeout='250ms';set local statement_timeout='5s';select app.backfill_private_invoice_terms(${batchSize}) result;commit;`;
}
async function psqlBatch(sql){
 // Standard PG* environment selects the operator's database. No URL/password is
 // placed in argv or logs. Each psql process commits one batch then disconnects.
 const child=(await import('node:child_process')).spawn('psql',['-X','-q','-A','-t','--set','ON_ERROR_STOP=1','--set','VERBOSITY=sqlstate'],{stdio:['pipe','pipe','pipe']});
 let output='';child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.resume();child.stdin.end(sql);
 await new Promise((resolve,reject)=>{child.once('error',()=>reject(new Error('PSQL_UNAVAILABLE')));child.once('exit',code=>code===0?resolve():reject(new Error('BACKFILL_BATCH_ROLLED_BACK')));});
 return JSON.parse(output.trim());
}
export async function runPrivateInvoiceBackfill({execute=psqlBatch,batchSize=25,onBatch=()=>{}}={}){
 for(;;){const status=await execute(privateBackfillBatchSQL(batchSize));await onBatch(status);if(status.allComplete)return status;
  if(status.busy)await new Promise(resolve=>setTimeout(resolve,50));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const batchSize=process.argv[2]===undefined?25:Number(process.argv[2]);
 try{await runPrivateInvoiceBackfill({batchSize,onBatch:status=>process.stdout.write(JSON.stringify(status)+'\n')});}
 catch(error){process.stderr.write('Private invoice backfill stopped: '+error.message+'. No partial batch committed.\n');process.exitCode=1;}
}
