import "server-only";
import type { ApiSuccess, PaginationMeta } from "@/shared/types/api";
export function ok<T>(data: T, meta?: PaginationMeta): Response {
  return Response.json({
    success: true,
    data,
    ...(meta ? { meta } : {}),
  } satisfies ApiSuccess<T>);
}
export function created<T>(data: T): Response {
  return Response.json({ success: true, data } satisfies ApiSuccess<T>, {
    status: 201,
  });
}
export function noContent(): Response {
  return new Response(null, { status: 204 });
}
