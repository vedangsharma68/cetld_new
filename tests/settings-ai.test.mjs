import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as settings from '../settings-ai.js';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const requestedModels = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/openai/gpt-oss-20b',
  '@cf/qwen/qwen3-30b-a3b-fp8',
  '@cf/zai-org/glm-4.7-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
];

function fakeSelect(value, optionValues) {
  const listeners = new Map();
  return {
    value,
    options: optionValues.map(optionValue => ({ value: optionValue, disabled: false })),
    addEventListener(type, listener) {
      const group = listeners.get(type) || [];
      group.push(listener);
      listeners.set(type, group);
    },
    dispatch(type) {
      for (const listener of listeners.get(type) || []) listener({ target: this });
    },
    option(valueToFind) {
      return this.options.find(option => option.value === valueToFind);
    },
  };
}

function optionsFromMarkup(markup) {
  return [...markup.matchAll(/<option value="([^"]*)"([^>]*)>(.*?)<\/option>/g)].map(match => ({
    value: match[1],
    disabled: /(?:^|\s)disabled(?:\s|$)/.test(match[2]),
    selected: /(?:^|\s)selected(?:\s|$)/.test(match[2]),
    label: match[3],
  }));
}

test('offers the requested Cloudflare and Gemini models in both pickers with readable labels', () => {
  for (const model of requestedModels) {
    assert.ok(settings.AI_MODELS.includes(model), `${model} is a primary option`);
    assert.ok(settings.AI_FALLBACK_MODELS.includes(model), `${model} is a fallback option`);
    assert.ok(settings.AI_MODEL_LABELS[model], `${model} has a readable label`);
  }
  assert.ok(settings.AI_MODELS.indexOf('space-bunny-free') < settings.AI_MODELS.indexOf(requestedModels[0]));
  assert.ok(!settings.AI_FALLBACK_MODELS.includes('longcat-2.5-preview-free'));
});

test('live verified model overrides are appended without changing the existing defaults', () => {
  const primary = settings.mergeAIModelOptions(settings.AI_MODELS, ['zen/custom-primary']);
  const fallback = settings.mergeAIModelOptions(settings.AI_FALLBACK_MODELS, ['zen/custom-fallback']);
  assert.equal(primary[0][0], 'space-bunny-free');
  assert.equal(fallback[0][0], requestedModels[0]);
  assert.ok(primary.some(([code]) => code === 'zen/custom-primary'));
  assert.ok(fallback.some(([code]) => code === 'zen/custom-fallback'));
  assert.deepEqual(settings.buildAISettingsPayload('workspace-123', {
    primary_model: 'zen/custom-primary',
    fallback_model: 'zen/custom-fallback',
  }, { models: primary, fallbackModels: fallback }), {
    workspaceId: 'workspace-123',
    primary_model: 'zen/custom-primary',
    fallback_model: 'zen/custom-fallback',
  });
});

test('rendered options and live picker handlers prevent the same model in both roles', () => {
  const primaryModel = requestedModels[0];
  const fallbackModel = requestedModels[1];
  const primaryMarkup = settings.renderAIModelOptions(primaryModel, settings.AI_MODELS, { excludedModel: fallbackModel });
  const fallbackMarkup = settings.renderAIModelOptions(fallbackModel, settings.AI_FALLBACK_MODELS, { allowNone: true, excludedModel: primaryModel });
  const primaryRenderedOptions = optionsFromMarkup(primaryMarkup);
  const fallbackRenderedOptions = optionsFromMarkup(fallbackMarkup);
  assert.equal(primaryRenderedOptions.find(option => option.value === fallbackModel).disabled, true);
  assert.equal(fallbackRenderedOptions.find(option => option.value === primaryModel).disabled, true);
  assert.equal(fallbackRenderedOptions[0].value, '');

  const primary = fakeSelect(primaryRenderedOptions.find(option => option.selected).value, primaryRenderedOptions.map(option => option.value));
  const fallback = fakeSelect(fallbackRenderedOptions.find(option => option.selected).value, fallbackRenderedOptions.map(option => option.value));
  settings.bindAIModelPickers(primary, fallback);
  assert.equal(primary.option(fallbackModel).disabled, true);
  assert.equal(fallback.option(primaryModel).disabled, true);

  primary.value = fallbackModel;
  primary.dispatch('change');
  assert.equal(primary.value, fallbackModel);
  assert.equal(fallback.value, '', 'changing primary to the current fallback clears the fallback');
  assert.equal(primary.option(fallbackModel).disabled, false);

  fallback.value = primary.value;
  fallback.dispatch('change');
  assert.equal(primary.value, fallbackModel);
  assert.equal(fallback.value, '', 'choosing the primary as fallback clears the optional fallback');
  assert.equal(fallback.option(primary.value).disabled, true);
});

