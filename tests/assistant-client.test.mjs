import test from 'node:test';
import assert from 'node:assert/strict';
import {createAssistantClient} from '../assistant-client.js';

test('sends authenticated, workspace-scoped conversation data', async () => {
  let request;
  const client = createAssistantClient({
    getAccessToken: async () => 'session-token',
    fetchImpl: async (url, options) => {
      request = {url, options};
      return {ok: true, json: async () => ({message: {content: '₹84,600 is overdue.'}})};
    },
  });

  const answer = await client.send({
    workspaceId: 'workspace-1',
    messages: [{role: 'user', content: 'What is overdue?'}],
  });

  assert.equal(answer, '₹84,600 is overdue.');
  assert.equal(request.url, '/api/ai?action=assistant');
  assert.equal(request.options.headers.Authorization, 'Bearer session-token');
  assert.deepEqual(JSON.parse(request.options.body), {
    workspaceId: 'workspace-1',
    message: 'What is overdue?',
    history: [],
  });
});

test('matches the AI backend history contract and appends grounded guidance', async () => {
  let body;
  const client = createAssistantClient({
    getAccessToken: async () => 'session-token',
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return {ok: true, json: async () => ({answer: 'Verified balances', guidance: 'Follow up politely.'})};
    },
  });
  const messages = Array.from({length: 10}, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `Message ${index}`,
  }));
  messages.push({role: 'user', content: 'What next?'});
  assert.equal(await client.send({workspaceId: 'workspace-1', messages}), 'Verified balances\n\nFollow up politely.');
  assert.equal(body.message, 'What next?');
  assert.equal(body.history.length, 8);
  assert.deepEqual(body.history, messages.slice(2, 10));
});

test('refuses unauthenticated requests before calling the backend', async () => {
  let called = false;
  const client = createAssistantClient({
    getAccessToken: async () => null,
    fetchImpl: async () => { called = true; },
  });
  await assert.rejects(
    client.send({workspaceId: 'workspace-1', messages: [{role: 'user', content: 'Hello'}]}),
    /Sign in/,
  );
  assert.equal(called, false);
});

test('surfaces backend errors without inventing an answer', async () => {
  const client = createAssistantClient({
    getAccessToken: async () => 'session-token',
    fetchImpl: async () => ({ok: false, json: async () => ({error: 'Assistant backend is not configured.'})}),
  });
  await assert.rejects(
    client.send({workspaceId: 'workspace-1', messages: [{role: 'user', content: 'Hello'}]}),
    /not configured/,
  );
});

test('rejects empty responses and invalid message history', async () => {
  const client = createAssistantClient({
    getAccessToken: async () => 'session-token',
    fetchImpl: async () => ({ok: true, json: async () => ({answer: '  '})}),
  });
  await assert.rejects(client.send({workspaceId: 'workspace-1', messages: []}), /Write a question/);
  await assert.rejects(
    client.send({workspaceId: 'workspace-1', messages: [{role: 'user', content: 'Hello'}]}),
    /empty response/,
  );
});
