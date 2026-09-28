import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as settings from '../settings-ai.js';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

test('keeps Space Bunny primary distinct from LongCat and Gemini fallbacks', () => {
  assert.deepEqual(settings.AI_MODELS, [
    'space-bunny-free',
  ]);
  assert.deepEqual(settings.AI_FALLBACK_MODELS, [
    'longcat-2.5-preview-free',
    'gemini-3.5-flash',
  ]);
});

test('persists only selected model IDs through the workspace-scoped settings API', () => {
  assert.match(app, /body:\{workspaceId:state\.workspace\.id,primary_model:primaryModel,fallback_model:fallbackModel\}/);
  assert.doesNotMatch(app, /OPENROUTER_API_KEY/);
  assert.match(app,/AI_FALLBACK_MODELS/);
  assert.match(app,/fallbackModel&&!AI_FALLBACK_MODELS\.some/);
  assert.doesNotMatch(app,/fallbackModel&&!AI_MODELS\.some/);
});
