import {invoiceExtractionResponseSchema, validateInvoiceExtractionResponse} from './extraction.mjs';

export const DIAGNOSTIC_MODEL = 'gemini-3.5-flash-lite';
export const DIAGNOSTIC_BUDGET_MS = 45_000;
export const DIAGNOSTIC_COOLDOWN_MS = 60_000;
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${DIAGNOSTIC_MODEL}:generateContent`;
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAGAAAAAgCAYAAADtwH1UAAAACXBIWXMAAAsTAAALEwEAmpwYAAAEgklEQVRoge2YWSh9XxTHb/opEuFBMjxQpshYxkyZQihDMlySrvCGkKGEQiQvXpAM4U0i44OIErmmDClEZgmZXdP6t1bd253O/fn/XJ3U+dbu3vZeezjns/faax0ecGJVPHan58QBYFkcAJbFAWBZHACWxQFgWRwAlsUBYFkcgN8A4O3tDWZmZqC7uxuHhoZga2tLpv34+BiEQiFj2d3dJbvV1VWVdkKhEF5eXmB5eVmm7uPjQ2FNe3t7MjZLS0tweHj4Ty9hY2MDent7qayvryu0n5ycyMx1enqq8NzK+qkFwPT0NDg4OEBBQQF0dnZCY2MjuLq6gqWlJQFBjY+PQ1paGvB4PAgLC4OEhARJiYiIgOjoaLIzNTWFrKwsKnw+n+zDw8Mldebm5vRiy8vLwc7ODiwsLKC4uBheX18V1tXT0wNRUVE0RmFhIa0vLi6O1lVWVgZPT09/ffijoyMIDAyE+Ph4aGtrg9bWVoiJiQF/f396uWJNTExAeno6zZWZmQmTk5NUPzY2BlZWVhAUFAT19fWgdgBIVktLC6amphROhJ+fH2RnZ0vqFhYWaIGbm5sytvhCxQBsbW0l9RcXF2Q/MjIiqUNYaI9KSkoimKqEEHAMaUDn5+fg4eEBXl5eKiHc3t6CjY0NVFVVKbQVFRWBtbU13N3dSeoWFxdpLvFO//z8hJKSEsjJyYH393f4V6kEEBAQQLtBmUZHR2mnqgKAR/Xy8hLu7+8lR10VgJ2dHXJB3wGAOjg4AE1NTaipqWHsiy/ewMAARCKRQtvDwwPo6OhAbW2tUgDYJzU1Ferq6uC7YgRwdXUFGhoaUFFR8aWBlAGorKwkv6pMygBI6zsAxJvH0dGRsa+zszPZMMnd3Z1OkjyA2dlZWldfXx+oQ4wAVlZWaMKWlpb/BcDe3h7c3NyomJiYsAYgIyODdjGT9PT0IDk5mbE9NjYWjIyMFABgnUAgAHWJEQAeNZywubn5V54APp8P+vr6jH0NDQ0pSGASXvC4geQBpKSk0G9DQwP8KIDHx0e6gPGi+YqY7gB0ZWwAcHFxAV9fX8a+Pj4+4O3trdJFBQcHK70Dqqur1QZB5SWMtNGl4I0vL3RNpaWlf42CMIafn59XG4D+/n7Y399XCWBubo7qxWGyMuH6cYNdX18rtJ2dncGfP3+gq6uLMQpSFwSVAHAHY2yO8bG0tre3yReK42FVADBiwLxBXQAEAgElhUwAMG/BfAPtlG0c6VA6NDSUXBX+FwvHQv+PLkg6AZQHoC4IvK8kK5ichISEQF5eHiQmJoKTkxMMDg5KbNrb2ylqwMWYmZlRMiQumEzJAxgeHqY8gsfj0VFvamqSaY+MjARjY2PQ1taWGQuLrq4uAcAwEhNEHAMTIXQXGLVgLjEwMPClh39+fob8/HxaX25uLsX06LrQ7UqHpx0dHZLn8/T0JPDyEPB5MDT/sW9BNzc3sLa2Rmm5qp31GyUSiejzChZl98lPivsYx7I4ACyLA8CyOAAsiwPAsjgALIsDwLI4ACyLA8CyOADArv4DZ/1XeQSY/osAAAAASUVORK5CYII=';

const SIMPLE_SCHEMA = Object.freeze({type:'object',additionalProperties:false,required:['answer'],properties:{answer:{type:'string',enum:['OK']}}});
const FIELD_PATHS = new Set(['generation_config','generationConfig','generation_config.response_json_schema','generationConfig.responseJsonSchema','generation_config.max_output_tokens','generationConfig.maxOutputTokens','contents','contents[0].parts','contents[0].parts[1].inline_data','contents[0].parts[1].inlineData','contents[0].parts[1].inline_data.data','contents[0].parts[1].inlineData.data','contents[0].parts[1].inline_data.mime_type','contents[0].parts[1].inlineData.mimeType']);
const CATEGORIES = new Set(['none','unknown','input_token_limit','output_token_limit','malformed_inline_data','invalid_api_key','key_restricted','api_disabled','billing_required','response_schema_rejected','permission_denied','rate_limited','provider_unavailable','invalid_response','response_contract_invalid','timeout','network_error','not_configured']);

export function diagnosticFixture() { return {mimeType:'image/png', data:PNG_BASE64}; }
export function validDiagnosticFixture() {
  const bytes = Buffer.from(PNG_BASE64, 'base64');
  return bytes.length === 1232 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.subarray(-8,-4).toString('ascii') === 'IEND';
}

function request(parts, schema, maxOutputTokens) {
  return {contents:[{role:'user',parts}],generationConfig:{temperature:0,maxOutputTokens,...(schema?{responseMimeType:'application/json',responseJsonSchema:schema}:{})}};
}
export function diagnosticRequests() {
  const image = {inlineData:diagnosticFixture()};
  return [
    {name:'text', payload:request([{text:'Reply with exactly OK.'}],null,8)},
    {name:'image', payload:request([{text:'Read the image and reply with exactly OK.'},image],null,16)},
    {name:'structured', payload:request([{text:'Return the fixed answer OK.'}],SIMPLE_SCHEMA,32)},
    {name:'invoice_schema', payload:request([{text:'Extract only facts visibly printed in this synthetic image. Return null for absent invoice fields.'},image],invoiceExtractionResponseSchema,2048)},
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

export function createGeminiDiagnostic({fetchImpl=globalThis.fetch, now=Date.now, cooldowns=new Map()}={}) {
  return async function run({userId,role,apiKey}) {
    if (!['owner','admin'].includes(role)) return {error:'DIAGNOSTIC_ADMIN_REQUIRED',status:403};
    if (typeof apiKey !== 'string' || !apiKey) return {model:DIAGNOSTIC_MODEL,stages:diagnosticRequests().map(spec=>({stage:spec.name,status:'not_run',category:'not_configured',httpStatus:null}))};
    const started=now(), prior=cooldowns.get(userId);
    if (Number.isFinite(prior) && started-prior<DIAGNOSTIC_COOLDOWN_MS) return {error:'DIAGNOSTIC_COOLDOWN',status:429,retryAfterSeconds:Math.ceil((DIAGNOSTIC_COOLDOWN_MS-(started-prior))/1000)};
    if (cooldowns.size>10_000) for (const [id,at] of cooldowns) if (started-at>=DIAGNOSTIC_COOLDOWN_MS) cooldowns.delete(id);
    cooldowns.set(userId,started);
    const stages=[];
    for (const spec of diagnosticRequests()) {
      const remaining=DIAGNOSTIC_BUDGET_MS-(now()-started);
      if (remaining<=0) { stages.push({stage:spec.name,status:'not_run',category:'timeout',httpStatus:null}); break; }
      const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),Math.min(12_000,remaining));
      try {
        const response=await fetchImpl(ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':apiKey},body:JSON.stringify(spec.payload),signal:controller.signal,redirect:'error'});
        const body=await boundedJson(response);
        if (!response.ok || body?.error) {
          const safe=classifyDiagnosticError(body,response.status);
          stages.push({stage:spec.name,status:'http_rejected',category:safe.category,httpStatus:response.status,...safe});
          break;
        }
        const text=outputText(body);
        if (!text) { stages.push({stage:spec.name,status:'invalid_response',category:'invalid_response',httpStatus:response.status}); break; }
        if (spec.name==='invoice_schema') {
          try { validateInvoiceExtractionResponse(JSON.parse(text)); }
          catch { stages.push({stage:spec.name,status:'contract_invalid',category:'response_contract_invalid',httpStatus:response.status}); break; }
        }
        stages.push({stage:spec.name,status:'success',category:'none',httpStatus:response.status});
      } catch (error) {
        const timeout=error?.name==='AbortError' || now()-started>=DIAGNOSTIC_BUDGET_MS;
        stages.push({stage:spec.name,status:timeout?'timeout':'network_error',category:error?.diagnosticCode==='invalid_response'?'invalid_response':timeout?'timeout':'network_error',httpStatus:null});
        break;
      } finally { clearTimeout(timer); }
    }
    for (const spec of diagnosticRequests().slice(stages.length)) stages.push({stage:spec.name,status:'not_run',category:'none',httpStatus:null});
    return {model:DIAGNOSTIC_MODEL,stages};
  };
}
