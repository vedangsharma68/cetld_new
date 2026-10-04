// Provider compatibility only. Tool authorization and argument validation remain
// in the scoped executor; this module cannot choose a business operation.
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function decode(value){
  if(typeof value!=='string'||value.length>8192)return null;
  try{return JSON.parse(value);}catch{}
  // Some chat models emit JavaScript's \\' escape in JSON strings. Remove
  // only that unsupported escape, preserving escaped backslashes verbatim.
  let quoted=false,output='';
  for(let index=0;index<value.length;index++){
    const char=value[index];
    if(char==='"'){quoted=!quoted;output+=char;continue;}
    if(quoted&&char==='\\'){
      const next=value[++index];
      if(next===undefined)return null;
      output+=next==="'"?"'":'\\'+next;
    }else output+=char;
  }
  try{return JSON.parse(output);}catch{return null;}
}
function canonical(call,index,allowed,{native=false}={}){
  if(!object(call))return null;
  const fn=object(call.function)?call.function:call;
  const name=fn.name;
  if(typeof name!=='string'||!allowed.has(name))return native?call:null;
  if(Object.keys(call).some(key=>!['id','type','function','name','arguments','parameters'].includes(key)))return native?call:null;
  const raw=fn.arguments??fn.parameters;
  const args=typeof raw==='string'?decode(raw):raw;
  if(!object(args))return native?call:null;
  const argumentsText=JSON.stringify(args);
  if(argumentsText.length>8192)return native?call:null;
  return {id:typeof call.id==='string'&&call.id.length<=256?call.id:'provider-call-'+globalThis.crypto.randomUUID(),
    type:'function',function:{name,arguments:argumentsText}};
}
export function normalizeProviderToolCalls(result,options={}){
  const allowed=new Set((options.tools||[]).map(tool=>tool?.function?.name).filter(name=>typeof name==='string'));
  const native=Array.isArray(result.toolCalls)?result.toolCalls:[];
  if(native.length)return {...result,toolCalls:native.map((call,index)=>canonical(call,index,allowed,{native:true}))};
  if(!allowed.size||options.tool_choice==='none')return result;
  const text=String(result.content||'').trim();
  const fenced=text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const value=decode(fenced?fenced[1]:text);
  const envelope=object(value)&&Object.keys(value).length===1&&Array.isArray(value.tool_calls)?value.tool_calls:value;
  const batch=Array.isArray(envelope)?envelope:[envelope];
  if(!batch.length||batch.length>6)return result;
  const calls=batch.map((call,index)=>canonical(call,index,allowed));
  if(calls.some(call=>!call))return result;
  return {...result,content:'',finishReason:'tool_calls',toolCalls:calls};
}
// Reject protocol-looking output even when its JSON is malformed or names an
// unknown function. Tools-off generation never turns this text into execution.
export function internalToolEnvelope(value){
  const text=String(value||'');
  return /["'](?:tool_calls|function_call)["']\s*:/.test(text)
    ||(/["']name["']\s*:\s*["'][\w.-]+["']/.test(text)&&/["'](?:parameters|arguments)["']\s*:/.test(text));
}
