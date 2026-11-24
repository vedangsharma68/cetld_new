import "server-only";
import { sql } from "@/server/db/client";
export async function pingDatabase(): Promise<void> {
  await sql`select 1`;
}
