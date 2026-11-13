import {createPrivateValueMatcher,decodePrivateJSON,normalizePrivateValue,privateFieldKeys} from './private-value-matcher.mjs';
export const PRIVATE_PAYLOAD_BLOCKED='PRIVATE_PAYLOAD_BLOCKED';
// One workspace-scoped canonical index owns every admission boundary. Its
// candidate lattice retains ambiguous values unless a scalar/common-word
// interpretation is established; unknown phrasing is never a release proof.
export function createCanonicalPrivateValueIndex(terms){
 const match=createPrivateValueMatcher(terms,{canonical:true});
 const contains=(value,depth=0,ordinary=false)=>{
  if(depth>32)return true;const scan=ordinary?match.ordinary:match;
  if(typeof value==='string'){const decoded=decodePrivateJSON(value);return decoded!==undefined&&decoded!==value?contains(decoded,depth+1,ordinary):scan(value);}
  if(Array.isArray(value))return value.some(v=>contains(v,depth+1,ordinary))||value.every(v=>typeof v==='string'||typeof v==='number')&&scan(value.join(privateFieldKeys(value.join(' ')).some(k=>k.startsWith('date:'))?' ':'; '));
  if(value&&typeof value==='object'){
   const lower=Object.fromEntries(Object.entries(value).map(([k,v])=>[k.toLowerCase(),v])),days=lower.day??lower.days,month=lower.month,year=lower.year,calendar=days!=null&&month!=null;
   if(calendar){for(const d of [].concat(days))for(const m of [].concat(month))for(const y of [].concat(year??'')){const date=typeof m==='number'||/^[0-9]+$/.test(normalizePrivateValue(m))?String(d)+'/'+String(m)+(y!==''?'/'+y:''):String(d)+' '+String(m)+(y!==''?' '+y:'');if(scan(date))return true;}}
   // Typed calendar components are owned by the date, not reinterpreted as
   // unrelated amounts. Other dynamic keys/values retain their provenance.
   return Object.entries(value).some(([k,v])=>!(calendar&&['day','days','month','year'].includes(k.toLowerCase()))&&(scan(k)||contains(v,depth+1,ordinary)));
  }return scan(value);
 };
 const assert=value=>{if(contains(value))throw Object.assign(new Error('Private payload withheld'),{code:PRIVATE_PAYLOAD_BLOCKED});};
 return {contains,ordinary:value=>contains(value,0,true),entities:value=>match.entities(value),spans:(...args)=>match.spans(...args),assert,
  assertPayload(payload,{trustedSystem}={}){
   const assert=value=>{if(contains(value,0,true))throw Object.assign(new Error('Private payload withheld'),{code:PRIVATE_PAYLOAD_BLOCKED});};
   // Protocol constants (model ID, token budget, role names) are not disclosures.
   // All assembled content, histories, tools and recursively encoded arguments
   // remain value-bearing, including keys inside user/tool data structures.
   const frame=[];for(const [position,message] of (payload.messages||[]).entries()){if(position===0&&message.role==='system'&&message.content===trustedSystem)continue;assert(message.content);if(typeof message.content==='string')frame.push(message.content);for(const call of message.tool_calls||[]){assert(call.function?.name);assert(call.function?.arguments);}}assert(frame.join(';\n'));assert(payload.tools||[]);
   for(const [key,value] of Object.entries(payload)){if(['messages','tools'].includes(key))continue;if(key==='model'&&typeof value==='string'||key==='stream'&&typeof value==='boolean'||['temperature','max_tokens','top_p','seed'].includes(key)&&typeof value==='number'||key==='tool_choice'&&['auto','none','required'].includes(value))continue;assert(key);assert(value);}
  }};
}
