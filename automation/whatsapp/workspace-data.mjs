import {sanitizeReminderTemplate} from '../preferences.mjs';
import {resolveWorkspaceRecord,validateCustomFields,ownerCalendar} from './workspace-records.mjs';
import {sanitizeOwnerBotPreferences,mergeOwnerBotPreferences,OWNER_BOT_LANGUAGE_OPTIONS} from './bot-preferences.mjs';
import {
  CF_PRIMARY_MODEL,
  GEMINI_FALLBACK_MODEL,
  VERIFIED_MODEL_CATALOG,
} from '../../ai/provider.mjs';

const DATA_ACTION = 'owner_workspace_data_change';
const MAX_LIMIT = 50;
const OPERATIONS = Object.freeze([
  'read','create','update','delete','restore','pending','confirm','cancel','describe',
  'analyzeAttachment','saveAttachment','reviewAttachment','sendFile',
]);
const FILTER_OPERATORS = Object.freeze(['eq','neq','gt','gte','lt','lte','ilike','in','is']);
const ALLOWED_ARGS = new Set(['request','operation','table','columns','filters','values','limit','offset','order']);
const FORBIDDEN_KEY = /^(?:workspace|tenant|owner)(?:id|_id)$/i;
const SECRET_KEY = /(?:token|secret|password|api.?key|credential|authorization|cookie|storage.?path|code.?hash|private.?key)/i;
const INTERNAL_KEY = /^(?:id|workspace_id|owner_id|tenant_id|user_id|customer_id|invoice_id)$/i;
const YES = /^\s*(?:yes|y|ok|okay|confirm|confirmed|do it|go ahead|proceed|approve)\s*[.!]?\s*$/i;
const CANCEL = /^\s*(?:no|cancel|never mind|nevermind|discard)\s*[.!]?\s*$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TABLES = Object.freeze({
  business_records: {
    label:'Custom business records (suppliers, projects, inventory, and other owner-defined categories)',scope:'workspace',
    columns:['record_type','name','custom_fields','created_at','updated_at'],defaults:['record_type','name','custom_fields'],
    filters:['id','record_type','name'],writeColumns:['record_type','name','custom_fields'],
  },
  workspace_settings: {
    label:'Business settings', scope:'workspace',
    columns:['business_name','default_currency','default_timezone','follow_up_preferences','owner_bot_preferences','created_at','updated_at'],
    defaults:['business_name','default_currency','default_timezone','follow_up_preferences','owner_bot_preferences'],
    filters:['business_name','default_currency','default_timezone'],
    writeColumns:['business_name','default_currency','default_timezone','follow_up_preferences','owner_bot_preferences'],
  },
  workspace_ai_settings: {
    label:'AI model settings', scope:'workspace',
    columns:['primary_model','fallback_model','created_at','updated_at'],
    defaults:['primary_model','fallback_model'], filters:['primary_model','fallback_model'],
    writeColumns:['primary_model','fallback_model'],
  },
  customers: {
    label:'Customers', scope:'workspace',
    columns:['name','company_name','email','phone','custom_fields','created_at','updated_at'],
    defaults:['name','company_name','email','phone','custom_fields'], filters:['id','name','company_name','email','phone'],
    writeColumns:['name','company_name','email','phone','custom_fields'],
  },
  invoices: {
    label:'Invoices', scope:'workspace',
    columns:['invoice_number','customer_name','issue_date','due_date','currency','total_amount','amount_paid','status','notes','custom_fields','created_at','updated_at'],
    defaults:['invoice_number','customer_name','issue_date','due_date','currency','total_amount','amount_paid','status','custom_fields'],
    filters:['id','invoice_number','customer_name','issue_date','due_date','currency','total_amount','amount_paid','status'],
    writeColumns:['invoice_number','customer_name','customer_id','customer_email','customer_phone','issue_date','due_date','currency','total_amount','subtotal','tax','notes','status','custom_fields','invoice_direction'],
  },
  payments: {
    label:'Payments', scope:'workspace',
    columns:['invoice_number','amount','paid_at','method','reference','created_at'],
    defaults:['invoice_number','amount','paid_at','method','reference'],
    filters:['invoice_number','amount','paid_at','method','reference'],
  },
  invoice_files: {
    label:'Invoice file metadata', scope:'workspace',
    columns:['invoice_number','file_name','mime_type','size_bytes','created_at'],
    defaults:['invoice_number','file_name','mime_type','size_bytes','created_at'],
    filters:['invoice_number','file_name','mime_type','created_at'],
  },
});

const TYPE_BY_COLUMN = Object.freeze({
  name:'string',company_name:'string',email:'string',phone:'string',business_name:'string',
  default_currency:'string',default_timezone:'string',primary_model:'string',fallback_model:'string',
  invoice_number:'string',customer_name:'string',issue_date:'date',due_date:'date',currency:'string',
  total_amount:'number',amount_paid:'number',status:'string',notes:'string',amount:'number',paid_at:'date',
  method:'string',reference:'string',file_name:'string',mime_type:'string',size_bytes:'number',created_at:'date',updated_at:'date',
});

const WRITE_SCHEMA = Object.freeze({
  business_records:{create:['record_type','name','custom_fields'],update:['record_type','name','custom_fields']},
  customers:{
    create:['name','company_name','email','phone','custom_fields'],
    update:['name','company_name','email','phone','custom_fields'],
    delete:[],
  },
  workspace_ai_settings:{update:['primary_model','fallback_model']},
  invoices:{
    create:['invoice_number','customer_name','customer_id','customer_email','customer_phone','issue_date','due_date','currency','total_amount','subtotal','tax','notes','custom_fields'],
    update:['invoice_number','issue_date','due_date','currency','total_amount','notes','status','custom_fields'],
    reviewAttachment:['invoice_number','customer_name','issue_date','due_date','total_amount','currency','invoice_direction'],
  },
  workspace_settings:{update:['business_name','follow_up_preferences','default_currency','default_timezone','owner_bot_preferences']},
});

function definition() {
  // The server validates the full catalog. Do not send that catalog on every
  // model request; describe exposes it when the model needs unfamiliar fields.
  return {type:'function',function:{name:'workspaceData',
    description:'Read or change workspace data. Clear owner instructions execute directly when allowed; otherwise a proposal needs a decision. Prefer structured fields; request text handles unfamiliar operations. Omit columns for defaults. business_records create values require record_type and name; extra fields go inside custom_fields. Customers use name/email/phone; invoices use customer_name (joined name; ilike for partial names), invoice_number/total_amount/status. Settings use primary_model/fallback_model/follow_up_preferences. custom_fields stores extra business facts as a flat object of snake_case keys and text/number/boolean/null values, with a merge on update; describe lists fields; pending reads proposals; confirm/cancel decide them.',
    parameters:{type:'object',additionalProperties:false,
      properties:{
        request:{type:'string',minLength:1,maxLength:1200},
        operation:{type:'string',enum:OPERATIONS},
        table:{type:'string',enum:Object.keys(TABLES)},
        columns:{type:'array',maxItems:20,items:{type:'string'}},
        filters:{type:'array',maxItems:8,items:{type:'object',additionalProperties:false,
          properties:{column:{type:'string'},
            operator:{type:'string',enum:FILTER_OPERATORS},
            value:{type:['string','number','boolean','null','array'],items:{type:['string','number','boolean','null']}}},
          required:['column','operator','value']}},
        values:{type:'object'},
        limit:{type:'integer',minimum:1,maximum:MAX_LIMIT},
        offset:{type:'integer',minimum:0,maximum:100000},
        order:{type:'object',additionalProperties:false,
          properties:{column:{type:'string'},direction:{type:'string',enum:['asc','desc']}},required:['column','direction']},
      },
    }}};
}

