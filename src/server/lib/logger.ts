import "server-only";
import pino from "pino";
import { getEnv } from "@/env";
export const logger = pino({
  level: getEnv().LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "password",
      "password_hash",
      "token",
      "secret",
      "DATABASE_URL",
      "DIRECT_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
    ],
    censor: "[REDACTED]",
  },
});
