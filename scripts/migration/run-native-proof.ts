// Proof scripts can use the application pool as well as a dedicated assertion
// connection. Close the former explicitly instead of waiting for idle timeout.
import { sql } from "../../src/server/db/client";
import matrix from "./native-proof-matrix.json";
const allowed = new Set([...matrix, "audit-roles"]);
const name = process.argv[2];
if (!name || !allowed.has(name)) throw Error("Unknown native proof");
try {
  await import(`./verify-native-${name}.ts`);
} finally {
  await sql.end();
}
