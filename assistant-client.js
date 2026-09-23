const DEFAULT_ENDPOINT = '/api/assistant';
const REQUEST_TIMEOUT_MS = 45_000;

function responseMessage(payload) {
  const value = payload?.message?.content ?? payload?.content ?? payload?.answer;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('The assistant returned an empty response. Please try again.');
  }
  return value.trim();
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
    async send({workspaceId, messages, signal} = {}) {
      if (!workspaceId) throw new Error('Open a workspace before using the assistant.');
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in to ask about your live financial data.');

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, {once: true});

      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({workspaceId, messages: safeMessages(messages)}),
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(typeof payload?.error === 'string' ? payload.error : 'The assistant is unavailable right now.');
        }
        return responseMessage(payload);
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
