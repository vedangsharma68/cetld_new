import "server-only";
import { and, eq, ilike, asc, desc, count, exists } from "drizzle-orm";
import { db } from "@/server/db/client";
import { customers, workspaceMembers } from "@/server/db/schema";
import type {
  CreateCustomerInput,
  UpdateCustomerInput,
  CustomerFilters,
} from "@/shared/schemas/customers.schema";
const memberScope = (userId: string) =>
  exists(
    db
      .select({ id: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, customers.workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      ),
  );
export const customerRepository = {
  async membership(userId: string, workspaceId: string) {
    const [row] = await db
      .select({
        workspaceId: workspaceMembers.workspaceId,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, userId),
          eq(workspaceMembers.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    return row ?? null;
  },
  async list(userId: string, filters: CustomerFilters) {
    const condition = and(
      eq(customers.workspaceId, filters.workspaceId),
      memberScope(userId),
      filters.search
        ? ilike(
            customers.name,
            `%${filters.search.replace(/[\\%_]/g, "\\$&")}%`,
          )
        : undefined,
    );
    return db.transaction(
      async (tx) => {
        const rows = await tx
          .select()
          .from(customers)
          .where(condition)
          .orderBy(
            (filters.direction === "asc" ? asc : desc)(customers[filters.sort]),
          )
          .limit(filters.pageSize)
          .offset((filters.page - 1) * filters.pageSize);
        const [total] = await tx
          .select({ value: count() })
          .from(customers)
          .where(condition);
        return { rows, total: total?.value ?? 0 };
      },
      { isolationLevel: "repeatable read" },
    );
  },
  async find(userId: string, id: string) {
    const [row] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.id, id), memberScope(userId)))
      .limit(1);
    return row ?? null;
  },
  async create(userId: string, input: CreateCustomerInput) {
    return db.transaction(async (tx) => {
      const [member] = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.userId, userId),
            eq(workspaceMembers.workspaceId, input.workspaceId),
          ),
        )
        .for("share");
      if (!member) return null;
      const [row] = await tx
        .insert(customers)
        .values({ ...input, email: input.email || null })
        .returning();
      return row ?? null;
    });
  },
  async update(userId: string, id: string, input: UpdateCustomerInput) {
    const [row] = await db
      .update(customers)
      .set({
        ...input,
        email: input.email === undefined ? undefined : input.email || null,
      })
      .where(
        and(
          eq(customers.id, id),
          exists(
            db
              .select({ id: workspaceMembers.userId })
              .from(workspaceMembers)
              .where(
                and(
                  eq(workspaceMembers.workspaceId, customers.workspaceId),
                  eq(workspaceMembers.userId, userId),
                ),
              ),
          ),
        ),
      )
      .returning();
    return row ?? null;
  },
  async remove(userId: string, id: string) {
    const [row] = await db
      .delete(customers)
      .where(
        and(
          eq(customers.id, id),
          exists(
            db
              .select({ id: workspaceMembers.userId })
              .from(workspaceMembers)
              .where(
                and(
                  eq(workspaceMembers.workspaceId, customers.workspaceId),
                  eq(workspaceMembers.userId, userId),
                ),
              ),
          ),
        ),
      )
      .returning({ id: customers.id });
    return row ?? null;
  },
};
