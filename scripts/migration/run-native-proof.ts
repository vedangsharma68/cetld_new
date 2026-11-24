// Proof scripts can use the application pool as well as a dedicated assertion
// connection. Close the former explicitly instead of waiting for idle timeout.
import { sql } from "../../src/server/db/client";
const allowed = new Set([
  "auth",
  "import",
  "lifecycle",
  "financial-preservation",
  "settings-constraints",
  "financial-history",
  "number-parity",
]);
const name = process.argv[2];
if (!name || !allowed.has(name)) throw Error("Unknown native proof");
try {
  await import(`./verify-native-${name}.ts`);
} finally {
  await sql.end();
}
