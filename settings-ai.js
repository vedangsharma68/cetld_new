const CLOUDFLARE_AND_GEMINI_MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/openai/gpt-oss-20b',
  '@cf/qwen/qwen3-30b-a3b-fp8',
  '@cf/zai-org/glm-4.7-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
];

export const AI_MODEL_LABELS = {
  'space-bunny-free': 'Space Bunny Free',
  'mimo-v2.6-flash-free': 'MiMo V2.6 Flash Free',
  'muse-spark-1.3-contributor-free': 'Muse Spark 1.3 Contributor Free',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': 'Cloudflare · Llama 3.3 70B',
  '@cf/meta/llama-4-scout-17b-16e-instruct': 'Cloudflare · Llama 4 Scout',
  '@cf/mistralai/mistral-small-3.1-24b-instruct': 'Cloudflare · Mistral 3.1 Small',
  '@cf/openai/gpt-oss-20b': 'Cloudflare · gpt-oss 20B',
  '@cf/qwen/qwen3-30b-a3b-fp8': 'Cloudflare · Qwen3 30B A3B',
  '@cf/zai-org/glm-4.7-flash': 'Cloudflare · GLM 4.7 Flash',
  'gemini-3.5-flash': 'Google · Gemini 3.5 Flash',
  'gemini-3.5-flash-lite': 'Google · Gemini 3.5 Flash Lite',
};

// Keep Space Bunny first. The live API catalog replaces these values
// after account setup, so server-side role validation remains authoritative.
export const AI_MODELS = [
  'space-bunny-free',
  'mimo-v2.6-flash-free',
  'muse-spark-1.3-contributor-free',
  ...CLOUDFLARE_AND_GEMINI_MODELS,
];

export const AI_FALLBACK_MODELS = [
  ...CLOUDFLARE_AND_GEMINI_MODELS,
  'mimo-v2.6-flash-free',
  'muse-spark-1.3-contributor-free',
];

export const EXTRACTION_MODELS = [
  'gemini-3.5-flash-lite',
];

const modelCodes = models => (Array.isArray(models) ? models : []).map(model =>
  Array.isArray(model) ? String(model[0]) : String(model));

export function mergeAIModelOptions(models = AI_MODELS, verifiedModels = []) {
  const merged = (Array.isArray(models) ? models : []).map(entry => Array.isArray(entry)
    ? [String(entry[0]), String(entry[1] ?? AI_MODEL_LABELS[entry[0]] ?? entry[0])]
    : [String(entry), AI_MODEL_LABELS[entry] || String(entry)]);
  const seen = new Set(merged.map(([code]) => code));
  for (const code of modelCodes(verifiedModels)) {
    if (code === 'longcat-2.5-preview-free') continue;
    if (!seen.has(code)) {
      merged.push([code, AI_MODEL_LABELS[code] || code]);
      seen.add(code);
    }
  }
  return merged;
}

export function normalizeAISettings(settings, {
  models = AI_MODELS,
} = {}) {
  const primaryCodes = modelCodes(models);
  const requestedPrimary = String(settings?.primary_model || '');
  const primary = primaryCodes.includes(requestedPrimary)
    ? requestedPrimary
    : (requestedPrimary || primaryCodes[0] || '');
  const requestedFallback = String(settings?.fallback_model || '');
  const fallback = requestedFallback && requestedFallback !== primary
    ? requestedFallback
    : null;
  return { ...settings, primary_model: primary, fallback_model: fallback };
}

export function buildAISettingsPayload(workspaceId, settings, {
  models = AI_MODELS,
  fallbackModels = AI_FALLBACK_MODELS,
} = {}) {
  const primaryCodes = modelCodes(models);
  const fallbackCodes = modelCodes(fallbackModels);
  const primary = String(settings?.primary_model || '');
  const fallback = String(settings?.fallback_model || '') || null;

  if (!workspaceId || !primaryCodes.includes(primary) || (fallback && (!fallbackCodes.includes(fallback) || fallback === primary))) {
    throw new Error('Choose valid, distinct primary and fallback models.');
  }

  return { workspaceId, primary_model: primary, fallback_model: fallback };
}

export async function loadAISettings(request, workspaceId, options) {
  const settings = await request('settings', { method: 'GET', query: { workspaceId } });
  return normalizeAISettings(settings, options);
}

