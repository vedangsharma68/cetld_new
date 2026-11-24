import {createWhatsAppInvoiceTestHandler} from '../automation/whatsapp/test-send.mjs';
import {config} from '../config.js';

export default createWhatsAppInvoiceTestHandler({env: {
  ...process.env,
  SUPABASE_URL: process.env.SUPABASE_URL || config.url,
  SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY || config.key,
}});
