import {createHash} from 'node:crypto';
import {APIError, requestBody, readJSON, uuid} from '../ai/http.mjs';
import {authorizeAIWorkspace} from '../ai/store.mjs';
import {config} from '../config.js';
import {MAX_BYTES, parseTally} from './tally.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createTallyHandler({authorize=authorizeAIWorkspace, fetchImpl=fetch, env=process.env}={}) {
  return async (req,res) => {
    if (req.method !== 'POST') return res.status(405).json({error:'Use POST.'});
    try {
      const body = requestBody(req,['action','workspaceId','filename','content','previewId','planHash'],MAX_BYTES * 2 + 8192);
      const workspaceId = uuid(body.workspaceId);
      if (!['preview','confirm'].includes(body.action) || typeof body.filename !== 'string' || typeof body.content !== 'string') throw new APIError(400,'Invalid import request.');
      const settings = {...env,SUPABASE_URL:env.SUPABASE_URL || config.url,SUPABASE_PUBLISHABLE_KEY:env.SUPABASE_PUBLISHABLE_KEY || config.key};
      const store = await authorize(req,workspaceId,{env:settings,fetchImpl});
      if (store.role !== 'owner') throw new APIError(403,'Only the workspace owner can import Tally data.');
      const base = new URL(settings.SUPABASE_URL).origin;
      async function request(path,payload) {
        const response = await fetchImpl(base + '/rest/v1/' + path,{method:payload ? 'POST' : 'GET',headers:{apikey:settings.SUPABASE_PUBLISHABLE_KEY,Authorization:req.headers.authorization,'Content-Type':'application/json'},...(payload ? {body:JSON.stringify(payload)} : {}),redirect:'error',signal:AbortSignal.timeout(60000)});
        const result = await readJSON(response);
        if (!response.ok) {
          if (result?.code === '40001') throw new APIError(409,'Import preview changed. Preview this file again before confirming.');
          throw new APIError(response.status === 403 ? 403 : 503,'Tally import could not complete. Retry the same file safely.');
        }
        return result;
      }
      const preferences = await request('workspace_settings?' + new URLSearchParams({workspace_id:`eq.${workspaceId}`,select:'default_currency',limit:'1'}));
      const workspaceCurrency = preferences[0]?.default_currency || 'INR';
      let parsed;
      try { parsed = parseTally(body.filename,body.content,{workspaceCurrency}); } catch(error) { throw new APIError(400,error.message); }
      // Leave room for per-row decisions below the 4 MB response/database bounds.
      if (Buffer.byteLength(JSON.stringify([parsed.customers,parsed.invoices])) > 3 * 1024 * 1024) throw new APIError(400,'The normalized import is too large. Export fewer rows per file.');
      const input = {p_workspace_id:workspaceId,p_customers:parsed.customers,p_invoices:parsed.invoices};
      if (body.action === 'preview') {
        const plan = await request('rpc/preview_tally',input);
        const previewId = digest([workspaceId,body.filename,body.content,plan.planHash]);
        const currencies = [...new Set(parsed.invoices.map(invoice=>invoice.currency))];
        const warnings = currencies.some(currency=>currency !== plan.workspaceCurrency)
          ? [`Workspace currency is ${plan.workspaceCurrency}. Invoice currencies (${currencies.join(', ')}) are preserved; amounts are never converted.`] : [];
        return res.status(200).json({previewId,plan,counts:parsed.counts,errors:parsed.errors,warnings});
      }
      if (typeof body.planHash !== 'string' || body.previewId !== digest([workspaceId,body.filename,body.content,body.planHash])) throw new APIError(400,'Preview this file before confirming.');
      if (parsed.errors.length) throw new APIError(400,'Fix validation errors and preview the file again.');
      return res.status(200).json(await request('rpc/import_tally',{...input,p_expected_hash:body.planHash}));
    } catch(error) { return res.status(error instanceof APIError ? error.status : 503).json({error:error instanceof APIError ? error.code : 'Tally import is unavailable. Please retry.'}); }
  };
}
