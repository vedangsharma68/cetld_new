import "server-only";
import { z } from "zod";
import { BadRequestError } from "./errors";
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch (error: unknown) {
    if (error instanceof SyntaxError)
      throw new BadRequestError("Malformed JSON");
    throw error;
  }
}
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export function pagination(request: Request) {
  const result = paginationSchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!result.success) throw new BadRequestError("Invalid pagination");
  return result.data;
}
