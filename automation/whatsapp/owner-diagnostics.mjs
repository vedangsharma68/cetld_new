import {resolveOwnerBinding} from './owner-binding.mjs';
import {createOwnerMessageHandler} from './owner-handler.mjs';
import {createOwnerWorkspaceTools} from './owner-workspace-tools.mjs';
import {createProviderHealthStore} from '../../ai/provider-health.mjs';
import {randomUUID} from 'node:crypto';

/** Internal opt-in live probe. The caller must pass the processor's cron auth.
 * It never sends WhatsApp messages, persists proposals or changes ledger data.
 * Every data operation still uses the ordinary verified-owner server tool. */
export async function diagnoseOwnerChat({supabase,env=process.env,fetchImpl=fetch,logger=console,
  scenario='john-invoices',forceCloudflareUnavailable=false,providerFactory}={}){
  const questions={'john-invoices':'tell me about johns invoices',meta:'which model r u usin'};
  if(!Object.hasOwn(questions,scenario))throw new TypeError('Unsupported diagnostic scenario');
  const candidates=String(env.WHATSAPP_TEST_ALLOWLIST||'').split(',').map(value=>value.trim()).filter(value=>/^\+[1-9]\d{6,14}$/.test(value));
  let binding,phone;
  for(const candidate of candidates){const found=await resolveOwnerBinding({supabase,phone:candidate});if(found){binding=found;phone=candidate;break;}}
  if(!binding)return {ok:false,code:'VERIFIED_TEST_OWNER_REQUIRED'};
  const health=createProviderHealthStore({env,fetchImpl,logger});
  const healthStore=forceCloudflareUnavailable?{getUnavailableUntil:identity=>identity.provider==='cloudflare'
    ?Promise.resolve(Date.now()+60_000):health.getUnavailableUntil(identity),markUnavailable:(...args)=>health.markUnavailable(...args)}:health;
  const events=[];let invoiceRows=0,invoiceQueries=0;const invoiceNumbers=new Set(),operations=[];
  const safeFields=new Set(['id','customer_id','name','company_name','email','phone','invoice_number','customer_name','issue_date','due_date','currency','total_amount','amount_paid','status','notes','primary_model','fallback_model']);
  const safeField=value=>safeFields.has(value)?value:'unknown';
  const probeLogger={info(event,fields){events.push({event,fields});logger?.info?.(event,fields);},warn:(...args)=>logger?.warn?.(...args),error:(...args)=>logger?.error?.(...args)};
  const handler=createOwnerMessageHandler({supabase,env,fetchImpl,logger:probeLogger,healthStore,replyStore:null,
    ...(providerFactory?{providerFactory}:{}),toolsFactory(options){
      const tools=createOwnerWorkspaceTools(options);
      const definitions=structuredClone(tools.definitions);
      const definition=definitions.find(item=>item.function.name==='workspaceData');
      delete definition.function.parameters.properties.request;
      definition.function.description+=' Diagnostic: structured reads only.';
      return {...tools,definitions,async execute(name,args,context){
        if(name!=='getAIProviderConfiguration'&&(name!=='workspaceData'||args?.request!==undefined||!['read','describe','pending'].includes(args?.operation)))
          return {ok:false,code:'DENIED',readOnly:true,message:'Live diagnostics permit structured reads only. No changes were made.'};
        const output=await tools.execute(name,args,context);
        operations.push({tool:name,operation:['read','describe','pending'].includes(args?.operation)?args.operation:'unknown',
          table:['invoices','customers','workspace_settings','workspace_ai_settings','payments','invoice_files'].includes(args?.table)?args.table:null,
          columns:Array.isArray(args?.columns)?args.columns.map(safeField):null,
          filterColumns:Array.isArray(args?.filters)?args.filters.map(filter=>safeField(filter.column)):[],
          code:output?.ok?'OK':['INVALID','DENIED','UNAVAILABLE','NOT_FOUND'].includes(output?.code)?output.code:'OTHER'});
        if(args?.table==='invoices'&&output?.ok&&Array.isArray(output.rows)){
          invoiceQueries++;
          invoiceRows+=output.rows.length;for(const row of output.rows)if(row.invoice_number)invoiceNumbers.add(String(row.invoice_number));
        }
        return output;
      }};
    }});
  const start=Date.now();
  const result=await handler({...binding,phone,verifiedOwnerBinding:binding,message:questions[scenario],messageId:'diagnostic-'+randomUUID(),
    allowDeferred:true,budgetMs:120_000});
  const durations=kind=>events.filter(entry=>entry.event===kind).map(entry=>entry.fields.durationMs);
  return {ok:Boolean(result?.answer&&!result?.plannerFailure&&!result?.deferred&&(scenario!=='john-invoices'||invoiceQueries>0)),scenario,durationMs:Date.now()-start,
    servedModel:result?.servedModel||null,servedProvider:result?.servedProvider||null,plannerCode:result?.plannerFailure?.code||null,deferred:result?.deferred===true,
    toolRounds:result?.agentDiagnostics?.toolRounds||0,invoiceRows,invoiceQueries,operations,
    groundedInvoiceNumbers:[...invoiceNumbers].filter(number=>result?.answer?.includes(number)).length,
    contextReads:events.filter(entry=>entry.event==='WhatsApp owner context read').map(entry=>entry.fields),
    authorization:events.find(entry=>entry.event==='WhatsApp owner context authorization')?.fields||null,
    modelDurationsMs:durations('WhatsApp owner model call'),toolDurationsMs:durations('WhatsApp owner tool call'),
    // No ledger facts or generated text leave the privileged diagnostic path.
  };
}
