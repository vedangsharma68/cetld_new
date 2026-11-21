import {createHash} from 'node:crypto';
const unwrap=r=>{if(r?.error)throw r.error;return r?.data;};
const hash=value=>createHash('sha256').update(value).digest('hex');
const bucket='whatsapp-delivery-private';
const phase=input=>input.phase||'answer';
export function serviceDeliveryRequest(input,method='reply'){
 const value={...input,workspaceId:input.workspaceId??null,kind:input.kind||'normal',audience:input.audience||'customer',phase:phase(input)};
 if(value.media){value.media={...value.media};delete value.media.bytes;}
 return JSON.parse(JSON.stringify({method,input:value}));
}
export function createServiceDeliveryStore(supabase){
 return {
  async save(input,method='reply'){
   const request=serviceDeliveryRequest(input,method);
   if(method==='media'){
    if(!input.media?.bytes?.length||input.media.bytes.length>10*1024*1024)throw Error('Invalid delivery media size');
    const sha256=hash(input.media.bytes);
    if(input.media.id&&input.media.invoice_id&&input.media.storage_path?.startsWith(input.workspaceId+'/'+input.media.invoice_id+'/'))request.input.media.deliveryBlob={bucket:'invoice-files',path:input.media.storage_path,sha256};
    else{
     const path=hash(input.messageId+'\0'+phase(input))+'/'+sha256;
     const upload=await supabase.storage.from(bucket).upload(path,input.media.bytes,{contentType:'application/octet-stream',upsert:false});
     if(upload.error){const existing=unwrap(await supabase.storage.from(bucket).download(path));if(hash(Buffer.from(await existing.arrayBuffer()))!==sha256)throw upload.error;}
     request.input.media.deliveryBlob={bucket,path,sha256};
    }
   }
   let result;for(let attempt=0;attempt<2;attempt++){
    result=await supabase.rpc('whatsapp_save_service_delivery',{p_message_id:input.messageId,p_phone:input.to,p_phase:phase(input),p_request:request});if(!result?.error)break;
   }
   return unwrap(result);
  },
  protocol:async(event,protocol)=>unwrap(await supabase.rpc('whatsapp_save_service_delivery',{p_message_id:event.provider_message_id,p_phone:event.sender_phone,p_phase:'answer',p_request:{method:'protocol',protocol,input:{workspaceId:null,to:event.sender_phone,messageId:event.provider_message_id,kind:'verification',audience:'customer',phase:'answer'}}})),
  state:async event=>unwrap(await supabase.rpc('whatsapp_service_delivery_state',{p_message_id:event.provider_message_id,p_phone:event.sender_phone}))||[],
  claim:async(excluded=[])=>unwrap(await supabase.rpc('whatsapp_claim_ready_service_delivery',{p_excluded:excluded})),
  async ready(){const response=await supabase.rpc('whatsapp_service_delivery_status',{}),value=response?.data;if(response?.error||value?.ready!==true||value?.queueRevision!==2||value?.legacyAcknowledgmentsReconciled!==true)throw Error('Apply all four signup and dispatch migrations before starting this worker');return value;},
  finish:async(input,result)=>unwrap(await supabase.rpc('whatsapp_finish_service_delivery',{p_message_id:input.messageId,p_phone:input.to,p_phase:phase(input),p_status:result?.status==='accepted'?'accepted':result?.status==='blocked'?'blocked':['unknown','failed'].includes(result?.status)?'quarantined':'pending',p_reason:result?.reason||null})),
  release:async lease=>unwrap(await supabase.rpc('whatsapp_release_service_delivery',{p_event_id:lease.event.id,p_phase:lease.delivery.phase,p_token:lease.delivery.lease_token})),
  async media(input){
   const ref=input.media?.deliveryBlob;
   const source=ref?.bucket==='invoice-files'&&ref.path===input.media.storage_path&&ref.path.startsWith(input.workspaceId+'/'+input.media.invoice_id+'/')&&!ref.path.split('/').some(p=>p==='.'||p==='..');
   const privateBlob=ref?.bucket===bucket&&/^[a-f0-9]{64}\/[a-f0-9]{64}$/.test(ref.path)&&ref.path.split('/')[1]===ref.sha256;
   if(!source&&!privateBlob)throw Error('Invalid delivery blob reference');
   const blob=unwrap(await supabase.storage.from(ref.bucket).download(ref.path)),bytes=Buffer.from(await blob.arrayBuffer());
   if(bytes.length>10*1024*1024||hash(bytes)!==ref.sha256)throw Error('Stored delivery media changed');
   const media={...input.media,bytes};delete media.deliveryBlob;return media;
  },
 };
}

// Producer-side intent exists before ANY sender authority read. Replaying the
// stored request changes no send admission, claim, privacy or cutoff routine.
export function wrapServiceDelivery(sender,store){
 const wrapped=Object.create(sender);
 for(const [name,method]of [['sendServiceReply','reply'],['sendServiceMedia','media']])if(typeof sender[name]==='function')Object.defineProperty(wrapped,name,{value:async input=>{
  const delivery=await store.save(input,method);
  if(delivery.status!=='pending')return {status:delivery.status==='quarantined'?'unknown':delivery.status,reason:delivery.reason};
  const saved=delivery.request.input;
  let actual={...saved};
  if(method==='media')actual.media=await store.media(actual);
  try{const result=await sender[name].call(sender,actual);await store.finish(actual,result);return result;}
  catch(error){try{await store.finish(actual,{status:'pending',reason:error?.code||'delivery_unavailable'});}catch{}throw error;}
 }});
 return wrapped;
}
