import "server-only";
import { NotFoundError } from "@/server/lib/errors";
import type {
  CreateCustomerInput,
  UpdateCustomerInput,
  CustomerFilters,
} from "@/shared/schemas/customers.schema";
import { canViewCustomer, canManageCustomer } from "./customers.policy";
import { customerRepository } from "./customers.repository";
export function createCustomerService(repository = customerRepository) {
  return {
    async list(userId: string, filters: CustomerFilters) {
      canViewCustomer(
        await repository.membership(userId, filters.workspaceId),
        filters.workspaceId,
      );
      const result = await repository.list(userId, filters);
      return {
        rows: result.rows,
        meta: {
          page: filters.page,
          pageSize: filters.pageSize,
          total: result.total,
        },
      };
    },
    async detail(userId: string, id: string) {
      const row = await repository.find(userId, id);
      if (!row) throw new NotFoundError("Customer");
      canViewCustomer(
        await repository.membership(userId, row.workspaceId),
        row.workspaceId,
      );
      return row;
    },
    async create(userId: string, input: CreateCustomerInput) {
      canManageCustomer(
        await repository.membership(userId, input.workspaceId),
        input.workspaceId,
      );
      const row = await repository.create(userId, input);
      if (!row) throw new NotFoundError("Customer");
      return row;
    },
    async update(userId: string, id: string, input: UpdateCustomerInput) {
      const current = await repository.find(userId, id);
      if (!current) throw new NotFoundError("Customer");
      canManageCustomer(
        await repository.membership(userId, current.workspaceId),
        current.workspaceId,
      );
      const row = await repository.update(userId, id, input);
      if (!row) throw new NotFoundError("Customer");
      return row;
    },
    async remove(userId: string, id: string) {
      const current = await repository.find(userId, id);
      if (!current) throw new NotFoundError("Customer");
      canManageCustomer(
        await repository.membership(userId, current.workspaceId),
        current.workspaceId,
      );
      if (!(await repository.remove(userId, id)))
        throw new NotFoundError("Customer");
    },
  };
}
export const customerService = createCustomerService();
