import "server-only";
import { getSessionUser } from "@/server/lib/auth";
import { ok, created, noContent } from "@/server/lib/response";
import { readJson } from "@/server/lib/validation";
import { BadRequestError } from "@/server/lib/errors";
import type { RouteContext } from "@/server/lib/handler";
import {
  invoiceIdSchema,
  invoiceFiltersSchema,
  createInvoiceSchema,
  invoiceUploadSchema,
  finalizeInvoiceSchema,
} from "@/shared/schemas/invoices.schema";
import { invoiceService } from "./invoices.service";
async function idFrom(c: RouteContext) {
  const id = invoiceIdSchema.safeParse((await c.params).id);
  if (!id.success) throw new BadRequestError("Invalid invoice id");
  return id.data;
}
export const invoiceController = {
  async list(request: Request) {
    const user = await getSessionUser();
    const input = invoiceFiltersSchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!input.success) throw new BadRequestError("Invalid invoice filters");
    const result = await invoiceService.list(user.id, input.data);
    return ok(result.rows, result.meta);
  },
  async create(request: Request) {
    const user = await getSessionUser();
    return created(
      await invoiceService.create(
        user.id,
        createInvoiceSchema.parse(await readJson(request)),
      ),
    );
  },
  async detail(_r: Request, c: RouteContext) {
    const user = await getSessionUser();
    return ok(await invoiceService.detail(user.id, await idFrom(c)));
  },
  async upload(request: Request, c: RouteContext) {
    const user = await getSessionUser();
    return ok(
      await invoiceService.upload(
        user.id,
        await idFrom(c),
        invoiceUploadSchema.parse(await readJson(request)),
      ),
    );
  },
  async finalize(request: Request, c: RouteContext) {
    const user = await getSessionUser();
    finalizeInvoiceSchema.parse(await readJson(request));
    return ok(await invoiceService.finalize(user.id, await idFrom(c)));
  },
  async download(_r: Request, c: RouteContext) {
    const user = await getSessionUser();
    return ok(await invoiceService.download(user.id, await idFrom(c)));
  },
  async remove(_r: Request, c: RouteContext) {
    const user = await getSessionUser();
    await invoiceService.remove(
      user.id,
      await idFrom(c),
      c.requestId ?? crypto.randomUUID(),
    );
    return noContent();
  },
};
