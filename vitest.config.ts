import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({resolve:{alias:{"@":fileURLToPath(new URL("./src",import.meta.url)),"server-only":fileURLToPath(new URL("./tests/migration/server-only.ts",import.meta.url))}},test:{include:["tests/migration/**/*.test.ts"],environment:"node",setupFiles:["tests/migration/setup.ts"]}});
