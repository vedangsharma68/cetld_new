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
  assert.equal(request.url, '/api/assistant');
  assert.equal(request.options.headers.Authorization, 'Bearer session-token');
  assert.deepEqual(JSON.parse(request.options.body), {
    workspaceId: 'workspace-1',
    messages: [{role: 'user', content: 'What is overdue?'}],
  });
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
