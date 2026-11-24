import "server-only";
import { ok } from "@/server/lib/response";
export async function prepareGoogleSignup() {
  return ok({ ready: true });
}
