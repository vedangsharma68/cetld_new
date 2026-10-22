import {deadlineFetch} from './invoice-sync.mjs';
import {timingSafeEqual} from 'node:crypto';
import {SupabaseAccountingStore} from './accounting/store.mjs';
import {createAccountingRuntime} from './runtime.mjs';
import {invoiceSyncPersistence} from './invoice-sync-store.mjs';
import {retryAssistantInvoiceSync} from '../ai/invoice-ops.mjs';

export function createInvoiceReconcileStore({env=process.env,fetchImpl=fetch}={}) {
  const db = new SupabaseAccountingStore({url:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl});
  return {
    async connections() {
      // Fetch only non-secret identity fields. Keyset pagination avoids a fixed
      // workspace limit silently dropping later tenants.
      const result=[]; let cursor=null;
      for (;;) {
        const params=new URLSearchParams({provider:'eq.zoho_books',status:'eq.connected',provider_account_id:'not.is.null',api_domain:'not.is.null',select:'owner_id,workspace_id',order:'workspace_id.asc',limit:'100',...(cursor?{workspace_id:`gt.${cursor}`}:{})});
        const rows=await db.request(`${db.table}?${params}`);
        result.push(...rows); if(rows.length<100)break; cursor=rows.at(-1).workspace_id;
      }
      return result;
    },
    async candidates(connections, now) {
      const workspaceIds=[...new Set(connections.map(c=>c.workspace_id))], candidates=[];
      for(let offset=0;offset<workspaceIds.length;offset+=100) {
        const rows=await db.request(`invoices?${new URLSearchParams({workspace_id:`in.(${workspaceIds.slice(offset,offset+100).join(',')})`,deleted_at:'is.null',external_invoice_id:'is.null',status:'not.in.(void,cancelled)',
          'metadata->>bookkeeping_record_id':'is.null',
          and:'(or(metadata->>bookkeeping_sync_status.in.(pending,failed,not_configured),metadata->>bookkeeping_sync_status.is.null),or(metadata->>invoice_direction.neq.payable,metadata->>invoice_direction.is.null),or(metadata->>bookkeeping_sync_exhausted.is.null,metadata->>bookkeeping_sync_exhausted.neq.true))',
          or:`(metadata->>bookkeeping_sync_next_at.is.null,metadata->>bookkeeping_sync_next_at.lte.${now})`,select:'id,workspace_id,created_at',order:'created_at.asc,id.asc',limit:'25'})}`);
        candidates.push(...rows);
      }
      return candidates.sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id)).slice(0,25);
    },
    scoped(connection) {
      const workspaceId=connection.workspace_id;
      const query=async(table,{select='*',filters={},limit=10}={})=>db.request(`${table}?${new URLSearchParams({...filters,workspace_id:`eq.${workspaceId}`,select,limit:String(limit)})}`);
      const read=async id=>(await query('invoices',{filters:{id:`eq.${id}`,deleted_at:'is.null'}}))[0] || null;
      const patch=async(row,body)=>(await db.request(`invoices?${new URLSearchParams({workspace_id:`eq.${workspaceId}`,id:`eq.${row.id}`,updated_at:`eq.${row.updated_at}`,deleted_at:'is.null',select:'*'})}`,{method:'PATCH',headers:{'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify(body)}))[0] || null;
      return {workspaceId,userId:connection.owner_id,query,getAssistantInvoice:read,
        ...invoiceSyncPersistence({read,patch}),
        async updateAssistantInvoiceMetadata(id,metadata,fields={}) {
          const row=await read(id); if(!row)throw Error('Invoice unavailable');
          const saved=await patch(row,{metadata,...fields}); if(!saved)throw Error('Invoice changed'); return saved;
        },

      };
    }
  };
}
export async function reconcileInvoiceSync({store,accounting,clock=()=>new Date(),budgetMs=240_000}={}) {
  const started=clock().getTime(),results=[];
  const connections=await store.connections();
  const byWorkspace=new Map(),blockedWorkspaces=new Set();
  for(const connection of connections)if(!byWorkspace.has(connection.workspace_id))byWorkspace.set(connection.workspace_id,connection);
  for(const row of await store.candidates(connections,clock().toISOString())) {
    if(clock().getTime()-started>=budgetMs || results.length>=25)break;
    const connection=byWorkspace.get(row.workspace_id);if(!connection || blockedWorkspaces.has(row.workspace_id))continue;
    try {
      const result=await retryAssistantInvoiceSync({store:store.scoped(connection),invoiceId:row.id,accounting,clock,manualRetry:false});
      results.push({invoiceId:row.id,status:result.sync.status});
      if(result.sync.status==='not_configured' || [401,403,429,500,502,503,504].includes(result.invoice?.metadata?.bookkeeping_sync_http_status))blockedWorkspaces.add(row.workspace_id);
    } catch { results.push({invoiceId:row.id,status:'error'}); }
  }
  return {processed:results.length,results};
}

export function createInvoiceReconcileHandler({env=process.env,fetchImpl=fetch,storeFactory=createInvoiceReconcileStore,accountingFactory=createAccountingRuntime,clock}={}) {
  return async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    if(req.method!=='GET')return res.status(405).json({error:'GET required'});
    const expected=env.CRON_SECRET?Buffer.from(`Bearer ${env.CRON_SECRET}`):null,actual=Buffer.from(String(req.headers?.authorization||''));
    if(!expected || actual.length!==expected.length || !timingSafeEqual(actual,expected))return res.status(401).json({error:'Unauthorized'});
    const boundedFetch=deadlineFetch(fetchImpl,260_000);
    try { return res.status(200).json(await reconcileInvoiceSync({store:storeFactory({env,fetchImpl:boundedFetch}),accounting:accountingFactory({env,fetchImpl:boundedFetch}),clock})); }
    catch { return res.status(503).json({error:'Invoice sync scheduler unavailable'}); }
  };
}
