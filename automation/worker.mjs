// Run once from a scheduler every minute. Multiple workers are coordinated by DB claims.
import { pathToFileURL } from 'node:url';
import { required, uuid } from './http.mjs';

export async function runWorkerOnce({ env = process.env, fetchImpl = fetch } = {}) {
  const endpoint = new URL('/api/automation', required(env, 'AUTOMATION_APP_URL'));
  if (endpoint.protocol !== 'https:') throw new Error('Worker target must use HTTPS');
  const workspaces = JSON.parse(required(env, 'AUTOMATION_WORKSPACES'));
  if (!Array.isArray(workspaces) || workspaces.length > 1000) throw new Error('Invalid workspace configuration');
  const results = [];
  for (const item of workspaces) {
    const workspaceId = uuid(item.workspaceId), ownerId = uuid(item.ownerId);
    const result = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${required(env, 'AUTOMATION_WORKER_SECRET')}` }, body: JSON.stringify({ action: 'tick', workspaceId, ownerId }), signal: AbortSignal.timeout(55000) });
    results.push({ workspaceId, ok: result.ok, status: result.status });
  }
  return results;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWorkerOnce().then(results => { console.log(JSON.stringify(results)); if (results.some(result => !result.ok)) process.exitCode = 1; }).catch(() => { console.error('Automation worker failed; inspect configuration and server health.'); process.exitCode = 1; });
}
