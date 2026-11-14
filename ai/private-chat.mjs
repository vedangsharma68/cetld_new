import {PRIVATE_PAYLOAD_BLOCKED} from './private-payload-boundary.mjs';
import {privateDocumentKeyPattern} from './private-value-language.mjs';
import {ordinaryPart,normalizePrivateValue,normalizePrivateText,privateOriginStart,decodePrivateJSON} from './private-value-matcher.mjs';
import {OFFLINE_CONFIRMATION_REPLY,OFFLINE_CANCEL_REPLY} from './offline-invoice-review.mjs';
import {CF_PRIMARY_MODEL, CF_BACKUP_MODEL, isCloudflareModelId} from './provider.mjs';
import {financialChatIntent} from '../invoice/chat-intent.mjs';

export const PRIVATE_CHAT_SYSTEM_MESSAGE='You are cetld, a helpful WhatsApp assistant. Answer ordinary conversation concisely using the supplied ordinary chat memory. Use available tools for current non-invoice requests. You have no access to private invoice records. Never invent invoice, customer, payment, balance or reminder facts. Ask the user to use the invoice menu for those questions.';
export const PRIVATE_CHAT_REPLY = 'I can only answer invoice questions from verified records. I kept the private details local. Use the invoice menu to check a balance or status, or continue the upload review to correct or confirm it. You can send an unrelated chat request separately.';
export const CHAT_UNAVAILABLE_REPLY = 'Chat is temporarily unavailable. Please try again shortly. Nothing was lost; your invoices and reviews are still saved.';

// Unparsed create/correction values can themselves contain punctuation or
// sentences. Their payload extends to the end of the turn; only an independent
// prefix can be separated before this explicit local-data statement.
export function privateChatSpans(message){
  const start=privateOriginStart(message);
  return start===null?[]:[[start,String(message??'').length]];
}

// This is a routing hint, NOT the privacy boundary. The boundary below never
// forwards caller-supplied transcripts, tool schemas/results, summaries, media,
// checkpoints, profiles, or error text. All business context stays on the server.
export function privateChatTopic(message,depth=0) {
  if(depth>32)return true;
  if(message&&typeof message==='object'){
    if(Array.isArray(message))return message.some(value=>privateChatTopic(value,depth+1));
    return Object.entries(message).some(([key,value])=>new RegExp(privateDocumentKeyPattern,'u').test(normalizePrivateValue(key))||privateChatTopic(value,depth+1));
  }
  if(typeof message==='string'){const decoded=decodePrivateJSON(message);if(decoded!==undefined&&decoded!==message&&privateChatTopic(decoded,depth+1))return true;}
  const text=normalizePrivateValue(message);
  if(privateChatSpans(message).length)return true;
  return financialChatIntent(message)
    || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text);
}

export function privateChatModelSettings(options={}){
  const primaryModel=isCloudflareModelId(options.primaryModel)?options.primaryModel:CF_PRIMARY_MODEL;
  const fallbackModel=isCloudflareModelId(options.fallbackModel)&&options.fallbackModel!==primaryModel?options.fallbackModel
    :primaryModel===CF_BACKUP_MODEL?CF_PRIMARY_MODEL:CF_BACKUP_MODEL;
  return {primaryModel,fallbackModel};
}

export function localReviewTurn(action, message, interactionId) {
  if (action?.extractionRoute !== 'offline') return false;
  message=normalizePrivateValue(message);
  if (interactionId || OFFLINE_CONFIRMATION_REPLY.test(message) || OFFLINE_CANCEL_REPLY.test(message) || /\b(?:review|missing)\b/i.test(message)) return true;
  // Ordinary chat and unrelated deterministic operations remain available while
  // a review is open. Unstructured review replies stay local, too.
  if (/\b(?:balance|outstanding|owes?|owing|status|menu|remind\w*)\b/i.test(message)) return false;
  if (['saved','canceled'].includes(action.stage)) return /^(?:yes|confirm|cancel)[.!\s]*$/i.test(message);
  return /\b(?:change|set|correct|edit|update|fix|total|subtotal|tax|currency|due date|notes|direction)\b/i.test(message) || /^\s*\d+(?:[.,]\d+)?\s*$/.test(message) || privateChatTopic(message) || /^(?:yes|no|ok|okay|INR|USD|EUR|GBP)[.!\s]*$/i.test(message) || /\b(?:issued|issuance|retract|statement|untrue)\b/i.test(message);
}

