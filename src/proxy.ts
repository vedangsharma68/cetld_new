import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { getEnv } from "@/env";
export function isPublicPath(path: string): boolean {
  return (
    [
      "/",
      "/login",
      "/invite",
      "/signup",
      "/verify-email",
      "/api/v1/auth/verify-email",
      "/api/health",
      "/api/v1/auth/signup",
      "/api/v1/auth/google-signup",
    ].includes(path) ||
    path === "/api/auth" ||
    path.startsWith("/api/auth/")
  );
}
export async function proxy(request: NextRequest) {
  if (isPublicPath(request.nextUrl.pathname)) return NextResponse.next();
  const token = await getToken({
    req: request,
    secret: getEnv().AUTH_SECRET,
    secureCookie: request.nextUrl.protocol === "https:",
  });
  if (token) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/"))
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "UNAUTHORIZED",
          message: "Please sign in",
          requestId: crypto.randomUUID(),
        },
      },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  return NextResponse.redirect(new URL("/login", request.url));
}
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
