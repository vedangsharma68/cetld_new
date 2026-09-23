import {APIError, uuid, readJSON, readBounded} from './http.mjs';
import {DEFAULT_FALLBACK_MODEL, DEFAULT_MODEL, sanitizeModelSettings} from './provider.mjs';

const TABLES = new Set(['invoices', 'customers', 'payments', 'invoice_files']);

// No service-role credential is used: both REST and Storage enforce caller RLS.
export async function authorizeAIWorkspace(req, workspaceId, {env = process.env, fetchImpl = fetch} = {}) {
  if (typeof window !== 'undefined') throw new APIError(500, 'SERVER_ONLY');
  workspaceId = uuid(workspaceId);
  const authorization = req.headers?.authorization;
  if (typeof authorization !== 'string' || !/^Bearer [^\s]{10,16384}$/.test(authorization)) throw new APIError(401, 'SIGN_IN_REQUIRED');
  const rawURL = env.SUPABASE_URL, key = env.SUPABASE_PUBLISHABLE_KEY;
  if (!rawURL || !key) throw new APIError(503, 'SUPABASE_NOT_CONFIGURED');
  const url = new URL(rawURL);
  if (url.protocol !== 'https:' && !(env.NODE_ENV === 'test' && url.hostname === 'localhost')) throw new APIError(503, 'INVALID_SERVER_CONFIGURATION');
  const base = url.origin, headers = {apikey: key, Authorization: authorization};
  async function request(path, options = {}) {
    let res;
    try { res = await fetchImpl(base + path, {...options, redirect: 'error', headers: {...headers, 'Content-Type': 'application/json', ...options.headers}, signal: AbortSignal.timeout(10000)}); }
    catch { throw new APIError(503, 'DATABASE_UNAVAILABLE'); }
    if (!res.ok) throw new APIError(res.status === 401 ? 401 : res.status === 403 ? 403 : 503, 'DATABASE_REQUEST_FAILED');
    return readJSON(res);
  }
  const user = await request('/auth/v1/user');
  const userId = uuid(user?.id);
  const membership = await request('/rest/v1/workspace_members?' + new URLSearchParams({workspace_id: `eq.${workspaceId}`, user_id: `eq.${userId}`, select: 'workspace_id,user_id,role', limit: '1'}));
  if (!Array.isArray(membership) || membership.length !== 1 || membership[0].workspace_id !== workspaceId || membership[0].user_id !== userId || !['owner', 'admin', 'member'].includes(membership[0].role)) throw new APIError(403, 'WORKSPACE_ACCESS_DENIED');
  const role = membership[0].role;
  function checkRows(rows) {
    if (!Array.isArray(rows) || rows.some(r => r.workspace_id !== workspaceId)) throw new APIError(502, 'WORKSPACE_SCOPE_VIOLATION');
    return rows;
  }
  const store = {
    workspaceId, userId, role,
    async query(table, {select = '*', filters = {}, order = 'id.asc', limit = 100, offset = 0} = {}) {
      if (!TABLES.has(table) || Object.hasOwn(filters, 'workspace_id') || !Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0 || offset > 10000) throw new APIError(400, 'INVALID_QUERY');
      const scoped = select === '*' || select.split(',').includes('workspace_id') ? select : select + ',workspace_id';
      const projection = scoped.split(',').map(c => ['total_amount', 'amount_paid', 'amount'].includes(c) ? c + '::text' : c).join(',');
      const query = new URLSearchParams({...filters, workspace_id: `eq.${workspaceId}`, select: projection, order, limit: String(limit), offset: String(offset)});
      return checkRows(await request(`/rest/v1/${table}?${query}`));
    },
    async getSettings() {
      const rows = checkRows(await request('/rest/v1/workspace_ai_settings?' + new URLSearchParams({workspace_id: `eq.${workspaceId}`, select: 'workspace_id,primary_model,fallback_model', limit: '1'})));
      const row = rows[0];
      if (!row) return {workspace_id: workspaceId, primary_model: DEFAULT_MODEL, fallback_model: DEFAULT_FALLBACK_MODEL};
      const models = sanitizeModelSettings({primaryModel: row.primary_model, fallbackModel: row.fallback_model});
      return {...row, primary_model: models.primaryModel, fallback_model: models.fallbackModel};
    },
    async saveSettings({primary_model, fallback_model}) {
      if (!['owner', 'admin'].includes(role)) throw new APIError(403, 'SETTINGS_ADMIN_REQUIRED');
      const rows = checkRows(await request('/rest/v1/workspace_ai_settings?on_conflict=workspace_id&select=workspace_id,primary_model,fallback_model', {method: 'POST', headers: {Prefer: 'resolution=merge-duplicates,return=representation'}, body: JSON.stringify({workspace_id: workspaceId, primary_model, fallback_model})}));
      if (rows.length !== 1) throw new APIError(503, 'SETTINGS_NOT_SAVED');
      return rows[0];
    },
    async downloadInvoiceFile(fileId) {
      fileId = uuid(fileId);
      const rows = await store.query('invoice_files', {select: 'id,invoice_id,storage_path,file_name,mime_type,size_bytes', filters: {id: `eq.${fileId}`}, limit: 1});
      const row = rows[0];
      if (!row) throw new APIError(404, 'FILE_NOT_FOUND');
      const parts = String(row.storage_path).split('/');
      if (parts.length !== 3 || parts[0] !== workspaceId || parts[1] !== uuid(row.invoice_id) || !parts[2] || ['.', '..'].includes(parts[2]) || /[\\\x00-\x1f]/.test(parts[2])) throw new APIError(403, 'INVALID_FILE_SCOPE');
      if (!['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(row.mime_type) || Number(row.size_bytes) > 10 * 1024 * 1024) throw new APIError(415, 'UNSUPPORTED_FILE');
      let response;
      try { response = await fetchImpl(`${base}/storage/v1/object/authenticated/invoice-files/${parts.map(encodeURIComponent).join('/')}`, {headers, redirect: 'error', signal: AbortSignal.timeout(15000)}); }
      catch { throw new APIError(503, 'STORAGE_UNAVAILABLE'); }
      if (!response.ok) throw new APIError(404, 'FILE_NOT_FOUND');
      return {bytes: await readBounded(response, 10 * 1024 * 1024), mimeType: row.mime_type, fileName: row.file_name};
    }
  };
  return Object.freeze(store);
}