function catalog(table=null) {
  return {
    operations:OPERATIONS,
    tables:Object.fromEntries(Object.entries(TABLES).filter(([name])=>!table||name===table).map(([name,spec])=>[name,{
      label:spec.label,columns:spec.columns,filters:spec.filters,
      writeFields:WRITE_SCHEMA[name]||{},
      ...(name==='business_records'?{writeValueConstraints:{create:{required:['record_type','name'],record_type:'lowercase category: one letter followed by up to 63 lowercase letters, digits or underscores',name:'nonempty text, up to 200 characters',custom_fields:'flat object of snake_case business keys and text/number/boolean/null values; extra fields must be nested here'},update:{record_type:'same category format',name:'nonempty text, up to 200 characters',custom_fields:'merges with existing fields'}}}:{}),
      ...(name==='invoices'?{writeValueConstraints:{update:{status:['paid','unpaid'],unpaid:'Checks current payment facts. Never removes or reverses payments.'}}}:{}),
      ...(name==='workspace_settings'?{writeValueConstraints:{update:{
        owner_bot_preferences:{description:'Owner assistant style; partial fields merge with saved preferences.',assistantName:'text, 1-50 characters',tone:['concise','friendly','formal'],language:OWNER_BOT_LANGUAGE_OPTIONS.map(item=>item.value),replyLength:['short','balanced','detailed'],confirmationMode:['direct','buttons'],serviceReplySignature:'text, up to 120 characters',customInstruction:'style text, up to 500 characters'},
        follow_up_preferences:{description:'Customer reminder settings; partial fields merge with saved preferences.',tone:['gentle','professional','firm'],reminderTemplate:'up to 1000 characters; tokens {{business_name}}, {{customer_name}}, {{invoice_number}}, {{balance}}, {{due_date}}',allowedWeekdays:'array of weekday numbers 0-6',escalation:['pause','manual_review'],stopOnPayment:true}
      }}}:{}),
      ...(name==='workspace_ai_settings'?{writeValueConstraints:{update:{primary_model:VERIFIED_MODEL_CATALOG.filter(entry=>entry.roles.includes('primary')).map(entry=>entry.id),fallback_model:[null,...VERIFIED_MODEL_CATALOG.filter(entry=>entry.roles.includes('fallback')).map(entry=>entry.id)]}}}:{}),
      operations:name==='invoices'?['read','create','update','delete','restore','reviewAttachment']
        :name==='business_records'?['read','create','update']:name==='customers'?['read','create','update','delete']
          :name==='workspace_settings'||name==='workspace_ai_settings'?['read','update']
            :['read'],
    }])),
    filterOperators:FILTER_OPERATORS,
    limits:{read:MAX_LIMIT,offset:100000,filters:8,oneWriteTargetPerProposal:true},
  };
}

function safeFollowupPreferences(value) {
  if(!ownObject(value))return {};
  const out={};
  const tone=value.tone;
  if(['gentle','professional','firm'].includes(tone))out.tone=tone;
  const ranges={firstReminderDays:[0,90],cadenceDays:[1,90],maxReminders:[1,20]};
  for(const [key,[min,max]] of Object.entries(ranges))if(Number.isInteger(value[key])&&value[key]>=min&&value[key]<=max)out[key]=value[key];
  const start=value.contactStart??value.hoursStart,end=value.contactEnd??value.hoursEnd;
  const time=/^([01]\d|2[0-3]):[0-5]\d$/;
  if(typeof start==='string'&&time.test(start))out.contactStart=start;
  if(typeof end==='string'&&time.test(end))out.contactEnd=end;
  const weekdays=value.allowedWeekdays??value.weekdays;
  if(Array.isArray(weekdays)&&weekdays.length>=1&&weekdays.length<=7&&weekdays.every(day=>Number.isInteger(day)&&day>=0&&day<=6))
    out.allowedWeekdays=[...new Set(weekdays)];
  if(['pause','manual_review'].includes(value.escalation))out.escalation=value.escalation;
  for(const key of ['pauseOnReply','dailySummary'])if(typeof value[key]==='boolean')out[key]=value[key];
  if(value.stopOnPayment===true)out.stopOnPayment=true;
  if(value.reminderTemplate!==undefined)try{out.reminderTemplate=sanitizeReminderTemplate(value.reminderTemplate);}catch{}
  if(typeof value.businessName==='string'&&value.businessName.length<=200)out.businessName=value.businessName;
  if(typeof value.timezone==='string'&&value.timezone.length<=100)try{new Intl.DateTimeFormat('en',{timeZone:value.timezone});out.timezone=value.timezone;}catch{}
  return out;
}

