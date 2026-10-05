import {APIError, readBounded} from '../../ai/http.mjs';

const NAMES = Object.freeze(['cetld_invoice_update_v2', 'cetld_invoice_update_btn_v2',
  'cetld_invoice_gentle_v1', 'cetld_invoice_gentle_btn_v1']);
const RECIPIENT = '+919871367051';
const SENDER = '+917303338959';
const MAX_PAGES = 3;

/** Only called after the existing test handler's JWT, owner/operator and QA gates. */
export async function readApprovedReminderTemplates({env, fetchImpl}) {
  const version = env.WHATSAPP_GRAPH_API_VERSION;
  const waba = env.WHATSAPP_WABA_ID;
  const phone = env.WHATSAPP_PHONE_NUMBER_ID;
  const token = env.WHATSAPP_ACCESS_TOKEN;
  if (!/^v\d+\.\d+$/.test(version || '') || !/^\d{5,30}$/.test(waba || '')
    || !/^\d{5,30}$/.test(phone || '') || typeof token !== 'string' || !token.trim()) {
    throw new APIError(503, 'WHATSAPP_TEMPLATE_READ_NOT_CONFIGURED');
  }
  const credentials = [token, env.SUPABASE_SERVICE_ROLE_KEY].filter(Boolean);
  function safeString(value, limit = 4096) {
    if (typeof value !== 'string' || value.length > limit
      || credentials.some(secret => value.includes(secret))
      || /(?:access_token\s*[=:]|Bearer\s)/i.test(value)) throw new APIError(502, 'INVALID_TEMPLATE_METADATA');
    return value;
  }
  async function pages(edge, fields, name) {
    const rows = [], seen = new Set();
    let after;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({fields, limit: '100', ...(name ? {name} : {}), ...(after ? {after} : {})});
      // Never follow upstream paging URLs: they may contain credentials or another host/account.
      let response;
      try {
        response = await fetchImpl(`https://graph.facebook.com/${version}/${waba}/${edge}?${query}`, {
          method: 'GET', redirect: 'error', headers: {Authorization: `Bearer ${token}`},
          signal: AbortSignal.timeout(3000),
        });
      } catch { throw new APIError(502, 'WHATSAPP_TEMPLATE_READ_UNAVAILABLE'); }
      if (!response.ok) throw new APIError(502, 'WHATSAPP_TEMPLATE_READ_UNAVAILABLE');
      let payload;
      try { payload = JSON.parse((await readBounded(response, 128 * 1024)).toString('utf8')); }
      catch { throw new APIError(502, 'INVALID_TEMPLATE_METADATA'); }
      if (!Array.isArray(payload?.data) || payload.data.length > 100) throw new APIError(502, 'INVALID_TEMPLATE_METADATA');
      rows.push(...payload.data);
      if (!payload.paging?.next) return rows;
      after = payload.paging?.cursors?.after;
      if (typeof after !== 'string' || !/^[A-Za-z0-9_=-]{1,1024}$/.test(after) || seen.has(after)
        || credentials.some(secret => after.includes(secret))) {
        throw new APIError(502, 'INVALID_TEMPLATE_PAGINATION');
      }
      seen.add(after);
    }
    throw new APIError(502, 'TEMPLATE_PAGINATION_LIMIT');
  }
  const phones = await pages('phone_numbers', 'id,display_phone_number');
  const matched = phones.filter(row => row?.id === phone);
  if (matched.length !== 1 || '+' + String(matched[0].display_phone_number || '').replace(/\D/g, '') !== SENDER) {
    throw new APIError(409, 'WHATSAPP_TEMPLATE_ACCOUNT_MISMATCH');
  }
  function component(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new APIError(502, 'INVALID_TEMPLATE_METADATA');
    const output = {type: safeString(row.type, 64)};
    for (const key of ['format', 'text']) if (row[key] !== undefined) output[key] = safeString(row[key]);
    if (row.buttons !== undefined) {
      if (!Array.isArray(row.buttons) || row.buttons.length > 10) throw new APIError(502, 'INVALID_TEMPLATE_METADATA');
      output.buttons = row.buttons.map(button => {
        if (!button || typeof button !== 'object' || Array.isArray(button)) throw new APIError(502, 'INVALID_TEMPLATE_METADATA');
        const result = {type: safeString(button.type, 64)};
        for (const key of ['text', 'url', 'phone_number', 'flow_id', 'flow_action', 'navigate_screen']) {
          if (button[key] !== undefined) result[key] = safeString(button[key]);
        }
        return result;
      });
    }
    return output;
  }
  const templates = [];
  for (const name of NAMES) {
    const rows = await pages('message_templates', 'id,name,language,status,category,parameter_format,components', name);
    // Filtering remains mandatory even if the upstream name filter is ignored.
    const matching = rows.filter(row => row?.name === name && row?.language === 'en');
    if (matching.length > 1) throw new APIError(502, 'DUPLICATE_TEMPLATE_METADATA');
    if (!matching.length) { templates.push({name, language: 'en', found: false}); continue; }
    const row = matching[0];
    if (!Array.isArray(row.components) || row.components.length > 10) throw new APIError(502, 'INVALID_TEMPLATE_METADATA');
    const output = {name, language: 'en', found: true, id: safeString(row.id, 64),
      status: safeString(row.status, 64), category: safeString(row.category, 64),
      components: row.components.map(component)};
    if (row.parameter_format !== undefined) output.parameter_format = safeString(row.parameter_format, 64);
    templates.push(output);
  }
  return {readOnly: true, recipient: RECIPIENT, sendingBot: SENDER, language: 'en', graphVersion: version, templates};
}
