import type { FieldErrors } from "@/shared/types/api";
export class ApiClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: FieldErrors,
    public requestId?: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}
const messages: Record<string, string> = {
  FILE_TOO_LARGE: "Choose a file under 10 MB.",
  UNSUPPORTED_FILE_TYPE: "Choose a PDF file.",
  STORAGE_UNAVAILABLE: "File storage is unavailable. Try again.",
  DATABASE_UNAVAILABLE: "Cetld is temporarily unavailable. Try again.",
  NETWORK_ERROR: "Check your internet connection.",
  INTERNAL_ERROR: "Something went wrong. Try again.",
};
export function toUserMessage(error: unknown): string {
  return error instanceof ApiClientError
    ? (messages[error.code] ?? error.message)
    : "Something went wrong. Try again.";
}
