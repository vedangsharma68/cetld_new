import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getEnv } from "../../src/env";
const env=getEnv();
if(env.APP_ENV==="production"&&env.MIGRATION_ALLOW_PRODUCTION!=="yes")throw new Error("Production migration is locked pending cutover approval");
const sql=postgres(env.DIRECT_URL,{max:1,prepare:false});
try {await sql`select pg_advisory_lock(184239021)`;await migrate(drizzle(sql),{migrationsFolder:"src/server/db/migrations"});}finally{await sql`select pg_advisory_unlock(184239021)`;await sql.end();}
