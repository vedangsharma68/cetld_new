import { z } from "zod";
const schema = z.object({
  DATABASE_URL: z
    .url()
    .refine(
      (v) => new URL(v).port === "6543",
      "Use the transaction pooler on port 6543",
    ),
  DIRECT_URL: z
    .url()
    .refine(
      (v) => new URL(v).port === "5432",
      "Use direct migration connection on port 5432",
    ),
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_INVOICE_BUCKET: z.literal("invoices").default("invoices"),
  AUTH_SECRET: z.string().min(32),
  AUTH_GOOGLE_ID: z.string().min(1),
  AUTH_GOOGLE_SECRET: z.string().min(1),
  APP_URL: z.url(),
  AUTH_CLIENT_IP_HEADER: z.string().default(""),
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
  SMTP_USER: z.string().default(""),
  SMTP_PASSWORD: z.string().default(""),
  SMTP_FROM: z.string().default(""),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  APP_ENV: z
    .enum(["development", "test", "preview", "production"])
    .default("development"),
  MIGRATION_ALLOW_PRODUCTION: z.enum(["yes", "no"]).default("no"),
  DISPATCH_ENABLED: z.literal("false").default("false"),
});
export type Env = z.infer<typeof schema>;
let cached: Env | undefined;
export function getEnv(): Env {
  if (cached) return cached;
  const result = schema.safeParse(process.env);
  if (!result.success)
    throw new Error(
      "Invalid server environment: " +
        result.error.issues.map((i) => i.path.join(".")).join(", "),
    );
  cached = result.data;
  return cached;
}
export function validateEnv(): void {
  getEnv();
}

export function isProductionBuild(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}
