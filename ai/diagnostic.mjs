import {INVOICE_EXTRACTION_MAX_TOKENS, invoiceExtractionPrompt, invoiceExtractionResponseSchema, validateInvoiceExtractionWireResponse} from './extraction.mjs';
import {inflateSync} from 'node:zlib';

export const DIAGNOSTIC_MODEL = 'gemini-3.5-flash-lite';
export const DIAGNOSTIC_BUDGET_MS = 45_000;
export const DIAGNOSTIC_COOLDOWN_MS = 60_000;
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${DIAGNOSTIC_MODEL}:generateContent`;
const PNG_BASE64 = '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';

const SIMPLE_SCHEMA = Object.freeze({type:'object',additionalProperties:false,required:['answer'],properties:{answer:{type:'string',enum:['OK']}}});
const FIELD_PATHS = new Set(['generation_config','generationConfig','generation_config.response_json_schema','generationConfig.responseJsonSchema','generation_config.max_output_tokens','generationConfig.maxOutputTokens','contents','contents[0].parts','contents[0].parts[1].inline_data','contents[0].parts[1].inlineData','contents[0].parts[1].inline_data.data','contents[0].parts[1].inlineData.data','contents[0].parts[1].inline_data.mime_type','contents[0].parts[1].inlineData.mimeType']);
const CATEGORIES = new Set(['none','unknown','input_token_limit','output_token_limit','malformed_inline_data','invalid_api_key','key_restricted','api_disabled','billing_required','response_schema_rejected','permission_denied','rate_limited','provider_unavailable','invalid_response','response_contract_invalid','timeout','network_error','not_configured']);

export function diagnosticFixture() { return {mimeType:'image/png', data:PNG_BASE64}; }
function crc32(bytes) {
  let crc=0xffffffff;
  for (const byte of bytes) {
    crc^=byte;
    for (let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);
  }
  return (crc^0xffffffff)>>>0;
}
export function validateDiagnosticPng(bytes) {
  try {
    const png=Buffer.from(bytes);
    if (!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return false;
    let offset=8, width=0, height=0, sawHeader=false, sawEnd=false;
    const compressed=[];
    while (offset+12<=png.length) {
      const length=png.readUInt32BE(offset), end=offset+12+length;
      if (end>png.length) return false;
      const type=png.subarray(offset+4,offset+8), data=png.subarray(offset+8,offset+8+length);
      if (crc32(png.subarray(offset+4,offset+8+length))!==png.readUInt32BE(offset+8+length)) return false;
      const name=type.toString('ascii');
      if (!sawHeader) {
        if (name!=='IHDR' || length!==13) return false;
        width=data.readUInt32BE(0);height=data.readUInt32BE(4);
        if (width!==192 || height!==96 || data[8]!==8 || data[9]!==2 || data[10]!==0 || data[11]!==0 || data[12]!==0) return false;
        sawHeader=true;
      } else if (name==='IDAT') compressed.push(data);
      else if (name==='IEND') {
        if (length!==0 || end!==png.length) return false;
        sawEnd=true;offset=end;break;
      }
      offset=end;
    }
    if (!sawHeader || !sawEnd || compressed.length===0 || offset!==png.length) return false;
    const pixels=inflateSync(Buffer.concat(compressed));
    const stride=width*3+1;
    if (pixels.length!==height*stride) return false;
    for (let row=0;row<height;row++) if (pixels[row*stride]>4) return false;
    return true;
  } catch { return false; }
}
export function validDiagnosticFixture() {
  return validateDiagnosticPng(Buffer.from(PNG_BASE64, 'base64'));
}

function request(parts, schema, maxOutputTokens) {
  return {contents:[{role:'user',parts}],generationConfig:{temperature:0,maxOutputTokens,...(schema?{responseMimeType:'application/json',responseJsonSchema:schema}:{})}};
}
export function diagnosticRequests() {
  const image = {inlineData:diagnosticFixture()};
  return [
    {name:'text', payload:request([{text:'Reply with exactly OK.'}],null,8)},
    {name:'structured', payload:request([{text:'Return the fixed answer OK.'}],SIMPLE_SCHEMA,32)},
    {name:'image', payload:request([{text:'Read the image and reply with exactly OK.'},image],null,16)},
    {name:'invoice_schema', payload:request([{text:invoiceExtractionPrompt('')},image],invoiceExtractionResponseSchema,INVOICE_EXTRACTION_MAX_TOKENS)},
  ];
}

function knownMetadata(body) {
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  const info = details.find(x => typeof x?.['@type'] === 'string' && x['@type'].endsWith('google.rpc.ErrorInfo'));
  const violation = details.find(x => typeof x?.['@type'] === 'string' && x['@type'].endsWith('google.rpc.BadRequest'));
  const reason = typeof info?.reason === 'string' ? info.reason.toUpperCase() : '';
  const domain = info?.domain === 'googleapis.com' ? 'googleapis.com' : info?.domain === 'generativelanguage.googleapis.com' ? 'generativelanguage.googleapis.com' : 'unknown';
  const fieldPaths = [...new Set((violation?.fieldViolations || []).map(x => x?.field).filter(x => FIELD_PATHS.has(x)))].slice(0, 8);
  return {reason,domain,fieldPaths};
}
export function classifyDiagnosticError(body, status) {
  const {reason,domain,fieldPaths} = knownMetadata(body);
  const bounded = [body?.error?.status, body?.error?.message].filter(x=>typeof x==='string').join(' ').slice(0,2048).toLowerCase();
  let category = 'unknown';
  if (/input.{0,20}token|prompt.{0,20}(too long|limit)/.test(bounded)) category='input_token_limit';
  else if (/output.{0,20}token|max.?output.?tokens/.test(bounded)) category='output_token_limit';
  else if (/inline.?data|base64|mime.?type/.test(bounded)) category='malformed_inline_data';
  else if (reason==='API_KEY_INVALID' || /api key.{0,20}(invalid|not valid)/.test(bounded)) category='invalid_api_key';
  else if (['API_KEY_SERVICE_BLOCKED','API_KEY_HTTP_REFERRER_BLOCKED','API_KEY_IP_ADDRESS_BLOCKED'].includes(reason) || /api key.{0,30}(restrict|blocked)/.test(bounded)) category='key_restricted';
  else if (reason==='SERVICE_DISABLED' || /api.{0,20}(disabled|not enabled)/.test(bounded)) category='api_disabled';
  else if (reason==='BILLING_DISABLED' || /billing/.test(bounded)) category='billing_required';
  else if (/response.?json.?schema|response.?schema|schema/.test(bounded)) category='response_schema_rejected';
  else if (status===401 || status===403 || reason==='ACCESS_TOKEN_SCOPE_INSUFFICIENT' || /permission.?denied/.test(bounded)) category='permission_denied';
  else if (status===429) category='rate_limited';
  else if (status>=500) category='provider_unavailable';
  return {category:CATEGORIES.has(category)?category:'unknown',reason:['API_KEY_INVALID','API_KEY_SERVICE_BLOCKED','API_KEY_HTTP_REFERRER_BLOCKED','API_KEY_IP_ADDRESS_BLOCKED','SERVICE_DISABLED','BILLING_DISABLED','ACCESS_TOKEN_SCOPE_INSUFFICIENT'].includes(reason)?reason:'unknown',domain,fieldPaths};
}

async function boundedJson(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > 256*1024) throw Object.assign(Error(),{diagnosticCode:'invalid_response'});
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 256*1024) throw Object.assign(Error(),{diagnosticCode:'invalid_response'});
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw Object.assign(Error(),{diagnosticCode:'invalid_response'}); }
}
function outputText(body) { return body?.candidates?.[0]?.content?.parts?.filter(x=>typeof x?.text==='string').map(x=>x.text).join('') || ''; }
const KEY_WIDE_FAILURES = new Set(['invalid_api_key','key_restricted','api_disabled','billing_required','permission_denied','rate_limited']);

export function createGeminiDiagnostic({fetchImpl=globalThis.fetch, now=Date.now, cooldowns=new Map()}={}) {
  return async function run({userId,role,apiKey}) {
    const specs=diagnosticRequests();
    if (!['owner','admin'].includes(role)) return {error:'DIAGNOSTIC_ADMIN_REQUIRED',status:403};
    if (typeof apiKey !== 'string' || !apiKey) return {model:DIAGNOSTIC_MODEL,stages:specs.map(spec=>({stage:spec.name,status:'not_run',category:'not_configured',httpStatus:null}))};
    const started=now(), prior=cooldowns.get(userId);
    if (Number.isFinite(prior) && started-prior<DIAGNOSTIC_COOLDOWN_MS) return {error:'DIAGNOSTIC_COOLDOWN',status:429,retryAfterSeconds:Math.ceil((DIAGNOSTIC_COOLDOWN_MS-(started-prior))/1000)};
    if (cooldowns.size>10_000) for (const [id,at] of cooldowns) if (started-at>=DIAGNOSTIC_COOLDOWN_MS) cooldowns.delete(id);
    cooldowns.set(userId,started);
    const stages=[];
    if (!validDiagnosticFixture()) return {model:DIAGNOSTIC_MODEL,stages:specs.map(spec=>({stage:spec.name,status:'not_run',category:'invalid_response',httpStatus:null}))};
    let haltedCategory=null;
    for (const spec of specs) {
      const remaining=DIAGNOSTIC_BUDGET_MS-(now()-started);
      if (remaining<=0) { haltedCategory='timeout'; break; }
      const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),Math.min(12_000,remaining));
      try {
        const response=await fetchImpl(ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':apiKey},body:JSON.stringify(spec.payload),signal:controller.signal,redirect:'error'});
        const body=await boundedJson(response);
        if (!response.ok || body?.error) {
          const safe=classifyDiagnosticError(body,response.status);
          stages.push({stage:spec.name,status:'http_rejected',category:safe.category,httpStatus:response.status,...safe});
          if (KEY_WIDE_FAILURES.has(safe.category)) haltedCategory=safe.category;
          if (haltedCategory) break;
          continue;
        }
        const text=outputText(body);
        if (!text) { stages.push({stage:spec.name,status:'invalid_response',category:'invalid_response',httpStatus:response.status}); continue; }
        if (spec.name==='structured') {
          try {
            const value=JSON.parse(text);
            if (value?.answer!=='OK' || Object.keys(value).length!==1) throw Error();
          } catch { stages.push({stage:spec.name,status:'contract_invalid',category:'response_contract_invalid',httpStatus:response.status}); continue; }
        }
        if (spec.name==='invoice_schema') {
          try { validateInvoiceExtractionWireResponse(JSON.parse(text)); }
          catch { stages.push({stage:spec.name,status:'contract_invalid',category:'response_contract_invalid',httpStatus:response.status}); continue; }
        }
        stages.push({stage:spec.name,status:'success',category:'none',httpStatus:response.status});
      } catch (error) {
        const timeout=error?.name==='AbortError' || now()-started>=DIAGNOSTIC_BUDGET_MS;
        stages.push({stage:spec.name,status:timeout?'timeout':'network_error',category:error?.diagnosticCode==='invalid_response'?'invalid_response':timeout?'timeout':'network_error',httpStatus:null});
      } finally { clearTimeout(timer); }
    }
    for (const spec of specs.slice(stages.length)) stages.push({stage:spec.name,status:'not_run',category:haltedCategory || 'none',httpStatus:null});
    return {model:DIAGNOSTIC_MODEL,stages};
  };
}
