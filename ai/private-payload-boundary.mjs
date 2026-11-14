import {createHash} from 'node:crypto';
import {createPrivateValueMatcher,decodePrivateJSON,normalizePrivateValue,privateFieldKeys,privateOriginStart} from './private-value-matcher.mjs';
export const PRIVATE_PAYLOAD_BLOCKED='PRIVATE_PAYLOAD_BLOCKED';
// One workspace-scoped canonical index owns every admission boundary. Its
// candidate lattice retains ambiguous values unless a scalar/common-word
// interpretation is established; unknown phrasing is never a release proof.
export function createCanonicalPrivateValueIndex(terms){
 const match=createPrivateValueMatcher(terms,{canonical:true});
 const blocked=()=>Object.assign(new Error('Private payload withheld'),{code:PRIVATE_PAYLOAD_BLOCKED});
 const fingerprint=(value,memo=new WeakMap(),depth=0)=>{
  if(depth>32)throw blocked();const hash=createHash('sha256');
  if(value&&typeof value==='object'){
   if(memo.has(value)){const old=memo.get(value);if(old===null)throw blocked();return old;}memo.set(value,null);
   hash.update(Array.isArray(value)?'array:':'object:');
   if(Array.isArray(value))for(const child of value)hash.update(fingerprint(child,memo,depth+1));
   else for(const key of Object.keys(value).sort()){hash.update(JSON.stringify(normalizePrivateValue(key)));hash.update(fingerprint(value[key],memo,depth+1));}
   const result=hash.digest('hex');memo.set(value,result);return result;
  }
  hash.update(typeof value+':'+(typeof value==='string'?normalizePrivateValue(value):JSON.stringify(value)));return hash.digest('hex');
 };
 // A JSON-encoded private field remains a value after decoding/reordering.
 // This supplements leaf candidates without reinterpreting typed date parts.
 const structures=new Set();for(const term of terms){const value=decodePrivateJSON(String(term));if(value&&typeof value==='object')structures.add(fingerprint(value));}

 const contains=(value,depth=0,ordinary=false,memo=new WeakMap(),origins=true)=>{
  if(depth>32)return true;const scan=ordinary?match.ordinary:match;
  if(typeof value==='string'){if(origins&&privateOriginStart(value)!==null)return true;const decoded=decodePrivateJSON(value);return decoded!==undefined&&decoded!==value?(decoded&&typeof decoded==='object'?contains(decoded,depth+1,ordinary,memo,origins):contains(decoded,depth+1,ordinary,memo,origins)||scan(value)):scan(value);}
  if(value&&typeof value==='object'&&structures.size&&structures.has(fingerprint(value,memo)))return true;
  if(Array.isArray(value))return value.some(v=>contains(v,depth+1,ordinary,memo,origins))||value.every(v=>typeof v==='string'||typeof v==='number')&&scan(value.join(privateFieldKeys(value.join(' ')).some(k=>k.startsWith('date:'))?' ':'; '));
  if(value&&typeof value==='object'){
   const lower=Object.fromEntries(Object.entries(value).map(([k,v])=>[k.toLowerCase(),v])),days=lower.day??lower.days,month=lower.month,year=lower.year,calendar=days!=null&&month!=null;
   if(calendar){for(const d of [].concat(days))for(const m of [].concat(month))for(const y of [].concat(year??'')){const date=typeof m==='number'||/^[0-9]+$/.test(normalizePrivateValue(m))?String(d)+'/'+String(m)+(y!==''?'/'+y:''):String(d)+' '+String(m)+(y!==''?' '+y:'');if(scan(date))return true;}}
   // Typed calendar components are owned by the date, not reinterpreted as
   // unrelated amounts. Other dynamic keys/values retain their provenance.
   return Object.entries(value).some(([k,v])=>!(calendar&&['day','days','month','year'].includes(k.toLowerCase()))&&(scan(k)||contains(v,depth+1,ordinary,memo,origins)));
  }return scan(value);
 };
 const assert=value=>{if(contains(value))throw Object.assign(new Error('Private payload withheld'),{code:PRIVATE_PAYLOAD_BLOCKED});};
 return {assertValues:value=>{if(contains(value,0,true,new WeakMap(),false))throw blocked();},contains,ordinary:value=>contains(value,0,true),entities:value=>match.entities(value),spans:(...args)=>match.spans(...args),assert,
  assertPayload(payload,{trustedSystem}={}){
   const assert=value=>{if(contains(value,0,true))throw Object.assign(new Error('Private payload withheld'),{code:PRIVATE_PAYLOAD_BLOCKED});};
   // Protocol constants (model ID, token budget, role names) are not disclosures.
   // All assembled content, histories, tools and recursively encoded arguments
   // remain value-bearing, including keys inside user/tool data structures.
   const frame=[];for(const [position,message] of (payload.messages||[]).entries()){if(position===0&&message.role==='system'&&message.content===trustedSystem)continue;assert(message.content);if(typeof message.content==='string')frame.push(message.content);for(const call of message.tool_calls||[]){assert(call.function?.name);assert(call.function?.arguments);}}if(contains(frame.join(';\n'),0,true,new WeakMap(),false))throw blocked();assert(payload.tools||[]);
   for(const [key,value] of Object.entries(payload)){if(['messages','tools'].includes(key))continue;if(key==='model'&&typeof value==='string'||key==='stream'&&typeof value==='boolean'||['temperature','max_tokens','top_p','seed'].includes(key)&&typeof value==='number'||key==='tool_choice'&&['auto','none','required'].includes(value))continue;assert(key);assert(value);}
  }};
}
