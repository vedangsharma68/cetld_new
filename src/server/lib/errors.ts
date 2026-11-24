import "server-only";
import type { FieldErrors } from "@/shared/types/api";
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: FieldErrors,
    public isOperational = true,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
export class BadRequestError extends AppError {
  constructor(message = "Bad request") {
    super(400, "BAD_REQUEST", message);
  }
}
export class UnauthorizedError extends AppError {
  constructor() {
    super(401, "UNAUTHORIZED", "Please sign in");
  }
}
export class ForbiddenError extends AppError {
  constructor(message = "You do not have access") {
    super(403, "FORBIDDEN", message);
  }
}
export class NotFoundError extends AppError {
  constructor(entity: string) {
    super(404, entity.toUpperCase() + "_NOT_FOUND", entity + " not found");
  }
}
export class ConflictError extends AppError {
  constructor(code: string, message: string) {
    super(409, code, message);
  }
}
export class PayloadTooLargeError extends AppError {
  constructor(maxMb: number) {
    super(413, "FILE_TOO_LARGE", `File must be under ${maxMb} MB`);
  }
}
export class UnsupportedMediaError extends AppError {
  constructor() {
    super(415, "UNSUPPORTED_FILE_TYPE", "Only PDF files are allowed");
  }
}
export class ValidationError extends AppError {
  constructor(details: FieldErrors) {
    super(422, "VALIDATION_FAILED", "Invalid input", details);
  }
}
export class RateLimitError extends AppError {
  constructor() {
    super(429, "RATE_LIMITED", "Too many requests");
  }
}
export class StorageError extends AppError {
  constructor() {
    super(
      502,
      "STORAGE_UNAVAILABLE",
      "File storage is temporarily unavailable",
    );
  }
}
export class DatabaseUnavailableError extends AppError {
  constructor() {
    super(503, "DATABASE_UNAVAILABLE", "Database is temporarily unavailable");
  }
}
