import "server-only";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { getEnv } from "@/env";
import * as schema from "./schema";
const globalForDb = globalThis as unknown as {
  cetldSql?: ReturnType<typeof postgres>;
};
export const sql =
  globalForDb.cetldSql ??
  postgres(getEnv().DATABASE_URL, {
    prepare: false,
    max: 5,
    connect_timeout: 5,
    idle_timeout: 20,
  });
globalForDb.cetldSql = sql;
export const db = drizzle(sql, { schema });
