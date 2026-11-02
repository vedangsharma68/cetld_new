import {ordinaryPart} from './private-value-matcher.mjs';
import {OFFLINE_CONFIRMATION_REPLY,OFFLINE_CANCEL_REPLY} from './offline-invoice-review.mjs';
import {CF_PRIMARY_MODEL, CF_BACKUP_MODEL, isCloudflareModelId} from './provider.mjs';

export const PRIVATE_CHAT_REPLY = 'I can only answer invoice questions from verified records. I kept the private details local. Use the invoice menu to check a balance or status, or continue the upload review to correct or confirm it. You can send an unrelated chat request separately.';
export const CHAT_UNAVAILABLE_REPLY = 'Chat is temporarily unavailable. Please try again shortly. Nothing was lost; your invoices and reviews are still saved.';

// This is a routing hint, NOT the privacy boundary. The boundary below never
// forwards caller-supplied transcripts, tool schemas/results, summaries, media,
// checkpoints, profiles, or error text. All business context stays on the server.
export function privateChatTopic(message) {
  const text=String(message||'');
  if(/\b(?:work[- ]life|balance between)\b/i.test(text))return false;
  return /\b(?:invoice\w*|receipts?|payments?|paid|unpaid|overdue|owes?|owed|owing|outstanding|receivables?|payables?|customers?|clients?|debtors?|creditors?|remind\w*)\b|[₹$€£]|\[cetld:/i.test(text)
    || /\bbills?\b/i.test(text)&&!/\bbill gates\b/i.test(text)
    || /\b(?:my|our|the|your|current|remaining|account)\s+(?:balance|total)\b/i.test(text)
    || /\b(?:set|change|correct|update|edit|fix)\b.{0,60}\b(?:total|tax|notes?|currency|due date|invoice date)\b/i.test(text)
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
  if (interactionId || OFFLINE_CONFIRMATION_REPLY.test(message) || OFFLINE_CANCEL_REPLY.test(message) || /\b(?:review|missing)\b/i.test(message)) return true;
  // Ordinary chat and unrelated deterministic operations remain available while
  // a review is open. Unstructured review replies stay local, too.
  if (/\b(?:balance|outstanding|owes?|owing|status|menu|remind\w*)\b/i.test(message)) return false;
  if (['saved','canceled'].includes(action.stage)) return /^(?:yes|confirm|cancel)[.!\s]*$/i.test(message);
  return /\b(?:change|set|correct|edit|update|fix|total|subtotal|tax|currency|due date|notes|direction)\b/i.test(message) || /^\s*\d+(?:[.,]\d+)?\s*$/.test(message) || privateChatTopic(message) || /^(?:yes|no|ok|okay|INR|USD|EUR|GBP)[.!\s]*$/i.test(message) || /\b(?:issued|issuance|retract|statement|untrue)\b/i.test(message);
}

export function createPrivateChatProvider({providerFactory, options, message, localOnly = false, memory}) {
  let provider,history,selection;
  let definitions=[];
  const issuedCalls=new Map();
  return {
    setTools(tools){definitions=Array.isArray(tools)?structuredClone(tools):[];},
    async generate(request = {}) {
      if (localOnly) return {content:PRIVATE_CHAT_REPLY,toolCalls:[],model:null};
      history ??= memory ? await memory.read(message,{allowPrivateCurrent:true}) : [];
      if(history===null)return {content:PRIVATE_CHAT_REPLY,toolCalls:[],model:null};
      selection ??= ordinaryPart(message,text=>privateChatTopic(text)||memory?.containsPrivate(text));
      if(!selection.text)return {content:PRIVATE_CHAT_REPLY,toolCalls:[],model:null};
      const currentTools=[];
      for(const turn of request.messages||[]){
        if(turn.role==='assistant'&&turn.tool_calls?.length){
          if(turn.tool_calls.every(call=>!issuedCalls.has(call.id)))continue;
          if(!turn.tool_calls.every(call=>issuedCalls.get(call.id)===JSON.stringify(call))||memory?.containsPrivate(JSON.stringify(turn.tool_calls)))return {content:PRIVATE_CHAT_REPLY,toolCalls:[],model:null};
          currentTools.push({role:'assistant',content:'',tool_calls:turn.tool_calls});
        }else if(turn.role==='tool'&&issuedCalls.has(turn.tool_call_id)){
          if(memory?.containsPrivate(turn.content)||/"table"\s*:\s*"(?:invoices|payments|invoice_files)"|invoice_review_draft|printedEvidence/.test(turn.content))
            return {content:PRIVATE_CHAT_REPLY,toolCalls:[],model:null};
          currentTools.push({role:'tool',tool_call_id:turn.tool_call_id,name:turn.name,content:turn.content});
        }
      }
      const requestedNames=new Set((request.tools||[]).map(tool=>tool?.function?.name));
      const tools=definitions.filter(tool=>requestedNames.has(tool?.function?.name));
      provider ||= providerFactory({...options, ...privateChatModelSettings(options),
        geminiApiKey:undefined,openRouterApiKey:undefined,zenApiKey:undefined});
      const result = await provider.generate({
        messages:[{role:'system',content:'You are cetld, a helpful WhatsApp assistant. Answer ordinary conversation concisely using the supplied ordinary chat memory. Use available tools for current non-invoice requests. You have no access to private invoice records. Never invent invoice, customer, payment, balance or reminder facts. Ask the user to use the invoice menu for those questions.'},
          ...history,{role:'user',content:selection.text},...currentTools],
        ...(tools.length?{tools,toolChoice:'auto'}:{}),
        maxTokens:800,temperature:0.2,signal:request.signal,deadlineAt:request.deadlineAt,
      });
      let content=privateChatTopic(result?.content)||memory?.containsPrivate?.(result?.content)?PRIVATE_CHAT_REPLY:result?.content;
      const toolCalls=(result.toolCalls||[]).filter(call=>tools.some(tool=>tool.function.name===call.function?.name)
        &&!memory?.containsPrivate(JSON.stringify(call)));
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
