import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AI_MODELS } from '../settings-ai.js';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

test('exposes only verified free model IDs', () => {
  assert.deepEqual(AI_MODELS, [
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    'openrouter/free',
  ]);
});

test('persists only selected model IDs through the workspace-scoped settings API', () => {
  assert.match(app, /body:\{workspaceId:state\.workspace\.id,primary_model:primaryModel,fallback_model:fallbackModel\}/);
  assert.doesNotMatch(app, /OPENROUTER_API_KEY/);
});
