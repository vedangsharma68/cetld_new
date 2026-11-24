import "server-only";
import { pingDatabase } from "./health.repository";
import { checkStorage } from "@/server/lib/storage";
export async function health() {
  await pingDatabase();
  await checkStorage();
  return { status: "ok", db: "ok", storage: "ok" } as const;
}
