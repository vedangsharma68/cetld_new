const DEFAULT_ENDPOINT = '/api/ai?action=assistant';
const REQUEST_TIMEOUT_MS = 90_000;

function publicErrorMessage(value) {
  if (typeof value !== 'string' || !value.trim()) return 'The assistant is unavailable right now. Please try again.';
  if (['INVALID_ASSISTANT_PLAN', 'INVALID_TOOL_ARGUMENTS', 'TOOL_NOT_ALLOWED'].includes(value)) return 'I couldn’t verify that answer. Please rephrase and try again.';
  if (/^[A-Z][A-Z0-9_]+$/.test(value)) return 'The assistant couldn’t complete that request. Please try again.';
  return value;
}

function responseMessage(payload) {
  const value = payload?.message?.content ?? payload?.content ?? payload?.answer;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('The assistant returned an empty response. Please try again.');
  }
  return [value.trim(), typeof payload?.guidance === 'string' ? payload.guidance.trim() : ''].filter(Boolean).join('\n\n');
}

function assistantResult(payload) {
  const answer = responseMessage(payload);
  const pendingAction = payload?.pendingAction;
  if (pendingAction && ['create_invoice', 'update_invoice','owner_reminder','owner_payment','owner_correction','owner_schedule'].includes(pendingAction.type) && typeof pendingAction.confirmationToken === 'string' && pendingAction.confirmationToken) {
    return {answer, pendingAction};
  }
  return answer;
}

function streamDelta(event) {
  if (typeof event === 'string') return event;
  return event?.delta?.text ?? event?.delta ?? event?.text ?? event?.choices?.[0]?.delta?.content ?? '';
}

async function readAssistantResponse(response, onProgress) {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    const payload = await response.json().catch(() => ({}));
    return assistantResult(payload);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', answer = '';
  while (true) {
    const {value, done} = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), {stream: !done});
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || '';
    for (const event of events) {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
      if (!data || data === '[DONE]') continue;
      let parsed;
      try { parsed = JSON.parse(data); } catch { parsed = data; }
      const delta = streamDelta(parsed);
      if (typeof delta === 'string' && delta) { answer += delta; onProgress?.(answer); }
    }
    if (done) break;
  }
  if (buffer.trim()) {
    const data = buffer.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (data && data !== '[DONE]') {
      let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; }
      answer += streamDelta(parsed);
    }
  }
  if (!answer.trim()) throw new Error('The assistant returned an empty response. Please try again.');
  return answer.trim();
}

function safeMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error('Write a question before sending.');
  }
  return messages.slice(-20).map(message => {
    const role = message?.role;
    const content = String(message?.content ?? '').trim();
    if (!['user', 'assistant'].includes(role) || !content || content.length > 4_000) {
      throw new Error('The conversation contains an invalid message.');
    }
    return {role, content};
  });
}

export function createAssistantClient({
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = globalThis.fetch,
  getAccessToken = async () => null,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');

  return {
    async load({workspaceId,signal}={}) {
      if(!workspaceId)throw new Error('Open a business before using the assistant.');
      const token=await getAccessToken();if(!token)throw new Error('Sign in to read your business conversation.');
      const response=await fetchImpl('/api/ai?action=assistant-history&workspaceId='+encodeURIComponent(workspaceId),{headers:{Authorization:`Bearer ${token}`},credentials:'same-origin',signal});
      const payload=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(publicErrorMessage(payload.error));
      if(!Array.isArray(payload.turns))throw new Error('The business conversation could not be loaded.');
      const turns=payload.turns.map(turn=>({role:turn.role,content:turn.content,...(turn.pending_action?{pendingAction:turn.pending_action}:{})}));
      if(payload.pending){const turn=turns.find(t=>t.pendingAction?.proposalId===payload.pending.proposalId);if(turn)turn.pendingAction=payload.pending;else turns.push({role:'assistant',content:payload.pendingSummary||'A business action is waiting for your confirmation.',pendingAction:payload.pending});}
      return turns;
    },
    async send({workspaceId, messages, signal, onProgress} = {}) {
      if (!workspaceId) throw new Error('Open a business before using the assistant.');
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in to ask about your live financial data.');

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, {once: true});

      try {
        const conversation = safeMessages(messages);
        const latest = conversation.at(-1);
        if (latest.role !== 'user') throw new Error('The latest conversation message must be from you.');
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({workspaceId, message: latest.content, history: conversation.slice(0, -1).slice(-8)}),
          signal: controller.signal,
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(publicErrorMessage(payload?.error));
        }
        return readAssistantResponse(response, onProgress);
      } catch (error) {
        if (error?.name === 'AbortError') throw new Error('The assistant took too long to respond. Please try again.');
        throw error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