export async function loadAIWorkspaceConfiguration(request, workspaceId, {
  primaryModels = AI_MODELS,
  fallbackModels = AI_FALLBACK_MODELS,
} = {}) {
  let availableModels = null;
  let availableFallbackModels = null;
  let extractionModels = EXTRACTION_MODELS;
  let catalogError = '';
  let settingsError = '';
  let models = mergeAIModelOptions(primaryModels);
  let fallbackOptions = mergeAIModelOptions(fallbackModels);

  const [catalogResult, settingsResult] = await Promise.allSettled([
    request('models', { method: 'GET' }),
    request('settings', { method: 'GET', query: { workspaceId } }),
  ]);

  if (catalogResult.status === 'fulfilled') {
    const catalog = catalogResult.value;
    if (Array.isArray(catalog?.models)) availableModels = catalog.models;
    if (Array.isArray(catalog?.fallbackModels)) availableFallbackModels = catalog.fallbackModels;
    if (Array.isArray(catalog?.extractionModels)) extractionModels = catalog.extractionModels;
    models = mergeAIModelOptions(primaryModels, availableModels || []);
    fallbackOptions = mergeAIModelOptions(fallbackModels, availableFallbackModels || []);
  } else {
    catalogError = catalogResult.reason?.message || 'Model availability could not be checked.';
  }

  let aiSettings;
  if (settingsResult.status === 'fulfilled') {
    aiSettings = normalizeAISettings(settingsResult.value, { models, fallbackModels: fallbackOptions });
  } else {
    aiSettings = normalizeAISettings({}, { models });
    settingsError = settingsResult.reason?.message || 'AI settings are unavailable.';
  }

  return {
    models,
    fallbackModels: fallbackOptions,
    availableModels,
    availableFallbackModels,
    extractionModels,
    aiSettings,
    aiSettingsError: settingsError || catalogError,
  };
}

export async function saveAISettings(request, workspaceId, settings, options) {
  const body = buildAISettingsPayload(workspaceId, settings, options);
  const saved = await request('settings', { method: 'PUT', body });
  return normalizeAISettings(saved, options);
}

export function readAIModelPickerValues(primarySelect, fallbackSelect, defaultPrimary = AI_MODELS[0]) {
  const primary = String(primarySelect?.value || defaultPrimary || '');
  const fallback = String(fallbackSelect?.value || '').trim() || null;
  return { primary_model: primary, fallback_model: fallback };
}

export function resetAIModelAvailability(state) {
  if (!state) return;
  state.availableAIModels = null;
  state.availableAIFallbackModels = null;
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[char]));

export function renderAIModelOptions(selected, models = AI_MODELS, {
  allowNone = false,
  excludedModel = '',
  availableModels = null,
} = {}) {
  const noModelOption = allowNone
    ? `<option value=""${selected ? '' : ' selected'}>No fallback</option>`
    : '';
  const entries = Array.isArray(models) ? models : [];
  const codes = modelCodes(entries);
  const availableCodes = Array.isArray(availableModels) ? new Set(modelCodes(availableModels)) : null;
  const missingSelection = selected && !codes.includes(String(selected))
    ? `<option value="${escapeHtml(selected)}" selected disabled>${escapeHtml(AI_MODEL_LABELS[selected] || selected)} · unavailable</option>`
    : '';
  const options = entries.map(entry => {
    const code = String(Array.isArray(entry) ? entry[0] : entry);
    const label = Array.isArray(entry) ? entry[1] : (AI_MODEL_LABELS[code] || code);
    const unavailable = availableCodes && !availableCodes.has(code);
    const disabled = excludedModel === code || unavailable || code === 'longcat-2.5-preview-free';
    return `<option value="${escapeHtml(code)}"${selected === code ? ' selected' : ''}${disabled ? ' disabled' : ''}>${escapeHtml(label)}${unavailable ? ' · unavailable' : ''}</option>`;
  }).join('');
  return noModelOption + missingSelection + options;
}

export function bindAIModelPickers(primarySelect, fallbackSelect, options) {
  if (!primarySelect || !fallbackSelect) return null;
  const availablePrimaryCodes = Array.isArray(options?.availableModels)
    ? new Set(modelCodes(options.availableModels))
    : null;
  const availableFallbackCodes = Array.isArray(options?.availableFallbackModels)
    ? new Set(modelCodes(options.availableFallbackModels))
    : null;

  const applySelection = changedPicker => {
    const normalized = normalizeAISettings({
      primary_model: primarySelect.value,
      fallback_model: fallbackSelect.value,
    }, options);

    if (changedPicker === 'fallback' && fallbackSelect.value === primarySelect.value) {
      fallbackSelect.value = '';
    } else {
      primarySelect.value = normalized.primary_model;
      fallbackSelect.value = normalized.fallback_model || '';
    }

    for (const option of primarySelect.options || []) {
      const unavailable = availablePrimaryCodes && option.value && !availablePrimaryCodes.has(option.value);
      option.disabled = !!(option.value && (option.value === fallbackSelect.value || unavailable || !modelCodes(options?.models || AI_MODELS).includes(option.value)));
    }
    for (const option of fallbackSelect.options || []) {
      const unavailable = availableFallbackCodes && option.value && !availableFallbackCodes.has(option.value);
      option.disabled = !!(option.value && (option.value === primarySelect.value || unavailable || !modelCodes(options?.fallbackModels || AI_FALLBACK_MODELS).includes(option.value)));
    }
  };

  applySelection();
  primarySelect.addEventListener('change', () => applySelection('primary'));
  fallbackSelect.addEventListener('change', () => applySelection('fallback'));
  return { primarySelect, fallbackSelect };
}
