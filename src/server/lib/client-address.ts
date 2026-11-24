import "server-only";
import { getEnv } from "@/env";
import { BadRequestError } from "./errors";
export function clientAddress(request: Request): string {
  const env = getEnv();
  if (env.APP_ENV === "test") return "synthetic-loopback";
  if (!env.AUTH_CLIENT_IP_HEADER)
    throw new Error("Trusted proxy address header must be configured for auth");
  const value = request.headers.get(env.AUTH_CLIENT_IP_HEADER)?.trim();
  if (
    !value ||
    value.includes(",") ||
    value.length > 64 ||
    !/^[a-f0-9:.]+$/i.test(value)
  )
    throw new BadRequestError("Client address unavailable");
  return value;
}
