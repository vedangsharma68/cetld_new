import test from 'node:test';
import assert from 'node:assert/strict';
import {readConversationHistory, writeConversationTurn} from '../automation/whatsapp/conversation-memory.mjs';

function memorySupabase(rows = []) {
  return {rows, from(table) {
    assert.equal(table, 'whatsapp_conversation_turns');
    let operation = 'select';
    const query = {
      select() { operation = 'select'; return query; }, eq() { return query; }, order() { return query; },
      limit(count) { return Promise.resolve({data: [...rows].sort((a, b) => b.id - a.id).slice(0, count), error: null}); },
      range(from, to) { return Promise.resolve({data: [...rows].sort((a, b) => b.id - a.id)
        .slice(from, to + 1).map(({id}) => ({id})), error: null}); },
      insert(value) { rows.push({...value, id: rows.length ? Math.max(...rows.map(row => row.id)) + 1 : 1,
        created_at: new Date().toISOString()}); return Promise.resolve({error: null}); },
      delete() { operation = 'delete'; return query; },
      in(_field, ids) { if (operation === 'delete') rows.splice(0, rows.length, ...rows.filter(row => !ids.includes(row.id))); return Promise.resolve({error: null}); },
    };
    return query;
  }};
}

test('conversation memory retains only the newest 20 turns and reads them oldest-first', async () => {
  const supabase = memorySupabase(Array.from({length: 20}, (_, index) => ({id: index + 1,
    workspace_id: 'workspace-a', phone: '+919871367051', role: index % 2 ? 'assistant' : 'user',
    content: `turn-${index + 1}`, created_at: new Date(index).toISOString()})));
  await writeConversationTurn({supabase, workspaceId: 'workspace-a', customerId: 'customer-a',
    phone: '+919871367051', role: 'user', content: 'turn-21'});
  assert.equal(supabase.rows.length, 20);
  assert.equal(supabase.rows.some(row => row.content === 'turn-1'), false);
  const history = await readConversationHistory({supabase, workspaceId: 'workspace-a', phone: '+919871367051'});
  assert.equal(history.length, 20);
  assert.equal(history[0].content, 'turn-2');
  assert.equal(history.at(-1).content, 'turn-21');
});
