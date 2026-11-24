import { describe, expect, it, vi } from "vitest";
vi.mock("@/server/modules/customers/customers.repository", () => ({
  customerRepository: {},
}));
import { createCustomerService } from "@/server/modules/customers/customers.service";
import {
  canManageCustomer,
  canViewCustomer,
} from "@/server/modules/customers/customers.policy";
import type { customerRepository } from "@/server/modules/customers/customers.repository";
const row = {
  id: "id",
  workspaceId: "workspace",
  name: "Test",
  companyName: null,
  email: null,
  phone: null,
  createdAt: new Date(),
};
function repository() {
  return {
    membership: vi
      .fn()
      .mockResolvedValue({ workspaceId: "workspace", role: "owner" }),
    list: vi.fn().mockResolvedValue({ rows: [row], total: 1 }),
    find: vi.fn().mockResolvedValue(row),
    create: vi.fn().mockResolvedValue(row),
    update: vi.fn().mockResolvedValue(row),
    remove: vi.fn().mockResolvedValue({ id: "id" }),
  } satisfies {
    [K in keyof typeof customerRepository]: ReturnType<typeof vi.fn>;
  };
}
describe("customer policy", () => {
  it("hides foreign workspace records", () => {
    expect(() => canViewCustomer(null, "workspace")).toThrow("not found");
    expect(() =>
      canViewCustomer({ workspaceId: "other", role: "owner" }, "workspace"),
    ).toThrow("not found");
  });
  it("members retain customer write access", () => {
    expect(() =>
      canViewCustomer(
        { workspaceId: "workspace", role: "member" },
        "workspace",
      ),
    ).not.toThrow();
    expect(() =>
      canManageCustomer(
        { workspaceId: "workspace", role: "member" },
        "workspace",
      ),
    ).not.toThrow();
  });
});
describe("customer service", () => {
  it("lists scoped rows and meta", async () => {
    const repo = repository();
    const filters = {
      workspaceId: "workspace",
      page: 1,
      pageSize: 20,
      search: "",
      sort: "name",
      direction: "asc",
    } as const;
    expect(await createCustomerService(repo).list("u", filters)).toMatchObject({
      rows: [row],
      meta: { total: 1, page: 1, pageSize: 20 },
    });
    expect(repo.list).toHaveBeenCalledWith("u", filters);
  });
  it("denies list before repository query", async () => {
    const repo = repository();
    repo.membership.mockResolvedValue(null);
    await expect(
      createCustomerService(repo).list("u", {
        workspaceId: "workspace",
        page: 1,
        pageSize: 20,
        search: "",
        sort: "name",
        direction: "asc",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(repo.list).not.toHaveBeenCalled();
  });
  it("detail and foreign detail", async () => {
    const repo = repository();
    const service = createCustomerService(repo);
    expect(await service.detail("u", "id")).toEqual(row);
    repo.find.mockResolvedValue(null);
    await expect(service.detail("u", "id")).rejects.toMatchObject({
      statusCode: 404,
    });
  });
  it("create", async () => {
    const repo = repository();
    expect(
      await createCustomerService(repo).create("u", {
        workspaceId: "workspace",
        name: "Test",
      }),
    ).toEqual(row);
    repo.membership.mockResolvedValue(null);
    await expect(
      createCustomerService(repo).create("u", {
        workspaceId: "workspace",
        name: "Test",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
  it("update and denied update", async () => {
    const repo = repository();
    expect(
      await createCustomerService(repo).update("u", "id", { name: "Changed" }),
    ).toEqual(row);
    repo.membership.mockResolvedValue(null);
    await expect(
      createCustomerService(repo).update("u", "id", { name: "Changed" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
  it("delete and missing delete", async () => {
    const repo = repository();
    await createCustomerService(repo).remove("u", "id");
    expect(repo.remove).toHaveBeenCalledWith("u", "id");
    repo.remove.mockResolvedValue(null);
    await expect(
      createCustomerService(repo).remove("u", "id"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
