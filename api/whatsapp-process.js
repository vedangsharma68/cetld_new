import whatsappHandler from './whatsapp.js';

/** Dedicated Vercel Cron route; the shared handler verifies CRON_SECRET. */
export default function handler(request, response) {
  return whatsappHandler({method: request.method, headers: request.headers,
    query: {...request.query, process: '1'}, url: request.url}, response);
}