function fail(code='INVALID',message='That workspace data request is not supported.') { return {ok:false,code,message}; }
function safeError(error) {
  const raw=String(error?.code||'').toUpperCase();
  const code=({PGRST116:'NOT_FOUND','404':'NOT_FOUND',NOT_FOUND:'NOT_FOUND',AMBIGUOUS:'AMBIGUOUS',
    ACTION_STALE:'STALE',STALE:'STALE',ACTION_EXPIRED:'EXPIRED',EXPIRED:'EXPIRED',
    OWNER_REQUIRED:'DENIED',UNBOUND:'DENIED',PERMISSION_DENIED:'DENIED','42501':'DENIED',
    INVALID_REQUEST:'INVALID',INVALID_ARGUMENT:'INVALID',INVALID:'INVALID',
    INVALID_CONFIRMATION:'INVALID',STALE_CONFIRMATION:'INVALID',PENDING:'PENDING',ACTION_PENDING:'PENDING',
    IN_USE:'IN_USE',NO_ACTION:'NO_PENDING_ACTION',NO_PENDING_ACTION:'NO_PENDING_ACTION',DATABASE_UNAVAILABLE:'UNAVAILABLE',
  })[raw]||'UNAVAILABLE';
  const messages={NOT_FOUND:'No matching record was found.',AMBIGUOUS:'More than one record matches. Narrow the request to one record.',
    STALE:'The record changed after it was reviewed. Please review the current value again.',EXPIRED:'That proposal expired. Start a new request.',
    PENDING:'Another owner change is already waiting for a decision. Confirm or cancel it first.',
    IN_USE:'This customer still has invoices and cannot be deleted.',
    DENIED:'This action is not available for the current owner binding.',INVALID:'That workspace data request is not supported.',
    NO_PENDING_ACTION:'There is no pending workspace data change to apply.',UNAVAILABLE:'The workspace data service is temporarily unavailable.'};
  return fail(code,messages[code]);
}
function sanitise(value,scope,depth=0) {
  if(depth>8)return undefined;
  if(value===null||typeof value==='string'||typeof value==='number'||typeof value==='boolean') {
    if(typeof value==='string'&&[scope?.workspaceId,scope?.ownerId,scope?.customerId].some(id=>id&&value===id))return undefined;
    return value;
  }
  if(Array.isArray(value))return value.map(item=>sanitise(item,scope,depth+1)).filter(item=>item!==undefined);
  if(!value||typeof value!=='object')return undefined;
  const out={};
  for(const [key,item] of Object.entries(value)) {
    if(SECRET_KEY.test(key)||INTERNAL_KEY.test(key)||FORBIDDEN_KEY.test(key))continue;
    const safe=sanitise(item,scope,depth+1);if(safe!==undefined)out[key]=safe;
  }
  return out;
}
function containsForbiddenIdentity(input,scope) {
  if(typeof input==='string')return [scope?.workspaceId,scope?.ownerId,scope?.customerId].some(id=>id&&input.toLowerCase().includes(String(id).toLowerCase()));
  if(Array.isArray(input))return input.some(item=>containsForbiddenIdentity(item,scope));
  if(!input||typeof input!=='object')return false;
  return Object.entries(input).some(([key,value])=>FORBIDDEN_KEY.test(key.replace(/[-\s]/g,'_'))||containsForbiddenIdentity(value,scope));
}
function ownObject(value) { return value&&typeof value==='object'&&!Array.isArray(value); }
function exactKeys(value,allowed) { return ownObject(value)&&Object.keys(value).every(key=>allowed.includes(key)); }
function dataOf(result) {
  if(result?.error)throw Object.assign(new Error('workspace data database call failed'),{code:result.error.code||'UNAVAILABLE'});
  return Array.isArray(result?.data)&&result.data.length===1?result.data[0]:result?.data;
}
function scalarSafe(value) {
  if(value===null||typeof value==='boolean')return true;
  if(typeof value==='number')return Number.isFinite(value);
  if(typeof value==='string')return value.length<=500&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
  return false;
}
function validateFilter(filter,table) {
  const spec=TABLES[table];
  if(!exactKeys(filter,['column','operator','value'])||!spec.filters.includes(filter.column)
      ||!FILTER_OPERATORS.includes(filter.operator))throw new TypeError('invalid filter');
  const {column,operator,value}=filter;
  if(operator==='in') {
    if(!Array.isArray(value)||value.length<1||value.length>25||!value.every(scalarSafe))throw new TypeError('invalid list filter');
  } else if(operator==='is') {
    if(value!==null&&typeof value!=='boolean')throw new TypeError('invalid is filter');
  } else if(!scalarSafe(value))throw new TypeError('invalid filter value');
  const type=TYPE_BY_COLUMN[column]||'string';
  const values=operator==='in'?value:[value];
  if(values.some(item=>item!==null&&(type==='number'?typeof item!=='number'||!Number.isFinite(item)
    :type==='string'?typeof item!=='string':type==='date'?typeof item!=='string':false)))throw new TypeError('filter type mismatch');
  if(['gt','gte','lt','lte','ilike'].includes(operator)&&value===null)throw new TypeError('invalid comparison');
  if(operator==='ilike'&&typeof value!=='string')throw new TypeError('invalid pattern');
  return {column,operator,value};
}
function normalizeRequest(raw,scope,planRequest,ctx) {
  if(!ownObject(raw))throw new TypeError('invalid arguments');
  if(containsForbiddenIdentity(raw,scope))throw new TypeError('scope identity supplied');
  if(Object.keys(raw).some(key=>!ALLOWED_ARGS.has(key)))throw new TypeError('unknown arguments');
  if(typeof raw.request==='string') {
    if(Object.keys(raw).some(key=>!['request','operation','table'].includes(key))||!raw.request.trim()||raw.request.length>1200)throw new TypeError('invalid request');
    if(raw.operation!==undefined&&!OPERATIONS.includes(raw.operation)||raw.table!==undefined&&!Object.hasOwn(TABLES,raw.table))throw new TypeError('invalid request hints');
    if(typeof planRequest!=='function')throw new TypeError('natural-language planning unavailable');
    const hints=Object.fromEntries(['operation','table'].filter(key=>raw[key]!==undefined).map(key=>[key,raw[key]]));
    const text=Object.keys(hints).length?JSON.stringify({request:raw.request.trim(),hints}):raw.request.trim();
    return Promise.resolve(planRequest(text,{catalog:catalog(raw.table||null),signal:ctx.signal,deadlineAt:ctx.deadlineAt}))
      .then(planned=>{
        ctx.assertLive();
        if(!ownObject(planned)||containsForbiddenIdentity(planned,scope))throw new TypeError('invalid planned operation');
        for(const[key,value]of Object.entries(hints))if(planned[key]!==undefined&&planned[key]!==value)throw new TypeError('conflicting request hints');
        return normalizeStructured({...hints,...planned});
      });
  }
  return Promise.resolve(normalizeStructured(raw));
  function normalizeStructured(args) {
    if(!ownObject(args)||containsForbiddenIdentity(args,scope)||Object.keys(args).some(key=>!ALLOWED_ARGS.has(key)))throw new TypeError('invalid planned operation');
    const operation=args.operation;
    if(!OPERATIONS.includes(operation))throw new TypeError('unknown operation');
    const table=args.table||null;
    if(table!==null&&!Object.hasOwn(TABLES,table))throw new TypeError('unknown table');
    const noTableOps=['pending','confirm','cancel','describe','analyzeAttachment','saveAttachment'];
    if(!table&&!noTableOps.includes(operation))throw new TypeError('table required');
    if(table&&!['read','create','update','delete','restore','reviewAttachment','sendFile','describe'].includes(operation))throw new TypeError('invalid table operation');
    if(['pending','confirm','cancel','describe'].includes(operation)&&Object.keys(args).some(key=>!['operation',...(operation==='describe'?['table']:[])].includes(key)))throw new TypeError('unexpected operation fields');
    const filters=args.filters===undefined?[]:args.filters;
    if(!Array.isArray(filters)||filters.length>8)throw new TypeError('invalid filters');
    const normalizedFilters=filters.map(filter=>validateFilter(filter,table||'invoices'));
    const columns=args.columns===undefined?null:args.columns;
    if(columns!==null&&(!Array.isArray(columns)||columns.length<1||columns.length>20
      ||columns.some(column=>typeof column!=='string'||!TABLES[table]?.columns.includes(column))))throw new TypeError('invalid columns');
    const values=args.values===undefined?{}:args.values;
    if(!ownObject(values))throw new TypeError('invalid values');
    if(table==='invoices'&&['create','update','reviewAttachment'].includes(operation)
      &&(!exactKeys(values,WRITE_SCHEMA.invoices[operation])||!Object.keys(values).length||values.status!==undefined&&!['paid','unpaid'].includes(values.status)))throw new TypeError('invalid invoice fields');
    const limit=args.limit===undefined?20:Number(args.limit);
    if(!Number.isInteger(limit)||limit<1||limit>MAX_LIMIT)throw new TypeError('invalid limit');
    const offset=args.offset===undefined?0:Number(args.offset);
    if(!Number.isInteger(offset)||offset<0||offset>100000)throw new TypeError('invalid offset');
    let order=null;
    if(args.order!==undefined) {
      if(!exactKeys(args.order,['column','direction'])||!TABLES[table]?.columns.includes(args.order.column)
          ||!['asc','desc'].includes(args.order.direction))throw new TypeError('invalid order');
      if(args.order.column==='customer_name'||(['payments','invoice_files'].includes(table)&&args.order.column==='invoice_number'))
        throw new TypeError('related fields cannot control pagination order');
      order={column:args.order.column,direction:args.order.direction};
    }
    if(table==='invoices'&&['update','delete','restore','sendFile'].includes(operation)) {
      const key=operation==='restore'?['invoice_number']:operation==='update'?['invoice_number','id','customer_name']:['invoice_number','id'];
      if(normalizedFilters.length!==1||!key.includes(normalizedFilters[0].column)
        ||!(normalizedFilters[0].operator==='eq'||operation==='update'&&normalizedFilters[0].column==='customer_name'&&normalizedFilters[0].operator==='ilike'))
        throw new TypeError('invoice action requires exactly one canonical target');
    }
    if(operation==='create'&&table==='invoices'&&normalizedFilters.length)throw new TypeError('invoice creation cannot include filters');
    if(operation==='create'&&table==='customers'&&normalizedFilters.length)throw new TypeError('customer creation cannot include filters');
    return {operation,table,columns,filters:normalizedFilters,values,limit,offset,order};
  }
}

