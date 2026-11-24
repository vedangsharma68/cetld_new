import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import { ApiClientError } from "./errors";
export function applyServerErrors<T extends FieldValues>(
  form: UseFormReturn<T>,
  error: unknown,
): boolean {
  if (!(error instanceof ApiClientError) || error.status !== 422) return false;
  for (const [name, messages] of Object.entries(
    error.details?.fieldErrors ?? {},
  )) {
    if (messages?.[0])
      form.setError(name as Path<T>, { type: "server", message: messages[0] });
  }
  return true;
}
