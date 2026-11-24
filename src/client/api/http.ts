import { ApiClientError } from "@/client/lib/errors";
import type { ApiError, ApiSuccess, Paginated } from "@/shared/types/api";
async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<ApiSuccess<T> | undefined> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      credentials: "include",
    });
  } catch {
    throw new ApiClientError(
      0,
      "NETWORK_ERROR",
      "Check your internet connection",
    );
  }
  if (response.status === 204) return;
  const body: ApiSuccess<T> | ApiError | null = await response
    .json()
    .catch(() => null);
  if (!response.ok || !body?.success) {
    const error = body && !body.success ? body.error : undefined;
    throw new ApiClientError(
      response.status,
      error?.code ?? "UNKNOWN_ERROR",
      error?.message ?? "Request failed",
      error?.details,
      error?.requestId,
    );
  }
  return body;
}
export async function http<T>(path: string, init?: RequestInit): Promise<T> {
  return (await request<T>(path, init))?.data as T;
}
export async function httpPaginated<T>(
  path: string,
  init?: RequestInit,
): Promise<Paginated<T>> {
  const body = await request<T[]>(path, init);
  if (!body?.meta)
    throw new ApiClientError(
      502,
      "INVALID_RESPONSE",
      "Invalid pagination response",
    );
  return { data: body.data, meta: body.meta };
}
