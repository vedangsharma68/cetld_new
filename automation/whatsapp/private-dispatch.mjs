import {createCanonicalPrivateValueIndex} from '../../ai/private-payload-boundary.mjs';
import {privateFieldKeys,privateNumberKeys,privateOriginStart} from '../../ai/private-value-matcher.mjs';
import {createHash} from 'node:crypto';
// Every WhatsApp content transport, including injected transports and retries,
// admits the final serialized body against recipient-owned canonical keys.
export async function prepareWhatsAppDispatch({supabase,workspaceId,phone,publicIdentities=[],media}){
 const r=await supabase.rpc('whatsapp_dispatch_privacy_snapshot',{p_workspace_id:workspaceId??null,p_phone:phone});
 if(r?.error||!Array.isArray(r?.data?.terms))throw Object.assign(Error('Recipient privacy snapshot unavailable'),{code:'PRIVATE_PAYLOAD_BLOCKED'});
 const index=createCanonicalPrivateValueIndex(r.data.terms);
 let fileOwned=false,ownedFileName;
 if(media){
  const source=(r.data.files||[]).find(f=>f.id===media.id&&f.invoice_id===media.invoice_id&&f.workspace_id===workspaceId&&f.storage_path===media.storage_path);
  if(source&&supabase.storage){const downloaded=await supabase.storage.from('invoice-files').download(source.storage_path);
   if(!downloaded.error&&downloaded.data){const actual=Buffer.from(await downloaded.data.arrayBuffer());fileOwned=createHash('sha256').update(actual).digest('hex')===createHash('sha256').update(media.bytes).digest('hex');if(fileOwned)ownedFileName=source.file_name;}}
 }
 // Public identities are compiler constants, never message/user fields. They
 // certify only whole identifiers; numeric fragments remain private elsewhere.
 const identities=new Set([...(r.data.identifiers||[]),...publicIdentities.flatMap(value=>privateFieldKeys(value).filter(k=>k.startsWith('identifier:')))]),owned=createCanonicalPrivateValueIndex([...identities]);
 const values=new Set(r.data.values||[]),ownedValues=createCanonicalPrivateValueIndex([...values].filter(k=>/^(number|date|date-range):/.test(k)));
 const scoped=value=>{
  if(typeof value==='string'){
   const chars=value.split('');
   const certified=owned.spans(value).filter(([a,b])=>privateFieldKeys(value.slice(a,b)).some(k=>identities.has(k)));
   for(const [a,b] of ownedValues.spans(value)){
    const part=value.slice(a,b),keys=[...privateFieldKeys(part).filter(k=>/^[a-z-]+:/.test(k)),...privateNumberKeys(part,true)];
    if(keys.length&&keys.every(k=>values.has(k)))certified.push([a,b]);
   }
   const foreign=index.spans(value,{ordinary:true}),origin=privateOriginStart(value);
   if(origin!==null&&foreign[0]?.[0]===origin&&foreign[0]?.[1]===value.length)foreign.shift();
   // A complete foreign date/range or reference that encloses an owned
   // identifier remains private. Only matches wholly inside the ID are owned.
   for(const [a,b] of foreign)if(!certified.some(([x,y])=>x<=a&&y>=b))index.assertValues(value.slice(a,b));
   for(const [a,b] of certified){
    // An owned identifier consumes its whole span; its numeric components
    // cannot be reinterpreted as somebody else's amount. Origin/clause spans
    // are never certificates: their complete field identity must agree.
    if(privateFieldKeys(value.slice(a,b)).some(k=>identities.has(k)))for(let i=a;i<b;i++)chars[i]=' ';
   }
   return chars.join('');
  }
  if(Array.isArray(value))return value.map(scoped);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,scoped(v)]));
  return value;
 };
 let uploadedId;
 const leaves=value=>Array.isArray(value)?value.flatMap(leaves):value&&typeof value==='object'?Object.values(value).flatMap(leaves):[value];
 const admit=(payload,{audience='customer'}={})=>{
  if('+'+String(payload.to||'').replace(/^\+/,'')!==phone)throw Object.assign(Error('Recipient changed'),{code:'PRIVATE_PAYLOAD_BLOCKED'});
  if(['image','document'].includes(payload.type)&&audience!=='owner'&&!fileOwned)throw Object.assign(Error('File recipient provenance unavailable'),{code:'PRIVATE_PAYLOAD_BLOCKED'});
  if(['image','document'].includes(payload.type)&&payload[payload.type]?.id!==uploadedId)throw Object.assign(Error('Uploaded file binding changed'),{code:'PRIVATE_PAYLOAD_BLOCKED'});
  const {to,type,messaging_product,recipient_type,biz_opaque_callback_data,...content}=payload;
  if(fileOwned&&content.document?.filename===ownedFileName)content.document={...content.document,filename:''};
  // Template name/language/component type are Graph protocol identifiers,
  // like the model ID at the AI boundary. All dynamic parameter data is scanned.
  const visible=payload.type==='template'
    ?payload.template?.components?.flatMap(component=>(component.parameters||[]).map(({type,...data})=>data))
    :content;
  index.assertValues(scoped(leaves(visible)));
 };
 admit.upload=form=>{const name=form.get('file')?.name||'';if(!fileOwned||name!==ownedFileName)index.assertValues(scoped(name));};
 admit.bindMediaId=id=>{if(typeof id!=='string'||!id)throw Object.assign(Error('Invalid uploaded file identity'),{code:'PRIVATE_PAYLOAD_BLOCKED'});uploadedId=id;};
 return admit;
}
export async function dispatchWhatsApp({supabase,workspaceId,fetchImpl,url,init,admission,audience}){
 if(init.body instanceof FormData){
  if(!admission)throw Object.assign(Error('Upload privacy admission unavailable'),{code:'PRIVATE_PAYLOAD_BLOCKED'});
  admission.upload(init.body);
  return fetchImpl(url,init);
 }
 const serialized=init.body,payload=JSON.parse(serialized);
 if(payload.status==='read'){
  // Read/typing acknowledgments have no content. Reject added data fields.
  if(Object.keys(payload).sort().join(',')!=='message_id,messaging_product,status,typing_indicator'||payload.messaging_product!=='whatsapp'||typeof payload.message_id!=='string'||Object.keys(payload.typing_indicator||{}).join(',')!=='type'||payload.typing_indicator.type!=='text')throw Object.assign(Error('Invalid status frame'),{code:'PRIVATE_PAYLOAD_BLOCKED'});
  return fetchImpl(url,{...init,body:serialized});
 }
 const screen=admission??await prepareWhatsAppDispatch({supabase,workspaceId,phone:'+'+String(payload.to||'').replace(/^\+/,'')});
 screen(payload,{audience});
 // Dispatch the exact bytes admitted above. No assembler/serializer runs later.
 return fetchImpl(url,{...init,body:serialized});
}