function validArguments(value){
  if(value&&typeof value==='object')return !Array.isArray(value);
  try {const decoded=JSON.parse(value);return decoded&&typeof decoded==='object'&&!Array.isArray(decoded);}catch{return false;}
}
// Domain gates inspect decoded protocol values as well as retained-value
// screening. JSON escaping must never launder a local result into a request.
function localToolData(value,depth=0){
  if(depth>32)return true;
  if(typeof value==='string'){
    try{return localToolData(JSON.parse(value),depth+1);}catch{return /^[\[{"]/.test(normalizePrivateValue(value))||/invoice_review_draft|printedEvidence/.test(value);}
  }
  if(Array.isArray(value))return value.some(item=>localToolData(item,depth+1));
  if(value&&typeof value==='object')return Object.entries(value).some(([key,item])=>
    /invoice|payment|receipt|receivable|payable|balance|customer|client|contact|debtor|creditor|reminder|printedevidence|ownerprovidedfacts/.test(normalizePrivateValue(key))
    ||['table','resource','type'].includes(normalizePrivateValue(key))&&/^(?:invoices?|payments?|receipts?|customers?|contacts?|invoice_files|invoice_review_draft)$/.test(normalizePrivateValue(item))
    ||localToolData(item,depth+1));
  return false;
}

export function createPrivateChatProvider({providerFactory, options, message, localOnly = false, memory}) {
  let provider,history,selection;
  let definitions=[];
  const issuedCalls=new Map();
  return {
    privateChatBoundary:true,
    setTools(tools){definitions=Array.isArray(tools)?structuredClone(tools):[];},
    async generate(request = {}) {
      if (localOnly) return {content:PRIVATE_CHAT_REPLY,toolCalls:[],model:null};
      history ??= memory ? await memory.read(message,{allowPrivateCurrent:true}) : [];
      if(history===null)return {content:PRIVATE_CHAT_REPLY,toolCalls:[],model:null};
      selection ??= ordinaryPart(message,text=>privateChatTopic(text)||(memory?.containsOrdinary?.(text)??memory?.containsPrivate(text)),text=>[...privateChatSpans(text),...(memory?.privateSpans?.(text)||[])]);
      if(!selection.text)return {content:PRIVATE_CHAT_REPLY,toolCalls:[],model:null};
      const currentTools=[];
      for(const turn of request.messages||[]){
        if(turn.role==='assistant'&&turn.tool_calls?.length){
          if(turn.tool_calls.every(call=>!issuedCalls.has(call.id)))continue;
          if(!turn.tool_calls.every(call=>issuedCalls.get(call.id)===JSON.stringify(call))||memory?.containsPrivate(turn.tool_calls))return {content:PRIVATE_CHAT_REPLY,toolCalls:[],model:null};
          currentTools.push({role:'assistant',content:'',tool_calls:turn.tool_calls});
        }else if(turn.role==='tool'&&issuedCalls.has(turn.tool_call_id)){
          if(typeof turn.content!=='string'||memory?.containsPrivate(turn.content)||localToolData(turn.content))
            return {content:PRIVATE_CHAT_REPLY,toolCalls:[],model:null};
          currentTools.push({role:'tool',tool_call_id:turn.tool_call_id,name:turn.name,content:turn.content});
        }
      }
      const requestedNames=new Set((request.tools||[]).map(tool=>tool?.function?.name));
      const tools=definitions.filter(tool=>requestedNames.has(tool?.function?.name)&&!memory?.containsPrivate(tool));
      provider ||= providerFactory({...options, ...privateChatModelSettings(options),
        privatePayloadGate:payload=>memory?.assertFinalPayload?.(payload),
        geminiApiKey:undefined,openRouterApiKey:undefined,zenApiKey:undefined});
      const assembled={
        messages:[{role:'system',content:PRIVATE_CHAT_SYSTEM_MESSAGE},
          ...history,{role:'user',content:selection.text},...currentTools],
        ...(tools.length?{tools,toolChoice:'auto'}:{}),
        maxTokens:800,temperature:0.2,signal:request.signal,deadlineAt:request.deadlineAt,
      };
      let result;try{memory?.assertPayload?.(assembled);result=await provider.generate(assembled);}catch(error){if(error.code===PRIVATE_PAYLOAD_BLOCKED)return {content:PRIVATE_CHAT_REPLY,toolCalls:[],model:null};throw error;}
      await memory?.refresh?.();
      let content=privateChatTopic(result?.content)||memory?.containsPrivate?.(result?.content)?PRIVATE_CHAT_REPLY:result?.content;
      const toolCalls=(result.toolCalls||[]).filter(call=>tools.some(tool=>tool.function.name===call.function?.name)
        &&!memory?.containsPrivate(call)&&validArguments(call.function?.arguments)&&!localToolData(call.function.arguments));
      if(toolCalls.length!==(result.toolCalls||[]).length)content=PRIVATE_CHAT_REPLY;
      for(const call of toolCalls)issuedCalls.set(call.id,JSON.stringify(call));
      if(memory && content && content!==PRIVATE_CHAT_REPLY && !toolCalls.length) await memory.append(selection.text,content);
      return {...result,content:selection.mixed&&content!==PRIVATE_CHAT_REPLY?content+'\n\nI kept the private part local. Use the invoice menu or your current review for that part.':content,toolCalls};
    },
    async generateStructured() {
      throw Object.assign(new Error(PRIVATE_CHAT_REPLY),{code:'LOCAL_DATA_ONLY'});
    },
  };
}
