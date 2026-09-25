const DEFAULT_ENDPOINT = '/api/ai?action=assistant';
const REQUEST_TIMEOUT_MS = 90_000;

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
  if (pendingAction && ['create_invoice', 'update_invoice'].includes(pendingAction.type) && typeof pendingAction.confirmationToken === 'string' && pendingAction.confirmationToken) {
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
    async send({workspaceId, messages, signal, onProgress} = {}) {
      if (!workspaceId) throw new Error('Open a workspace before using the assistant.');
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
          throw new Error(typeof payload?.error === 'string' ? payload.error : 'The assistant is unavailable right now.');
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
