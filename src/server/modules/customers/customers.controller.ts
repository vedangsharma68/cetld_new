import "server-only";
import { getSessionUser } from "@/server/lib/auth";
import { ok, created, noContent } from "@/server/lib/response";
import { BadRequestError } from "@/server/lib/errors";
import { readJson } from "@/server/lib/validation";
import type { RouteContext } from "@/server/lib/handler";
import {
  customerIdSchema,
  customerFiltersSchema,
  createCustomerSchema,
  updateCustomerSchema,
} from "@/shared/schemas/customers.schema";
import { customerService } from "./customers.service";
async function idFrom(context: RouteContext) {
  const parsed = customerIdSchema.safeParse((await context.params).id);
  if (!parsed.success) throw new BadRequestError("Invalid customer id");
  return parsed.data;
}
export const customerController = {
  async list(request: Request) {
    const user = await getSessionUser();
    const filters = customerFiltersSchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!filters.success) throw new BadRequestError("Invalid customer filters");
    const result = await customerService.list(user.id, filters.data);
    return ok(result.rows, result.meta);
  },
  async detail(_request: Request, context: RouteContext) {
    const user = await getSessionUser();
    return ok(await customerService.detail(user.id, await idFrom(context)));
  },
  async create(request: Request) {
    const user = await getSessionUser();
    return created(
      await customerService.create(
        user.id,
        createCustomerSchema.parse(await readJson(request)),
      ),
    );
  },
  async update(request: Request, context: RouteContext) {
    const user = await getSessionUser();
    return ok(
      await customerService.update(
        user.id,
        await idFrom(context),
        updateCustomerSchema.parse(await readJson(request)),
      ),
    );
  },
  async remove(_request: Request, context: RouteContext) {
    const user = await getSessionUser();
    await customerService.remove(user.id, await idFrom(context));
    return noContent();
  },
};
