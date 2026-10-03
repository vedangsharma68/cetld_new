export const DEFAULT_OWNER_BOT_PREFERENCES = Object.freeze({
  assistantName: 'Cetld Assistant',
  tone: 'friendly',
  language: 'auto',
  replyLength: 'balanced',
  confirmationMode: 'direct',
  serviceReplySignature: '',
  customInstruction: '',
});

const FIELDS = Object.freeze(Object.keys(DEFAULT_OWNER_BOT_PREFERENCES));
const TONES = new Set(['concise', 'friendly', 'formal']);
const LENGTHS = new Set(['short', 'balanced', 'detailed']);
const CONFIRMATION_MODES = new Set(['direct', 'buttons']);
export const OWNER_BOT_LANGUAGE_OPTIONS = Object.freeze([
  ['auto', 'Match the owner'], ['English', 'English'], ['Hindi', 'Hindi'], ['Hinglish', 'Hinglish'],
  ['Bengali', 'Bengali'], ['Gujarati', 'Gujarati'], ['Kannada', 'Kannada'], ['Malayalam', 'Malayalam'],
  ['Marathi', 'Marathi'], ['Tamil', 'Tamil'], ['Telugu', 'Telugu'], ['Urdu', 'Urdu'],
].map(([value, label]) => Object.freeze({value, label})));
const LANGUAGES = new Set(OWNER_BOT_LANGUAGE_OPTIONS.map(({value}) => value));

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, field, maxLength, {required = false, allowNewlines = false} = {}) {
  if (typeof value !== 'string') throw new TypeError(`Invalid ${field}.`);
  const forbidden = allowNewlines ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (forbidden.test(value)) throw new TypeError(`Invalid ${field}.`);
  const raw = value.trim();
  const text = raw.replace(/\s+/g, ' ');
  if (required && !text) throw new TypeError(`${field} is required.`);
  if (text.length > maxLength) throw new TypeError(`${field} must be ${maxLength} characters or fewer.`);
  return text;
}

function normalizeText(value, fallback, maxLength, options) {
  try { return cleanText(value, 'preference', maxLength, options); }
  catch { return fallback; }
}

export function sanitizeOwnerBotPreferences(value) {
  if (!isObject(value)) throw new TypeError('Owner bot preferences must be an object.');
  if (Object.keys(value).some(key => !FIELDS.includes(key))) throw new TypeError('Unknown owner bot preference.');

  const input = {...DEFAULT_OWNER_BOT_PREFERENCES, ...value};
  const assistantName = cleanText(input.assistantName, 'assistant name', 50, {required: true});
  const language = cleanText(input.language, 'language', 48, {required: true});
  if (!LANGUAGES.has(language)) throw new TypeError('Choose a supported reply language.');
  if (!TONES.has(input.tone)) throw new TypeError('Choose a valid assistant tone.');
  if (!LENGTHS.has(input.replyLength)) throw new TypeError('Choose a valid reply length.');
  if (!CONFIRMATION_MODES.has(input.confirmationMode)) throw new TypeError('Choose a valid confirmation mode.');

  return {
    assistantName,
    tone: input.tone,
    language,
    replyLength: input.replyLength,
    confirmationMode: input.confirmationMode,
    serviceReplySignature: normalizeOwnerServiceReplyText(cleanText(input.serviceReplySignature, 'service reply signature', 120)).slice(0, 120),
    customInstruction: cleanText(input.customInstruction, 'custom instruction', 500, {allowNewlines: true}),
  };
}

export function normalizeOwnerBotPreferences(value) {
  if (!isObject(value)) return {...DEFAULT_OWNER_BOT_PREFERENCES};
  const candidate = {};
  if (Object.hasOwn(value, 'assistantName')) candidate.assistantName = normalizeText(value.assistantName, DEFAULT_OWNER_BOT_PREFERENCES.assistantName, 50, {required: true});
  if (TONES.has(value.tone)) candidate.tone = value.tone;
  if (Object.hasOwn(value, 'language')) {
    const language = normalizeText(value.language, DEFAULT_OWNER_BOT_PREFERENCES.language, 48, {required: true});
    candidate.language = LANGUAGES.has(language) ? language : DEFAULT_OWNER_BOT_PREFERENCES.language;
  }
  if (LENGTHS.has(value.replyLength)) candidate.replyLength = value.replyLength;
  if (CONFIRMATION_MODES.has(value.confirmationMode)) candidate.confirmationMode = value.confirmationMode;
  if (Object.hasOwn(value, 'serviceReplySignature')) candidate.serviceReplySignature = normalizeOwnerServiceReplyText(normalizeText(value.serviceReplySignature, '', 120)).slice(0, 120);
  if (Object.hasOwn(value, 'customInstruction')) candidate.customInstruction = normalizeText(value.customInstruction, '', 500, {allowNewlines: true});
  return {...DEFAULT_OWNER_BOT_PREFERENCES, ...candidate};
}

export function mergeOwnerBotPreferences(current, patch) {
  if (!isObject(patch)) throw new TypeError('Owner bot preference changes must be an object.');
  return sanitizeOwnerBotPreferences({...normalizeOwnerBotPreferences(current), ...patch});
}

export function normalizeOwnerServiceReplyText(value) {
  return String(value ?? '').replace(/\s*[—–]\s*/g, ', ').replace(/^\s*,\s*|\s*,\s*$/g, '').trim();
}

export function ownerBotLanguageLabel(value) {
  return OWNER_BOT_LANGUAGE_OPTIONS.find(option => option.value === value)?.label || 'Match the owner';
}

function workspaceId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) throw new TypeError('A verified workspace is required.');
  return value.trim();
}

export function createOwnerBotPreferencesStore(supabase) {
  if (!supabase || typeof supabase.from !== 'function') throw new TypeError('A workspace settings database client is required.');
  return {
    async read(verifiedWorkspaceId) {
      const id = workspaceId(verifiedWorkspaceId);
      const result = await supabase.from('workspace_settings')
        .select('owner_bot_preferences,updated_at').eq('workspace_id', id).maybeSingle();
      if (result.error) throw result.error;
      return normalizeOwnerBotPreferences(result.data?.owner_bot_preferences);
    },
    async write(verifiedWorkspaceId, value) {
      const id = workspaceId(verifiedWorkspaceId);
      const owner_bot_preferences = sanitizeOwnerBotPreferences(value);
      const result = await supabase.from('workspace_settings').update({owner_bot_preferences})
        .eq('workspace_id', id).select('owner_bot_preferences,updated_at').maybeSingle();
      if (result.error) throw result.error;
      if (!result.data) throw new Error('Workspace settings were not found.');
      return {
        ...result.data,
        owner_bot_preferences: normalizeOwnerBotPreferences(result.data.owner_bot_preferences),
      };
    },
  };
}
