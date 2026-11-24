import type { NextRequest } from "next/server";
import { handlers } from "@/server/auth.config";
import { getEnv } from "@/env";
export const runtime = "nodejs";
function guarded(handler: (request: NextRequest) => Promise<Response>) {
  return async (request: NextRequest) => {
    const expected = new URL(getEnv().APP_URL);
    if (request.headers.get("host") !== expected.host)
      return new Response("Invalid host", { status: 400 });
    return handler(request);
  };
}
export const GET = guarded(handlers.GET);
export const POST = guarded(handlers.POST);
