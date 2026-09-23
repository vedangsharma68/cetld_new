// Server-only transport. Errors intentionally exclude upstream bodies and credentials.
export class APIError extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}
export function uuid(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new APIError(400, 'INVALID_ID');
  return value.toLowerCase();
}
export function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new APIError(400, 'INVALID_INPUT');
  return value;
}
export function requestBody(req, allowed, maxBytes = 32768) {
  let value = req.body;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > maxBytes) throw new APIError(413, 'REQUEST_TOO_LARGE');
    try { value = JSON.parse(value); } catch { throw new APIError(400, 'INVALID_JSON'); }
  }
  if (Buffer.byteLength(JSON.stringify(value ?? null)) > maxBytes) throw new APIError(413, 'REQUEST_TOO_LARGE');
  return object(value, allowed);
}
export async function readBounded(response, limit) {
  if (Number(response.headers?.get('content-length')) > limit) throw new APIError(413, 'RESPONSE_TOO_LARGE');
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new APIError(413, 'RESPONSE_TOO_LARGE');
    return bytes;
  }
  const reader = response.body.getReader(), chunks = []; let total = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      total += value.length;
      if (total > limit) { await reader.cancel(); throw new APIError(413, 'RESPONSE_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
export async function readJSON(response) {
  const bytes = await readBounded(response, 4 * 1024 * 1024);
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new APIError(502, 'INVALID_UPSTREAM_RESPONSE'); }
}
export function sendError(res, error) {
  // Only known, sanitized application/provider error codes cross the API boundary.
  const safe = error instanceof APIError || error?.name === 'AIError';
  return res.status(safe && Number.isInteger(error.status) ? error.status : 503).json({error: safe ? error.code : 'AI_UNAVAILABLE'});
}
