import whatsappHandler from './whatsapp.js';
import {createReminderCronHandler} from '../automation/reminder-cron.mjs';

/** Both daily jobs share a function; each selected handler verifies CRON_SECRET. */
export function createWhatsAppProcessHandler({processHandler=whatsappHandler,
  reminderHandler=createReminderCronHandler()}={}) {
  return function handler(request, response) {
    if(request.headers?.['x-vercel-cron-schedule']==='0 4 * * *')
      return reminderHandler(request,response);
    return processHandler({method: request.method, headers: request.headers,
      query: {...request.query, process: '1'}, url: request.url}, response);
  };
}
export default createWhatsAppProcessHandler();
