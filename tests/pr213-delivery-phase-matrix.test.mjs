import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {fixture,png} from './fixtures/private-invoice.mjs';import {createInboundRuntime,SupabaseInboundInbox} from '../automation/whatsapp/cloud-inbound.mjs';import {createWhatsAppOutbound} from '../automation/whatsapp/cloud-outbound.mjs';import {createServiceDeliveryStore,wrapServiceDelivery} from '../automation/whatsapp/service-delivery.mjs';import {createConversationStore} from '../automation/whatsapp/conversation-store.mjs';
const env={WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_COMMERCIAL_OUTBOUND_ENABLED:'true',WHATSAPP_ACCESS_TOKEN:'fixture',WHATSAPP_PHONE_NUMBER_ID:'123456',WHATSAPP_GRAPH_API_VERSION:'v24.0'},logger={info(){},warn(){},error(){}};
for(const format of ['owner-text','customer-text','unreadable','interactive','media','customer-media','ack'])for(const fault of ['preclaim','postclaim','postfence','reconstruction'])test('phase queue '+format+'/'+fault+' preserves the first intent and repeats every send check',async()=>{
 const f=await fixture();try{
  const audience=['customer-text','unreadable','customer-media'].includes(format)?'customer':'owner',phone=audience==='owner'?f.scope.phone:'+12025550859',id='wamid.matrix-'+format+'-'+fault,phase=format==='ack'?'ack':'answer',sent=[];let customer=f.scope.customerId,media;
  if(audience==='customer'){
   customer=(await f.db.query("insert into customers(workspace_id,name,phone) values($1,'Matrix Grove',$2) returning id",[f.scope.workspaceId,phone])).rows[0].id;
   await f.db.query("insert into whatsapp_consents(workspace_id,customer_id,phone,source,consent_text_version,categories) values($1,$2,$3,'verbal','fixture',array['invoice_updates'])",[f.scope.workspaceId,customer,phone]);
  }
  await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,provider_timestamp,status) values($1,'123456',$2,'text','Explain gardening',now(),'pending')",[id,phone]);
  const conversations=createConversationStore(f.supabase);await conversations.record({workspaceId:f.scope.workspaceId,customerId:audience==='customer'?customer:null,phone,direction:'inbound',audience,body:'Explain gardening',status:'received',providerMessageId:id,key:'inbound:'+id});
  let staged=false,claimed=false,fenced=false,injected=false;
  const supabase={storage:f.supabase.storage,from:table=>{const q=f.supabase.from(table);if(table==='whatsapp_inbound_events'){const select=q.select.bind(q);q.select=(...args)=>{const query=select(...args),single=query.maybeSingle.bind(query);query.maybeSingle=async()=>{if(args[0]==='*'&&!injected&&(fault==='preclaim'&&staged||fault==='postclaim'&&claimed||fault==='postfence'&&fenced)){injected=true;return {error:{code:'08006',message:'Transient authority read'}};}return single();};return query;};}return q;},rpc:async(name,args)=>{const r=await f.supabase.rpc(name,args);if(name==='whatsapp_save_service_delivery'&&r.data){staged=true;if(fault==='reconstruction'&&!injected){injected=true;throw Error('Producer ended after durable commit');}}if(name==='whatsapp_claim_reserved_reply'&&r.data===true)claimed=true;if(name==='whatsapp_begin_reply_dispatch'&&r.data===true)fenced=true;return r;}};
  const inbox=new SupabaseInboundInbox(supabase,{env}),[event]=await inbox.claim(1);
  const fetchImpl=async(url,init)=>{if(new URL(url).pathname.endsWith('/media'))return Response.json({id:'uploaded-media'});const payload=JSON.parse(init.body);if(payload.status==='read')return Response.json({success:true});sent.push(payload);return Response.json({messages:[{id:'wamid.matrix-delivered'}]});};
  const actual=createWhatsAppOutbound({supabase,env,logger,fetchImpl,authorizeInboundReply:input=>inbox.claimReply(input)}),producer=wrapServiceDelivery(actual,createServiceDeliveryStore(supabase));
  const input={workspaceId:f.scope.workspaceId,to:phone,body:format==='unreadable'?'I could not read that. Send text or a photo.':'Saved gardening answer',caption:'Saved gardening answer',businessName:'Offline Studio',lastInboundAt:event.provider_timestamp,messageId:id,kind:'normal',audience,phase,...(format==='interactive'?{buttons:[{id:'stored-choice',title:'Open'}]}:{})};
  if(format==='media'||format==='customer-media'){
   media={bytes:png,mime_type:'image/png',file_name:'garden.png'};
   if(format==='customer-media'){
    const invoice=(await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,currency,status) values($1,$2,'MATRIX-FILE',43,'INR','draft') returning id",[f.scope.workspaceId,customer])).rows[0].id,path=f.scope.workspaceId+'/'+invoice+'/'+randomUUID();
    const uploaded=await f.supabase.storage.from('invoice-files').upload(path,png,{contentType:'image/png'});assert.equal(uploaded.error,null);
    const file=(await f.db.query("insert into invoice_files(workspace_id,invoice_id,storage_path,file_name,mime_type,size_bytes) values($1,$2,$3,'garden.png','image/png',$4) returning *",[f.scope.workspaceId,invoice,path,png.length])).rows[0];media={...file,bytes:png};
   }
   input.media=media;
  }
  try{const result=await producer[input.media?'sendServiceMedia':'sendServiceReply'](input);assert.equal(result.status,'pending');}catch(error){assert.equal(fault,'reconstruction',error.message);}
  assert.equal(injected,true);assert.equal(sent.length,0);
  const saved=(await f.db.query('select * from app.whatsapp_service_deliveries where event_id=$1 and phase=$2',[event.id,phase])).rows[0];assert.equal(saved.status,'pending');assert.equal(saved.request.input.body,input.body);assert.equal(saved.phase,phase);
  await inbox.defer(event,'DELIVERY_PENDING');if(phase==='ack')await f.db.query("update whatsapp_inbound_events set status='done' where id=$1",[event.id]);
  await f.db.query("update whatsapp_inbound_events set next_attempt_at=now()-interval '1 minute' where id=$1",[event.id]);await f.db.query("update app.whatsapp_service_deliveries set next_attempt_at=now()-interval '1 minute' where event_id=$1",[event.id]);
  const runtime=()=>createInboundRuntime({supabase,env,logger,fetchImpl,onOwnerMessage:()=>assert.fail('Queue recovery cannot regenerate an answer'),onBoundMessage:()=>assert.fail('Queue recovery cannot invoke a model')});
  await runtime().processPending();assert.equal(sent.length,1);assert.equal((await f.db.query('select status from app.whatsapp_service_deliveries where event_id=$1 and phase=$2',[event.id,phase])).rows[0].status,'accepted');
  const expected=audience==='customer'?input.body+'\n\n- Offline Studio':input.body;
  if(format==='interactive'){assert.equal(sent[0].type,'interactive');assert.equal(sent[0].interactive.body.text,expected);assert.equal(sent[0].interactive.action.buttons[0].reply.id,'stored-choice');}
  else if(input.media){assert.equal(sent[0].type,'image');assert.equal(sent[0].image.caption,audience==='customer'?input.caption+'\n\n- Offline Studio':input.caption);}
  else assert.equal(sent[0].text.body,expected);
  await runtime().processPending();assert.equal(sent.length,1);
 }finally{await f.close();}
});
