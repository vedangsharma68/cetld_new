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

test('assembles streamed markdown without dropping chunks',async()=>{
  const encoder=new TextEncoder(),progress=[];
  const stream=new ReadableStream({start(controller){controller.enqueue(encoder.encode('data: {"delta":"## Summary\\n\\n"}\n\n'));controller.enqueue(encoder.encode('data: {"delta":"- Invoice one\\n"}\n\ndata: {"delta":"- Invoice two"}\n\ndata: [DONE]\n\n'));controller.close()}});
  const client=createAssistantClient({getAccessToken:async()=> 'session-token',fetchImpl:async()=>new Response(stream,{status:200,headers:{'Content-Type':'text/event-stream'}})});
  const answer=await client.send({workspaceId:'workspace-1',messages:[{role:'user',content:'Give me a detailed summary'}],onProgress:value=>progress.push(value)});
  assert.equal(answer,'## Summary\n\n- Invoice one\n- Invoice two');
  assert.equal(progress.at(-1),answer);
});

