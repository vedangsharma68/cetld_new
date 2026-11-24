import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getEnv } from "@/env";
const env = getEnv();
export const supabaseAdmin = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  },
);
