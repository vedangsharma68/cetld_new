import { getEnv } from "../../src/env";
if(getEnv().APP_ENV!=="test")throw new Error("Synthetic seed allowed only in test");
await import("./seed-local-test");
