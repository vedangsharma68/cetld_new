import "server-only";
import { ZodError } from "zod";
import { getEnv } from "@/env";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  DatabaseUnavailableError,
  ValidationError,
} from "./errors";
import { logger } from "./logger";
export type RouteContext = {
  params: Promise<Record<string, string>>;
  requestId?: string;
};
export type Controller = (
  request: Request,
  context: RouteContext,
) => Promise<Response>;
function codeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return;
  if ("code" in error && typeof error.code === "string") return error.code;
  return "cause" in error ? codeOf(error.cause) : undefined;
}
export function withHandler(controller: Controller): Controller {
  return async (request, context) => {
    const requestId = crypto.randomUUID();
    try {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        const origin = request.headers.get("origin");
        if (!origin || origin !== new URL(getEnv().APP_URL).origin)
          throw new ForbiddenError("Request origin is not allowed");
      }
      const response = await controller(request, { ...context, requestId });
      response.headers.set("X-Request-Id", requestId);
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch (caught: unknown) {
      let error: unknown = caught;
      const code = codeOf(error);
      if (error instanceof ZodError)
        error = new ValidationError(error.flatten());
      else if (code === "23505")
        error = new ConflictError("DUPLICATE", "Record already exists");
      else if (code === "23503")
        error = new ConflictError(
          "RELATED_RECORD",
          "Related record missing or in use",
        );
      else if (
        code &&
        [
          "ECONNREFUSED",
          "ECONNRESET",
          "ETIMEDOUT",
          "ENOTFOUND",
          "08000",
          "08001",
          "08003",
          "08006",
          "57P01",
        ].includes(code)
      )
        error = new DatabaseUnavailableError();
      const operational = error instanceof AppError && error.isOperational;
      const safe =
        error instanceof AppError && error.isOperational
          ? error
          : new AppError(500, "INTERNAL_ERROR", "Something went wrong");
      // Do not log driver messages or error objects: SQL and bound values may be private.
      logger[operational ? "warn" : "error"](
        { requestId, code: safe.code, path: new URL(request.url).pathname },
        operational ? safe.message : "Unhandled error",
      );
      return Response.json(
        {
          success: false,
          error: {
            code: safe.code,
            message: safe.message,
            ...(safe.details ? { details: safe.details } : {}),
            requestId,
          },
        },
        {
          status: safe.statusCode,
          headers: { "X-Request-Id": requestId, "Cache-Control": "no-store" },
        },
      );
    }
  };
}
