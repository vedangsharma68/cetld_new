import {CF_BACKUP_MODEL, CF_PRIMARY_MODEL, GEMINI_FALLBACK_MODEL} from '../../ai/provider.mjs';
import {installVerifiedOwnerRpc} from './verified-owner-rpc.mjs';

export const OWNER_CHAT_SCOPE = Object.freeze({
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  ownerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  customerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  phone: '+919871367051',
});
export const OTHER_WORKSPACE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const JOHN_CUSTOMER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export const JOHN_INVOICE_ID = 'ffffffff-ffff-4fff-8fff-fffffffffff1';
export const PAYMENT_INVOICE_ID = 'ffffffff-ffff-4fff-8fff-fffffffffff3';
export const DEFAULT_NOW = new Date('2026-10-02T09:00:00.000Z');

const clone = value => value == null ? value : structuredClone(value);
const matches = (row, filter) => filter(row);

/** A small, strict Supabase-shaped store. All model-readable tenants are seeded. */
export function createOwnerChatDatabase({primaryModel = CF_PRIMARY_MODEL, fallbackModel = GEMINI_FALLBACK_MODEL} = {}) {
  const now = DEFAULT_NOW.toISOString();
  const tables = {
    workspace_ai_settings: [{workspace_id:OWNER_CHAT_SCOPE.workspaceId,primary_model:primaryModel,fallback_model:fallbackModel,updated_at:now}],
    workspaces:[{id:OWNER_CHAT_SCOPE.workspaceId,owner_id:OWNER_CHAT_SCOPE.ownerId}],
    workspace_members:[{workspace_id:OWNER_CHAT_SCOPE.workspaceId,user_id:OWNER_CHAT_SCOPE.ownerId,role:'owner'}],
    whatsapp_owner_verifications:[{workspace_id:OWNER_CHAT_SCOPE.workspaceId,phone:OWNER_CHAT_SCOPE.phone,
      requested_by:OWNER_CHAT_SCOPE.ownerId,verified_at:now}],
    whatsapp_consents:[{workspace_id:OWNER_CHAT_SCOPE.workspaceId,customer_id:OWNER_CHAT_SCOPE.customerId,
      phone:OWNER_CHAT_SCOPE.phone,consented_by:OWNER_CHAT_SCOPE.ownerId,revoked_at:null}],
    whatsapp_global_suppressions:[],whatsapp_suppressions:[],
    workspace_settings: [{workspace_id:OWNER_CHAT_SCOPE.workspaceId,business_name:'Northstar Studio',owner_bot_preferences:{confirmationMode:'buttons'},whatsapp_owner_phone:OWNER_CHAT_SCOPE.phone,default_currency:'INR',
      default_timezone:'Asia/Kolkata',follow_up_preferences:{tone:'gentle',maxReminders:3,cadenceDays:4,firstReminderDays:2,
        contactStart:'09:00',contactEnd:'18:00',pauseOnReply:true,dailySummary:false},updated_at:now}],
    customers: [
      {id:JOHN_CUSTOMER_ID,workspace_id:OWNER_CHAT_SCOPE.workspaceId,name:'John Smith',company_name:'John Smith Studio',
        email:'john@example.test',phone:'+14155550101',created_at:now,updated_at:now,metadata:{}},
      {id:OWNER_CHAT_SCOPE.customerId,workspace_id:OWNER_CHAT_SCOPE.workspaceId,name:'Northstar Owner',company_name:null,
        email:null,phone:OWNER_CHAT_SCOPE.phone,created_at:now,updated_at:now,metadata:{whatsapp_owner:true}},
      {id:'e0000000-0000-4000-8000-000000000001',workspace_id:OTHER_WORKSPACE_ID,
        name:'John Smith Foreign Co',company_name:'Foreign John',email:'foreign@example.test',phone:'+14155550999',created_at:now,updated_at:now,metadata:{}},
    ],
    invoices: [
      {id:'ffffffff-ffff-4fff-8fff-fffffffffff1',workspace_id:OWNER_CHAT_SCOPE.workspaceId,customer_id:JOHN_CUSTOMER_ID,
        invoice_number:'INV-001',issue_date:'2026-09-01',due_date:'2026-10-01',currency:'USD',total_amount:125,amount_paid:0,
        status:'sent',notes:null,metadata:{invoice_direction:'receivable'},created_at:now,updated_at:now,deleted_at:null},
      {id:'ffffffff-ffff-4fff-8fff-fffffffffff3',workspace_id:OWNER_CHAT_SCOPE.workspaceId,customer_id:JOHN_CUSTOMER_ID,
        invoice_number:'INV-003',issue_date:'2026-09-12',due_date:'2026-10-12',currency:'USD',total_amount:450,amount_paid:0,
        status:'sent',notes:null,metadata:{invoice_direction:'receivable'},created_at:now,updated_at:now,deleted_at:null},
      {id:'ffffffff-ffff-4fff-8fff-fffffffffff4',workspace_id:OWNER_CHAT_SCOPE.workspaceId,customer_id:JOHN_CUSTOMER_ID,
        invoice_number:'INV-004',issue_date:'2026-09-14',due_date:'2026-10-14',currency:'USD',total_amount:80,amount_paid:0,
        status:'sent',notes:null,metadata:{invoice_direction:'receivable',requires_exact_delete_confirmation:false},created_at:now,updated_at:now,deleted_at:null},
      {id:'ffffffff-ffff-4fff-8fff-fffffffffff5',workspace_id:OWNER_CHAT_SCOPE.workspaceId,customer_id:JOHN_CUSTOMER_ID,
        invoice_number:'INV-005',issue_date:'2026-09-15',due_date:'2026-10-15',currency:'USD',total_amount:95,amount_paid:0,
        status:'sent',notes:null,metadata:{invoice_direction:'receivable',requires_exact_delete_confirmation:true},created_at:now,updated_at:now,deleted_at:null},
      {id:'ffffffff-ffff-4fff-8fff-fffffffffff6',workspace_id:OWNER_CHAT_SCOPE.workspaceId,customer_id:JOHN_CUSTOMER_ID,
        invoice_number:'INV-006',issue_date:'2026-09-16',due_date:'2026-10-16',currency:'USD',total_amount:160,amount_paid:0,
        status:'sent',notes:null,metadata:{invoice_direction:'receivable'},created_at:now,updated_at:now,deleted_at:null},
      {id:'ffffffff-ffff-4fff-8fff-fffffffffff9',workspace_id:OTHER_WORKSPACE_ID,customer_id:JOHN_CUSTOMER_ID,
        invoice_number:'OTHER-BUSINESS-SECRET',issue_date:'2026-09-01',due_date:'2026-10-01',currency:'USD',total_amount:9999,
        amount_paid:0,status:'sent',notes:'foreign tenant fixture',metadata:{invoice_direction:'receivable'},created_at:now,updated_at:now,deleted_at:null},
    ],
    payments: [], invoice_files: [], whatsapp_messages: [], whatsapp_pending_actions: [],
  };
  const readCalls = [];
  const rpcCalls = [];
  let nextPendingId = 1;
  let pendingGeneration = 0;
  let dataProposal = null;
  let deleteProposal = null;

  const currentPending = ({workspaceId, customerId, phone} = {}) => {
    const row = tables.whatsapp_pending_actions.find(item => item.consumed_at == null
      && item.workspace_id === (workspaceId || OWNER_CHAT_SCOPE.workspaceId)
      && item.customer_id === (customerId || OWNER_CHAT_SCOPE.customerId)
      && item.phone === (phone || OWNER_CHAT_SCOPE.phone));
    return row || null;
  };
  const fieldValue=(table,row,key)=>key.includes('->>')?row[key.split('->>')[0]]?.[key.split('->>')[1]]:
    table==='invoices'&&key==='customer.name'
    ?tables.customers.find(customer=>customer.workspace_id===row.workspace_id&&customer.id===row.customer_id)?.name:row[key];
  const resultRows = (table, filters, orders, range, limit, columns) => {
    readCalls.push({table, filters: filters.map(filter => filter.label), columns,limit,range:clone(range)});
    let found = (tables[table] || []).filter(row => filters.every(filter => matches(row, filter.fn)));
    for (const [key, ascending] of orders) found = [...found].sort((a,b) => {
      const compare = String(a[key] ?? '').localeCompare(String(b[key] ?? ''));
      return ascending ? compare : -compare;
    });
    if (range) found = found.slice(range[0], range[1] + 1);
    else if (limit != null) found = found.slice(0, limit);
    if (columns === '*') return found.map(clone);
    const names = String(columns || '').split(',').map(item => item.trim()).filter(Boolean);
    return found.map(row => {
      const output={};
      for(const name of names){
        if(name.startsWith('customer:customers!')){
          const customer=tables.customers.find(item=>item.workspace_id===row.workspace_id&&item.id===row.customer_id);
          output.customer=customer?{name:customer.name}:null;
        } else if(Object.hasOwn(row,name))output[name]=clone(row[name]);
      }
      return output;
    });
  };
  const from = table => {
    const filters = [], orders = [];
    let range = null, limit = null, columns = '*', operation = null, mutation = null;
    const q = {
      select(value = '*') { columns = value; if (!operation) operation = 'select'; return q; },
      eq(key,value) { filters.push({label:['eq',key,value],fn:row=>fieldValue(table,row,key)===value}); return q; },
      neq(key,value) { filters.push({label:['neq',key,value],fn:row=>row[key]!==value}); return q; },
      is(key,value) { filters.push({label:['is',key,value],fn:row=>(row[key]??null)===value}); return q; },
      not(key,operator,value) { filters.push({label:['not',key,operator,value],fn:row=>operator==='is'?(row[key]??null)!==value:row[key]!==value}); return q; },
      in(key,values) { filters.push({label:['in',key,clone(values)],fn:row=>values.includes(row[key])}); return q; },
      ilike(key,value) { const needle=String(value).replaceAll('%','').toLocaleLowerCase(); filters.push({label:['ilike',key,value],fn:row=>String(fieldValue(table,row,key)||'').toLocaleLowerCase().includes(needle)}); return q; },
      gt(key,value) { filters.push({label:['gt',key,value],fn:row=>row[key]>value}); return q; },
      gte(key,value) { filters.push({label:['gte',key,value],fn:row=>row[key]>=value}); return q; },
      lt(key,value) { filters.push({label:['lt',key,value],fn:row=>row[key]<value}); return q; },
      lte(key,value) { filters.push({label:['lte',key,value],fn:row=>row[key]<=value}); return q; },
      order(key,{ascending=true}={}) { orders.push([key,ascending]); return q; },
      limit(value) { limit = value; return q; },
      range(start,end) { range = [start,end]; return q; },
      insert(value) { operation='insert'; mutation=clone(value); return q; },
      update(value) { operation='update'; mutation=clone(value); return q; },
      delete() { operation='delete'; return q; },
      upsert(value,{onConflict}={}) { operation='upsert'; mutation=clone(value); q._onConflict=onConflict; return q; },
      async maybeSingle() { const data=resultRows(table,filters,orders,range,limit,columns)[0]||null; return {data,error:null}; },
      then(resolve,reject) {
        try {
          if (operation === 'insert' || operation === 'upsert') {
            const batch=Array.isArray(mutation)?mutation:[mutation];
            for (const item of batch) {
              const conflict=operation==='upsert'&&q._onConflict?q._onConflict.split(','):[];
              const prior=conflict.length?(tables[table]||[]).find(row=>conflict.every(key=>row[key]===item[key])):null;
              if(prior)Object.assign(prior,item);else (tables[table]||=([])).push({id:String((tables[table]||[]).length+1),created_at:new Date().toISOString(),...item});
            }
          } else if (operation === 'update') {
            for (const row of tables[table]||[]) if(filters.every(filter=>filter.fn(row)))Object.assign(row,mutation);
          } else if (operation === 'delete') {
            const rows=tables[table]||[];
            for (const row of [...rows]) if(filters.every(filter=>filter.fn(row)))rows.splice(rows.indexOf(row),1);
          }
          const data=resultRows(table,filters,orders,range,limit,columns);
          return Promise.resolve({data,error:null}).then(resolve,reject);
        } catch(error) { return Promise.reject(error).then(resolve,reject); }
      },
    };
    return q;
  };

  const rpc = async (name,args={}) => {
    rpcCalls.push({name,args:clone(args)});
    const ws=OWNER_CHAT_SCOPE.workspaceId;
    if (args.p_workspace_id != null && args.p_workspace_id !== ws) return {data:{ok:false,code:'OWNER_REQUIRED',reason:'unbound'}};
    if (name === 'whatsapp_load_pending_action_state') {
      const action=currentPending(args);
      return {data:{generation:pendingGeneration,id:action?.id??null,version:action?.version??null,action:clone(action?.action??null)}};
    }
    if (name === 'whatsapp_store_pending_action') {
      if(args.p_expected_generation!==pendingGeneration || currentPending(args))return {data:null};
      const row={id:nextPendingId++,version:1,generation:pendingGeneration+1,workspace_id:args.p_workspace_id,
        customer_id:args.p_customer_id,phone:args.p_phone,action:clone(args.p_action),created_at:new Date().toISOString(),consumed_at:null};
      tables.whatsapp_pending_actions.push(row);pendingGeneration++;
      return {data:clone(row)};
    }
    if (name === 'whatsapp_claim_pending_action') {
      const row=currentPending({workspaceId:args.p_workspace_id,customerId:args.p_customer_id,phone:args.p_phone});
      if(!row||row.id!==args.p_id)return {data:null};
      row.consumed_at=new Date().toISOString();pendingGeneration++;
      return {data:clone(row)};
    }
    if (name === 'whatsapp_workspace_data_propose') {
      const action={type:'owner_workspace_data_change',proposalId:'12345678-1234-4123-8123-123456789012',
        requestMessageId:args.p_request_message_id,table:args.p_table,operation:args.p_operation,targetId:args.p_target_id,
        expectedUpdatedAt:args.p_expected_updated_at,values:clone(args.p_values),summary:args.p_summary,
        expiresAt:new Date(Date.now()+600_000).toISOString()};
      const state=currentPending(args);
      if(state||args.p_expected_generation!==pendingGeneration)return {data:{ok:false,code:'ACTION_PENDING'}};
      dataProposal={action};
      const row={id:nextPendingId++,version:1,generation:pendingGeneration+1,workspace_id:args.p_workspace_id,
        customer_id:args.p_customer_id,phone:args.p_phone,action,created_at:new Date().toISOString(),consumed_at:null};
      tables.whatsapp_pending_actions.push(row);pendingGeneration++;
      return {data:{ok:true,expires_at:action.expiresAt}};
    }
    if (name === 'whatsapp_workspace_data_confirm' || name === 'whatsapp_workspace_data_cancel') {
      const confirm=name.endsWith('_confirm');
      const row=currentPending(args);
      if(!row || row.action?.type!=='owner_workspace_data_change')return {data:{ok:false,code:'NO_PENDING_ACTION'}};
      const raw=String(args.p_user_message||'').trim().toLowerCase();
      const explicit=confirm?['yes','y','ok','okay','confirm','confirmed','do it','go ahead','proceed','approve'].includes(raw)
        :['no','cancel','never mind','nevermind','discard'].includes(raw);
      if(!explicit || row.action.requestMessageId===args.p_confirmation_message_id || row.action.requestMessageId===args.p_cancel_message_id)
        return {data:{ok:false,code:'INVALID_CONFIRMATION'}};
      if(confirm) {
        const table=row.action.table;
        const target=(tables[table]||[]).find(item=>item.workspace_id===ws && (table==='workspace_ai_settings'||table==='workspace_settings'
          ?item.workspace_id===row.action.targetId:item.id===row.action.targetId));
        if(target) Object.assign(target,clone(row.action.values),{updated_at:new Date().toISOString()});
      }
      row.consumed_at=new Date().toISOString();pendingGeneration++;
      dataProposal=null;
      return {data:{ok:true,completed:confirm,action:confirm?'workspace_data_updated':'workspace_data_canceled'}};
    }
    if (name === 'whatsapp_confirm_owner_create_settings') {
      const row=currentPending(args);
      if(!row || row.action?.type!=='owner_settings_update')return {data:{ok:false,reason:'no_action'}};
      const rawId=args.p_confirmation_message_id;
      if(!rawId||row.action.sourceMessageId===rawId)return {data:{ok:false,reason:'invalid_confirmation'}};
      const settings=tables.workspace_settings.find(item=>item.workspace_id===ws);
      if(row.action.request.businessName)settings.business_name=row.action.request.businessName;
      settings.follow_up_preferences={...settings.follow_up_preferences,...clone(row.action.request.patch)};
      settings.updated_at=new Date().toISOString();row.consumed_at=new Date().toISOString();pendingGeneration++;
      return {data:{ok:true,actionType:'owner_settings_update',changed:clone(row.action.request.patch)}};
    }
    if (name === 'whatsapp_confirm_owner_invoice_action') {
      const row=currentPending(args);
      if(!row || row.id!==args.p_action_id || !['owner_invoice_update','owner_invoice_payment'].includes(row.action?.type))
        return {data:{ok:false,reason:'no_action'}};
      const inbound=tables.whatsapp_messages.find(item=>item.provider_message_id===args.p_confirmation_message_id
        &&item.workspace_id===ws&&item.phone===args.p_phone&&item.direction==='inbound');
      const raw=String(inbound?.body||'').trim().toLowerCase();
      const explicit=['yes','y','ok','okay','confirm','confirmed','do it','go ahead','proceed','approve'].includes(raw);
      if(args.p_confirm && !explicit)return {data:{ok:false,reason:'invalid_confirmation'}};
      if(args.p_confirm) {
        const invoice=tables.invoices.find(item=>item.workspace_id===ws&&item.id===row.action.invoiceId);
        if(!invoice)return {data:{ok:false,reason:'not_found'}};
        if(row.action.type==='owner_invoice_payment') {
          const outstanding=Number(invoice.total_amount)-Number(invoice.amount_paid||0);
          invoice.amount_paid=Number(invoice.total_amount);invoice.status='paid';invoice.updated_at=new Date().toISOString();
          tables.payments.push({id:String(tables.payments.length+1),workspace_id:ws,invoice_id:invoice.id,amount:outstanding,
            paid_at:new Date().toISOString(),method:'owner-confirmed',reference:null,created_at:new Date().toISOString()});
        } else Object.assign(invoice,clone(row.action.changes),{updated_at:new Date().toISOString()});
      }
      row.consumed_at=new Date().toISOString();pendingGeneration++;
      return {data:{ok:true,invoiceNumber:row.action.invoiceNumber,actionType:row.action.type}};
    }
    if (name === 'invoice_lifecycle_action') {
      const action=args.p_action;
      if(action==='pending')return {data:{ok:true,action:'proposal_loaded',pending:!!deleteProposal,...clone(deleteProposal||{})}};
      if(action==='prepare') {
        const invoice=tables.invoices.find(item=>item.workspace_id===ws&&item.id===args.p_invoice_id);
        if(!invoice || invoice.deleted_at)return {data:{ok:false,code:'INVOICE_NOT_FOUND'}};
        if(deleteProposal)return {data:{ok:false,code:'ACTION_PENDING'}};
        deleteProposal={proposalId:'22345678-1234-4123-8123-123456789012',invoiceId:invoice.id,invoiceNumber:invoice.invoice_number,
          customerName:'John Smith',totalAmount:invoice.total_amount,currency:invoice.currency,status:invoice.status,
          expiresAt:new Date(Date.now()+600_000).toISOString(),expectedUpdatedAt:invoice.updated_at,
          requiresExactConfirmation:invoice.metadata?.requires_exact_delete_confirmation===true};
        return {data:{ok:true,action:'proposal_created',...clone(deleteProposal)}};
      }
      if(action==='confirm') {
        if(!deleteProposal || deleteProposal.proposalId!==args.p_proposal_id)return {data:{ok:false,code:'PROPOSAL_NOT_FOUND'}};
        const valid=deleteProposal.requiresExactConfirmation
          ?String(args.p_user_message||'').trim()===`DELETE ${deleteProposal.invoiceNumber}`
          :['yes','y','ok','okay','confirm','confirmed','do it','go ahead','proceed','approve'].includes(String(args.p_user_message||'').trim().toLowerCase());
        if(!valid)return {data:{ok:false,code:'EXACT_CONFIRMATION_REQUIRED'}};
        const invoice=tables.invoices.find(item=>item.workspace_id===ws&&item.id===deleteProposal.invoiceId);
        if(invoice)invoice.deleted_at=new Date().toISOString();
        const result={ok:true,action:'deleted',...clone(deleteProposal)};deleteProposal=null;
        return {data:result};
      }
      if(action==='cancel') {
        if(!deleteProposal)return {data:{ok:false,code:'PROPOSAL_NOT_FOUND'}};
        const result={ok:true,action:'cancelled',...clone(deleteProposal)};deleteProposal=null;return {data:result};
      }
      if(action==='undo') {
        const invoice=tables.invoices.find(item=>item.workspace_id===ws&&(args.p_invoice_number?item.invoice_number===args.p_invoice_number:item.id===args.p_invoice_id));
        if(!invoice||!invoice.deleted_at)return {data:{ok:false,code:'NOT_DELETED'}};
        invoice.deleted_at=null;
        return {data:{ok:true,action:'restored',invoiceId:invoice.id,invoiceNumber:invoice.invoice_number,customerName:'John Smith',
          totalAmount:invoice.total_amount,currency:invoice.currency,status:invoice.status,expiresAt:new Date(Date.now()+600_000).toISOString()}};
      }
      return {data:{ok:false,code:'FEATURE_UNAVAILABLE'}};
    }
    return {data:{ok:false,code:'FEATURE_UNAVAILABLE'}};
  };
  const supabase={tables,readCalls,rpcCalls,from,rpc};
  installVerifiedOwnerRpc(supabase,()=>tables,{expectedPhone:OWNER_CHAT_SCOPE.phone});
  return {supabase,tables,readCalls,rpcCalls,scope:OWNER_CHAT_SCOPE,assertScopedReads(){
    for(const call of readCalls.filter(item=>['customers','invoices','payments','workspace_settings','workspace_ai_settings'].includes(item.table))) {
      const workspace=call.filters.find(filter=>filter[0]==='eq'&&filter[1]==='workspace_id');
      if(!workspace||workspace[2]!==OWNER_CHAT_SCOPE.workspaceId)throw new Error(`owner query was not scoped to the verified workspace (${call.table})`);
    }
    if(readCalls.some(call=>call.filters.some(filter=>filter[1]==='workspace_id'&&filter[2]===OTHER_WORKSPACE_ID)))
      throw new Error('foreign workspace was queried');
  }};
}

export function createOwnerReplyStore() {
  const replies=new Map();
  const history=[];
  const key=scope=>`${scope.workspaceId}|${scope.phone}|${scope.messageId||''}`;
  return {
    history,
    async find(scope) {
      const saved=replies.get(key(scope));
      if(saved)return clone(saved);
      return null;
    },
    async save(scope,result) {
      const canonical=clone(result);
      replies.set(key(scope),canonical);
      history.push({workspaceId:scope.workspaceId,phone:scope.phone,messageId:scope.messageId,message:scope.message,at:Date.now(),result:canonical});
      return clone(canonical);
    },
  };
}
