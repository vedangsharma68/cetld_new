import {createAIHandler} from '../ai/routes.mjs';
import {config} from '../config.js';

// One server-only entry point; no browser bundle imports provider credentials.
// The Supabase URL and publishable key are public client configuration already
// shipped in config.js. Keep them as a safe runtime fallback when the hosting
// environment does not inject its copies; OpenRouter remains env-only.
export default createAIHandler({env: {
  ...process.env,
  SUPABASE_URL: process.env.SUPABASE_URL || config.url,
  SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY || config.key
}});
