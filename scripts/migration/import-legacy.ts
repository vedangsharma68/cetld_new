import postgres from "postgres";
import { getEnv } from "../../src/env";
const env=getEnv();
// Deliberately no production execution yet. Run against a restored schema-only/synthetic
// predecessor first, inspect column mappings, then obtain a separate cutover approval.
if(env.APP_ENV==="production")throw new Error("Legacy import has not passed a production cutover review");
if(process.argv[2]!=="--inspect")throw new Error("Only --inspect is currently supported; no rows are changed");
const sql=postgres(env.DIRECT_URL,{max:1,prepare:false});
try{const columns=await sql`select table_schema,table_name,column_name,data_type from information_schema.columns where (table_schema='auth' and table_name in ('users','identities')) or (table_schema='public' and table_name in ('users','profiles','workspaces','workspace_members','customers','invoices','invoice_files')) or (table_schema='app' and table_name='signup_invites') order by table_schema,table_name,ordinal_position`;process.stdout.write(JSON.stringify({schemaOnly:true,columns},null,2)+"\n");}finally{await sql.end();}