function validateValues(table,operation,values,current={}) {
  const fields=WRITE_SCHEMA[table]?.[operation];
  if(!fields||!exactKeys(values,fields))throw new TypeError('invalid write fields');
  if(!Object.keys(values).length&&!(table==='customers'&&operation==='delete'))throw new TypeError('empty write');
  const clean={};
  for(const [key,value] of Object.entries(values)) {
    if(key==='follow_up_preferences'){
      if(!ownObject(value)||!exactKeys(value,['tone','firstReminderDays','cadenceDays','maxReminders','contactStart','contactEnd','allowedWeekdays','escalation','pauseOnReply','stopOnPayment','dailySummary','reminderTemplate'])||JSON.stringify(value).length>8192)throw new TypeError('invalid follow-up preferences');
      clean[key]={...value};
      if(value.reminderTemplate!==undefined)clean[key].reminderTemplate=sanitizeReminderTemplate(value.reminderTemplate);
      continue;
    }
    if(key==='owner_bot_preferences'){clean[key]=sanitizeOwnerBotPreferences(value);continue;}
    if(key==='custom_fields'){clean[key]=validateCustomFields(value);continue;}
    if(value===null&&['company_name','email','phone','fallback_model'].includes(key)){clean[key]=null;continue;}
    if(typeof value==='string') {
      const text=value.trim();
      const max={name:200,business_name:200,company_name:255,email:320,phone:40,default_timezone:100,primary_model:160,fallback_model:160}[key]||500;
      if(!text||text.length>max||/[\r\n\u0000]/.test(text))throw new TypeError('invalid text field');
      if(['email'].includes(key)&&!/^\S+@\S+\.\S+$/.test(text))throw new TypeError('invalid email');
      clean[key]=key==='default_currency'?text.toUpperCase():text;
    } else throw new TypeError('invalid write value');
  }
  if(['customers','business_records'].includes(table)&&operation==='create'&&typeof clean.name!=='string')throw new TypeError('record name required');
  if(table==='business_records'&&(operation==='create'&&!clean.record_type||clean.record_type!==undefined&&!/^[a-z][a-z0-9_]{0,63}$/.test(clean.record_type)))throw new TypeError('invalid record category');
  if(table==='workspace_settings'&&operation==='update') {
    if(clean.default_currency!==undefined&&!/^[A-Z]{3}$/.test(clean.default_currency))throw new TypeError('invalid currency');
    if(clean.default_timezone!==undefined)try{new Intl.DateTimeFormat('en',{timeZone:clean.default_timezone});}catch{throw new TypeError('invalid timezone');}
  }
  if(table==='workspace_ai_settings') {
    const currentPrimary=current.primary_model||CF_PRIMARY_MODEL;
    const currentFallback=current.fallback_model===undefined?GEMINI_FALLBACK_MODEL:current.fallback_model;
    const primary=clean.primary_model===undefined?currentPrimary:clean.primary_model;
    const fallback=clean.fallback_model===undefined?currentFallback:clean.fallback_model;
    const primaryEntry=VERIFIED_MODEL_CATALOG.find(entry=>entry.id===primary&&entry.roles.includes('primary'));
    const fallbackEntry=fallback===null?null:VERIFIED_MODEL_CATALOG.find(entry=>entry.id===fallback&&entry.roles.includes('fallback'));
    if(!primaryEntry||fallback!==null&&!fallbackEntry||primary===fallback)throw new TypeError('model choice unavailable');
    clean.primary_model=primary;
    if(fallback!==undefined)clean.fallback_model=fallback;
  }
  return clean;
}

function applyFilter(query,filter) {
  const {column,operator,value}=filter;
  const method=operator==='is'?'is':operator;
  if(typeof query?.[method]!=='function')throw new TypeError('query filter unavailable');
  return query[method](column,value);
}
function asEpoch(value) {
  if(value instanceof Date)return value.getTime();
  if(typeof value==='string'){const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:NaN;}
  return Number(value);
}
function displayField(key) {
  return ({
    name:'Name',company_name:'Company name',email:'Email',phone:'Phone',
    default_currency:'Default currency',default_timezone:'Default timezone',
    primary_model:'Primary model',fallback_model:'Fallback model',
  })[key]||key.replaceAll('_',' ');
}

function validateAdapterSettingsValues(values) {
  const allowed=['business_name','follow_up_preferences'];
  if(!exactKeys(values,allowed)||!Object.keys(values).length)throw new TypeError('invalid settings fields');
  if(values.business_name!==undefined&&(typeof values.business_name!=='string'||!values.business_name.trim()
      ||values.business_name.trim().length>200||/[\r\n\u0000]/.test(values.business_name)))throw new TypeError('invalid business name');
  if(values.follow_up_preferences!==undefined) {
    const patch=values.follow_up_preferences;
    const keys=['tone','maxReminders','cadenceDays','firstReminderDays','contactStart','contactEnd','pauseOnReply','dailySummary'];
    if(!exactKeys(patch,keys)||!Object.keys(patch).length)throw new TypeError('invalid follow-up preferences');
    if(patch.tone!==undefined&&!['gentle','professional','firm'].includes(patch.tone))throw new TypeError('invalid follow-up tone');
    for(const [key,min,max] of [['maxReminders',1,20],['cadenceDays',1,90],['firstReminderDays',0,90]])
      if(patch[key]!==undefined&&(!Number.isInteger(patch[key])||patch[key]<min||patch[key]>max))throw new TypeError('invalid follow-up interval');
    for(const key of ['contactStart','contactEnd'])if(patch[key]!==undefined&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(patch[key]))throw new TypeError('invalid contact time');
    for(const key of ['pauseOnReply','dailySummary'])if(patch[key]!==undefined&&typeof patch[key]!=='boolean')throw new TypeError('invalid follow-up toggle');
  }
}