test('temporarily unavailable saved options stay visible, selected, and disabled', () => {
  const primaryModel = requestedModels[0];
  const fallbackModel = requestedModels[1];
  const normalized = settings.normalizeAISettings({ primary_model: primaryModel, fallback_model: fallbackModel });
  const primaryMarkup = settings.renderAIModelOptions(normalized.primary_model, settings.AI_MODELS, {
    availableModels: ['space-bunny-free'],
  });
  const fallbackMarkup = settings.renderAIModelOptions(normalized.fallback_model, settings.AI_FALLBACK_MODELS, {
    availableModels: ['longcat-2.5-preview-free'],
  });
  const primaryOptions = optionsFromMarkup(primaryMarkup);
  const fallbackOptions = optionsFromMarkup(fallbackMarkup);
  assert.equal(primaryOptions.find(option => option.value === primaryModel).selected, true);
  assert.equal(primaryOptions.find(option => option.value === primaryModel).disabled, true);
  assert.match(primaryOptions.find(option => option.value === primaryModel).label, /unavailable/);
  assert.equal(fallbackOptions.find(option => option.value === fallbackModel).selected, true);
  assert.equal(fallbackOptions.find(option => option.value === fallbackModel).disabled, true);

  const primary = fakeSelect(primaryModel, primaryOptions.map(option => option.value));
  const fallback = fakeSelect(fallbackModel, fallbackOptions.map(option => option.value));
  primary.option(primaryModel).disabled = true;
  fallback.option(fallbackModel).disabled = true;
  settings.bindAIModelPickers(primary, fallback, {
    availableModels: ['space-bunny-free'],
    availableFallbackModels: ['longcat-2.5-preview-free'],
  });
  assert.equal(primary.option(primaryModel).disabled, true, 'binding preserves unavailable status');
  assert.equal(fallback.option(fallbackModel).disabled, true, 'binding preserves unavailable status');

  // Native forms omit a selected disabled option from FormData. Reading the
  // select value directly keeps that saved value intact when saving other fields.
  const formDataWouldContainPrimary = !primary.option(primary.value).disabled;
  const formDataWouldContainFallback = !fallback.option(fallback.value).disabled;
  assert.equal(formDataWouldContainPrimary, false);
  assert.equal(formDataWouldContainFallback, false);
  assert.deepEqual(settings.readAIModelPickerValues(primary, fallback), {
    primary_model: primaryModel,
    fallback_model: fallbackModel,
  });
});

test('saved duplicate models resolve on load while preserving settings access metadata', () => {
  const loaded = settings.normalizeAISettings({
    primary_model: requestedModels[2],
    fallback_model: requestedModels[2],
    can_manage: false,
    role: 'member',
  });

  assert.equal(loaded.primary_model, requestedModels[2]);
  assert.equal(loaded.fallback_model, null);
  assert.equal(loaded.can_manage, false);
  assert.equal(loaded.role, 'member');
});

test('workspace settings save and reload use the API payload and preserve the API response', async () => {
  const calls = [];
  let saved = {
    primary_model: 'space-bunny-free',
    fallback_model: 'longcat-2.5-preview-free',
    can_manage: true,
    workspace_role: 'owner',
  };
  const request = async (action, options) => {
    calls.push({ action, options });
    assert.equal(action, 'settings');
    if (options.method === 'GET') return { ...saved };
    saved = { ...options.body, can_manage: true, role: 'owner' };
    return { ...saved };
  };

  const loaded = await settings.loadAISettings(request, 'workspace-123');
  assert.equal(loaded.primary_model, 'space-bunny-free');
  assert.equal(loaded.fallback_model, 'longcat-2.5-preview-free');
  assert.equal(loaded.can_manage, true);

  const selection = { primary_model: requestedModels[4], fallback_model: requestedModels[5] };
  const afterSave = await settings.saveAISettings(request, 'workspace-123', selection);
  assert.deepEqual(calls[0], {
    action: 'settings',
    options: { method: 'GET', query: { workspaceId: 'workspace-123' } },
  });
  assert.deepEqual(calls[1], {
    action: 'settings',
    options: {
      method: 'PUT',
      body: { workspaceId: 'workspace-123', primary_model: selection.primary_model, fallback_model: selection.fallback_model },
    },
  });
  assert.equal(afterSave.can_manage, true);
  assert.equal(afterSave.role, 'owner');

  const reloaded = await settings.loadAISettings(request, 'workspace-123');
  assert.equal(reloaded.primary_model, selection.primary_model);
  assert.equal(reloaded.fallback_model, selection.fallback_model);
  assert.equal(reloaded.role, 'owner');
  assert.throws(() => settings.buildAISettingsPayload('workspace-123', {
    primary_model: requestedModels[0],
    fallback_model: requestedModels[0],
  }), /valid, distinct/);
});

