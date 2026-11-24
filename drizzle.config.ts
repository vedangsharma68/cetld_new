import { defineConfig } from "drizzle-kit";
import { getEnv } from "./src/env";
export default defineConfig({dialect:"postgresql",schema:"./src/server/db/schema/*.ts",out:"./src/server/db/migrations",dbCredentials:{url:getEnv().DIRECT_URL},strict:true,verbose:false});