export function createWorkspaceDataTool({supabase,scope,executeSafetyOperation,getRuntimeConfig,planRequest,authorize,
  message='',messageId=null,pending=null,pendingAtStart=null,clock=()=>new Date(),signal,deadlineAt,executeDirectOperation=null,confirmationMode='buttons',timezone='UTC'}={}) {
  if(!supabase?.from||typeof scope?.workspaceId!=='string')throw new TypeError('Supabase and verified workspace scope required');
  let replyRequirement=null;
  let writeAttempted=false;
  let attemptedOperation=null;
  let nextActionParams=null,nextActionResult=null,nextActionRecords=null;
  const readScoped=async ({table,columns,filters,limit,offset,order},internalColumns=[],ctx,{customerName=false,customerFilter=null}={})=>{
    const spec=TABLES[table];
    const selected=columns||spec.defaults;
    const actual=selected.filter(column=>column!=='customer_name'
      &&!(['payments','invoice_files'].includes(table)&&column==='invoice_number'));
    const selectedWithInternals=[...new Set([...actual,...internalColumns])];
    if(!selectedWithInternals.length)throw new TypeError('empty selected fields');
    await ctx?.assertAuthorized?.();
    const joinCustomer=table==='invoices'&&(customerName||customerFilter);
    const joinName=joinCustomer?`,customer:customers!invoices_workspace_id_customer_id_fkey${customerFilter?'!inner':''}(name)`:'';
    let query=supabase.from(table).select(selectedWithInternals.join(',')+joinName);
    query=query.eq('workspace_id',scope.workspaceId);
    if(table==='invoices')query=query.is('deleted_at',null);
    for(const filter of filters)query=applyFilter(query,filter);
    if(customerFilter)query=applyFilter(query,{...customerFilter,column:'customer.name'});
    if(order)query=query.order(order.column,{ascending:order.direction==='asc'});
    else if(['customers','invoices','payments','invoice_files'].includes(table))query=query.order('created_at',{ascending:false});
    if(['customers','invoices','payments','invoice_files','business_records'].includes(table))query=query.order('id',{ascending:false});
    if(typeof query.range==='function')query=query.range(offset,offset+limit);
    else query=query.limit(offset+limit+1);
    const result=await query;
    await ctx?.assertAuthorized?.();
    ctx?.assertLive();
    if(result?.error)throw Object.assign(new Error('workspace data read failed'),{code:result.error.code||'UNAVAILABLE'});
    const rows=Array.isArray(result?.data)?result.data:[];
    return typeof query.range==='function'?rows:rows.slice(offset,offset+limit+1);
  };
  const findRelatedRows=async(table,column,values,select,ctx)=>{
    await ctx?.assertAuthorized?.();
    const query=supabase.from(table).select(select).eq('workspace_id',scope.workspaceId);
    if(table==='invoices')query.is('deleted_at',null);
    query.in(column,values);
    const result=await query.limit(MAX_LIMIT+1);
    await ctx?.assertAuthorized?.();
    ctx?.assertLive();
    if(result?.error)throw Object.assign(new Error('workspace data relation lookup failed'),{code:result.error.code||'UNAVAILABLE'});
    return Array.isArray(result?.data)?result.data:[];
  };
  const read=async (params,ctx)=>{
    const table=params.table,spec=TABLES[table],requested=params.columns||spec.defaults;
    const relationFilters=params.filters.filter(filter=>
      (table==='invoices'&&filter.column==='customer_name')
      ||(['payments','invoice_files'].includes(table)&&filter.column==='invoice_number'));
    if(relationFilters.length>1)throw new TypeError('combine one related-record filter at a time');
    let filters=params.filters.filter(filter=>!relationFilters.includes(filter));
    let rows;
    if(relationFilters.length) {
      const rf=relationFilters[0];
      if(table==='invoices') {
        // The FK join below keeps customer-name filtering and invoice loading
        // in one workspace-scoped round trip, including the display name.
      } else {
        await ctx.assertAuthorized();
        let q=supabase.from('invoices').select('id').eq('workspace_id',scope.workspaceId).is('deleted_at',null);
        q=applyFilter(q,{...rf,column:'invoice_number'});const rel=await q.limit(MAX_LIMIT+1);await ctx.assertAuthorized();ctx.assertLive();
        if(rel?.error)throw rel.error;
        if((rel?.data||[]).length>MAX_LIMIT){await ctx.assertAuthorized();return {ok:true,rows:[],truncated:true,note:'The related invoice filter matches too many records. Narrow it before continuing.'};}
        const ids=(rel?.data||[]).map(row=>row.id).filter(value=>UUID.test(value)).slice(0,MAX_LIMIT);
        if(!ids.length){await ctx.assertAuthorized();return {ok:true,rows:[],truncated:false};}
        filters=[...filters,{column:'invoice_id',operator:'in',value:ids}];
      }
    }
    const internal=[];
    if(table==='invoices')internal.push('id','invoice_number','updated_at','status','total_amount','amount_paid');
    if(table==='customers')internal.push('id','name','updated_at','metadata');
    if(['payments','invoice_files'].includes(table))internal.push('invoice_id');
    if(['payments','invoice_files'].includes(table)&&relationFilters.length)internal.push('invoice_id');
    if(table==='customers'&&params.operation!=='read')internal.push('id','updated_at');
    rows=await readScoped({...params,filters},internal,ctx,{customerName:requested.includes('customer_name'),
      customerFilter:relationFilters[0]&&table==='invoices'?relationFilters[0]:null});
    if(!rows.length&&['customers','invoices','business_records'].includes(table)&&params.filters.length
      &&params.filters.every(f=>f.operator==='eq')&&params.filters.some(f=>['name','company_name','customer_name'].includes(f.column))){
      const found=await resolveWorkspaceRecord({supabase,scope,table,filters:params.filters,operation:'read',
        select:table==='invoices'?'id,invoice_number':'id,name',assertAuthorized:()=>ctx.assertAuthorized(),assertLive:()=>ctx.assertLive()});
      if(found.code==='AMBIGUOUS')return safeError(found);
      if(found.ok)rows=await readScoped({...params,filters:[{column:'id',operator:'in',value:found.rows.map(row=>row.id)}]},internal,ctx,{customerName:requested.includes('customer_name')});
    }
    const rawPageCount=rows.length;
    let labels=new Map();
    if(['payments','invoice_files'].includes(table)&&internal.includes('invoice_id')) {
      const ids=[...new Set(rows.map(row=>row.invoice_id).filter(value=>UUID.test(value||'')))];
      if(ids.length){const invoices=await findRelatedRows('invoices','id',ids,'id,invoice_number',ctx);labels=new Map(invoices.map(row=>[row.id,row.invoice_number]));}
    }
    if(['payments','invoice_files'].includes(table))rows=rows.filter(row=>labels.has(row.invoice_id));
    const finalColumns=requested.filter(column=>column!=='customer_name'
      &&!(['payments','invoice_files'].includes(table)&&column==='invoice_number'));
    const output=rows.map(row=>{
      const safe=Object.fromEntries(finalColumns.filter(column=>Object.hasOwn(row,column)&&!INTERNAL_KEY.test(column)).map(column=>[column,
        column==='follow_up_preferences'?safeFollowupPreferences(row[column]):row[column]]));
      if(requested.includes('customer_name'))safe.customer_name=row.customer?.name||row.customer?.[0]?.name||null;
      if(requested.includes('invoice_number')&&['payments','invoice_files'].includes(table))safe.invoice_number=labels.get(row.invoice_id)||null;
      return safe;
    });
    const truncated=rawPageCount>params.limit;
    await ctx.assertAuthorized();
    if(['customers','invoices'].includes(table))nextActionRecords=rows.slice(0,params.limit).map(row=>Object.fromEntries(
      internal.filter(key=>Object.hasOwn(row,key)).map(key=>[key,key==='metadata'?{whatsapp_owner:row.metadata?.whatsapp_owner===true}:structuredClone(row[key])])));
    return sanitise({ok:true,rows:output.slice(0,params.limit),truncated,
      ...(truncated?{nextOffset:params.offset+params.limit}:{})},scope);
  };
  const rpc=async(name,args,ctx)=>{
    await ctx?.assertAuthorized?.();
    const result=await supabase.rpc(name,args);
    await ctx?.assertAuthorized?.();
    ctx?.assertLive();
    if(result?.error)throw Object.assign(new Error('workspace data operation failed'),{code:result.error.code||'UNAVAILABLE'});
    const row=Array.isArray(result?.data)?result.data[0]:result?.data;
    if(!row||typeof row!=='object')throw Object.assign(new Error('workspace data result unavailable'),{code:'UNAVAILABLE'});
    return row;
  };
  const exactScopeKeys={p_workspace_id:scope.workspaceId,p_customer_id:scope.customerId,p_phone:scope.phone};
  const delegate=async(params,ctx)=>{
    if(typeof executeSafetyOperation!=='function')return fail();
    let safeParams=params;
    if(params.table==='invoices'&&params.operation==='create'&&Object.hasOwn(params.values,'customer_id')) {
      const customerId=params.values.customer_id;
      if(typeof customerId!=='string'||!UUID.test(customerId)||Object.hasOwn(params.values,'customer_name')
          ||Object.hasOwn(params.values,'client_name'))return fail('INVALID','Choose one customer for the invoice.');
      await ctx.assertAuthorized();
      let query=supabase.from('customers').select('name').eq('workspace_id',scope.workspaceId).eq('id',customerId);
      const found=await query.limit(2);await ctx.assertAuthorized();ctx.assertLive();
      if(found?.error)throw found.error;
      const matches=found?.data||[];
      if(matches.length===0)return fail('NOT_FOUND','That customer was not found in this workspace.');
      if(matches.length!==1)return fail('AMBIGUOUS','Choose one customer for the invoice.');
      const values={...params.values,customer_name:matches[0].name};delete values.customer_id;
      safeParams={...params,values};
    }
    await ctx.assertAuthorized();
    if(['create','update','delete','restore','confirm','cancel','saveAttachment','reviewAttachment','sendFile'].includes(params.operation)) {
      writeAttempted=true;
    }
    const result=await executeSafetyOperation({...safeParams,scope,message,messageId,pending,pendingAtStart,
      authorize,clock,signal:ctx.signal,deadlineAt:ctx.deadlineAt});
    await ctx.assertAuthorized();
    return sanitise(result,scope);
  };
  const checkWriteTarget=async (params,ctx)=>{
    const {table,operation,filters,values}=params;
    let clean=table==='workspace_ai_settings'?null:table==='invoices'?{custom_fields:validateCustomFields(values.custom_fields)}:validateValues(table,operation,values);
    let row=null,targetId=null,expectedUpdatedAt=null,summary='';
    if(['customers','business_records'].includes(table)&&operation==='create') {
      summary=`Create ${table==='customers'?'customer':clean.record_type} ${clean.name}`;
    } else if(table==='business_records') {
      const found=await resolveWorkspaceRecord({supabase,scope,table,filters,operation,select:'id,record_type,name,custom_fields,updated_at',
        assertAuthorized:()=>ctx.assertAuthorized(),assertLive:()=>ctx.assertLive()});
      if(!found.ok)throw Object.assign(new Error('business record lookup failed'),{code:found.code});
      row=found.row;targetId=row.id;expectedUpdatedAt=row.updated_at;summary=`Update ${row.record_type} ${row.name}: ${JSON.stringify(clean)}`;
    } else if(table==='invoices') {
      const found=await resolveWorkspaceRecord({supabase,scope,table,filters,operation,select:'id,invoice_number,custom_fields,updated_at',
        assertAuthorized:()=>ctx.assertAuthorized(),assertLive:()=>ctx.assertLive()});
      if(!found.ok)throw Object.assign(new Error('invoice lookup failed'),{code:found.code});
      row=found.row;targetId=row.id;expectedUpdatedAt=row.updated_at;
      summary=`Update invoice ${row.invoice_number}: custom fields ${JSON.stringify(clean.custom_fields)}`;
    } else if(table==='customers') {
      const found=await resolveWorkspaceRecord({supabase,scope,table,filters,operation,select:'id,name,company_name,email,phone,custom_fields,updated_at,metadata',
        assertAuthorized:()=>ctx.assertAuthorized(),assertLive:()=>ctx.assertLive()});
      if(!found.ok)throw Object.assign(new Error('customer lookup failed'),{code:found.code});
      row=found.row;targetId=row.id;expectedUpdatedAt=row.updated_at;
      if(!UUID.test(targetId||'')||typeof expectedUpdatedAt!=='string')throw Object.assign(new Error('customer changed'),{code:'STALE'});
      if(row.metadata?.whatsapp_owner===true)return fail('DENIED','The linked owner contact cannot be changed as a customer.');
      if(operation==='delete')summary=`Delete customer ${row.name}`;
      else summary=`Update customer ${row.name}: `+Object.entries(clean)
        .map(([key,value])=>`${displayField(key)}: ${row[key]??'not set'} → ${value??'not set'}`).join('; ');
    } else if(table==='workspace_settings') {
      if(filters.length)throw Object.assign(new Error('workspace settings are already scoped'),{code:'INVALID'});
      await ctx.assertAuthorized();
      let query=supabase.from(table).select('business_name,default_currency,default_timezone,follow_up_preferences,owner_bot_preferences,updated_at').eq('workspace_id',scope.workspaceId);
      const found=await query.maybeSingle();
      await ctx.assertAuthorized();
      ctx.assertLive();
      if(found?.error)throw found.error;
      row=found?.data||null;
      if(!row)throw Object.assign(new Error('workspace settings unavailable'),{code:'NOT_FOUND'});
      targetId=scope.workspaceId;expectedUpdatedAt=row.updated_at;
      if(values.owner_bot_preferences)clean.owner_bot_preferences=mergeOwnerBotPreferences(row.owner_bot_preferences,values.owner_bot_preferences);
      summary=Object.entries(clean).map(([key,value])=>`${displayField(key)}: ${row[key]??'not set'} → ${value}`).join('; ');
    } else if(table==='workspace_ai_settings') {
      if(filters.length)throw Object.assign(new Error('AI settings are already scoped'),{code:'INVALID'});
      await ctx.assertAuthorized();
      let query=supabase.from(table).select('primary_model,fallback_model,updated_at').eq('workspace_id',scope.workspaceId);
      const found=await query.maybeSingle();await ctx.assertAuthorized();ctx.assertLive();
      if(found?.error)throw found.error;
      row=found?.data||null;
      let runtime={};
      if(typeof getRuntimeConfig==='function')try{await ctx.assertAuthorized();runtime=await getRuntimeConfig()||{};await ctx.assertAuthorized();}catch{runtime={};}
      ctx.assertLive();
      const runtimePrimaryRaw=runtime.activePrimaryModel||runtime.primaryModel;
      const runtimeFallback=runtime.activeFallbackModel===undefined?runtime.fallbackModel:runtime.activeFallbackModel;
      const primaryChoice=value=>VERIFIED_MODEL_CATALOG.some(entry=>entry.id===value&&entry.roles.includes('primary'));
      const fallbackChoice=value=>value===null||VERIFIED_MODEL_CATALOG.some(entry=>entry.id===value&&entry.roles.includes('fallback'));
      const safeRuntimePrimary=primaryChoice(runtimePrimaryRaw)?runtimePrimaryRaw:CF_PRIMARY_MODEL;
      const safeRuntimeFallback=runtimeFallback===undefined?GEMINI_FALLBACK_MODEL
        :fallbackChoice(runtimeFallback)?runtimeFallback:GEMINI_FALLBACK_MODEL;
      const currentPrimary=primaryChoice(row?.primary_model)?row.primary_model:safeRuntimePrimary;
      const currentFallback=fallbackChoice(row?.fallback_model)?row.fallback_model:safeRuntimeFallback;
      clean=validateValues(table,operation,values,{primary_model:currentPrimary,fallback_model:currentFallback});
      targetId=scope.workspaceId;expectedUpdatedAt=row?.updated_at||null;
      summary=Object.entries(clean).map(([key,value])=>{
        const before=key==='primary_model'?currentPrimary:currentFallback;
        const display=id=>VERIFIED_MODEL_CATALOG.find(entry=>entry.id===id)?.label||id||'off';
        return `${displayField(key)}: ${display(before)} → ${display(value)}`;
      }).join('; ');
    }
    if(operation==='delete'&&table!=='customers')throw Object.assign(new Error('this table cannot be deleted'),{code:'INVALID'});
    return {clean,row,targetId,expectedUpdatedAt,summary};
  };
  const propose=async (params,ctx)=>{
    const invoiceCustom=params.table==='invoices'&&params.operation==='update'&&Object.keys(params.values).length===1&&params.values.custom_fields;
    if(!invoiceCustom&&!['customers','business_records','workspace_settings','workspace_ai_settings'].includes(params.table))
      return typeof executeSafetyOperation==='function'?delegate(params,ctx):fail();
    if(params.table==='workspace_settings'&&params.operation==='update'
      &&Object.keys(params.values).every(key=>['business_name','follow_up_preferences'].includes(key))
      &&Object.keys(params.values.follow_up_preferences||{}).every(key=>['tone','maxReminders','cadenceDays','firstReminderDays','contactStart','contactEnd','pauseOnReply','dailySummary'].includes(key))) {
      validateAdapterSettingsValues(params.values);
      return delegate(params,ctx);
    }
    if(params.operation==='delete'&&params.table!=='customers')return fail();
    if(params.operation==='create'&&!['customers','business_records'].includes(params.table))return fail();
    if(params.operation==='update'&&params.table==='customers'||params.operation==='delete'&&params.table==='customers'
      ||params.operation==='create'&&['customers','business_records'].includes(params.table)||params.operation==='update'&&['workspace_settings','workspace_ai_settings','business_records'].includes(params.table)||invoiceCustom) {
      await ctx.assertAuthorized();
      const pendingState=await pending?.loadPendingActionState?.({...scope});
      await ctx.assertAuthorized();
      ctx.assertLive();
      if(!pendingState||!Number.isSafeInteger(Number(pendingState.generation)))return fail('UNAVAILABLE','A safe confirmation store is unavailable.');
      const activeAction=pendingState.action;
      const terminalReview=activeAction?.type==='invoice_review_draft'&&['saved','canceled'].includes(activeAction.stage);
      if(pendingState.id!=null&&activeAction?.type!=='owner_invoice_deleted'&&!terminalReview)
        return fail('PENDING','Another owner change is already waiting for a decision. Confirm or cancel it first.');
      if(!messageId)return fail('INVALID','This change needs an owner message before it can be proposed.');
      const target=await checkWriteTarget(params,ctx);ctx.assertLive();
      await ctx.assertAuthorized();
      writeAttempted=true;
      const saved=await rpc('whatsapp_workspace_data_propose',{
        ...exactScopeKeys,p_request_message_id:messageId,p_operation:params.operation,p_table:params.table,
        p_target_id:target.targetId,p_expected_updated_at:target.expectedUpdatedAt,p_values:target.clean,
        p_summary:target.summary,p_expected_generation:Number(pendingState.generation),
        p_expected_pending_id:pendingState.id??null,p_expected_pending_version:pendingState.version??null,
      },ctx);
      if(saved.ok!==true) return safeRpcResult(saved);
      replyRequirement={confirmationText:'yes',requiresCancel:true,requiresReplyCue:true,
        requiredFacts:{changeValues:Object.entries(target.clean).filter(([key,value])=>JSON.stringify(value)!==JSON.stringify(target.row?.[key])).map(([field,value])=>({field:displayField(field),value,...(VERIFIED_MODEL_CATALOG.some(entry=>entry.id===value)?{alternatives:[value,VERIFIED_MODEL_CATALOG.find(entry=>entry.id===value).label.replace(/ \([^)]*\)$/,'')]}:{})}))},maxLength:3790};
      return {ok:true,requiresConfirmation:true,table:params.table,operation:params.operation,
        summary:target.summary,changes:target.clean,confirmationText:'yes',expiresAt:saved.expires_at||saved.expiresAt||null};
    }
    return fail();
  };
  const safeRpcResult=row=>{
    if(row.ok===true)return sanitise(row,scope);
    const code=String(row.code||row.reason||'UNAVAILABLE').toUpperCase();
    return safeError({code});
  };
  const handlePending=async (operation,ctx)=>{
    const action=pendingAtStart?.action;
    if(operation==='pending'&&action?.type===DATA_ACTION)return {
      ok:true,pending:true,kind:'workspace_data_change',table:action.table,operation:action.operation,
      summary:typeof action.summary==='string'?action.summary:null,expiresAt:action.expiresAt||pendingAtStart.expires_at||null,
    };
    const terminalAction=action?.type==='owner_invoice_deleted'
      ||(action?.type==='invoice_review_draft'&&['saved','canceled'].includes(action.stage));
    if(['pending','confirm','cancel'].includes(operation)&&(!action||terminalAction)&&messageId
      &&(YES.test(String(message||''))||CANCEL.test(String(message||'')))) {
      const confirm=YES.test(String(message||''));
      try {
        const replay=await rpc(confirm?'whatsapp_workspace_data_confirm':'whatsapp_workspace_data_cancel',{
          ...exactScopeKeys,p_pending_id:null,p_pending_version:null,p_proposal_id:null,
          p_confirmation_message_id:confirm?messageId:null,p_cancel_message_id:confirm?null:messageId,
          p_user_message:String(message||''),
        },ctx);
        if(replay.replayed===true)return safeRpcResult(replay);
      } catch { /* A receipt lookup is optional; preserve the existing action adapter fallback. */ }
    }
    if(['confirm','cancel'].includes(operation)&&action?.type===DATA_ACTION) {
      const explicit=operation==='confirm'?YES.test(String(message||'')):CANCEL.test(String(message||''));
      if(!explicit||!messageId||messageId===action.requestMessageId)
        return fail('INVALID',operation==='confirm'?'Only a later explicit owner confirmation can apply this proposal.':'Only an explicit owner cancellation can cancel this proposal.');
      ctx.assertLive();
      await ctx.assertAuthorized();
      writeAttempted=true;
      const name=operation==='confirm'?'whatsapp_workspace_data_confirm':'whatsapp_workspace_data_cancel';
      const result=await rpc(name,{...exactScopeKeys,p_pending_id:pendingAtStart.id,p_pending_version:pendingAtStart.version,
        p_proposal_id:action.proposalId,p_confirmation_message_id:operation==='confirm'?messageId:null,
        p_cancel_message_id:operation==='cancel'?messageId:null,p_user_message:String(message||'')},ctx);
      return safeRpcResult(result);
    }
    if(typeof executeSafetyOperation!=='function')return fail('NO_PENDING_ACTION','There is no matching pending owner action.');
    return delegate({operation},ctx);
  };
  const describe=async (ctx,table=null)=>{
    let runtime=null;
    if(!table&&typeof getRuntimeConfig==='function')try{await ctx.assertAuthorized();runtime=await getRuntimeConfig();await ctx.assertAuthorized();}catch{runtime=null;}
    ctx.assertLive();
    const safeRuntime=runtime&&typeof runtime==='object'?Object.fromEntries([
      'configurationSource','workspaceSettingsAvailable','activePrimaryModel','activePrimaryProvider','activeFallbackModel',
      'activeFallbackProvider','primaryModel','primaryProvider','fallbackModel','fallbackProvider','planningModel','planningProvider','servedModel','servedProvider',
    ].filter(key=>runtime[key]!==undefined).map(key=>[key,runtime[key]])):null;
    await ctx.assertAuthorized();
    return {ok:true,catalog:catalog(table),...(!table?{runtime:safeRuntime}:{}),...(!table||table==='workspace_ai_settings'?{modelChoices:VERIFIED_MODEL_CATALOG.map(({id,label,provider,roles})=>({id,label,provider,roles}))}:{})};
  };
  const executeRequest=async (raw,executionOptions={})=>{
    const signals=[signal,executionOptions?.signal].filter(Boolean);
    const combinedSignal=signals.length>1&&typeof AbortSignal?.any==='function'?AbortSignal.any(signals):signals[0];
    const deadlines=[deadlineAt,executionOptions?.deadlineAt].map(asEpoch).filter(Number.isFinite);
    const effectiveDeadline=deadlines.length?Math.min(...deadlines):null;
    const ctx={signal:combinedSignal,deadlineAt:effectiveDeadline,
      assertLive(){
        if(signals.some(item=>item.aborted))throw Object.assign(new Error(),{code:'OWNER_LOOP_TIMEOUT'});
        if(effectiveDeadline!==null&&Date.now()>=effectiveDeadline)throw Object.assign(new Error(),{code:'OWNER_LOOP_TIMEOUT'});
      },
      async assertAuthorized(){
        this.assertLive();
        if(typeof authorize!=='function'||!await authorize(scope))throw Object.assign(new Error(),{code:'OWNER_REQUIRED'});
        this.assertLive();
      }};
    try {
      try { await ctx.assertAuthorized(); }
      catch(error) { if(error?.code==='OWNER_REQUIRED')return fail('DENIED','This action is not available for the current owner binding.'); throw error; }
      const params=await normalizeRequest(raw,scope,planRequest,ctx);
      nextActionParams=structuredClone(params);
      if(params.values?.custom_fields!==undefined)validateCustomFields(params.values.custom_fields);
      const dateFields=['due_date','issue_date'].filter(field=>Object.hasOwn(params.values||{},field));
      const ownerRelative=params.operation==='update'&&dateFields.length===1&&!/\b\d{4}-\d{2}-\d{2}\b/.test(message)
        ?(()=>{const days=[...new Set([...String(message).matchAll(/\b(today|tomorrow|yesterday)(?:['’]?s)?\b/gi)].map(match=>match[1].toLowerCase()))];return days.length===1?days[0]:null;})():null;
      if(params.table==='invoices')for(const field of ['due_date','issue_date']){
        const relative=ownerRelative&&dateFields.includes(field)?ownerRelative:String(params.values?.[field]??'').toLowerCase().replace(/['’]/g,'').replace(/s? date$/,'').trim();
        if(['today','tomorrow','yesterday'].includes(relative)){
          const calendar=ownerCalendar(clock,timezone);
          params.values[field]=relative==='today'?calendar.currentDate:calendar[relative];
        }
      }
      ctx.assertLive();
      attemptedOperation={operation:params.operation,...(params.table?{table:params.table}:{})};
      const readResult=result=>({...result,operation:params.operation,table:params.table,readOnly:true});
      if(params.operation==='describe')return readResult(await describe(ctx,params.table));
      if(['pending','confirm','cancel'].includes(params.operation)) {
        const result=await handlePending(params.operation,ctx);
        return params.operation==='pending'?readResult(result):result;
      }
      if(params.operation==='read')return readResult(await read(params,ctx));
      if(params.table==='invoices'&&params.operation==='update'&&params.values.status==='unpaid'){
        if(Object.keys(params.values).length!==1)return fail('INVALID','Check unpaid status separately from other invoice changes.');
        const found=await resolveWorkspaceRecord({supabase,scope,table:'invoices',filters:params.filters,operation:'update',
          select:'id,invoice_number,status,total_amount,amount_paid',assertAuthorized:()=>ctx.assertAuthorized(),assertLive:()=>ctx.assertLive()});
        if(!found.ok)return safeError(found);
        const invoice=found.row;
        const payments=await findRelatedRows('payments','invoice_id',[invoice.id],'id,amount',ctx);
        if(Number(invoice.amount_paid)!==0||payments.length||!['draft','sent','overdue'].includes(invoice.status))
          return fail('PAYMENT_GUARD','This invoice has payments or a terminal status. Marking it unpaid cannot erase payment history. Review the recorded payments first.');
        return {ok:true,readOnly:true,completed:false,alreadyUnpaid:true,requiresConfirmation:false,invoiceNumber:invoice.invoice_number,
          message:'This invoice is already unpaid. No payment or invoice data was changed.'};
      }
      if(params.table==='invoices'&&params.operation==='update'&&params.filters[0]?.column==='customer_name'){
        const found=await resolveWorkspaceRecord({supabase,scope,table:'invoices',filters:params.filters,operation:'update',
          select:'id,invoice_number',assertAuthorized:()=>ctx.assertAuthorized(),assertLive:()=>ctx.assertLive()});
        if(!found.ok)return safeError(found);
        params.filters=[{column:'id',operator:'eq',value:found.row.id}];
      }
      // Validate before marking or dispatching a write. A malformed model call
      // can then be corrected from the catalog without a database write attempt.
      if(['business_records','customers'].includes(params.table)&&['create','update'].includes(params.operation))
        params.values=validateValues(params.table,params.operation,params.values);
      if(['create','update','delete','restore'].includes(params.operation)&&confirmationMode==='direct'&&typeof executeDirectOperation==='function'){
        ctx.assertLive();await ctx.assertAuthorized();writeAttempted=true;
        const result=await executeDirectOperation(params,ctx);
        await ctx.assertAuthorized();ctx.assertLive();
        return {...sanitise(result,scope),operation:params.operation,table:params.table,writeAttempted:true};
      }
      if(params.operation==='create'||params.operation==='update'||params.operation==='delete')return await propose(params,ctx);
      if(['restore','analyzeAttachment','saveAttachment','reviewAttachment','sendFile'].includes(params.operation)) {
        if(typeof executeSafetyOperation!=='function')return fail();
        return delegate(params,ctx);
      }
      return fail();
    } catch(error) {
      if(!(error instanceof TypeError))return safeError(error);
      const errors={
        'invoice action requires exactly one canonical target':['TARGET_REQUIRED','Which invoice do you mean? Send its invoice number or customer name. If that customer has several invoices, I will ask you to choose. No change was made.'],
        'invalid invoice fields':['INVALID_FIELDS','Those invoice fields are not supported. Use status paid or unpaid for a payment-status check; unpaid never removes recorded payments. No change was made.'],
        'invalid request':['REQUEST_SHAPE','The assistant combined two request formats. It should send either a description or structured fields. No change was made.'],
        'invalid write fields':['INVALID_FIELDS','Use the supported write fields in this catalog. Additional business facts must be nested inside custom_fields. Correct the tool arguments using the owner message already supplied; no database write was attempted.'],
        'record name required':['REQUIRED_FIELDS','Creating this record requires a nonempty name. Business records also require record_type. Use the owner message already supplied and the returned catalog; no database write was attempted.'],
        'invalid record category':['INVALID_CATEGORY','Business records require record_type as a lowercase category with letters, digits or underscores. Use the owner category already supplied; no database write was attempted.'],
        'invalid write value':['INVALID_VALUE','Use the field types in this catalog. Extra business facts belong in custom_fields, which accepts text, numbers, booleans or null. No database write was attempted.'],
        'empty write':['REQUIRED_FIELDS','Provide at least one supported field from the owner request. No database write was attempted.'],
        'invalid text field':['INVALID_VALUE','Record text fields must be nonempty, within the catalog length limits and contain no control characters. No database write was attempted.'],
      };
      const detail=errors[error.message];
      return detail?{ok:false,code:'INVALID',validationCode:detail[0],message:detail[1]}:fail();
    }
  };
  const execute=async(raw,options)=>{
    nextActionParams=null;nextActionResult=null;nextActionRecords=null;
    const result=await executeRequest(raw,options);
    nextActionResult=result;
    return result?.code==='INVALID'?{...result,...(!result.validationCode?{message:'Use request text alone, or the structured fields in this catalog. Do not combine request with filters, values or columns. pending/confirm/cancel take no table or values.'}:{}),catalog:catalog(typeof raw?.table==='string'&&Object.hasOwn(TABLES,raw.table)?raw.table:null)}:result;
  };
  return Object.freeze({definition:definition(),execute,getReplyRequirement:()=>replyRequirement?{...replyRequirement}:null,
    getNextActionContext:()=>nextActionParams&&nextActionResult?{params:nextActionParams,result:nextActionResult,records:nextActionRecords}:null,
    getWriteAttempted:()=>writeAttempted,getAttemptedOperation:()=>attemptedOperation});
}

export {sanitise as sanitizeWorkspaceToolResult};
