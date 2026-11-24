import { mkdirSync } from "node:fs";
import path from "node:path";
export function evidencePath(name: string) {
  const dir =
    process.env.MIGRATION_EVIDENCE_DIR ??
    path.join(process.cwd(), "test-results", "visual");
  mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}
