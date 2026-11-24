import "server-only";
import { ok } from "@/server/lib/response";
import { health } from "./health.service";
export async function getHealth(): Promise<Response> {
  return ok(await health());
}