test('a model catalog outage does not replace the saved workspace model settings', async () => {
  const calls = [];
  const request = async (action, options) => {
    calls.push({ action, options });
    if (action === 'models') throw new Error('catalog offline');
    return {
      primary_model: requestedModels[3],
      fallback_model: requestedModels[4],
      role: 'admin',
    };
  };

  const result = await settings.loadAIWorkspaceConfiguration(request, 'workspace-456');
  assert.deepEqual(calls.map(call => call.action).sort(), ['models', 'settings']);
  assert.equal(calls.find(call => call.action === 'settings').options.query.workspaceId, 'workspace-456');
  assert.equal(result.availableModels, null, 'a failed availability check remains unknown');
  assert.equal(result.availableFallbackModels, null);
  assert.equal(result.aiSettings.primary_model, requestedModels[3]);
  assert.equal(result.aiSettings.fallback_model, requestedModels[4]);
  assert.equal(result.aiSettings.role, 'admin');
  assert.equal(result.aiSettingsError, 'catalog offline');
});

test('account transitions clear prior live availability', () => {
  const state = { availableAIModels: ['private/model'], availableAIFallbackModels: ['private/fallback'] };
  settings.resetAIModelAvailability(state);
  assert.equal(state.availableAIModels, null);
  assert.equal(state.availableAIFallbackModels, null);
});

test('the Settings page renders and binds the same production model picker helpers', () => {
  assert.match(app, /modelOptions\(state\.aiSettings\?\.primary_model\|\|AI_MODELS\[0\]\[0\],AI_MODELS,false,state\.aiSettings\?\.fallback_model\|\|''.*,state\.availableAIModels\)/);
  assert.match(app, /modelOptions\(state\.aiSettings\?\.fallback_model\|\|'',AI_FALLBACK_MODELS,true,state\.aiSettings\?\.primary_model\|\|AI_MODELS\[0\]\[0\].*,state\.availableAIFallbackModels\)/);
  assert.match(app, /bindAIModelPickers\(settingsForm\.querySelector/);
  assert.match(app, /loadAIWorkspaceConfiguration\(aiRequest,workspace\.id/);
  assert.match(app, /saveAISettings\(aiRequest,state\.workspace\.id/);
  assert.match(app, /readAIModelPickerValues\(form\.querySelector/);
  assert.match(app, /loadAIWorkspaceConfiguration\(aiRequest,workspace\.id/);
  assert.match(app, /function demo\(\)\{\+\+loadEpoch;resetAIModelAvailability\(state\)/);
  assert.match(app, /resetAIModelAvailability\(state\);state\.authMode='login'/);
  assert.match(app, /event==='SIGNED_OUT'&&!state\.demo\)\{\+\+loadEpoch;resetAIModelAvailability\(state\)/);
  assert.doesNotMatch(app, /OPENROUTER_API_KEY/);
});


test('new free vision choices are selectable while retired LongCat stays visible only as saved unavailable selection', () => {
  for(const id of ['mimo-v2.6-flash-free','muse-spark-1.3-contributor-free']) {
    assert.ok(settings.AI_MODELS.includes(id));assert.ok(settings.AI_FALLBACK_MODELS.includes(id));
  }
  const retired='longcat-2.5-preview-free';
  assert.ok(!settings.AI_MODELS.includes(retired));
  assert.ok(!settings.mergeAIModelOptions(settings.AI_FALLBACK_MODELS,[retired]).some(([id])=>id===retired));
  const loaded=settings.normalizeAISettings({primary_model:requestedModels[0],fallback_model:retired});
  assert.equal(loaded.fallback_model,retired);
  const rendered=optionsFromMarkup(settings.renderAIModelOptions(retired,settings.AI_FALLBACK_MODELS,{allowNone:true}));
  assert.ok(rendered.find(option=>option.value===retired).selected);
  assert.ok(rendered.find(option=>option.value===retired).disabled);
  const primary=fakeSelect(requestedModels[0],settings.AI_MODELS);
  const fallback=fakeSelect(retired,['',...settings.AI_FALLBACK_MODELS,retired]);
  settings.bindAIModelPickers(primary,fallback);
  assert.equal(fallback.value,retired);assert.ok(fallback.option(retired).disabled);
  assert.throws(()=>settings.buildAISettingsPayload('workspace-123',loaded));
});
