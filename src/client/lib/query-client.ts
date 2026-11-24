"use client";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiClientError, toUserMessage } from "./errors";
export function handleGlobalError(error: unknown): void {
  if (error instanceof ApiClientError && error.status === 401) {
    window.location.assign("/login");
    return;
  }
  if (error instanceof ApiClientError && error.status === 422) return;
  toast.error(toUserMessage(error));
}
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30000,
        retry: (count, error) =>
          !(
            error instanceof ApiClientError &&
            error.status >= 400 &&
            error.status < 500
          ) && count < 2,
        refetchOnWindowFocus: false,
      },
    },
    queryCache: new QueryCache({ onError: handleGlobalError }),
    mutationCache: new MutationCache({ onError: handleGlobalError }),
  });
}
